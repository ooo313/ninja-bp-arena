import type { BattleResourceSnapshot, MatchState, OnlineCommandType, PendingUndo, RoomStatus, Seat, PrivateLoadout } from '@bp-core'

/** 客户端在线模式的类型（与 Shared BP Core / 数据库结构对应） */

export type { OnlineCommandType, PendingUndo, RoomStatus, Seat }

export interface RoomMember {
  user_id: string
  seat: Seat
  display_name: string
}

/** 从数据库拉取的权威房间快照 */
export interface RoomSnapshot {
  privateLoadout?: PrivateLoadout | null
  room: {
    id: string
    code: string
    status: RoomStatus
    match_state: MatchState
    revision: number
    pending_action: PendingUndo | null
    expires_at: string
    host_user_id: string
    /** v0.3：{id,enabled}[]；v0.4 起为完整轻量 Ninja Snapshot（id/name/enabled/quality/avatar/assetKey） */
    /** Loaded once on entry; omitted by lightweight state refreshes. */
    pool?: unknown[]
    /** v0.4：房主创建时固化的数据包元信息（旧房间可能为 null） */
    data_pack_metadata?: { packId: string; schemaVersion?: number; packVersion?: string; checksum?: string } | null
    resource_snapshot?: BattleResourceSnapshot | null
  } | null
  members: RoomMember[]
}

export interface CommandResponse {
  privateLoadout?: PrivateLoadout | null
  status: 'APPLIED' | 'REJECTED'
  idempotent?: boolean
  match?: MatchState
  revision?: number
  roomStatus?: RoomStatus
  pendingUndo?: PendingUndo | null
  code?: string
  message?: string
}

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'syncing' | 'reconnecting' | 'offline'

/** Presence 条目（只做临时在线信息，禁止存放 BP 状态） */
export interface PresenceEntry {
  seat: Seat
  displayName: string
  onlineAt: number
}
