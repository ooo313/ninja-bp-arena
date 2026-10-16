import { create } from 'zustand'
import type { BattleResourceSnapshot, BattleRule, DraftResourceType, MatchState, Ninja, OnlineCommandType, OnlineNinjaSnapshot, PendingUndo, RoomStatus, Seat } from '@bp-core'
import { getSealedDraft, toBattleResourceSnapshot, toOnlineNinjaSnapshots, type PrivateLoadout } from '@bp-core'
import { supabase, isOnlineConfigured } from '@/lib/supabase'
import { getPhase } from '@bp-core'
import { roomApi } from './roomClient'
import { useNinjaStore } from '@/store/ninjaStore'
import { useDataPackStore, parseRoomNinjaSnapshot } from '@/dataPack/store'
import type { ConnectionState, PresenceEntry, RoomMember } from './types'
import type { MatchPackMetadata } from '@bp-core'

/**
 * 在线房间 Store。
 *
 * 关键原则：
 * - 数据库 / Edge Function 是权威状态源，客户端只发送命令
 * - Realtime 只负责“有更新”的通知，收到后重新拉取权威快照
 * - presence 只存放临时在线信息（禁止存放 Ban/Pick）
 * - pendingCommand 期间禁止重复点击（正确性优先于 100ms 动画）
 */

interface OnlineRoomState {
  configOk: boolean
  userId: string | null
  authReady: boolean

  roomId: string | null
  roomCode: string | null
  roomStatus: RoomStatus | null
  roomExpiresAt: number | null
  match: MatchState | null
  privateLoadout: PrivateLoadout | null
  revision: number
  members: RoomMember[]
  mySeat: Seat | null
  isHost: boolean
  pendingUndo: PendingUndo | null

  connection: ConnectionState
  realtimeConnected: boolean
  pendingCommand: OnlineCommandType | null
  lastError: { code: string; message: string } | null
  presence: Record<string, PresenceEntry>
  onlineNinjaIds: string[] | null
  /** v0.4：房间的忍者快照（显示权威，双方一致；旧房间为 null） */
  roomNinjas: Ninja[] | null
  /** v0.4：房间的数据包元信息（等待页展示 + 加入一致性提示） */
  roomPackMetadata: MatchPackMetadata | null
  roomResources: BattleResourceSnapshot | null

  ensureAuth: () => Promise<boolean>
  createRoom: (input: { displayName: string; seat: 'BLUE' | 'RED'; rule: MatchState['rule'] }) => Promise<{ ok: boolean; code?: string; error?: string }>
  joinRoom: (input: { code: string; seat: 'AUTO' | 'BLUE' | 'RED' | 'OBSERVER'; displayName: string }) => Promise<{ ok: boolean; seat?: Seat; error?: string }>
  enterRoom: (roomId: string, code: string) => Promise<{ ok: boolean; error?: string }>
  sendCommand: (type: OnlineCommandType, payload?: { ninjaId?: string; resourceId?: string; resourceType?: DraftResourceType; side?: string; resourceIds?: string[]; phaseKey?: string }) => Promise<{ ok: boolean; reason?: string }>
  /** 强制重新拉取权威快照（怀疑本地状态滞后时使用） */
  resync: () => Promise<void>
  /** 基于最新权威状态判断当前是否轮到本客户端 */
  isMyTurnNow: () => boolean
  leaveRoom: () => void
  refreshSnapshot: () => Promise<void>
  markOffline: () => void
  clearError: () => void
}

let currentChannel: ReturnType<NonNullable<typeof supabase>['channel']> | null = null
let pollTimer: number | null = null
let resubscribeTimer: number | null = null
let resubscribeAttempts = 0
let leaving = false
let roomGeneration = 0
let snapshotFlight: { generation: number; promise: Promise<void> } | null = null
let refreshQueued = false
let snapshotFailures = 0

function stopPoll() {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer)
    pollTimer = null
  }
}

function startPoll(get: () => OnlineRoomState) {
  stopPoll()
  // Healthy Realtime needs only a low-frequency safety net. When the socket
  // is unavailable, HTTP polling keeps the authoritative room usable.
  pollTimer = window.setInterval(() => {
    const st = get()
    if (st.roomId && !leaving && navigator.onLine !== false) void st.refreshSnapshot()
  }, get().realtimeConnected ? 12_000 : 3_000)
}

function deriveMySeat(members: RoomMember[], userId: string | null): Seat | null {
  if (!userId) return null
  return members.find((m) => m.user_id === userId)?.seat ?? null
}

function userFacingRoomError(err: unknown): string {
  const code = (err as { code?: string } | null)?.code
  if (code === 'DB_ERROR') return '房间数据暂时无法读取，请稍后重试'
  if (code === 'NETWORK') return '网络连接异常，请稍后重试'
  if (code === 'INTERNAL' || !code) return '在线房间暂时不可用，请稍后重试'
  return err instanceof Error ? err.message : '在线房间暂时不可用，请稍后重试'
}

export const useOnlineRoomStore = create<OnlineRoomState>()((set, get) => ({
  configOk: isOnlineConfigured,
  userId: null,
  authReady: false,

  roomId: null,
  roomCode: null,
  roomStatus: null,
  roomExpiresAt: null,
  match: null,
  privateLoadout: null,
  revision: -1,
  members: [],
  mySeat: null,
  isHost: false,
  pendingUndo: null,

  connection: 'idle',
  realtimeConnected: false,
  pendingCommand: null,
  lastError: null,
  presence: {},
  onlineNinjaIds: null,
  roomNinjas: null,
  roomPackMetadata: null,
  roomResources: null,

  // ---- 匿名认证：首次进入在线模式自动 signInAnonymously ----
  ensureAuth: async () => {
    if (!supabase) return false
    const { data } = await supabase.auth.getSession()
    if (data.session?.user) {
      set({ userId: data.session.user.id, authReady: true })
      return true
    }
    const { data: anon, error } = await supabase.auth.signInAnonymously()
    if (error || !anon.session) {
      set({ lastError: { code: 'AUTH_FAILED', message: '进入在线模式失败，请稍后重试' }, authReady: true })
      return false
    }
    set({ userId: anon.session.user.id, authReady: true })
    return true
  },

  createRoom: async ({ displayName, seat, rule }) => {
    if (!get().configOk) return { ok: false, error: '在线模式尚未配置' }
    try {
      const authOk = await get().ensureAuth()
      if (!authOk) return { ok: false, error: '进入在线模式失败' }
      const ninjaStore = useNinjaStore.getState()
      const pool = ninjaStore.ninjas.map((n) => ({ id: n.id, enabled: n.enabled }))
      // v0.4：房间固化完整轻量快照（id/name/enabled/quality/avatar/assetKey），
      // 加入方以它为显示权威，双方数据包版本不同也不会显示不同角色
      const pack = useDataPackStore.getState().activePack()
      const ninjas: OnlineNinjaSnapshot[] = toOnlineNinjaSnapshots(
        ninjaStore.ninjas,
        pack?.manifest.assetBaseUrl,
      )
      const resourceSnapshot = toBattleResourceSnapshot({
        ninjas: ninjaStore.ninjas,
        secretScrolls: pack?.secretScrolls ?? [],
        summons: pack?.summons ?? [],
      }, pack?.manifest.assetBaseUrl)
      const packMetadata = pack
        ? {
            packId: pack.manifest.id,
            schemaVersion: pack.manifest.schemaVersion,
            packVersion: pack.manifest.version,
            checksum: pack.manifest.checksum,
          }
        : undefined
      const identity = await roomApi.createRoom({ displayName, seat, rule: rule as BattleRule, pool, ninjas, resourceSnapshot, packMetadata })
      const entered = await get().enterRoom(identity.roomId, identity.code)
      return entered.ok ? { ok: true, code: identity.code } : { ok: false, error: entered.error }
    } catch (err) {
      const code = (err as { code?: string }).code
      const extra = (err as { payload?: { resourceType?: string; required?: number; available?: number } }).payload
      if ((code === 'INSUFFICIENT_RESOURCE_POOL' || code === 'INSUFFICIENT_NINJA_POOL') && extra) {
        return {
          ok: false,
          error: `${extra.resourceType ?? 'ninjas'} 当前只有 ${extra.available} 个可用资源，该规则至少需要 ${extra.required} 个。请先补充资源池。`,
        }
      }
      return { ok: false, error: userFacingRoomError(err) }
    }
  },

  joinRoom: async ({ code, seat, displayName }) => {
    if (!get().configOk) return { ok: false, error: '在线模式尚未配置' }
    try {
      const authOk = await get().ensureAuth()
      if (!authOk) return { ok: false, error: '进入在线模式失败' }
      const identity = await roomApi.joinRoom({ code, seat, displayName })
      const entered = await get().enterRoom(identity.roomId, identity.code)
      return entered.ok ? { ok: true, seat: identity.seat } : { ok: false, error: entered.error }
    } catch (err) {
      return { ok: false, error: userFacingRoomError(err) }
    }
  },

  /** 进入房间：拉快照 + 订阅 Realtime / Presence（刷新恢复的入口） */
  enterRoom: async (roomId, code) => {
    if (!supabase) return { ok: false, error: '在线模式尚未配置' }
    leaving = false
    const generation = ++roomGeneration
    refreshQueued = false
    snapshotFailures = 0
    stopPoll()
    if (resubscribeTimer) {
      window.clearTimeout(resubscribeTimer)
      resubscribeTimer = null
    }
    // Invalidate the old channel before removing it: removal emits CLOSED.
    // Its callbacks must never disconnect or restart the replacement session.
    const previousChannel = currentChannel
    currentChannel = null
    set({ connection: 'connecting', realtimeConnected: false, pendingCommand: null, privateLoadout: null, roomId, roomCode: code, lastError: null })
    try {
      if (previousChannel) await supabase.removeChannel(previousChannel)
      if (leaving || generation !== roomGeneration) return { ok: false, error: '已离开房间' }
      const snap = await roomApi.fetchSnapshot(roomId)
      if (leaving || generation !== roomGeneration || get().roomId !== roomId) return { ok: false, error: '已离开房间' }
      if (!snap.room) {
        set({ connection: 'offline', lastError: { code: 'ROOM_NOT_FOUND', message: '房间不存在或已过期' } })
        return { ok: false, error: '房间不存在或你没有加入该房间' }
      }
      const userId = get().userId
      const parsed = parseRoomNinjaSnapshot(snap.room.pool)
      set({
        roomStatus: snap.room.status,
        roomExpiresAt: new Date(snap.room.expires_at).getTime(),
        match: snap.room.match_state,
        privateLoadout: snap.privateLoadout ?? null,
        revision: snap.room.revision,
        members: snap.members,
        mySeat: deriveMySeat(snap.members, userId),
        isHost: snap.room.host_user_id === userId,
        pendingUndo: snap.room.pending_action ?? null,
        onlineNinjaIds: Array.isArray(snap.room.pool) ? snap.room.pool.map((n) => (n as { id?: unknown }).id as string) : null,
        roomNinjas: parsed.valid && parsed.ninjas.length > 0 ? parsed.ninjas : null,
        roomPackMetadata: (snap.room.data_pack_metadata as MatchPackMetadata | null) ?? null,
        roomResources: snap.room.resource_snapshot ?? null,
        connection: navigator.onLine === false ? 'offline' : 'connected',
      })
      startPoll(get)

      // 订阅：postgres_changes 通知 → 重新拉取权威快照；presence 只做在线展示
      const channel = supabase.channel(`room:${roomId}`, { config: { presence: { key: userId ?? 'anon' } } })
      currentChannel = channel
      const isCurrent = () => !leaving && generation === roomGeneration && currentChannel === channel && get().roomId === roomId

      channel
        .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms', filter: `id=eq.${roomId}` }, () => {
          if (isCurrent()) void get().refreshSnapshot()
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'room_members', filter: `room_id=eq.${roomId}` }, () => {
          if (isCurrent()) void get().refreshSnapshot()
        })
        .on('presence', { event: 'sync' }, () => {
          if (!isCurrent()) return
          const state = channel.presenceState() as unknown as Record<string, PresenceEntry[]>
          const map: Record<string, PresenceEntry> = {}
          for (const [key, entries] of Object.entries(state)) {
            const latest = entries[entries.length - 1]
            if (latest) map[key] = latest
          }
          set({ presence: map })
        })
        .on('presence', { event: 'join' }, () => { if (isCurrent()) void get().refreshSnapshot() })
        .on('presence', { event: 'leave' }, () => { if (isCurrent()) void get().refreshSnapshot() })
        .subscribe(async (status: string) => {
          if (!isCurrent()) return
          if (status === 'SUBSCRIBED') {
            resubscribeAttempts = 0
            if (resubscribeTimer) window.clearTimeout(resubscribeTimer)
            resubscribeTimer = null
            set({ realtimeConnected: true })
            startPoll(get)
            await get().refreshSnapshot()
            if (!isCurrent()) return
            const me = get().members.find((m) => m.user_id === get().userId)
            if (me) {
              await channel.track({
                seat: me.seat,
                displayName: me.display_name,
                onlineAt: Date.now(),
              } satisfies PresenceEntry).catch(() => undefined)
            }
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            set({ realtimeConnected: false })
            startPoll(get)
            void get().refreshSnapshot()
            // The SDK already retries errors and timeouts. Only an unexpected
            // CLOSED channel needs replacement; never race its own retry loop.
            if (status === 'CLOSED' && !resubscribeTimer && resubscribeAttempts < 5) {
              resubscribeAttempts += 1
              const delay = Math.min(30_000, 3_000 * 2 ** (resubscribeAttempts - 1))
              resubscribeTimer = window.setTimeout(() => {
                resubscribeTimer = null
                const st = get()
                if (isCurrent() && st.roomId && st.roomCode && navigator.onLine !== false) {
                  void st.enterRoom(st.roomId, st.roomCode)
                }
              }, delay)
            }
          }
        })

      return { ok: true }
    } catch (err) {
      if (leaving || generation !== roomGeneration) return { ok: false, error: '已离开房间' }
      const message = userFacingRoomError(err)
      set({ connection: 'offline', lastError: { code: 'SNAPSHOT_FAILED', message } })
      return { ok: false, error: message }
    }
  },

  /** 信任数据库权威快照（Realtime 只触发这次刷新） */
  refreshSnapshot: async () => {
    const roomId = get().roomId
    if (!roomId || !supabase || leaving || navigator.onLine === false) return
    const generation = roomGeneration
    if (snapshotFlight?.generation === generation) {
      refreshQueued = true
      return snapshotFlight.promise
    }
    const flight = { generation, promise: Promise.resolve() }
    snapshotFlight = flight
    refreshQueued = false
    flight.promise = (async () => {
      try {
        const snap = await roomApi.fetchSnapshot(roomId, false)
        if (leaving || generation !== roomGeneration || get().roomId !== roomId) return
        if (!snap.room) return
        snapshotFailures = 0
        const current = get()
        if (snap.room.revision < current.revision) return
        set({
          roomStatus: snap.room.status,
          roomExpiresAt: new Date(snap.room.expires_at).getTime(),
          match: snap.room.revision === current.revision ? current.match : snap.room.match_state,
          privateLoadout: snap.privateLoadout ?? null,
          revision: snap.room.revision,
          members: snap.members,
          mySeat: deriveMySeat(snap.members, current.userId),
          isHost: snap.room.host_user_id === current.userId,
          pendingUndo: snap.room.pending_action ?? null,
          // Resource snapshots are immutable for the lifetime of a room. Keep
          // their references instead of rebuilding all 455 cards on every poll.
          connection: navigator.onLine === false ? 'offline' : 'connected',
          lastError: current.lastError?.code === 'SNAPSHOT_FAILED' ? null : current.lastError,
        })
      } catch {
        if (leaving || generation !== roomGeneration || get().roomId !== roomId) return
        snapshotFailures += 1
        // One failed poll is not proof that the whole room is offline.
        if (navigator.onLine === false) set({ connection: 'offline' })
        else if (snapshotFailures >= 2) set({ connection: 'reconnecting', lastError: { code: 'SNAPSHOT_FAILED', message: '房间同步暂时失败，正在重试' } })
      }
    })().finally(() => {
      if (snapshotFlight !== flight) return
      snapshotFlight = null
      // Coalesce bursts into one trailing refresh without making callers wait
      // forever when notifications keep arriving on a slow connection.
      if (refreshQueued && !leaving && generation === roomGeneration) void get().refreshSnapshot()
    })
    return flight.promise
  },

  /** 发送语义命令：服务端验证 → 应用 → 返回权威状态 */
  sendCommand: async (type, payload) => {
    const { roomId, revision, pendingCommand, match, connection } = get()
    if (!supabase || !roomId || !match) return { ok: false, reason: '未连接房间' }
    if (pendingCommand) return { ok: false, reason: '正在确认上一步操作……' }
    if (connection !== 'connected') return { ok: false, reason: '正在同步房间，请稍候' }

    const commandId = crypto.randomUUID()
    const generation = roomGeneration
    set({ pendingCommand: type })
    try {
      const res = await roomApi.sendCommand({ roomId, commandId, expectedRevision: revision, type, payload })
      if (leaving || generation !== roomGeneration || get().roomId !== roomId) return { ok: false, reason: '已离开房间' }
      if (res.status === 'APPLIED' && res.match) {
        if ((res.revision ?? -1) >= get().revision) {
          set({
            match: res.match,
            privateLoadout: 'privateLoadout' in res ? res.privateLoadout ?? null : get().privateLoadout?.phase_key === getSealedDraft(res.match)?.key ? get().privateLoadout : null,
            revision: res.revision ?? get().revision + 1,
            roomStatus: res.roomStatus ?? get().roomStatus,
            pendingUndo: res.pendingUndo ?? null,
            pendingCommand: null,
            connection: navigator.onLine === false ? 'offline' : 'connected',
          })
        } else set({ pendingCommand: null, connection: navigator.onLine === false ? 'offline' : 'connected' })
        return { ok: true }
      }
      if (res.code === 'REVISION_CONFLICT') {
        set({ pendingCommand: null, connection: 'syncing', lastError: { code: res.code, message: '比赛状态已更新，正在同步' } })
        await get().refreshSnapshot()
        return { ok: false, reason: '比赛状态已更新' }
      }
      const message = res.message ?? '操作被拒绝'
      set({ pendingCommand: null, connection: navigator.onLine === false ? 'offline' : 'connected', lastError: { code: res.code ?? 'REJECTED', message } })
      return { ok: false, reason: message }
    } catch (err) {
      if (leaving || generation !== roomGeneration || get().roomId !== roomId) return { ok: false, reason: '已离开房间' }
      const code = (err as { code?: string }).code
      const message = userFacingRoomError(err)
      const networkFailure = code === 'NETWORK' || !code
      set({ pendingCommand: null, connection: navigator.onLine === false ? 'offline' : code === 'REVISION_CONFLICT' ? 'syncing' : networkFailure ? 'reconnecting' : 'connected' })
      if (code === 'REVISION_CONFLICT') {
        set({ lastError: { code, message: '比赛状态已更新，正在同步' } })
        await get().refreshSnapshot()
        return { ok: false, reason: '比赛状态已更新' }
      }
      set({ lastError: { code: code ?? 'NETWORK', message } })
      void get().refreshSnapshot()
      return { ok: false, reason: message }
    }
  },

  /** 离开页面：保留席位方便重连（数据库成员记录保留） */
  resync: async () => {
    await get().refreshSnapshot()
  },

  isMyTurnNow: () => {
    const state = get()
    if (!state.match || state.roomStatus !== 'ACTIVE' || state.match.status !== 'IN_PROGRESS') return false
    if (state.mySeat !== 'BLUE' && state.mySeat !== 'RED') return false
    const sealed = getSealedDraft(state.match)
    if (sealed) return state.privateLoadout?.phase_key !== sealed.key
    return getPhase(state.match).side === state.mySeat && !getPhase(state.match).sequenceComplete
  },

  leaveRoom: () => {
    leaving = true
    roomGeneration += 1
    refreshQueued = false
    stopPoll()
    if (resubscribeTimer) {
      window.clearTimeout(resubscribeTimer)
      resubscribeTimer = null
    }
    const previousChannel = currentChannel
    currentChannel = null
    if (supabase && previousChannel) void supabase.removeChannel(previousChannel)
    set({
      roomId: null,
      roomCode: null,
      roomStatus: null,
      roomExpiresAt: null,
      match: null,
      privateLoadout: null,
  revision: -1,
      members: [],
      mySeat: null,
      isHost: false,
      pendingUndo: null,
      connection: 'idle',
      realtimeConnected: false,
      pendingCommand: null,
      presence: {},
      onlineNinjaIds: null,
      roomNinjas: null,
      roomPackMetadata: null,
      roomResources: null,
    })
  },

  clearError: () => set({ lastError: null }),
  markOffline: () => set({ connection: 'offline' }),
}))

// E2E 调试用：DEV 构建下暴露 store（生产构建不含）
if (import.meta.env.DEV && typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__nja = useOnlineRoomStore
}
