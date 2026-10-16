import type { BPActionType, BPSequenceStep, BattleRule, DraftResourceType, NormalizedBattleRule, ResourceDraftRule, Side } from './types.ts'

/**
 * 规则引擎：负责 BP 序列的展开与校验。
 * 比赛流程完全由 BattleRule 配置驱动，禁止在 UI 里硬编码顺序。
 */

/** 展开后的单步动作：一个 step(count=N) 会展开成 N 个 ExpandedAction */
export interface ExpandedAction {
  side: Side
  action: BPActionType
  resourceType: DraftResourceType
  /** 属于第几个序列步骤 */
  stepIndex: number
  /** 该步骤内的第几个（0 起） */
  indexInStep: number
}

export function expandSequence(steps: BPSequenceStep[], resourceType: DraftResourceType = 'NINJA', stepOffset = 0): ExpandedAction[] {
  const out: ExpandedAction[] = []
  steps.forEach((step, stepIndex) => {
    for (let i = 0; i < step.count; i += 1) {
      out.push({ side: step.side, action: step.action, resourceType, stepIndex: stepIndex + stepOffset, indexInStep: i })
    }
  })
  return out
}

/** One runtime representation for both legacy Ninja-only and resource rules. */
export function normalizeBattleRule(rule: BattleRule | NormalizedBattleRule): NormalizedBattleRule {
  const drafts = Array.isArray(rule.resourceDrafts) && rule.resourceDrafts.length > 0
    ? rule.resourceDrafts
    : [{
        resourceType: 'NINJA' as const,
        enabled: true,
        slotsPerSide: (rule as BattleRule).picksPerPlayer,
        sequence: [...(rule as BattleRule).banSequence, ...(rule as BattleRule).pickSequence],
        crossGameLock: (rule as BattleRule).usedNinjaLocked,
        uniqueAcrossSides: true,
        banPersistence: (rule as BattleRule).banPersistence,
        banOnlyFirstGame: (rule as BattleRule).banOnlyFirstGame,
        resetEachGame: true,
      }]
  return {
    id: rule.id, name: rule.name, version: rule.version,
    bestOf: rule.bestOf, winsRequired: rule.winsRequired,
    timerEnabled: rule.timerEnabled, timerSeconds: rule.timerSeconds,
    resourceDrafts: drafts,
  }
}

export function getResourceDraftRules(rule: BattleRule | NormalizedBattleRule): ResourceDraftRule[] {
  return normalizeBattleRule(rule).resourceDrafts
}

const SIDE_TEXT: Record<Side, string> = { BLUE: '蓝方', RED: '红方' }
const ACTION_TEXT: Record<BPActionType, string> = { BAN: '禁用', PICK: '选择' }

/** 人类可读的序列描述，如 “蓝方 禁用×1 → 红方 禁用×2” */
export function describeSequence(steps: BPSequenceStep[]): string {
  if (!steps.length) return '（无）'
  return steps.map((s) => `${SIDE_TEXT[s.side]} ${ACTION_TEXT[s.action]}×${s.count}`).join(' → ')
}

export interface SequenceParseResult {
  steps?: BPSequenceStep[]
  errors: string[]
}

/**
 * 校验一段序列 JSON（来自规则编辑器）。
 * banSequence 内只允许 BAN 步骤，pickSequence 内只允许 PICK 步骤，
 * 且引擎约定 Ban 全部完成后才进入 Pick。
 */
export function parseSequenceSteps(input: unknown, label: string, expectedAction: BPActionType): SequenceParseResult {
  const errors: string[] = []
  if (!Array.isArray(input)) {
    return { errors: [`${label} 必须是数组`] }
  }
  if (input.length === 0 && expectedAction === 'PICK') {
    errors.push(`${label} 不能为空`)
  }
  const steps: BPSequenceStep[] = []
  input.forEach((item, i) => {
    const no = i + 1
    if (typeof item !== 'object' || item === null) {
      errors.push(`${label} 第 ${no} 项格式错误`)
      return
    }
    const rec = item as Record<string, unknown>
    const side = rec.side
    const action = rec.action
    if (side !== 'BLUE' && side !== 'RED') {
      errors.push(`${label} 第 ${no} 项：side 必须是 "BLUE" 或 "RED"`)
      return
    }
    // 先校验字面量让 TS 收窄类型，再校验是否与期望动作一致
    if (action !== 'BAN' && action !== 'PICK') {
      errors.push(`${label} 第 ${no} 项：action 必须是 "${expectedAction}"`)
      return
    }
    if (action !== expectedAction) {
      errors.push(`${label} 第 ${no} 项：action 必须是 "${expectedAction}"`)
      return
    }
    const count = rec.count
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 6) {
      errors.push(`${label} 第 ${no} 项：count 必须是 1~6 的整数`)
      return
    }
    steps.push({ side, action, count })
  })
  if (errors.length) return { errors }
  return { steps, errors }
}

/** 校验整份规则（设置页保存 / 在线房间创建时使用） */
export function validateBattleRule(rule: BattleRule): string[] {
  const errors: string[] = []
  if (![1, 3, 5, 7].includes(rule.bestOf)) errors.push('赛制 bestOf 只支持 1 / 3 / 5 / 7')
  if (rule.winsRequired !== (rule.bestOf + 1) / 2) errors.push('winsRequired 必须等于过半胜场')
  if (typeof rule.timerEnabled !== 'boolean') errors.push('timerEnabled 必须是 boolean')
  if (!Number.isInteger(rule.timerSeconds) || rule.timerSeconds < 5 || rule.timerSeconds > 600) {
    errors.push('倒计时秒数必须在 5 ~ 600 之间')
  }
  if (!rule.resourceDrafts) {
    const ban = parseSequenceSteps(rule.banSequence, 'banSequence', 'BAN')
    const pick = parseSequenceSteps(rule.pickSequence, 'pickSequence', 'PICK')
    errors.push(...ban.errors, ...pick.errors)
    if (!Number.isInteger(rule.picksPerPlayer) || rule.picksPerPlayer < 1) errors.push('picksPerPlayer 必须大于 0')
    if (!Number.isInteger(rule.bansPerPlayer) || rule.bansPerPlayer < 0) errors.push('bansPerPlayer 必须为非负整数')
    if (ban.steps && pick.steps) {
      for (const side of ['BLUE', 'RED'] as const) {
        if (pick.steps.filter((s) => s.side === side).reduce((sum, s) => sum + s.count, 0) !== rule.picksPerPlayer) errors.push(`${side} 的 PICK 数必须等于 picksPerPlayer`)
        if (ban.steps.filter((s) => s.side === side).reduce((sum, s) => sum + s.count, 0) !== rule.bansPerPlayer) errors.push(`${side} 的 BAN 数必须等于 bansPerPlayer`)
      }
    }
  }
  if (rule.resourceDrafts !== undefined) {
    if (!Array.isArray(rule.resourceDrafts) || rule.resourceDrafts.length === 0) {
      errors.push('resourceDrafts 必须是非空数组')
    } else {
      const seen = new Set<DraftResourceType>()
      let enabledCount = 0
      for (const [index, draft] of rule.resourceDrafts.entries()) {
        const label = `resourceDrafts[${index}]`
        if (!draft || typeof draft !== 'object') {
          errors.push(`${label} 格式错误`)
          continue
        }
        if (!['NINJA', 'SECRET_SCROLL', 'SUMMON'].includes(draft.resourceType)) errors.push(`${label}.resourceType 非法`)
        if (seen.has(draft.resourceType)) errors.push(`${label}.resourceType 重复`)
        seen.add(draft.resourceType)
        if (typeof draft.enabled !== 'boolean') errors.push(`${label}.enabled 必须是 boolean`)
        if (draft.selectionMode !== undefined && !['SEQUENTIAL', 'SIMULTANEOUS'].includes(draft.selectionMode)) errors.push(`${label}.selectionMode 非法`)
        if (draft.selectionMode === 'SIMULTANEOUS' && (draft.resourceType === 'NINJA' || draft.uniqueAcrossSides || !draft.resetEachGame || (Array.isArray(draft.sequence) && draft.sequence.some((step) => step.action !== 'PICK')))) errors.push(`${label} 同时盲选仅支持每局重选、双方可使用相同资源的辅助资源 PICK`)
        if (draft.enabled) enabledCount += 1
        if (typeof draft.crossGameLock !== 'boolean' || typeof draft.uniqueAcrossSides !== 'boolean' || typeof draft.banPersistence !== 'boolean' || typeof draft.resetEachGame !== 'boolean') errors.push(`${label} 的锁定配置必须是 boolean`)
        if (draft.banOnlyFirstGame !== undefined && typeof draft.banOnlyFirstGame !== 'boolean') errors.push(`${label}.banOnlyFirstGame 必须是 boolean`)
        if (!Number.isInteger(draft.slotsPerSide) || draft.slotsPerSide < (draft.enabled ? 1 : 0) || draft.slotsPerSide > 12) {
          errors.push(`${label}.slotsPerSide 必须是 ${draft.enabled ? '1' : '0'}~12 的整数`)
        }
        if (draft.timerSeconds !== undefined && (!Number.isInteger(draft.timerSeconds) || draft.timerSeconds < 5 || draft.timerSeconds > 600)) {
          errors.push(`${label}.timerSeconds 必须是 5~600 的整数`)
        }
        if (!Array.isArray(draft.sequence) || (draft.enabled && draft.sequence.length === 0)) errors.push(`${label}.sequence 必须是非空数组`)
        else {
          if (draft.sequence.some((step) => !step || typeof step !== 'object' || !['BLUE', 'RED'].includes(step.side) || !['BAN', 'PICK'].includes(step.action) || !Number.isInteger(step.count) || step.count < 1 || step.count > 12)) {
            errors.push(`${label}.sequence 包含非法步骤`)
            continue
          }
          if (draft.enabled && !draft.resetEachGame && draft.crossGameLock && rule.bestOf > 1) errors.push(`${label} 继承阵容不能同时启用跨局锁定`)
          if (draft.enabled && !draft.resetEachGame && !draft.banPersistence && draft.sequence.some((step) => step.action === 'BAN') && rule.bestOf > 1) errors.push(`${label} 继承 Ban 时必须启用跨局 Ban 持续`)
          const picks = draft.sequence.filter((step) => step.action === 'PICK')
          if (draft.enabled && draft.sequence.some((step, stepIndex) => step.action === 'BAN' && draft.sequence.slice(0, stepIndex).some((prior) => prior.action === 'PICK'))) errors.push(`${label}.sequence 不能在 PICK 后执行 BAN`)
          const blue = picks.filter((step) => step.side === 'BLUE').reduce((sum, step) => sum + step.count, 0)
          const red = picks.filter((step) => step.side === 'RED').reduce((sum, step) => sum + step.count, 0)
          if (draft.enabled && (blue !== draft.slotsPerSide || red !== draft.slotsPerSide)) {
            errors.push(`${label}.sequence 的双方 PICK 数必须等于 slotsPerSide`)
          }
          for (const [stepIndex, step] of draft.sequence.entries()) {
            if (!['BLUE', 'RED'].includes(step.side) || !['BAN', 'PICK'].includes(step.action) || !Number.isInteger(step.count) || step.count < 1 || step.count > 12) {
              errors.push(`${label}.sequence[${stepIndex}] 非法`)
            }
          }
        }
      }
      if (enabledCount === 0) errors.push('至少启用一种资源 Draft')
    }
  }
  return errors
}
