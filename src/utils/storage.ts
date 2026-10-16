/**
 * localStorage 统一封装（v2：带 schema 版本与迁移）。
 *
 * 所有持久化都必须经过这里，禁止组件直接调用 localStorage：
 * - 统一 key 前缀
 * - 写入时包装 { __v, data }，读取时校验版本并迁移
 * - JSON 解析失败 / 版本过新 / 校验失败：console.warn 并安全回退，绝不让页面白屏
 */

export const STORAGE_PREFIX = 'ninja-bp.'

/** 当前存储 schema 版本。修改数据结构时递增并补充 migrator。 */
export const STORAGE_SCHEMA_VERSION = 5

export const STORAGE_KEYS = {
  ninjaPool: 'ninja_pool',
  battleRules: 'battle_rules',
  bpSettings: 'bp_settings',
  currentMatch: 'current_match',
  recentMatches: 'recent_matches',
  bpTimer: 'bp_timer',
  sealedLoadouts: 'sealed_loadouts',
  // v0.4 数据包体系
  activeDataPack: 'active_data_pack',
  installedDataPacks: 'installed_data_packs',
  dataPackUpdateState: 'data_pack_update_state',
  customNinjaPool: 'custom_ninja_pool',
  replayLibrary: 'replay_library',
} as const

interface Wrapped<T> {
  __v: number
  data: T
}

function isWrapped<T>(value: unknown): value is Wrapped<T> {
  return typeof value === 'object' && value !== null && '__v' in value && 'data' in value
}

function fullKey(key: string): string {
  return STORAGE_PREFIX + key
}

function getLocalStorage(): Storage | null {
  // 测试环境（Node）下可能没有 localStorage，做一次惰性探测
  try {
    if (typeof globalThis.localStorage !== 'undefined') return globalThis.localStorage
  } catch {
    /* ignore */
  }
  return null
}

export type Migrator = (legacyData: unknown, fromVersion: number) => unknown

/**
 * v1/v2/v3 → v4 Battle Data Pack 迁移入口。
 *
 * v0.3.x 的忍者池（ninja_pool）在 v3 中继续作为「当前生效池」的镜像使用；
 * 结构本身不变，因此数据原样通过。来源分类（内置 / 数据包 / 自定义）由
 * dataPackStore 在首次初始化时判定（与内置示例池逐条比较）。
 * 其它 key 的 v2 数据形状在 v3 中保持不变，同样原样通过。
 */
export function migrateStorageV2ToV3(legacyData: unknown, _fromVersion: number): unknown {
  // v1/v2 与 v3 的共有结构均无字段增删；保留函数作为显式迁移点，
  // 未来 v3 内部结构变化时在此按 _fromVersion 分支处理。
  return legacyData
}

/**
 * 读取并解析 JSON：
 * - v_current 数据直接校验后返回
 * - 更旧版本（含无版本的 v1 遗留数据）先经过 migrate 再校验
 * - 更新版本的数据（用户降级访问）放弃并回退
 * - 校验失败：warn + fallback，绝不让坏数据进入业务状态
 */
export function loadJSON<T>(
  key: string,
  fallback: T,
  validate?: (value: unknown) => boolean,
  migrate?: Migrator,
): T {
  const ls = getLocalStorage()
  if (!ls) return fallback
  try {
    const raw = ls.getItem(fullKey(key))
    if (raw === null || raw === '') return fallback

    const parsed: unknown = JSON.parse(raw)
    let data: unknown
    if (isWrapped<unknown>(parsed)) {
      if (parsed.__v > STORAGE_SCHEMA_VERSION) {
        console.warn(`[storage] "${key}" 来自更新的版本 (v${parsed.__v})，已忽略`)
        return fallback
      }
      if (parsed.__v < STORAGE_SCHEMA_VERSION) {
        data = migrate ? migrate(parsed.data, parsed.__v) : parsed.data
      } else {
        data = parsed.data
      }
    } else {
      // 无版本包装：视为 v1 遗留数据
      data = migrate ? migrate(parsed, 1) : parsed
    }

    if (validate && !validate(data)) {
      console.warn(`[storage] "${key}" 数据校验未通过，已回退为默认值`)
      return fallback
    }
    return data as T
  } catch (err) {
    console.warn(`[storage] "${key}" 数据损坏，已回退为默认值：`, err)
    return fallback
  }
}

export type SaveResult = 'ok' | 'quota' | 'error'

/** 写入：统一包装版本号。返回结果便于上层提示（存储空间不足时不崩溃）。 */
export function saveJSON(key: string, value: unknown): SaveResult {
  const ls = getLocalStorage()
  if (!ls) return 'error'
  try {
    const wrapped: Wrapped<unknown> = { __v: STORAGE_SCHEMA_VERSION, data: value }
    ls.setItem(fullKey(key), JSON.stringify(wrapped))
    return 'ok'
  } catch (err) {
    if (err instanceof DOMException && (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED')) {
      console.warn(`[storage] "${key}" 写入失败：本地存储空间不足`)
      return 'quota'
    }
    console.warn(`[storage] "${key}" 写入失败：`, err)
    return 'error'
  }
}

export function removeKey(key: string): void {
  const ls = getLocalStorage()
  if (!ls) return
  try {
    ls.removeItem(fullKey(key))
  } catch {
    /* ignore */
  }
}

/** 读取原始（未包装）文本 —— 备份 / 调试用途 */
export function readRaw(key: string): string | null {
  const ls = getLocalStorage()
  if (!ls) return null
  try {
    return ls.getItem(fullKey(key))
  } catch {
    return null
  }
}
