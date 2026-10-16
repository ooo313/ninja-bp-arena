import { json } from './http.ts'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getSealedDraft, revealSealedLoadouts, snapshotResources, validateMatchState, validateSealedLoadout, type BattleResourceSnapshot, type MatchState, type Side } from './bp-core/index.ts'

type Admin = Pick<SupabaseClient, 'from' | 'rpc'>
interface Submission { phase_key: string; side: Side; user_id: string; command_id: string; resource_type: string; resource_ids: string[] }

/** Called after JWT and room membership checks; the SQL RPC rechecks the seat. */
export async function submitPrivateLoadout(admin: Admin, userId: string, roomId: string, commandId: string, payload: { phaseKey?: unknown; resourceType?: unknown; resourceIds?: unknown; side?: unknown }) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { data: room, error: roomError } = await admin.from('rooms').select('id,status,match_state,revision,resource_snapshot,expires_at').eq('id', roomId).single()
    if (roomError || !room) return json({ error: 'ROOM_NOT_FOUND', message: '房间不存在' }, 400)
    const { data: member } = await admin.from('room_members').select('seat').eq('room_id', roomId).eq('user_id', userId).maybeSingle()
    if (!member || !['BLUE', 'RED'].includes(member.seat)) return json({ error: 'NOT_PERMITTED', message: '仅对局双方可以提交阵容' }, 400)
    if (room.status !== 'ACTIVE' || new Date(room.expires_at).getTime() <= Date.now()) return json({ error: 'ROOM_NOT_ACTIVE', message: '房间不在比赛中或已过期' }, 400)
    const side = member.seat as Side
    const match = room.match_state as MatchState
    const phase = getSealedDraft(match)
    const { data: prior, error: priorError } = await admin.from('room_loadout_submissions').select('*').eq('room_id', roomId).eq('user_id', userId).eq('command_id', commandId).maybeSingle()
    if (priorError) throw new Error(priorError.message)
    if (prior) {
      if (prior.phase_key !== payload.phaseKey || prior.resource_type !== payload.resourceType || JSON.stringify(prior.resource_ids) !== JSON.stringify(payload.resourceIds)) return json({ error: 'IDEMPOTENCY_KEY_REUSE', message: '同一请求标识不能用于不同阵容' }, 400)
      return json({ status: 'APPLIED', idempotent: true, match, revision: room.revision, roomStatus: room.status, pendingUndo: null, privateLoadout: phase?.key === prior.phase_key ? { phase_key: prior.phase_key, side, resource_ids: prior.resource_ids } : null })
    }
    if (!phase || payload.phaseKey !== phase.key || payload.resourceType !== phase.resourceType) return json({ error: 'REVISION_CONFLICT', message: '选择阶段已变化，请刷新阵容', match, revision: room.revision }, 409)
    if (payload.side !== undefined && payload.side !== side) return json({ error: 'NOT_PERMITTED', message: '不能代替对手提交阵容' }, 400)
    const resources = snapshotResources(room.resource_snapshot as BattleResourceSnapshot)
    const reason = validateSealedLoadout(match, side, phase.resourceType, payload.resourceIds, resources)
    if (reason) return json({ error: 'RESOURCE_BLOCKED', message: reason }, 400)
    const ids = payload.resourceIds as string[]
    const { data: records, error: submissionsError } = await admin.from('room_loadout_submissions').select('*').eq('room_id', roomId).eq('phase_key', phase.key)
    if (submissionsError) throw new Error(submissionsError.message)
    const mine = (records as Submission[]).find((item) => item.side === side)
    if (mine) return json({ error: 'LOADOUT_LOCKED', message: '本阶段阵容已确认，等待对方完成' }, 400)
    const other = (records as Submission[]).find((item) => item.side !== side)
    let revealed: MatchState | null = null
    if (other) {
      const choices = { [side]: ids, [other.side]: other.resource_ids } as Record<Side, string[]>
      const commands = { [side]: commandId, [other.side]: other.command_id } as Record<Side, string>
      const result = revealSealedLoadouts(match, choices, resources, Date.now(), commands)
      if (!result.ok || !result.state || !validateMatchState(result.state)) return json({ error: 'INVALID_REVEAL', message: result.reason ?? '阵容校验失败' }, 400)
      revealed = result.state
    }
    const { data: revision, error: commitError } = await admin.rpc('commit_room_loadout', {
      p_room_id: roomId, p_expected_revision: room.revision, p_expected_match: match,
      p_phase_key: phase.key, p_user_id: userId, p_side: side, p_command_id: commandId,
      p_resource_type: phase.resourceType, p_resource_ids: ids,
      p_opponent_command_id: other?.command_id ?? null, p_revealed_match: revealed,
    })
    if (commitError?.message.includes('REVISION_CONFLICT')) continue
    if (commitError) return json({ error: 'DB_ERROR', message: '阵容提交未完成，请刷新后重试' }, 400)
    return json({ status: 'APPLIED', match: revealed ?? match, revision: Number(revision), roomStatus: room.status, pendingUndo: null, privateLoadout: revealed ? null : { phase_key: phase.key, side, resource_ids: ids } })
  }
  return json({ error: 'REVISION_CONFLICT', message: '房间正在同步，请重试' }, 409)
}
