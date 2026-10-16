import type { BattleResourceSnapshot, BattleRule, DraftResourceType, OnlineCommandType, Seat } from '@bp-core'
import { supabase } from '@/lib/supabase'
import type { CommandResponse, RoomSnapshot } from './types'
import { getSealedDraft, type PrivateLoadout } from '@bp-core'

/**
 * 在线房间 API 封装：Edge Function 调用 + RLS 保护的快照读取。
 * UI 组件永远不直接接触这里（通过 onlineRoomStore / MatchSource 间接使用）。
 */

export interface CreateRoomInput {
  displayName: string
  seat: 'BLUE' | 'RED'
  rule: BattleRule
  pool: { id: string; enabled: boolean }[]
  /** v0.4：房间固化的忍者轻量快照（显示权威）；缺省时服务端用 pool 推导 */
  ninjas?: { id: string; name: string; enabled: boolean; quality: string; avatar?: string; assetKey?: string }[]
  resourceSnapshot?: BattleResourceSnapshot
  /** v0.4：房主数据包元信息 */
  packMetadata?: { packId: string; schemaVersion?: number; packVersion?: string; checksum?: string }
}

export interface JoinRoomInput {
  code: string
  seat: 'AUTO' | 'BLUE' | 'RED' | 'OBSERVER'
  displayName: string
}

export interface RoomIdentity {
  roomId: string
  code: string
  seat: Seat
  rejoined: boolean
}

function requireClient() {
  if (!supabase) throw new Error('在线模式尚未配置')
  return supabase
}

/** 统一解析 Edge Function 错误为 { code, message } */
async function callFunction<T>(name: string, body: Record<string, unknown>): Promise<T> {
  const client = requireClient()
  const { data, error } = await client.functions.invoke(name, { body })
  if (error) {
    // functions.invoke 把非 2xx 放进 error（FunctionsHttpError），正文需要解析
    let payload: { error?: string; message?: string; code?: string } = {}
    if (error instanceof Error && 'context' in error) {
      try {
        payload = await (error as { context: Response }).context.json()
      } catch {
        /* ignore */
      }
    }
    throw Object.assign(new Error(payload.message ?? error.message), {
      code: payload.error ?? payload.code ?? 'NETWORK',
      payload: payload as Record<string, unknown>,
    })
  }
  return data as T
}

export const roomApi = {
  async createRoom(input: CreateRoomInput): Promise<RoomIdentity> {
    return callFunction<RoomIdentity>('room-create', { ...input })
  },

  async joinRoom(input: JoinRoomInput): Promise<RoomIdentity> {
    return callFunction<RoomIdentity>('room-join', { ...input })
  },

  /** 拉取权威快照（RLS：仅成员可读；非成员读取返回 null room） */
  async fetchSnapshot(roomId: string, includeResources = true): Promise<RoomSnapshot> {
    const client = requireClient()
    // Both reads are independent. Bound each request so a stalled connection
    // cannot indefinitely block the room's single in-flight refresh.
    const signal = AbortSignal.timeout(15_000)
    const columns = 'id, code, status, match_state, revision, pending_action, expires_at, host_user_id'
    const [roomResult, membersResult] = await Promise.all([
      client.from('rooms')
        .select(includeResources ? `${columns}, pool, resource_snapshot, data_pack_metadata` : columns)
        .eq('id', roomId).abortSignal(signal).maybeSingle(),
      client.from('room_members').select('user_id, seat, display_name')
        .eq('room_id', roomId).abortSignal(signal),
    ])
    const { data: room, error: roomError } = roomResult
    if (roomError) throw Object.assign(new Error(roomError.message), { code: 'DB_ERROR' })

    const { data: members, error: membersError } = membersResult
    if (membersError) throw Object.assign(new Error(membersError.message), { code: 'DB_ERROR' })

    let privateLoadout: PrivateLoadout | null = null
    const typedRoom = room as unknown as RoomSnapshot['room']
    const sealed = typedRoom ? getSealedDraft(typedRoom.match_state) : null
    if (sealed) {
      // RLS returns only this JWT user's row; opponents and observers see none.
      const result = await client.from('room_loadout_submissions').select('phase_key,side,resource_ids').eq('room_id', roomId).eq('phase_key', sealed.key).abortSignal(signal).maybeSingle()
      if (result.error) throw Object.assign(new Error(result.error.message), { code: 'DB_ERROR' })
      privateLoadout = result.data as PrivateLoadout | null
    }

    return {
      room: (room as RoomSnapshot['room']) ?? null,
      members: (members as RoomSnapshot['members']) ?? [],
      privateLoadout,
    }
  },

  async fetchRoomIdByCode(code: string): Promise<string | null> {
    const client = requireClient()
    // RLS：只有成员能读到（用于刷新恢复）；未加入者必须走 joinRoom
    const { data } = await client.from('rooms').select('id').eq('code', code.toUpperCase()).maybeSingle()
    return data?.id ?? null
  },

  async sendCommand(input: {
    roomId: string
    commandId: string
    expectedRevision: number
    type: OnlineCommandType
    payload?: { ninjaId?: string; resourceId?: string; resourceType?: DraftResourceType; side?: string; resourceIds?: string[]; phaseKey?: string }
  }): Promise<CommandResponse> {
    return callFunction<CommandResponse>('room-command', input)
  },
}
