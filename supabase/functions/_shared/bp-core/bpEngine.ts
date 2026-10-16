import type { BPActionType, BattleRule, DraftResourceBase, DraftResourceType, PlayerGameState, Side } from './types.ts'
import type { EngineResult, GameState, MatchState } from './types.ts'
import type { Ninja } from './types.ts'
import { expandSequence, getResourceDraftRules, normalizeBattleRule, type ExpandedAction } from './ruleEngine.ts'
import { RESOURCE_TYPE_LABEL } from './resourceRegistry.ts'
import { rotateSide } from './sideRotation.ts'

/**
 * BP 引擎：整个项目的核心状态机（Shared BP Core）。
 *
 * 原则：
 * - 纯函数：输入 MatchState，输出新的 MatchState；不依赖 DOM / React /
 *   localStorage / Zustand，浏览器与 Edge Function（Deno）共用同一实现。
 * - 所有可用性判断集中在 canSelectNinja，UI 只消费结果。
 * - 当前阶段（Game / 阶段 / 行动方 / 动作 / 进度）由 BP 进度实时推导，
 *   不保存冗余的 currentStep，避免撤销/恢复时状态错位。
 */

export interface SelectCheck {
  allowed: boolean
  reason?: string
}

const deny = (reason: string): SelectCheck => ({ allowed: false, reason })
const ALLOW: SelectCheck = { allowed: true }

export function cloneMatch<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export interface TransitionContext { now: number; actionId?: string }

function nextTimestamp(m: MatchState, context?: TransitionContext): number {
  return context ? Math.max(context.now, m.updatedAt + 1) : m.updatedAt + 1
}

function createGameState(gameNumber: number): GameState {
  return {
    gameNumber,
    blue: { bans: [], picks: [] },
    red: { bans: [], picks: [] },
    started: false,
  }
}

export function getPlayerResourceState(
  player: PlayerGameState,
  resourceType: DraftResourceType,
): { bans: string[]; picks: string[] } {
  if (resourceType === 'NINJA') return player
  return player.resources?.[resourceType] ?? { bans: [], picks: [] }
}

function ensurePlayerResourceState(
  player: PlayerGameState,
  resourceType: DraftResourceType,
): { bans: string[]; picks: string[] } {
  if (resourceType === 'NINJA') return player
  player.resources ??= {}
  player.resources[resourceType] ??= { bans: [], picks: [] }
  return player.resources[resourceType] as { bans: string[]; picks: string[] }
}

/** 只统计当前局实际包含在序列中的动作；持久化继承的 loadout 不推进阶段。 */
function countSequenceActions(game: GameState, expanded: ExpandedAction[]): number {
  const actionKeys = new Set(expanded.map((step) => `${step.resourceType}:${step.action}`))
  let count = 0
  for (const resourceType of ['NINJA', 'SECRET_SCROLL', 'SUMMON'] as const) {
    for (const side of ['BLUE', 'RED'] as const) {
      const state = getPlayerResourceState(side === 'BLUE' ? game.blue : game.red, resourceType)
      if (actionKeys.has(`${resourceType}:BAN`)) count += state.bans.length
      if (actionKeys.has(`${resourceType}:PICK`)) count += state.picks.length
    }
  }
  return count
}

function createFollowingGameState(m: MatchState, gameNumber: number): GameState {
  const game = createGameState(gameNumber)
  const previous = getCurrentGame(m)
  for (const draft of getResourceDraftRules(m.rule)) {
    if (!draft.enabled || draft.resetEachGame) continue
    for (const side of ['BLUE', 'RED'] as const) {
      const from = getPlayerResourceState(side === 'BLUE' ? previous.blue : previous.red, draft.resourceType)
      const to = ensurePlayerResourceState(side === 'BLUE' ? game.blue : game.red, draft.resourceType)
      to.bans = [...from.bans]
      to.picks = [...from.picks]
    }
  }
  return game
}

// ---------------------------------------------------------------------------
// 创建 / 开始
// ---------------------------------------------------------------------------

export function createMatch(rule: BattleRule, bluePlayerName = '', redPlayerName = '', identity?: { id: string; now: number }): MatchState {
  const now = identity?.now ?? 0
  return {
    id: identity?.id ?? `match-${rule.id}`,
    // 规则深拷贝进比赛：之后修改规则模板不影响进行中的比赛
    rule: { ...cloneMatch(rule), resourceDrafts: cloneMatch(normalizeBattleRule(rule).resourceDrafts) },
    bluePlayerName: bluePlayerName.trim() || '蓝方',
    redPlayerName: redPlayerName.trim() || '红方',
    score: { blue: 0, red: 0 },
    currentGame: 1,
    games: [createGameState(1)],
    status: 'SETUP',
    history: [],
    createdAt: now,
    updatedAt: now,
  }
}

/** 从 SETUP 进入正式比赛（重置比分与第一局） */
export function startMatch(m: MatchState, context?: TransitionContext): MatchState {
  return {
    ...cloneMatch(m),
    score: { blue: 0, red: 0 },
    status: 'IN_PROGRESS',
    currentGame: 1,
    games: [createGameState(1)],
    history: [],
    updatedAt: nextTimestamp(m, context),
  }
}

/**
 * 整场重开：保留 rule / 双方名称 / match id，
 * 重置比分、局数、历史、Ban/Pick、USED、计时器等全部比赛运行状态。
 * 在线 RESET_MATCH 必须使用本函数（注意 startMatch 不重置比分）。
 */
export function restartMatch(m: MatchState, context?: TransitionContext): MatchState {
  return {
    ...cloneMatch(m),
    score: { blue: 0, red: 0 },
    currentGame: 1,
    games: [createGameState(1)],
    history: [],
    status: 'SETUP',
    timer: undefined,
    updatedAt: nextTimestamp(m, context),
  }
}

// ---------------------------------------------------------------------------
// 阶段推导（状态机核心）
// ---------------------------------------------------------------------------

export function getCurrentGame(m: MatchState): GameState {
  return m.games[m.games.length - 1]
}

/** 本局适用的完整动作序列（含 Ban 阶段与否由规则决定）。
 *  注意：先把两段步骤数组合并成一条序列再展开，
 *  保证 stepIndex 在整局内全局唯一（否则 Ban/Pick 两段的步骤编号会重叠）。 */
export function getGameSequence(m: MatchState, gameNumber: number): ExpandedAction[] {
  const expanded: ExpandedAction[] = []
  let stepOffset = 0
  for (const draft of normalizeBattleRule(m.rule).resourceDrafts) {
    if (!draft.enabled || (gameNumber > 1 && !draft.resetEachGame)) continue
    const steps = gameNumber > 1 && draft.banOnlyFirstGame
      ? draft.sequence.filter((step) => step.action !== 'BAN')
      : draft.sequence
    expanded.push(...expandSequence(steps.map((step) => ({ ...step, side: rotateSide(m.rule, gameNumber, step.side) })), draft.resourceType, stepOffset))
    stepOffset += steps.length
  }
  return expanded
}

export interface PhaseInfo {
  phaseKey: string
  gameNumber: number
  status: 'BANNING' | 'PICKING' | 'READY' | 'PLAYING' | 'COMPLETED'
  /** 当前步骤的动作；序列完成后为 null */
  action: BPActionType | null
  /** 当前阶段的资源类型；序列完成后为 null */
  resourceType: DraftResourceType | null
  /** 当前行动方；序列完成后为 null */
  side: Side | null
  /** 当前处于第几个序列步骤 */
  stepIndex: number | null
  /** 本步骤已完成数 */
  doneInStep: number
  /** 本步骤需要总数（例如 RED PICK×2 为 2） */
  stepCount: number
  /** 本步骤还差几个（“还需选择 N 名忍者”） */
  remainingInStep: number
  totalDone: number
  totalActions: number
  sequenceComplete: boolean
  expanded: ExpandedAction[]
}

/**
 * 推导当前阶段。已完成的动作数 = bans + picks，
 * 与展开序列逐一对应，因此撤销之后阶段自然回退，永不错乱。
 */
export function getCurrentDraftPhase(m: MatchState): PhaseInfo {
  const game = getCurrentGame(m)
  const expanded = getGameSequence(m, game.gameNumber)
  const totalDone = countSequenceActions(game, expanded)
  const base = {
    gameNumber: game.gameNumber,
    totalDone,
    totalActions: expanded.length,
    expanded,
  }

  if (totalDone >= expanded.length) {
    const status = game.winner ? 'COMPLETED' : game.started ? 'PLAYING' : 'READY'
    return {
      ...base,
      phaseKey: `${m.id}:G${game.gameNumber}:DONE:${status}`,
      status,
      action: null,
      resourceType: null,
      side: null,
      stepIndex: null,
      doneInStep: 0,
      stepCount: 0,
      remainingInStep: 0,
      sequenceComplete: true,
    }
  }

  const current = expanded[totalDone]
  // 同一 stepIndex 的动作在展开序列里必然连续
  const stepStart = expanded.findIndex((e) => e.stepIndex === current.stepIndex)
  const stepCount = expanded.filter((e) => e.stepIndex === current.stepIndex).length
  const doneInStep = totalDone - stepStart
  return {
    ...base,
    phaseKey: `${m.id}:G${game.gameNumber}:${current.resourceType}:${current.action}:${current.side}:S${current.stepIndex}`,
    status: current.action === 'BAN' ? 'BANNING' : 'PICKING',
    action: current.action,
    resourceType: current.resourceType,
    side: current.side,
    stepIndex: current.stepIndex,
    doneInStep,
    stepCount,
    remainingInStep: stepCount - doneInStep,
    sequenceComplete: false,
  }
}

/** Kept as an adapter for existing UI callers. */
export const getPhase = getCurrentDraftPhase

/** 之前小局已经出场的忍者（不含当前局） */
export function getUsedNinjas(m: MatchState): { blue: string[]; red: string[] } {
  const currentNumber = getCurrentGame(m).gameNumber
  const blue: string[] = []
  const red: string[] = []
  for (const g of m.games) {
    if (g.gameNumber === currentNumber) continue
    blue.push(...g.blue.picks)
    red.push(...g.red.picks)
  }
  return { blue, red }
}

// ---------------------------------------------------------------------------
// 可用性校验
// ---------------------------------------------------------------------------

/**
 * 判断某忍者当前能否被选择 / 禁用，失败时给出明确原因。
 * 校验顺序经过设计，保证提示与玩家直觉一致。
 */
export function canSelectNinja(
  m: MatchState,
  ninjaId: string,
  ninja?: Pick<Ninja, 'id' | 'enabled'>,
): SelectCheck {
  return canSelectResource(m, 'NINJA', ninjaId, ninja)
}

/** 所有资源共用的权威可选性校验。 */
export function canSelectResource(
  m: MatchState,
  resourceType: DraftResourceType,
  resourceId: string,
  resource?: Pick<DraftResourceBase, 'id' | 'enabled' | 'deprecated'>,
): SelectCheck {
  if (m.status === 'SETUP') return deny('比赛尚未开始')
  if (m.status === 'MATCH_FINISHED') return deny('比赛已经结束')

  const game = getCurrentGame(m)
  if (game.winner) return deny('本局比赛已结束')

  const phase = getPhase(m)
  if (phase.sequenceComplete) {
    return deny(game.started ? '比赛进行中，无法进行 BP 操作' : '双方阵容已锁定')
  }

  if (phase.resourceType !== resourceType) {
    return deny(`当前阶段应选择${phase.resourceType ? RESOURCE_TYPE_LABEL[phase.resourceType] : '资源'}`)
  }

  const label = RESOURCE_TYPE_LABEL[resourceType]
  if (!resource || resource.id !== resourceId) return deny(`${label}不存在`)
  if (!resource.enabled || resource.deprecated) return deny(`该${label}已被停用`)

  const draft = getResourceDraftRules(m.rule).find((item) => item.resourceType === resourceType)
  if (!draft?.enabled) return deny(`当前规则未启用${label}`)

  for (const g of m.games) {
    const blue = getPlayerResourceState(g.blue, resourceType)
    const red = getPlayerResourceState(g.red, resourceType)
    const banned = blue.bans.includes(resourceId) || red.bans.includes(resourceId)
    if (!banned) continue
    if (g.gameNumber === game.gameNumber || draft.banPersistence) {
      return deny(`该${label}已被禁用`)
    }
  }

  const blueCurrent = getPlayerResourceState(game.blue, resourceType)
  const redCurrent = getPlayerResourceState(game.red, resourceType)
  const mineState = phase.side === 'BLUE' ? blueCurrent : redCurrent
  const otherState = phase.side === 'BLUE' ? redCurrent : blueCurrent
  if (mineState.picks.includes(resourceId)) return deny(`己方已选择该${label}`)
  if (draft.uniqueAcrossSides && otherState.picks.includes(resourceId)) return deny(`对方已选择该${label}`)

  if (phase.action === 'BAN' && (blueCurrent.bans.includes(resourceId) || redCurrent.bans.includes(resourceId))) {
    return deny(`该${label}已被禁用`)
  }

  if (draft.crossGameLock) {
    for (const g of m.games) {
      if (g.gameNumber === game.gameNumber) continue
      const blue = getPlayerResourceState(g.blue, resourceType)
      const red = getPlayerResourceState(g.red, resourceType)
      if (blue.picks.includes(resourceId) || red.picks.includes(resourceId)) {
        return deny(resourceType === 'NINJA' ? '该忍者已在之前小局出战' : `该${label}已在之前小局使用`)
      }
    }
  }

  return ALLOW
}

/** 忍者卡片展示状态（视觉层） */
export type NinjaCardStatus = 'AVAILABLE' | 'BANNED' | 'BLUE_PICKED' | 'RED_PICKED' | 'USED' | 'DISABLED' | 'LOCKED'

export interface NinjaStatusInfo {
  status: NinjaCardStatus
  reason: string
}

export function getResourceCardStatus(m: MatchState, resourceType: DraftResourceType, resource: Pick<DraftResourceBase, 'id' | 'enabled' | 'deprecated'>): NinjaStatusInfo {
  if (!resource.enabled || resource.deprecated) return { status: 'DISABLED', reason: '该资源已被停用' }
  const game = getCurrentGame(m)
  const currentNumber = game.gameNumber
  const draft = getResourceDraftRules(m.rule).find((item) => item.resourceType === resourceType)

  for (const g of m.games) {
    const banned = getPlayerResourceState(g.blue, resourceType).bans.includes(resource.id) || getPlayerResourceState(g.red, resourceType).bans.includes(resource.id)
    if (banned && (g.gameNumber === currentNumber || draft?.banPersistence)) {
      return { status: 'BANNED', reason: '该资源已被禁用' }
    }
  }

  for (const side of ['BLUE', 'RED'] as const) {
    const player = side === 'BLUE' ? game.blue : game.red
    if (getPlayerResourceState(player, resourceType).picks.includes(resource.id)) {
      const position = rotateSide(m.rule, currentNumber, side)
      return { status: position === 'BLUE' ? 'BLUE_PICKED' : 'RED_PICKED', reason: position === 'BLUE' ? '蓝方已选择' : '红方已选择' }
    }
  }

  if (draft?.crossGameLock) {
    for (const g of m.games) {
      if (g.gameNumber === currentNumber) continue
      if (getPlayerResourceState(g.blue, resourceType).picks.includes(resource.id) || getPlayerResourceState(g.red, resourceType).picks.includes(resource.id)) {
        return { status: 'USED', reason: '该资源已在之前小局使用' }
      }
    }
  }

  if (getPhase(m).resourceType !== resourceType || m.status !== 'IN_PROGRESS') return { status: 'LOCKED', reason: '当前非该资源阶段' }
  return { status: 'AVAILABLE', reason: '' }
}

export function getNinjaCardStatus(m: MatchState, ninja: Ninja): NinjaStatusInfo {
  return getResourceCardStatus(m, 'NINJA', ninja)
}

export function getAvailableNinjas(m: MatchState, pool: Pick<Ninja, 'id' | 'enabled'>[]): Pick<Ninja, 'id' | 'enabled'>[] {
  return pool.filter((n) => canSelectNinja(m, n.id, n).allowed)
}

export function getUnavailableReason(m: MatchState, ninjaId: string, ninja?: Pick<Ninja, 'id' | 'enabled'>): string | null {
  const check = canSelectNinja(m, ninjaId, ninja)
  return check.allowed ? null : check.reason ?? null
}

// ---------------------------------------------------------------------------
// BP 操作
// ---------------------------------------------------------------------------

const fail = (reason: string): EngineResult => ({ ok: false, reason })

/**
 * 按当前阶段执行 Ban 或 Pick：阶段是 BAN 就禁用，是 PICK 就选择。
 * 点击哪个忍者由 UI 决定，属于哪一方由引擎的阶段推导决定。
 */
export function selectNinja(m: MatchState, ninjaId: string, ninja?: Pick<Ninja, 'id' | 'enabled'>, context?: TransitionContext): EngineResult {
  return selectResource(m, 'NINJA', ninjaId, ninja, context)
}

export function selectResource(
  m: MatchState,
  resourceType: DraftResourceType,
  resourceId: string,
  resource?: Pick<DraftResourceBase, 'id' | 'enabled' | 'deprecated'>,
  context?: TransitionContext,
): EngineResult {
  const check = canSelectResource(m, resourceType, resourceId, resource)
  if (!check.allowed) return fail(check.reason ?? `无法选择${RESOURCE_TYPE_LABEL[resourceType]}`)

  const phase = getPhase(m)
  const side = phase.side as Side
  const action = phase.action as BPActionType

  const next = cloneMatch(m)
  const game = getCurrentGame(next)
  const player = ensurePlayerResourceState(side === 'BLUE' ? game.blue : game.red, resourceType)
  if (action === 'BAN') player.bans.push(resourceId)
  else player.picks.push(resourceId)

  const timestamp = nextTimestamp(m, context)
  next.history.push({
    id: context?.actionId ?? `act-${m.id}-${m.history.length}`,
    gameNumber: game.gameNumber,
    side,
    action,
    ninjaId: resourceId,
    resourceType,
    resourceId,
    timestamp,
    sequenceIndex: phase.totalDone,
  })
  next.updatedAt = timestamp
  return { ok: true, state: next }
}

/** 语义别名：引擎按阶段决定实际动作，两个入口行为一致 */
export const banNinja = selectNinja
export const pickNinja = selectNinja

/** GAME READY → 进入比赛 */
export function enterGame(m: MatchState, context?: TransitionContext): EngineResult {
  if (m.status !== 'IN_PROGRESS') return fail('比赛未在进行中')
  const game = getCurrentGame(m)
  if (game.winner) return fail('本局已结束')
  const phase = getPhase(m)
  if (!phase.sequenceComplete) return fail('BP 尚未完成')
  if (game.started) return fail('本局已进入比赛')
  for (const draft of getResourceDraftRules(m.rule)) {
    if (!draft.enabled) continue
    const blue = getPlayerResourceState(game.blue, draft.resourceType).picks
    const red = getPlayerResourceState(game.red, draft.resourceType).picks
    if (blue.length !== draft.slotsPerSide || red.length !== draft.slotsPerSide) return fail('双方阵容槽位尚未填满')
    if (new Set(blue).size !== blue.length || new Set(red).size !== red.length) return fail('阵容包含重复资源')
    if (draft.uniqueAcrossSides && blue.some((id) => red.includes(id))) return fail('双方阵容包含重复资源')
    for (const id of [...blue, ...red]) {
      const check = canUseFinalResource(m, draft.resourceType, id)
      if (!check.allowed) return fail(check.reason ?? '阵容包含不可用资源')
    }
  }
  const next = cloneMatch(m)
  getCurrentGame(next).started = true
  next.updatedAt = nextTimestamp(m, context)
  return { ok: true, state: next }
}

function canUseFinalResource(m: MatchState, resourceType: DraftResourceType, id: string): SelectCheck {
  const draft = getResourceDraftRules(m.rule).find((item) => item.resourceType === resourceType)
  const game = getCurrentGame(m)
  for (const past of m.games) {
    if (past.gameNumber === game.gameNumber || draft?.banPersistence) {
      if (getPlayerResourceState(past.blue, resourceType).bans.includes(id) || getPlayerResourceState(past.red, resourceType).bans.includes(id)) return deny('阵容包含已禁用资源')
    }
    if (past.gameNumber < game.gameNumber && draft?.crossGameLock) {
      if (getPlayerResourceState(past.blue, resourceType).picks.includes(id) || getPlayerResourceState(past.red, resourceType).picks.includes(id)) return deny('阵容包含跨局锁定资源')
    }
  }
  return ALLOW
}

/** 记录本局胜者（比分 +1；满足条件则整场结束） */
export function setGameWinner(m: MatchState, side: Side, context?: TransitionContext): EngineResult {
  if (m.status === 'MATCH_FINISHED') return fail('比赛已经结束')
  const game = getCurrentGame(m)
  if (!game.started) return fail('本局尚未进入比赛')
  if (game.winner) return fail('本局已记录胜负')
  const completedBlue = m.games.filter((item) => item.winner === 'BLUE').length
  const completedRed = m.games.filter((item) => item.winner === 'RED').length
  if (m.score.blue !== completedBlue || m.score.red !== completedRed) return fail('比分与已完成小局不一致')

  const next = cloneMatch(m)
  getCurrentGame(next).winner = side
  if (side === 'BLUE') next.score.blue += 1
  else next.score.red += 1

  const reachedWins = next.score.blue >= next.rule.winsRequired || next.score.red >= next.rule.winsRequired
  const noGamesLeft = next.currentGame >= next.rule.bestOf
  if (reachedWins || noGamesLeft) next.status = 'MATCH_FINISHED'
  next.updatedAt = nextTimestamp(m, context)
  return { ok: true, state: next }
}

/** 进入下一局（保持 Ban 与已使用忍者） */
export function nextGame(m: MatchState, context?: TransitionContext): EngineResult {
  if (m.status === 'MATCH_FINISHED') return fail('比赛已经结束')
  const game = getCurrentGame(m)
  if (!game.winner) return fail('本局尚未记录胜负')
  if (m.currentGame >= m.rule.bestOf) return fail('已经是最后一局')

  const next = cloneMatch(m)
  next.currentGame += 1
  next.games.push(createFollowingGameState(m, next.currentGame))
  next.updatedAt = nextTimestamp(m, context)
  return { ok: true, state: next }
}

/** 重做本局 BP（尚未记录胜负时可用） */
export function resetCurrentGame(m: MatchState, context?: TransitionContext): EngineResult {
  const game = getCurrentGame(m)
  if (game.winner) return fail('本局已记录胜负，请使用撤销')
  const doneCount = countSequenceActions(game, getGameSequence(m, game.gameNumber))
  if (doneCount === 0 && !game.started) return fail('本局还没有任何操作')

  const next = cloneMatch(m)
  const gameIndex = next.games.length - 1
  const clean = gameIndex > 0
    ? createFollowingGameState({ ...next, games: next.games.slice(0, gameIndex) }, game.gameNumber)
    : createGameState(game.gameNumber)
  const g = next.games[gameIndex] = clean
  g.started = false
  next.history = next.history.filter((h) => h.gameNumber !== g.gameNumber)
  next.updatedAt = nextTimestamp(m, context)
  return { ok: true, state: next }
}

/**
 * 撤销最后一步 BP 动作（按 history 日志回退）。
 *
 * 在线模式无法使用客户端快照栈，服务端以 history 为准回退
 * 最近一条 Ban / Pick；若最后事件是胜负/换局，则不做回退（第一版约束，
 * 保证 BP 正确性优先）。本地模式的撤销仍使用完整快照（historyEngine.undo）。
 */
export function undoLastAction(m: MatchState, context?: TransitionContext): EngineResult {
  if (m.status === 'MATCH_FINISHED') return fail('比赛已经结束')
  if (m.history.length === 0) return fail('没有可撤销的操作')

  const last = m.history[m.history.length - 1]
  const next = cloneMatch(m)
  const game = getCurrentGame(next)
  if (game.gameNumber !== last.gameNumber) return fail('只能撤销当前小局的操作')
  if (game.winner) return fail('本局已记录胜负，无法直接撤销 BP')

  let count = 0
  for (const action of [...next.history].reverse()) {
    if (count > 0 && (!last.batchId || action.batchId !== last.batchId)) break
    if (action.gameNumber !== game.gameNumber) break
    const player = ensurePlayerResourceState(action.side === 'BLUE' ? game.blue : game.red, action.resourceType ?? 'NINJA')
    const arr = action.action === 'BAN' ? player.bans : player.picks
    const idx = arr.lastIndexOf(action.resourceId ?? action.ninjaId)
    if (idx === -1) return fail('撤销状态不一致')
    arr.splice(idx, 1)
    count++
  }
  next.history = next.history.slice(0, -count)
  next.updatedAt = nextTimestamp(m, context)
  return { ok: true, state: next }
}

// ---------------------------------------------------------------------------
// 在线计时器辅助（服务器权威）
// ---------------------------------------------------------------------------

/** 与客户端一致的阶段标识：phaseKey 变化才应重建 deadline */
export function computeTimerPhaseKey(m: MatchState): string {
  return getCurrentDraftPhase(m).phaseKey
}

/** 为新状态重建服务器倒计时（phaseKey 变化时调用；seconds 取自规则） */
export function rebuildTimer(m: MatchState, now: number): MatchState {
  if (!m.rule.timerEnabled) return m
  const phase = getCurrentDraftPhase(m)
  return {
    ...m,
    timer: {
      phaseKey: phase.phaseKey,
      deadlineAt: phase.sequenceComplete ? null : now + (getResourceDraftRules(m.rule).find((item) => item.resourceType === phase.resourceType)?.timerSeconds ?? m.rule.timerSeconds) * 1000,
      timedOut: false,
    },
  }
}

/** 判断两个状态的计时阶段是否不同（撤销/新步骤/换局检测） */
export function timerPhaseChanged(before: MatchState, after: MatchState): boolean {
  return computeTimerPhaseKey(before) !== computeTimerPhaseKey(after)
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

/** 导出比赛完整数据（JSON 下载 / 复盘用） */
export function exportMatchResult(m: MatchState): Record<string, unknown> {
  return {
    ...cloneMatch(m),
    source: 'Ninja BP Arena（忍界 BP · 玩家自制非官方工具）',
    exportedAt: new Date().toISOString(),
  }
}
