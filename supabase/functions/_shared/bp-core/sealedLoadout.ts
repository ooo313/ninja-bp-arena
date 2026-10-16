import type { DraftResourceType, MatchState, Side } from './types.ts'
import { cloneMatch, getCurrentGame, getPhase, getPlayerResourceState, rebuildTimer, selectResource } from './bpEngine.ts'
import { getResourceDraftRules } from './ruleEngine.ts'
import { getResource, type BattleResources } from './resourceRegistry.ts'

export interface PrivateLoadout {
  phase_key: string
  side: Side
  resource_ids: string[]
}

export function isPrivateLoadout(value: unknown): value is PrivateLoadout {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  return typeof item.phase_key === 'string' && (item.side === 'BLUE' || item.side === 'RED') && Array.isArray(item.resource_ids) && item.resource_ids.length > 0 && item.resource_ids.length <= 12 && item.resource_ids.every((id) => typeof id === 'string') && new Set(item.resource_ids).size === item.resource_ids.length
}

export function getSealedDraft(match: MatchState) {
  const phase = getPhase(match)
  if (match.status !== 'IN_PROGRESS' || phase.status !== 'PICKING' || !phase.resourceType || phase.resourceType === 'NINJA') return null
  const rule = getResourceDraftRules(match.rule).find((item) => item.resourceType === phase.resourceType)
  if (rule?.selectionMode !== 'SIMULTANEOUS') return null
  return { resourceType: phase.resourceType, count: rule.slotsPerSide, key: `${phase.phaseKey}:V${match.updatedAt}`, rule }
}

export function checkSealedChoice(match: MatchState, side: Side, type: DraftResourceType, id: string, resources: BattleResources, selected: string[] = []) {
  const phase = getSealedDraft(match)
  if (!phase || phase.resourceType !== type) return { allowed: false, reason: '当前不是该资源的同时选择阶段' }
  const item = getResource(resources, type, id)
  if (!item?.enabled || item.deprecated) return { allowed: false, reason: '该资源不存在或已停用' }
  if (selected.includes(id)) return { allowed: false, reason: '己方选择不能重复' }
  for (const game of match.games) {
    const mine = getPlayerResourceState(side === 'BLUE' ? game.blue : game.red, type)
    const other = getPlayerResourceState(side === 'BLUE' ? game.red : game.blue, type)
    if ((game.gameNumber === match.currentGame || phase.rule.banPersistence) && [...mine.bans, ...other.bans].includes(id)) return { allowed: false, reason: '该资源已被禁用' }
    if (game.gameNumber < match.currentGame && phase.rule.crossGameLock && [...mine.picks, ...other.picks].includes(id)) return { allowed: false, reason: '该资源已在之前小局使用' }
  }
  return { allowed: true }
}

export function validateSealedLoadout(match: MatchState, side: Side, type: DraftResourceType, ids: unknown, resources: BattleResources): string | null {
  const phase = getSealedDraft(match)
  if (!phase || type !== phase.resourceType) return '当前不是该资源的同时选择阶段'
  if (!Array.isArray(ids) || ids.length !== phase.count || !ids.every((id) => typeof id === 'string')) return `请选择完整的 ${phase.count} 个资源`
  const selected: string[] = []
  for (const id of ids) {
    const check = checkSealedChoice(match, side, type, id, resources, selected)
    if (!check.allowed) return check.reason ?? '资源不可用'
    selected.push(id)
  }
  return null
}

/** No partial result is ever returned. The caller commits this result once. */
export function revealSealedLoadouts(match: MatchState, choices: Record<Side, string[]>, resources: BattleResources, now: number, commandIds: Record<Side, string>) {
  const phase = getSealedDraft(match)
  if (!phase) return { ok: false, reason: '当前不是同时选择阶段' }
  for (const side of ['BLUE', 'RED'] as const) {
    const reason = validateSealedLoadout(match, side, phase.resourceType, choices[side], resources)
    if (reason) return { ok: false, reason }
  }
  let state = cloneMatch(match)
  const positions = { BLUE: 0, RED: 0 }
  for (let index = 0; index < phase.count * 2; index++) {
    const current = getPhase(state)
    if (!current.side || current.resourceType !== phase.resourceType) return { ok: false, reason: '辅助资源序列不一致' }
    const side = current.side
    const position = positions[side]++
    const id = choices[side][position]
    const result = selectResource(state, phase.resourceType, id, getResource(resources, phase.resourceType, id), { now, actionId: `${commandIds[side]}:${position}` })
    if (!result.ok || !result.state) return { ok: false, reason: result.reason }
    state = result.state
    state.history[state.history.length - 1].batchId = phase.key
  }
  if (getCurrentGame(state).started) return { ok: false, reason: '阵容阶段异常' }
  return { ok: true, state: rebuildTimer(state, now) }
}
