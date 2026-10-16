import type { BattleRule } from '@/types/bp'

/**
 * 武斗赛 BO3 默认模板。
 *
 * Ban（仅第一局）：蓝方×1 → 红方×2 → 蓝方×1，全场持续有效。
 * Pick（每局）：红方×1 → 蓝方×2 → 红方×2 → 蓝方×1。
 *
 * 注意：规则模板可以在设置页修改，这里只是默认值，
 * 不代表永远有效的官方最新规则。
 */
export const DEFAULT_RULE: BattleRule = {
  id: 'wudou-bo3-default',
  name: '武斗赛 BO3 默认模板',
  version: '1.0',

  bestOf: 3,
  winsRequired: 2,

  banOnlyFirstGame: true,
  banPersistence: true,
  usedNinjaLocked: true,

  bansPerPlayer: 2,
  picksPerPlayer: 3,

  banSequence: [
    { side: 'BLUE', action: 'BAN', count: 1 },
    { side: 'RED', action: 'BAN', count: 2 },
    { side: 'BLUE', action: 'BAN', count: 1 },
  ],
  pickSequence: [
    { side: 'RED', action: 'PICK', count: 1 },
    { side: 'BLUE', action: 'PICK', count: 2 },
    { side: 'RED', action: 'PICK', count: 2 },
    { side: 'BLUE', action: 'PICK', count: 1 },
  ],

  timerEnabled: true,
  timerSeconds: 60,
}

/** v0.4 行为兼容模板：不启用任何辅助资源。 */
export const NINJA_ONLY_RULE: BattleRule = DEFAULT_RULE

/**
 * Full Loadout Demo：仅用于演示通用资源 Draft，不代表任何官方赛事规则。
 * 每局先执行原 Ninja BP，再选择 1 个秘卷和 3 个有序通灵。
 */
export const FULL_LOADOUT_DEMO_RULE: BattleRule = {
  ...cloneRule(DEFAULT_RULE),
  id: 'full-loadout-demo',
  name: 'Full Loadout Demo（示例）',
  version: '2.0-demo',
  resourceDrafts: [
    {
      resourceType: 'NINJA',
      enabled: true,
      slotsPerSide: 3,
      sequence: [...DEFAULT_RULE.banSequence, ...DEFAULT_RULE.pickSequence],
      crossGameLock: true,
      uniqueAcrossSides: true,
      banPersistence: true,
      banOnlyFirstGame: true,
      resetEachGame: true,
    },
    {
      resourceType: 'SECRET_SCROLL',
      enabled: true,
      slotsPerSide: 1,
      sequence: [
        { side: 'BLUE', action: 'PICK', count: 1 },
        { side: 'RED', action: 'PICK', count: 1 },
      ],
      crossGameLock: false,
      uniqueAcrossSides: true,
      banPersistence: false,
      resetEachGame: true,
    },
    {
      resourceType: 'SUMMON',
      enabled: true,
      slotsPerSide: 3,
      sequence: [
        { side: 'BLUE', action: 'PICK', count: 3 },
        { side: 'RED', action: 'PICK', count: 3 },
      ],
      crossGameLock: false,
      uniqueAcrossSides: true,
      banPersistence: false,
      resetEachGame: true,
    },
  ],
}

/** Ninja BP is unchanged. Auxiliary loadouts are private, simultaneous and per ninja. */
export const WUDOU_LOADOUT_RULE: BattleRule = {
  ...cloneRule(FULL_LOADOUT_DEMO_RULE),
  id: 'wudou-sealed-loadout', name: '武斗完整阵容（同时盲选）', version: '1.0',
  resourceDrafts: FULL_LOADOUT_DEMO_RULE.resourceDrafts!.map((draft) => draft.resourceType === 'NINJA' ? { ...draft } : {
    ...draft, slotsPerSide: 3, uniqueAcrossSides: false, selectionMode: 'SIMULTANEOUS',
    sequence: [{ side: 'BLUE', action: 'PICK', count: 3 }, { side: 'RED', action: 'PICK', count: 3 }],
  }),
}

export const BUILT_IN_RULES: BattleRule[] = [NINJA_ONLY_RULE, FULL_LOADOUT_DEMO_RULE, WUDOU_LOADOUT_RULE]

export function cloneRule(rule: BattleRule): BattleRule {
  return JSON.parse(JSON.stringify(rule)) as BattleRule
}
