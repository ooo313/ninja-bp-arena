import type { DraftResourceType, MatchState, Side } from './types.ts'
import {
  canSelectResource,
  enterGame,
  nextGame,
  restartMatch,
  selectResource,
  setGameWinner,
  startMatch,
  undoLastAction,
  rebuildTimer,
  timerPhaseChanged,
  getPhase,
  computeTimerPhaseKey,
} from './bpEngine.ts'
import type { Ninja } from './types.ts'
import type { BattleResources } from './resourceRegistry.ts'
import { getResource } from './resourceRegistry.ts'

/**
 * 在线房间命令处理器（Shared BP Core 的纯函数部分）。
 *
 * 客户端永远不是权威状态源：客户端只发送“我想做什么”，
 * 由 Edge Function 调用本模块在服务端验证并执行，数据库保存结果。
 * 本模块不接触网络 / 数据库，因此可以完全离线地做单元测试。
 *
 * 关键规则：
 * - Side 一律由 getPhase(match) 推导，绝不信任客户端传来的 side
 * - 所有 applied 命令 revision + 1（由调用方做 CAS 更新）
 * - commandId 幂等由调用方（room_commands 表）保证
 */

export type OnlineCommandType =
  | 'START_MATCH'
  | 'SELECT_NINJA'
  | 'SELECT_RESOURCE'
  | 'SUBMIT_LOADOUT'
  | 'ENTER_GAME'
  | 'SET_GAME_WINNER'
  | 'NEXT_GAME'
  | 'REQUEST_UNDO'
  | 'CONFIRM_UNDO'
  | 'REJECT_UNDO'
  | 'RESTART_TIMER'
  | 'RESET_MATCH'
  | 'CLOSE_ROOM'

export type Seat = 'BLUE' | 'RED' | 'OBSERVER'

export type RoomStatus = 'WAITING' | 'ACTIVE' | 'FINISHED' | 'CLOSED'

/**
 * 挂起的撤销请求（存 rooms.pending_action）。
 *
 * 语义（v0.3.1 修正）：REQUEST_UNDO 本身会使 room revision +1，
 * pendingAtRevision 记录的是“请求被应用之后”的 revision。
 * - 当前 room revision === pendingAtRevision：请求有效，对方可确认
 * - 期间发生任何其他比赛命令（revision 前进）：请求自动失效
 */
export interface PendingUndo {
  type: 'UNDO'
  requestedBy: Seat
  requestedByUserId: string
  createdAt: number
  pendingAtRevision: number
}

/** 就座成员（服务端从 room_members 读取；display_name 用于 START_MATCH 填名） */
export interface SeatMember {
  userId: string
  displayName: string
}

export interface RoomCommandContext {
  /** 数据库中的权威状态 */
  match: MatchState
  revision: number
  roomStatus: RoomStatus
  /** ISO 或毫秒时间戳均可，处理前统一为 ms */
  expiresAt: number
  /** 当前用户席位（由 room_members 推导，不来自请求体） */
  mySeat: Seat | null
  isHost: boolean
  myUserId: string
  hostUserId: string
  /** 就座成员（服务端读取；START_MATCH 需要双方且名称由服务端填充） */
  seatMembers: { BLUE: SeatMember | null; RED: SeatMember | null }
  pendingUndo: PendingUndo | null
  /** 忍者池（SELECT_NINJA 校验忍者存在与 enabled） */
  ninjas: Array<Pick<Ninja, 'id' | 'enabled'>>
  resources?: BattleResources
  now: number
}

export interface RoomCommand {
  commandId: string
  roomId: string
  expectedRevision: number
  type: OnlineCommandType
  payload?: { ninjaId?: string; resourceId?: string; resourceType?: DraftResourceType; side?: Side; gameNumber?: number }
}

export type CommandOutcome =
  | {
      status: 'APPLIED'
      /** 新的权威状态（未变化时与输入相同） */
      match: MatchState
      /** 新 revision（APPLIED 一律 +1） */
      revision: number
      roomStatus: RoomStatus
      pendingUndo: PendingUndo | null
    }
  | { status: 'REJECTED'; code: RejectCode; message: string }

export type RejectCode =
  | 'NOT_AUTHENTICATED'
  | 'NOT_MEMBER'
  | 'NOT_HOST'
  | 'NOT_YOUR_TURN'
  | 'NOT_PERMITTED'
  | 'ROOM_EXPIRED'
  | 'ROOM_CLOSED'
  | 'ROOM_NOT_WAITING'
  | 'ROOM_NOT_ACTIVE'
  | 'SEAT_NOT_READY'
  | 'REVISION_CONFLICT'
  | 'INVALID_COMMAND'
  | 'NINJA_BLOCKED'
  | 'RESOURCE_BLOCKED'
  | 'MATCH_FINISHED'
  | 'NOTHING_TO_UNDO'
  | 'NO_PENDING_UNDO'
  | 'UNDO_EXPIRED'
  | 'UNDO_NOT_REQUESTER'
  | 'ENGINE_REJECTED'
  | 'ROOM_NOT_FOUND'

function reject(code: RejectCode, message: string): CommandOutcome {
  return { status: 'REJECTED', code, message }
}

function isSeatPlayer(seat: Seat | null): seat is 'BLUE' | 'RED' {
  return seat === 'BLUE' || seat === 'RED'
}

/** 命令是否需要执行引擎（决定是否重建计时器） */
function applyOneCommand(ctx: RoomCommandContext, cmd: RoomCommand): { match: MatchState; extra?: string } | CommandOutcome {
  const { match } = ctx

  switch (cmd.type) {
    case 'START_MATCH': {
      if (!ctx.isHost) return reject('NOT_HOST', '只有房主可以开始比赛')
      if (ctx.roomStatus !== 'WAITING') return reject('ROOM_NOT_WAITING', '房间已经开始或已结束')
      if (!ctx.seatMembers.BLUE || !ctx.seatMembers.RED) return reject('SEAT_NOT_READY', '需要蓝红双方都就座后才能开始')
      if (match.status !== 'SETUP') return reject('ROOM_NOT_WAITING', '比赛状态异常')
      // 玩家名称由服务端从 room_members.display_name 填充，不信任客户端
      const next = startMatch({
        ...match,
        bluePlayerName: ctx.seatMembers.BLUE.displayName || match.bluePlayerName,
        redPlayerName: ctx.seatMembers.RED.displayName || match.redPlayerName,
      }, { now: ctx.now })
      return { match: next, extra: 'ACTIVE' }
    }

    case 'SELECT_NINJA':
    case 'SELECT_RESOURCE': {
      if (ctx.roomStatus !== 'ACTIVE') return reject('ROOM_NOT_ACTIVE', '比赛未在进行中')
      if (!isSeatPlayer(ctx.mySeat)) return reject('NOT_PERMITTED', '观战者不能操作 BP')
      if (match.status === 'MATCH_FINISHED') return reject('MATCH_FINISHED', '比赛已经结束')

      // Side 由引擎阶段推导，不信任客户端
      const phase = getPhase(match)
      if (match.rule.resourceDrafts?.some((draft) => draft.resourceType === phase.resourceType && draft.selectionMode === 'SIMULTANEOUS')) return reject('INVALID_COMMAND', '请一次提交完整阵容，双方确认后统一公开')
      if (!phase.side || phase.sequenceComplete) return reject('NOT_YOUR_TURN', '当前不是选择阶段')
      if (phase.side !== ctx.mySeat) return reject('NOT_YOUR_TURN', '还没有轮到你操作')
      if (cmd.payload?.side !== undefined && cmd.payload.side !== ctx.mySeat) return reject('INVALID_COMMAND', '阵营与当前行动方不一致')
      if (cmd.payload?.gameNumber !== undefined && cmd.payload.gameNumber !== match.currentGame) return reject('INVALID_COMMAND', '小局编号与当前状态不一致')
      const resourceType = cmd.type === 'SELECT_NINJA' ? 'NINJA' : cmd.payload?.resourceType
      if (!resourceType || resourceType !== phase.resourceType) return reject('INVALID_COMMAND', '资源类型与当前阶段不一致')
      const resourceId = cmd.type === 'SELECT_NINJA' ? cmd.payload?.ninjaId : cmd.payload?.resourceId
      if (typeof resourceId !== 'string' || !resourceId) return reject('INVALID_COMMAND', '缺少资源 ID')
      const resource = ctx.resources
        ? getResource(ctx.resources, resourceType, resourceId)
        : resourceType === 'NINJA' ? ctx.ninjas.find((item) => item.id === resourceId) : undefined
      const check = canSelectResource(match, resourceType, resourceId, resource)
      if (!check.allowed) return reject(resourceType === 'NINJA' ? 'NINJA_BLOCKED' : 'RESOURCE_BLOCKED', check.reason ?? '无法选择该资源')

      const result = selectResource(match, resourceType, resourceId, resource, { now: ctx.now, actionId: cmd.commandId })
      if (!result.ok || !result.state) return reject('ENGINE_REJECTED', result.reason ?? '无法选择该资源')
      return { match: result.state }
    }

    case 'ENTER_GAME': {
      if (ctx.roomStatus !== 'ACTIVE') return reject('ROOM_NOT_ACTIVE', '比赛未在进行中')
      if (!isSeatPlayer(ctx.mySeat) && !ctx.isHost) return reject('NOT_PERMITTED', '观战者不能操作')
      const result = enterGame(match, { now: ctx.now })
      if (!result.ok) {
        // 双方同时点击“进入比赛”时，第二次视为幂等成功
        if (result.reason === '本局已进入比赛') return { match }
        return reject('ENGINE_REJECTED', result.reason ?? '无法进入比赛')
      }
      return { match: result.state! }
    }

    case 'SET_GAME_WINNER': {
      if (!ctx.isHost) return reject('NOT_HOST', '只有房主可以记录胜负')
      if (ctx.roomStatus !== 'ACTIVE') return reject('ROOM_NOT_ACTIVE', '比赛未在进行中')
      const side = cmd.payload?.side
      if (side !== 'BLUE' && side !== 'RED') return reject('INVALID_COMMAND', '缺少胜者阵营')
      const result = setGameWinner(match, side, { now: ctx.now })
      if (!result.ok || !result.state) return reject('ENGINE_REJECTED', result.reason ?? '无法记录胜负')
      return { match: result.state, extra: result.state.status === 'MATCH_FINISHED' ? 'FINISHED' : undefined }
    }

    case 'NEXT_GAME': {
      if (!ctx.isHost) return reject('NOT_HOST', '只有房主可以进入下一局')
      if (ctx.roomStatus !== 'ACTIVE') return reject('ROOM_NOT_ACTIVE', '比赛未在进行中')
      const result = nextGame(match, { now: ctx.now })
      if (!result.ok || !result.state) return reject('ENGINE_REJECTED', result.reason ?? '无法进入下一局')
      return { match: result.state }
    }

    case 'RESET_MATCH': {
      if (!ctx.isHost) return reject('NOT_HOST', '只有房主可以重置比赛')
      if (ctx.roomStatus !== 'ACTIVE' && ctx.roomStatus !== 'FINISHED') {
        return reject('ROOM_NOT_ACTIVE', '当前状态不能重置')
      }
      // 整场重开：比分 0:0、无 Ban/Pick/USED/历史、计时器清空，回到 WAITING 由房主再次开始
      return { match: restartMatch(match, { now: ctx.now }), extra: 'WAITING' }
    }

    case 'REQUEST_UNDO': {
      if (ctx.roomStatus !== 'ACTIVE') return reject('ROOM_NOT_ACTIVE', '比赛未在进行中')
      if (!isSeatPlayer(ctx.mySeat)) return reject('NOT_PERMITTED', '观战者不能请求撤销')
      if (match.status === 'MATCH_FINISHED') return reject('MATCH_FINISHED', '比赛已经结束')
      if (match.history.length === 0) return reject('NOTHING_TO_UNDO', '没有可撤销的操作')
      if (ctx.pendingUndo && ctx.pendingUndo.pendingAtRevision === ctx.revision && ctx.now - ctx.pendingUndo.createdAt < 30_000) return reject('NOT_PERMITTED', '已有待处理的撤销请求')
      return { match }
    }

    case 'CONFIRM_UNDO': {
      if (ctx.roomStatus !== 'ACTIVE') return reject('ROOM_NOT_ACTIVE', '比赛未在进行中')
      const pending = ctx.pendingUndo
      if (!pending) return reject('NO_PENDING_UNDO', '当前没有撤销请求')
      // 双人确认原则：请求者（按真实身份 userId）绝对不能自己确认，房主身份也不能绕过
      if (pending.requestedByUserId === ctx.myUserId) {
        return reject('UNDO_NOT_REQUESTER', '撤销请求需要对方确认')
      }
      // 只有另一方席位玩家或（非请求者的）房主可以确认
      const isOtherPlayer = isSeatPlayer(ctx.mySeat) && ctx.mySeat !== pending.requestedBy
      if (!isOtherPlayer && !ctx.isHost) return reject('NOT_PERMITTED', '只有对局玩家可以处理撤销请求')
      // 请求应用后发生过任何其他比赛命令（revision 前进）→ 自动失效
      if (pending.pendingAtRevision !== ctx.revision) return reject('UNDO_EXPIRED', '撤销请求已过期')
      if (ctx.now - pending.createdAt >= 30_000) return reject('UNDO_EXPIRED', '撤销请求已过期')
      const result = undoLastAction(ctx.match, { now: ctx.now })
      if (!result.ok || !result.state) return reject('NOTHING_TO_UNDO', result.reason ?? '没有可撤销的操作')
      return { match: result.state }
    }

    case 'REJECT_UNDO': {
      const pending = ctx.pendingUndo
      if (!pending) return reject('NO_PENDING_UNDO', '当前没有撤销请求')
      if (pending.pendingAtRevision !== ctx.revision || ctx.now - pending.createdAt >= 30_000) return reject('UNDO_EXPIRED', '撤销请求已过期')
      const involved = isSeatPlayer(ctx.mySeat) || ctx.isHost
      if (!involved) return reject('NOT_PERMITTED', '观战者不能处理撤销请求')
      return { match: ctx.match }
    }

    case 'RESTART_TIMER': {
      if (ctx.roomStatus !== 'ACTIVE') return reject('ROOM_NOT_ACTIVE', '比赛未在进行中')
      const phase = getPhase(match)
      const isActingSide = isSeatPlayer(ctx.mySeat) && phase.side === ctx.mySeat && !phase.sequenceComplete
      if (!isActingSide && !ctx.isHost) return reject('NOT_PERMITTED', '只有当前行动方或房主可以重新计时')
      if (!match.rule.timerEnabled) return reject('INVALID_COMMAND', '本房间未启用倒计时')
      return { match }
    }

    case 'CLOSE_ROOM': {
      // Host 关闭房间：任何状态都可以关闭（需二次确认在客户端完成）
      if (!ctx.isHost) return reject('NOT_HOST', '只有房主可以关闭房间')
      return { match, extra: 'CLOSED' }
    }

    default:
      return reject('INVALID_COMMAND', '未知命令')
  }
}

/**
 * 执行一条房间命令。
 * 返回 APPLIED 时，调用方必须以 CAS（WHERE revision = ctx.revision）方式
 * 将新状态写回数据库并把 revision + 1。
 */
export function applyRoomCommand(ctx: RoomCommandContext, cmd: RoomCommand): CommandOutcome {
  // 基础校验：时间
  const expiresAtMs = ctx.expiresAt > 1e12 ? ctx.expiresAt : ctx.expiresAt * 1000
  if (ctx.now >= expiresAtMs) return reject('ROOM_EXPIRED', '房间已过期')
  if (ctx.roomStatus === 'CLOSED') return reject('ROOM_CLOSED', '房间已关闭')
  if (!ctx.mySeat && !ctx.isHost) return reject('NOT_MEMBER', '你还没有加入这个房间')
  if (!Number.isInteger(cmd.expectedRevision) || cmd.expectedRevision < 0) {
    return reject('INVALID_COMMAND', 'revision 非法')
  }
  // CAS：客户端状态过期
  if (cmd.expectedRevision !== ctx.revision) return reject('REVISION_CONFLICT', '比赛状态已更新，请重新同步')

  const result = applyOneCommand(ctx, cmd)
  if ('status' in result) return result

  let nextMatch = result.match
  let nextStatus: RoomStatus = ctx.roomStatus
  if (result.extra === 'ACTIVE') nextStatus = 'ACTIVE'
  if (result.extra === 'FINISHED') nextStatus = 'FINISHED'
  if (result.extra === 'WAITING') nextStatus = 'WAITING'
  if (result.extra === 'CLOSED') nextStatus = 'CLOSED'

  // 计时器：只有服务器有权生成 deadline。
  // 阶段变化（新步骤/换局/开始）→ 以服务器时间重建；RESTART_TIMER → 立即重建。
  if (nextMatch.rule.timerEnabled && nextMatch.status === 'IN_PROGRESS') {
    const shouldRebuild =
      cmd.type === 'RESTART_TIMER' ||
      (nextMatch.status === 'IN_PROGRESS' &&
        (ctx.match.status !== 'IN_PROGRESS' || timerPhaseChanged(ctx.match, nextMatch)))
    if (shouldRebuild && computeTimerPhaseKey(nextMatch)) {
      nextMatch = rebuildTimer(nextMatch, ctx.now)
    }
  }
  if (nextMatch.status === 'MATCH_FINISHED' && nextMatch.timer) {
    nextMatch = { ...nextMatch, timer: { phaseKey: computeTimerPhaseKey(nextMatch), deadlineAt: null, timedOut: false } }
  }

  // 撤销请求的生命周期：
  // - REQUEST_UNDO：创建请求；pendingAtRevision 记录“应用后”的 revision（= 当前 + 1）
  // - CONFIRM/REJECT：清除
  // - 任何其他比赛命令都会推进 revision → 挂起请求自动失效
  const pendingUndo: PendingUndo | null =
    cmd.type === 'REQUEST_UNDO'
      ? {
          type: 'UNDO',
          requestedBy: ctx.mySeat as 'BLUE' | 'RED',
          requestedByUserId: ctx.myUserId,
          createdAt: ctx.now,
          pendingAtRevision: ctx.revision + 1,
        }
      : null  // CONFIRM/REJECT 清除；任何其他比赛命令使挂起请求失效

  // 撤销请求类命令不改变 match_state 内容（仍 +1 revision 以广播）
  return {
    status: 'APPLIED',
    match: nextMatch,
    revision: ctx.revision + 1,
    roomStatus: nextStatus,
    pendingUndo,
  }
}
