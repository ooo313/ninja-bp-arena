import { createContext, useContext, type ReactNode } from 'react'
import type { DraftResource, DraftResourceType, MatchState, Ninja, OnlineCommandType, PendingUndo, Side, PrivateLoadout } from '@bp-core'
import type { ConnectionState, Seat } from '@/online/types'

/**
 * MatchSource：本地模式与在线模式的统一接口。
 *
 * BP UI 组件只依赖这里，永远不感知 Supabase / revision / Edge Function。
 * 本地模式由 LocalMatchSource（bpStore + timerStore）实现；
 * 在线模式由 OnlineMatchSource（onlineRoomStore，服务端权威）实现。
 * 在线操作是异步的（等服务端确认），因此所有操作允许返回 Promise。
 */

export type OpResult = { ok: boolean; reason?: string }
export type OpResultOrPromise = OpResult | Promise<OpResult>

export interface MatchSource {
  mode: 'local' | 'online'
  match: MatchState | null

  selectNinja: (ninjaId: string) => OpResultOrPromise
  selectResource: (resourceType: DraftResourceType, resourceId: string) => OpResultOrPromise
  submitLoadout?: (side: Side, resourceType: DraftResourceType, resourceIds: string[]) => OpResultOrPromise
  privateLoadouts?: Partial<Record<Side, PrivateLoadout>>
  /** 本地：直接撤销；在线：发送撤销请求（需对方确认） */
  undo: () => OpResultOrPromise
  redo: () => OpResultOrPromise
  canUndo: boolean
  canRedo: boolean
  enterGame: () => OpResultOrPromise
  setGameWinner: (side: Side) => OpResultOrPromise
  nextGame: () => OpResultOrPromise
  resetMatch: () => void
  restartTimer: () => void

  // ---- 在线专属（本地模式为缺省值） ----
  mySeat?: Seat | null
  isHost?: boolean
  /** 当前是否轮到本客户端操作 */
  isMyTurn: boolean
  /** 综合判断此刻能否发起操作（回合 + 连接 + 无待确认命令） */
  canOperate: boolean
  /** 有命令正在等待服务端确认（在线模式禁止重复点击） */
  pendingCommand?: OnlineCommandType | null
  /** 在线模式的服务端权威 deadline（本地为 null，使用 timerStore） */
  onlineDeadline?: number | null
  connection?: ConnectionState
  pendingUndo?: PendingUndo | null
  myUserId?: string | null
  /** 房间忍者池快照（在线模式下过滤本机忍者池用） */
  onlineNinjaIds?: string[] | null
  /** 在线模式：怀疑本地状态滞后时强制重拉权威快照 */
  resync?: () => Promise<void>
  /**
   * v0.4：当前比赛的显示用忍者列表（显示权威）。
   * 本地 = 比赛创建时固化的 ninjaSnapshot（旧比赛回退本地池）；
   * 在线 = 房间 Ninja Snapshot（服务端校验依据，双方一致）。
   * 为空表示调用方应回退本地池。
   */
  matchNinjas?: Ninja[]
  matchResources?: Partial<Record<DraftResourceType, DraftResource[]>>
}

const MatchSourceContext = createContext<MatchSource | null>(null)

export function MatchSourceProvider({ value, children }: { value: MatchSource; children: ReactNode }) {
  return <MatchSourceContext.Provider value={value}>{children}</MatchSourceContext.Provider>
}

export function useMatchSource(): MatchSource {
  const ctx = useContext(MatchSourceContext)
  if (!ctx) throw new Error('useMatchSource 必须在 MatchSourceProvider 内使用')
  return ctx
}
