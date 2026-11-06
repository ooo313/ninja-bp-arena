import type { BattleRule } from './types.ts'
import { getResourceDraftRules, validateBattleRule } from './ruleEngine.ts'

/**
 * 忍者池容量需求分析（Shared BP Core）。
 *
 * getMinimumRequiredPoolSize(rule) 返回完成整场比赛（最坏情况）
 * 所需的最少「enabled」忍者数量。房间创建与本地开赛都用它做前置校验，
 * 避免比赛进行到一半因池子枯竭而无法继续。
 *
 * Worst-case simultaneous exclusions: persistent bans accumulate when a ban
 * phase repeats; transient bans occupy only the current game. Cross-game picks
 * accumulate only when locked. Shared-side picks need one side's slots, while
 * unique-across-sides picks need both sides' slots.
 *
 * 示例（默认武斗赛 BO3：Ban 蓝1红2蓝1 = 4，每局 Pick 6，USED 锁定）：
 *   4 + 6 × 3 = 22。
 */
export function getMinimumRequiredPoolSize(rule: BattleRule): number {
  return getMinimumRequiredResources(rule).ninjas
}

export interface MinimumRequiredResources {
  ninjas: number
  secretScrolls: number
  summons: number
}

export function getMinimumRequiredResources(rule: BattleRule): MinimumRequiredResources {
  const result: MinimumRequiredResources = { ninjas: 0, secretScrolls: 0, summons: 0 }
  for (const draft of getResourceDraftRules(rule)) {
    if (!draft.enabled) continue
    const bansPerGame = draft.sequence.filter((step) => step.action === 'BAN').reduce((sum, step) => sum + step.count, 0)
    const bluePicks = draft.sequence.filter((step) => step.action === 'PICK' && step.side === 'BLUE').reduce((sum, step) => sum + step.count, 0)
    const redPicks = draft.sequence.filter((step) => step.action === 'PICK' && step.side === 'RED').reduce((sum, step) => sum + step.count, 0)
    const picksPerGame = draft.uniqueAcrossSides ? bluePicks + redPicks : Math.max(bluePicks, redPicks)
    const gameCount = draft.resetEachGame ? (rule.bestOf || 1) : 1
    const picksTotal = draft.crossGameLock ? picksPerGame * gameCount : picksPerGame
    const required = draft.banPersistence
      ? (draft.banOnlyFirstGame ? bansPerGame : bansPerGame * gameCount) + picksTotal
      : draft.banOnlyFirstGame && gameCount > 1
        ? Math.max(bansPerGame + picksPerGame, picksTotal)
        : bansPerGame + picksTotal
    if (draft.resourceType === 'NINJA') result.ninjas = required
    else if (draft.resourceType === 'SECRET_SCROLL') result.secretScrolls = required
    else result.summons = required
  }
  return result
}

export interface RuleFeasibility {
  errors: string[]
  warnings: string[]
  requiredResources: MinimumRequiredResources
}

/** Analyze both intrinsic rule consistency and the enabled pool, when supplied. */
export function analyzeRuleFeasibility(
  rule: BattleRule,
  available?: Partial<MinimumRequiredResources>,
): RuleFeasibility {
  const errors = validateBattleRule(rule)
  const requiredResources = errors.length === 0
    ? getMinimumRequiredResources(rule)
    : { ninjas: 0, secretScrolls: 0, summons: 0 }
  const warnings: string[] = []
  for (const key of ['ninjas', 'secretScrolls', 'summons'] as const) {
    if (available?.[key] !== undefined && available[key] < requiredResources[key]) {
      errors.push(`${key} 需要至少 ${requiredResources[key]} 个可用资源，当前只有 ${available[key]} 个`)
    }
  }
  if (rule.bestOf === 5) warnings.push('BO5 请确认资源池能支持打满五局')
  return { errors, warnings, requiredResources }
}

/** 统计忍者池中可用（enabled）且 ID 唯一的忍者数量 */
export function countEnabledNinjas(pool: { id: string; enabled?: boolean }[]): number {
  const ids = new Set<string>()
  for (const n of pool) {
    if (n.enabled !== false && n.id) ids.add(n.id)
  }
  return ids.size
}

export const countEnabledResources = countEnabledNinjas
