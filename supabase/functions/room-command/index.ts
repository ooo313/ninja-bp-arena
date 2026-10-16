import { json, handleOptions } from '../_shared/http.ts'
import { serviceClient, getUserFromRequest } from '../_shared/supabase.ts'
import { submitPrivateLoadout } from '../_shared/loadoutSubmission.ts'
import {
  applyRoomCommand,
  validateMatchState,
  type OnlineCommandType,
  type PendingUndo,
  type RoomStatus,
  type Seat,
  type SeatMember,
  snapshotResources,
  type BattleResourceSnapshot,
  type DraftResourceType,
} from '../_shared/bp-core/index.ts'

/**
 * POST /functions/v1/room-command —— 在线 BP 的唯一写入口。
 *
 * 流程（顺序即安全边界）：
 *   1. JWT Authentication
 *   2. 解析并校验 roomId / commandId
 *   3. load target room（存在性）
 *   4. 查询 JWT user 在目标房间的 member —— 授权必须先于幂等响应，
 *      绝不因「commandId 曾存在」而跳过授权或返回他房数据
 *   5. 幂等检查（范围化：command_id + room_id + user_id + type + payload）
 *   6. Shared BP Core 验证并应用
 *   7. private.apply_room_state_cas（revision CAS + 审计，同一事务）
 *
 * 响应：
 * - 200 { status:'APPLIED', match, revision, roomStatus, pendingUndo }
 * - 400 { status:'REJECTED' | error:'IDEMPOTENCY_KEY_REUSE', ... }
 * - 409 { error:'REVISION_CONFLICT', message, match, revision }
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_BODY_BYTES = 8 * 1024

interface RoomRow {
  id: string
  code: string
  status: RoomStatus
  match_state: unknown
  revision: number
  pending_action: unknown
  expires_at: string
  pool: { id: string; enabled: boolean }[]
  resource_snapshot: BattleResourceSnapshot | null
  host_user_id: string
}

interface AuditRow {
  room_id: string
  user_id: string | null
  command_type: string
  payload: unknown
  status: 'APPLIED' | 'REJECTED'
  reject_code: string | null
}

async function loadRoom(admin: ReturnType<typeof serviceClient>, roomId: string): Promise<RoomRow | null> {
  const { data, error } = await admin
    .from('rooms')
    .select('id, code, status, match_state, revision, pending_action, expires_at, pool, resource_snapshot, host_user_id')
    .eq('id', roomId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return (data as RoomRow) ?? null
}

/** 规范化 payload 用于幂等一致性比较（键排序，消除序列化差异） */
function normalizePayload(payload: unknown): string {
  if (payload === null || payload === undefined) return 'null'
  if (typeof payload !== 'object') return JSON.stringify(payload)
  const rec = payload as Record<string, unknown>
  const keys = Object.keys(rec).filter((k) => rec[k] !== undefined).sort()
  return '{' + keys.map((k) => `${k}:${normalizePayload(rec[k])}`).join(',') + '}'
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return handleOptions()
  if (req.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405)

  try {
    const admin = serviceClient()
    const user = await getUserFromRequest(admin, req)
    if (!user) return json({ error: 'NOT_AUTHENTICATED', message: '登录状态失效，请刷新页面' }, 401)

    const rawBody = await req.text()
    if (rawBody.length > MAX_BODY_BYTES) return json({ error: 'PAYLOAD_TOO_LARGE', message: '命令体积超出限制' }, 413)
    const body = JSON.parse(rawBody) as {
      roomId?: unknown
      commandId?: unknown
      expectedRevision?: unknown
      type?: unknown
      payload?: { ninjaId?: unknown; resourceId?: unknown; resourceType?: unknown; side?: unknown; resourceIds?: unknown; phaseKey?: unknown }
    }

    const roomId = typeof body.roomId === 'string' ? body.roomId : ''
    const commandId = typeof body.commandId === 'string' ? body.commandId : ''
    const expectedRevision = Number(body.expectedRevision)
    const type = typeof body.type === 'string' ? (body.type as OnlineCommandType) : null
    if (!UUID_RE.test(roomId)) return json({ error: 'INVALID_COMMAND', message: 'roomId 非法' }, 400)
    if (!UUID_RE.test(commandId)) return json({ error: 'INVALID_COMMAND', message: 'commandId 非法' }, 400)
    if (!type) return json({ error: 'INVALID_COMMAND', message: '缺少命令类型' }, 400)

    const normalizedPayload = normalizePayload(body.payload ?? null)

    // ---- 1. 目标房间（先于幂等：授权优先）----
    const room = await loadRoom(admin, roomId)
    if (!room) return json({ error: 'ROOM_NOT_FOUND', message: '房间不存在' }, 404)

    // ---- 2. 当前 JWT user 的成员资格（授权核心）----
    const { data: member } = await admin
      .from('room_members')
      .select('seat')
      .eq('room_id', roomId)
      .eq('user_id', user.id)
      .maybeSingle()

    const seatMembers: { BLUE: SeatMember | null; RED: SeatMember | null } = { BLUE: null, RED: null }
    const { data: seated } = await admin
      .from('room_members')
      .select('user_id, seat, display_name')
      .eq('room_id', roomId)
      .in('seat', ['BLUE', 'RED'])
    for (const m of seated ?? []) {
      if (m.seat === 'BLUE') {
        seatMembers.BLUE = { userId: m.user_id as string, displayName: m.display_name as string }
      } else if (m.seat === 'RED') {
        seatMembers.RED = { userId: m.user_id as string, displayName: m.display_name as string }
      }
    }

    // ---- 授权拦截（必须先于幂等检查：非成员绝不返回任何房间状态）----
    if (!member && user.id !== room.host_user_id) {
      return json({ error: 'NOT_MEMBER', message: '你还没有加入这个房间' }, 400)
    }

    // Never write a sealed payload into the member-readable command audit log.
    if (type === 'SUBMIT_LOADOUT') return await submitPrivateLoadout(admin, user.id, roomId, commandId, body.payload ?? {})

    // ---- 3. 幂等检查（已通过授权：room + member 确认后才允许返回任何状态）----
    // 范围化语义：commandId 必须绑定同一 room + 同一 user；
    // 同 scope 但 type/payload 不一致同样视为复用攻击。
    const { data: priorRows } = await admin
      .from('room_commands')
      .select('room_id, user_id, command_type, payload, status, reject_code')
      .eq('command_id', commandId)
    const prior = (priorRows as AuditRow[] | null) ?? []
    if (prior.length > 0) {
      const mine = prior.find((r) => r.room_id === roomId && r.user_id === user.id)
      if (!mine) {
        // 同一 commandId 曾被其他房间 / 其他用户使用
        return json(
          { error: 'IDEMPOTENCY_KEY_REUSE', message: '请求标识已被其他操作使用，请重试' },
          400,
        )
      }
      if (mine.command_type !== type || normalizePayload(mine.payload) !== normalizedPayload) {
        return json(
          { error: 'IDEMPOTENCY_KEY_REUSE', message: '请求标识已被其他操作使用，请重试' },
          400,
        )
      }
      if (mine.status === 'APPLIED') {
        return json({
          status: 'APPLIED',
          idempotent: true,
          match: room.match_state,
          revision: room.revision,
          roomStatus: room.status,
          pendingUndo: room.pending_action ?? null,
        })
      }
      return json(
        { status: 'REJECTED', code: mine.reject_code ?? 'INVALID_COMMAND', message: '该命令此前已被拒绝', revision: room.revision, match: room.match_state },
        400,
      )
    }

    // ---- 4. 运行 Shared BP Core（与浏览器同一套规则；Side 由阶段推导，不信任客户端）----
    const outcome = applyRoomCommand(
      {
        match: room.match_state as never,
        revision: room.revision,
        roomStatus: room.status,
        expiresAt: new Date(room.expires_at).getTime(),
        mySeat: (member?.seat as Seat | undefined) ?? null,
        // 真正身份 = JWT user.id，绝不使用请求体传入的任何身份
        isHost: user.id === room.host_user_id,
        myUserId: user.id,
        hostUserId: room.host_user_id,
        seatMembers,
        pendingUndo: (room.pending_action as PendingUndo | null) ?? null,
        ninjas: Array.isArray(room.pool) ? room.pool : [],
        ...(room.resource_snapshot ? { resources: snapshotResources(room.resource_snapshot) } : {}),
        now: Date.now(),
      },
      {
        commandId,
        roomId,
        expectedRevision,
        type,
        payload: {
          ninjaId: typeof body.payload?.ninjaId === 'string' ? body.payload.ninjaId : undefined,
          resourceId: typeof body.payload?.resourceId === 'string' ? body.payload.resourceId : undefined,
          resourceType: ['NINJA', 'SECRET_SCROLL', 'SUMMON'].includes(String(body.payload?.resourceType))
            ? body.payload?.resourceType as DraftResourceType
            : undefined,
          // side 由服务端按阶段推导；此处仅透传（handler 不信任它）
          side:
            body.payload?.side === 'BLUE' || body.payload?.side === 'RED'
              ? (body.payload.side as 'BLUE' | 'RED')
              : undefined,
        },
      },
    )

    if (outcome.status === 'REJECTED') {
      // 审计写入：并发重复 commandId 时 upsert 冲突跳过，仍返回稳定业务响应
      await admin
        .from('room_commands')
        .upsert(
          {
            command_id: commandId,
            room_id: roomId,
            user_id: user.id,
            command_type: type,
            expected_revision: expectedRevision,
            payload: body.payload ?? null,
            status: 'REJECTED',
            reject_code: outcome.code,
          },
          { onConflict: 'room_id,user_id,command_id', ignoreDuplicates: true },
        )
      return json(
        { status: 'REJECTED', code: outcome.code, message: outcome.message, revision: room.revision, match: room.match_state },
        400,
      )
    }

    // ---- APPLIED：状态合法性兜底 + 事务化（CAS + 审计）写入 ----
    if (!validateMatchState(outcome.match)) {
      return json({ error: 'INTERNAL', message: '生成的比赛状态未通过校验，已中止写入' }, 500)
    }

    const { data: casResult, error: casError } = await admin.rpc('apply_room_state_cas', {
      p_room_id: roomId,
      p_expected_revision: room.revision,
      p_command_id: commandId,
      p_user_id: user.id,
      p_command_type: type,
      p_payload: body.payload ?? null,
      p_next_match_state: outcome.match,
      p_next_status: outcome.roomStatus,
      p_next_pending_action: outcome.pendingUndo,
    })
    if (casError) {
      // REVISION_CONFLICT 由 RPC 抛出并整体回滚
      if (casError.message.includes('REVISION_CONFLICT')) {
        const fresh = await loadRoom(admin, roomId)
        return json(
          { error: 'REVISION_CONFLICT', message: '比赛状态已更新，正在同步', match: fresh?.match_state, revision: fresh?.revision ?? 0 },
          409,
        )
      }
      return json({ error: 'DB_ERROR', message: casError.message }, 500)
    }

    const newRevision = Number(casResult)
    if (newRevision === -1) {
      // 幂等命中（并发重复 commandId，同 room 同 user）：返回当前权威状态
      const fresh = await loadRoom(admin, roomId)
      return json({
        status: 'APPLIED',
        idempotent: true,
        match: fresh?.match_state,
        revision: fresh?.revision ?? outcome.revision,
        roomStatus: fresh?.status ?? outcome.roomStatus,
        pendingUndo: (fresh?.pending_action as PendingUndo | null) ?? null,
      })
    }

    // 刷新成员在线时间
    await admin
      .from('room_members')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('room_id', roomId)
      .eq('user_id', user.id)

    return json({
      status: 'APPLIED',
      match: outcome.match,
      revision: newRevision,
      roomStatus: outcome.roomStatus,
      pendingUndo: outcome.pendingUndo,
    })
  } catch (err) {
    return json({ error: 'INTERNAL', message: err instanceof Error ? err.message : String(err) }, 500)
  }
})
