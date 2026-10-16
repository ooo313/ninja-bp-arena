import type { BattleRule, BPAction, MatchStatus, Side, BPActionType, MatchState, Ninja } from './types.ts'
import { validateBattleRule } from './ruleEngine.ts'
import { getCurrentDraftPhase, getGameSequence, getPlayerResourceState } from './bpEngine.ts'

/**
 * 持久化数据的运行时校验（Shared BP Core）。
 *
 * localStorage / 数据库里的数据永远不可信：只判断“字段是否存在”会让
 * {"games":[],"rule":{}} 这类合法 JSON 穿透进业务状态。
 * 这里做完整结构校验，校验失败的数据一律在加载层被丢弃并回退。
 */

const MATCH_STATUSES: MatchStatus[] = ['SETUP', 'IN_PROGRESS', 'MATCH_FINISHED']
const SIDES: Side[] = ['BLUE', 'RED']
const ACTIONS: BPActionType[] = ['BAN', 'PICK']
const QUALITIES = ['S', 'A', 'B', 'C']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

function isNonNegativeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((item) => typeof item === 'string')
}

/** 校验单个 GameState */
function isValidGameState(game: unknown, bestOf: number): boolean {
  if (!isRecord(game)) return false
  // 严格：gameNumber 必须 1..bestOf
  if (!isNonNegativeInt(game.gameNumber) || game.gameNumber < 1 || game.gameNumber > bestOf) return false
  if (game.started !== undefined && typeof game.started !== 'boolean') return false
  if (game.winner !== undefined && game.winner !== 'BLUE' && game.winner !== 'RED') return false
  for (const side of ['blue', 'red'] as const) {
    const player = game[side]
    if (!isRecord(player)) return false
    if (!isStringArray(player.bans) || !isStringArray(player.picks)) return false
    if (player.resources !== undefined) {
      if (!isRecord(player.resources)) return false
      for (const type of ['SECRET_SCROLL', 'SUMMON']) {
        const draft = player.resources[type]
        if (draft !== undefined && (!isRecord(draft) || !isStringArray(draft.bans) || !isStringArray(draft.picks))) return false
      }
    }
  }
  return true
}

/** 校验单个 BPAction */
function isValidBPAction(action: unknown): boolean {
  if (!isRecord(action)) return false
  if (!isNonEmptyString(action.id)) return false
  if (!isNonNegativeInt(action.gameNumber) || action.gameNumber < 1) return false
  if (!SIDES.includes(action.side as Side)) return false
  if (!ACTIONS.includes(action.action as BPActionType)) return false
  if (!isNonEmptyString(action.ninjaId)) return false
  if (action.resourceType !== undefined && !['NINJA', 'SECRET_SCROLL', 'SUMMON'].includes(action.resourceType as string)) return false
  if (action.resourceId !== undefined && !isNonEmptyString(action.resourceId)) return false
  if (action.batchId !== undefined && (!isNonEmptyString(action.batchId) || action.resourceType === 'NINJA')) return false
  if (typeof action.timestamp !== 'number') return false
  if (!isNonNegativeInt(action.sequenceIndex)) return false
  return true
}

/** 校验可选的服务端计时器字段 */
function isValidTimer(value: unknown): boolean {
  if (value === undefined) return true
  if (!isRecord(value)) return false
  if (value.phaseKey !== null && !isNonEmptyString(value.phaseKey)) return false
  if (value.deadlineAt !== null && typeof value.deadlineAt !== 'number') return false
  if (typeof value.timedOut !== 'boolean') return false
  return true
}

/** 校验存储中的 BattleRule（结构 + 业务规则双重校验） */
export function validateStoredRule(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (!isNonEmptyString(value.id) || !isNonEmptyString(value.name)) return false
  if (typeof value.version !== 'string') return false
  if (!isNonNegativeInt(value.bestOf) || !isNonNegativeInt(value.winsRequired)) return false
  if (
    typeof value.banOnlyFirstGame !== 'boolean' ||
    typeof value.banPersistence !== 'boolean' ||
    typeof value.usedNinjaLocked !== 'boolean' ||
    typeof value.timerEnabled !== 'boolean'
  ) {
    return false
  }
  if (!isNonNegativeInt(value.timerSeconds)) return false
  if (!Array.isArray(value.banSequence) || !Array.isArray(value.pickSequence)) return false
  return validateBattleRule(value as unknown as BattleRule).length === 0
}

/** 校验比赛的数据包元信息（v0.4 可选字段） */
function isValidPackMetadata(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (!isNonEmptyString(value.packId)) return false
  if (value.schemaVersion !== undefined && !isNonNegativeInt(value.schemaVersion)) return false
  if (value.packVersion !== undefined && (typeof value.packVersion !== 'string' || (value.packVersion as string).length > 40)) return false
  if (value.checksum !== undefined && (typeof value.checksum !== 'string' || !/^sha256:[0-9a-f]{64}$/i.test(value.checksum as string))) return false
  return true
}

/** 校验比赛的忍者池轻量快照（v0.4 可选字段） */
function isValidNinjaSnapshot(value: unknown): boolean {
  if (!Array.isArray(value)) return false
  for (const item of value) {
    if (!isRecord(item)) return false
    if (!isNonEmptyString(item.id)) return false
    if (typeof item.name !== 'string' || (item.name as string).trim() === '') return false
    if (typeof item.enabled !== 'boolean') return false
    if (typeof item.quality !== 'string' || !QUALITIES.includes(item.quality)) return false
    if (item.avatar !== undefined && typeof item.avatar !== 'string') return false
    if (item.assetKey !== undefined && typeof item.assetKey !== 'string') return false
  }
  return true
}

function isValidResourceSnapshot(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.ninjas) || !Array.isArray(value.secretScrolls) || !Array.isArray(value.summons)) return false
  if (!isValidNinjaSnapshot(value.ninjas)) return false
  for (const [key, expected] of [['secretScrolls', 'SECRET_SCROLL'], ['summons', 'SUMMON']] as const) {
    const items = value[key] as unknown[]
    for (const item of items) {
      if (!isRecord(item) || item.resourceType !== expected || !isNonEmptyString(item.id) || !isNonEmptyString(item.name) || typeof item.enabled !== 'boolean') return false
      if (item.asset !== undefined && typeof item.asset !== 'string') return false
      if (item.avatar !== undefined && typeof item.avatar !== 'string') return false
      if (item.assetKey !== undefined && typeof item.assetKey !== 'string') return false
      if (item.tags !== undefined && !isStringArray(item.tags)) return false
    }
  }
  return true
}

/**
 * 严格校验一场比赛的持久化数据。
 * 任何一层不合法都返回 false，由加载层整体丢弃。
 */
export function validateMatchState(value: unknown): boolean {
  if (!isRecord(value)) return false

  if (!isNonEmptyString(value.id)) return false
  if (!validateStoredRule(value.rule)) return false
  if (typeof value.bluePlayerName !== 'string' || typeof value.redPlayerName !== 'string') return false

  // 比分
  if (!isRecord(value.score)) return false
  if (!isNonNegativeInt(value.score.blue) || !isNonNegativeInt(value.score.red)) return false

  // 局数：currentGame 必须 1..bestOf
  if (!isNonNegativeInt(value.currentGame) || value.currentGame < 1) return false
  if (typeof value.status !== 'string' || !MATCH_STATUSES.includes(value.status as MatchStatus)) return false

  // games：至少一局；局数不超过 bestOf；gameNumber 严格 1,2,3… 递增；
  // currentGame 必须指向最后一局
  if (!Array.isArray(value.games) || value.games.length === 0) return false
  const rule = value.rule as unknown as BattleRule
  if (value.games.length > rule.bestOf) return false
  for (let i = 0; i < value.games.length; i += 1) {
    const game = value.games[i] as Record<string, unknown>
    if (!isValidGameState(game, rule.bestOf)) return false
    if (game.gameNumber !== i + 1) return false
  }
  const lastGame = value.games[value.games.length - 1] as Record<string, unknown>
  if (lastGame.gameNumber !== value.currentGame) return false
  if (value.currentGame > rule.bestOf) return false

  // 比分只能从已完成小局得出；状态也必须与胜场一致。
  const score = value.score as { blue: number; red: number }
  const games = value.games as MatchState['games']
  const blueWins = games.filter((game) => game.winner === 'BLUE').length
  const redWins = games.filter((game) => game.winner === 'RED').length
  if (score.blue !== blueWins || score.red !== redWins) return false
  if (games.slice(0, -1).some((game) => !game.winner)) return false
  if (games.some((game) => game.winner && game.started === false)) return false
  const reached = blueWins >= rule.winsRequired || redWins >= rule.winsRequired
  const playedOut = games.length === rule.bestOf && Boolean(games[games.length - 1].winner)
  if ((value.status === 'MATCH_FINISHED') !== (reached || playedOut)) return false

  // history
  if (!Array.isArray(value.history)) return false
  for (const action of value.history) {
    if (!isValidBPAction(action)) return false
    if ((action as BPAction).gameNumber > value.currentGame) return false
  }

  const match = value as unknown as MatchState
  for (const game of games) {
    const sequence = getGameSequence(match, game.gameNumber)
    for (const type of ['NINJA', 'SECRET_SCROLL', 'SUMMON'] as const) {
      const blue = getPlayerResourceState(game.blue, type)
      const red = getPlayerResourceState(game.red, type)
      const bans = sequence.filter((step) => step.resourceType === type && step.action === 'BAN').length
      const picks = sequence.filter((step) => step.resourceType === type && step.action === 'PICK').length
      if (game.gameNumber === 1 && (blue.bans.length + red.bans.length > bans || blue.picks.length + red.picks.length > picks)) return false
      if (new Set([...blue.bans, ...red.bans]).size !== blue.bans.length + red.bans.length) return false
      if (new Set(blue.picks).size !== blue.picks.length || new Set(red.picks).size !== red.picks.length) return false
    }
  }
  if (lastGame.started && !getCurrentDraftPhase(match).sequenceComplete) return false

  // 时间戳
  if (typeof value.createdAt !== 'number' || typeof value.updatedAt !== 'number') return false

  // 在线模式的可选服务端计时器
  if (!isValidTimer(value.timer)) return false

  // v0.4 可选数据快照
  if (value.dataPack !== undefined && !isValidPackMetadata(value.dataPack)) return false
  if (value.ninjaSnapshot !== undefined && !isValidNinjaSnapshot(value.ninjaSnapshot)) return false
  if (value.resourceSnapshot !== undefined && !isValidResourceSnapshot(value.resourceSnapshot)) return false

  return true
}

/** 校验单个 Ninja（持久化 / 运行时通用；新字段全部可选） */
export function validateNinjaRecord(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (!isNonEmptyString(value.id)) return false
  if (typeof value.name !== 'string' || (value.name as string).trim() === '') return false
  if (typeof value.quality !== 'string' || !QUALITIES.includes(value.quality)) return false
  if (!isStringArray(value.tags)) return false
  if (typeof value.enabled !== 'boolean') return false
  if (value.avatar !== undefined && typeof value.avatar !== 'string') return false
  if (value.aliases !== undefined && !isStringArray(value.aliases)) return false
  if (value.sortOrder !== undefined && !isNonNegativeInt(value.sortOrder)) return false
  if (value.remark !== undefined && typeof value.remark !== 'string') return false
  // v0.4 数据包字段（全部可选，出现时校验类型）
  if (value.slug !== undefined && typeof value.slug !== 'string') return false
  if (value.series !== undefined && !isStringArray(value.series)) return false
  if (value.forms !== undefined && !isStringArray(value.forms)) return false
  if (value.roles !== undefined && !isStringArray(value.roles)) return false
  if (value.rarityLabel !== undefined && typeof value.rarityLabel !== 'string') return false
  if (value.dataVersion !== undefined && typeof value.dataVersion !== 'string') return false
  if (value.assetKey !== undefined && typeof value.assetKey !== 'string') return false
  if (value.deprecated !== undefined && typeof value.deprecated !== 'boolean') return false
  if (value.version !== undefined && typeof value.version !== 'string') return false
  if (value.releaseDate !== undefined && typeof value.releaseDate !== 'string') return false
  return true
}

/** 校验计时器运行时数据（本地 timerStore） */
export function validateTimerState(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (value.phaseKey !== null && !isNonEmptyString(value.phaseKey)) return false
  if (value.deadlineAt !== null && typeof value.deadlineAt !== 'number') return false
  return true
}

/** 类型守卫：通过校验的 MatchState */
export function asMatchState(value: unknown): MatchState | null {
  return validateMatchState(value) ? (value as MatchState) : null
}

export type { BPAction, Ninja }
