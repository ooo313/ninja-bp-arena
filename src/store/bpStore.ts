import { create } from 'zustand'
import type { DraftResourceType, Side } from '@bp-core'
import type { MatchState } from '@/types/match'
import type { BattleRule } from '@/types/bp'
import {
  createMatch,
  enterGame,
  nextGame,
  resetCurrentGame,
  selectNinja,
  selectResource,
  setGameWinner,
  startMatch,
} from '@/engine/bpEngine'
import { getResource, snapshotResources, getSealedDraft, isPrivateLoadout, revealSealedLoadouts, validateSealedLoadout, type PrivateLoadout } from '@bp-core'
import { emptyStacks, recordSnapshot, redo, undo, type UndoStacks } from '@/engine/historyEngine'
import { validateMatchState } from '@/engine/matchValidator'
import { useNinjaStore } from './ninjaStore'
import { useSettingsStore } from './settingsStore'
import { buildMatchPackSnapshot } from '@/dataPack/store'
import { compactMatchForHistory } from '@/dataPack/matchSnapshot'
import { playSound } from '@/utils/sound'
import { loadJSON, readRaw, removeKey, saveJSON, STORAGE_KEYS } from '@/utils/storage'
import { toast } from './toastStore'
import { useReplayStore } from '@/replay/replayStore'

/**
 * BP 比赛 Store：引擎的 React 绑定层。
 *
 * 撤销/重做在这里完成：每次变更前把完整 MatchState 压入快照栈，
 * 撤销 = 弹出快照整体恢复，因此阶段、比分、Ban/Pick、可用性永远一致。
 * 进行中的比赛每次变更都会写入 localStorage（current_match），
 * 刷新页面后可以恢复到当前步骤。
 */

const MAX_RECENT = 20
const initialCurrentMatch = loadJSON<MatchState | null>(STORAGE_KEYS.currentMatch, null, (value) => validateMatchState(value))
const initialCurrentMatchCorrupt = readRaw(STORAGE_KEYS.currentMatch) !== null && initialCurrentMatch === null

interface OpResult {
  ok: boolean
  reason?: string
}

/** 从本地数组中筛出合法比赛，丢弃损坏条目并给出警告 */
function sanitizeMatchList(raw: unknown, source: string): MatchState[] {
  if (!Array.isArray(raw)) return []
  const valid: MatchState[] = []
  for (const item of raw) {
    if (validateMatchState(item)) {
      valid.push(item as MatchState)
    } else {
      console.warn(`[bpStore] ${source} 中存在损坏的比赛记录，已丢弃`)
    }
  }
  return valid
}

interface BPStore {
  privateLoadouts: Partial<Record<Side, PrivateLoadout>>
  submitLoadout: (side: Side, type: DraftResourceType, ids: string[]) => OpResult
  match: MatchState | null
  currentMatchCorrupt: boolean
  stacks: UndoStacks
  recentMatches: MatchState[]

  /** 新建并开始比赛（首页「开始 BP」） */
  startNewMatch: (bluePlayerName?: string, redPlayerName?: string, ruleOverride?: BattleRule) => MatchState
  /** 继续历史中的未完成比赛 */
  continueMatch: (id: string) => MatchState | null
  selectNinja: (ninjaId: string) => OpResult
  selectResource: (resourceType: DraftResourceType, resourceId: string) => OpResult
  undo: () => boolean
  redo: () => boolean
  canUndo: () => boolean
  canRedo: () => boolean
  enterGame: () => OpResult
  setGameWinner: (side: Side) => OpResult
  nextGame: () => OpResult
  resetCurrentGame: () => OpResult
  /** 重置比赛：相同规则与选手，开始全新一场 */
  resetMatch: () => void
  deleteRecent: (id: string) => void
  clearCurrent: () => void
  /** 恢复备份：整体替换当前比赛与历史（数据已在上层校验） */
  restoreBackup: (currentMatch: MatchState | null, recentMatches: MatchState[]) => void
  /** 在线比赛结束后保存到本地历史（按 id 去重，不覆盖当前比赛） */
  saveExternalMatch: (match: MatchState, roomId?: string) => void
}

/** 应用一次引擎变更：压快照 → 更新状态 → 持久化（含最近比赛列表） */
function commit(next: MatchState) {
  const { match, stacks } = useBPStore.getState()
  if (!match) return
  const newStacks = recordSnapshot(stacks, match)
  useBPStore.setState({ match: next, stacks: newStacks })
  useBPStore.setState({ privateLoadouts: {} })
  saveJSON(STORAGE_KEYS.sealedLoadouts, {})
  persistMatch(next)
}

function persistMatch(match: MatchState) {
  const currentSaved = saveJSON(STORAGE_KEYS.currentMatch, match)
  // 历史条目：进行中的比赛保留完整池快照（可继续）；已结束的比赛压缩
  // （只保留参与忍者的显示数据），避免「20 场 × 全量快照」撑爆存储
  const forHistory = match.status === 'MATCH_FINISHED' ? compactMatchForHistory(match) : match
  const recent = [forHistory, ...useBPStore.getState().recentMatches.filter((m) => m.id !== match.id)].slice(0, MAX_RECENT)
  useBPStore.setState({ recentMatches: recent })
  const saved = saveJSON(STORAGE_KEYS.recentMatches, recent)
  if (currentSaved === 'quota' || saved === 'quota') {
    toast('本地存储空间不足，比赛或历史记录可能未保存', 'error')
  }
  if (match.status === 'MATCH_FINISHED') useReplayStore.getState().saveFromMatch(forHistory, 'LOCAL')
}

export const useBPStore = create<BPStore>()((set, get) => ({
  privateLoadouts: loadJSON(STORAGE_KEYS.sealedLoadouts, {}, (value) => typeof value === 'object' && value !== null && Object.entries(value).every(([side, item]) => isPrivateLoadout(item) && item.side === side)),
  submitLoadout: (side, type, ids) => {
    const match = get().match
    if (!match) return { ok: false, reason: '没有进行中的比赛' }
    const phase = getSealedDraft(match)
    const resources = snapshotResources(match.resourceSnapshot)
    const reason = validateSealedLoadout(match, side, type, ids, resources)
    if (!phase || reason) return { ok: false, reason: reason ?? '当前不是同时选择阶段' }
    if (get().privateLoadouts[side]?.phase_key === phase.key) return { ok: false, reason: '己方已确认，等待对手完成' }
    const otherSide = side === 'BLUE' ? 'RED' : 'BLUE'
    const other = get().privateLoadouts[otherSide]
    if (other?.phase_key === phase.key) {
      const result = revealSealedLoadouts(match, { [side]: ids, [otherSide]: other.resource_ids } as Record<Side, string[]>, resources, Date.now(), { BLUE: crypto.randomUUID(), RED: crypto.randomUUID() })
      if (!result.ok || !result.state) return { ok: false, reason: result.reason }
      commit(result.state)
    } else {
      const privateLoadouts = { [side]: { phase_key: phase.key, side, resource_ids: [...ids] } }
      set({ privateLoadouts })
      saveJSON(STORAGE_KEYS.sealedLoadouts, privateLoadouts)
    }
    return { ok: true }
  },
  // 启动即恢复最近一场比赛：严格校验，损坏数据整体回退为 null
  match: initialCurrentMatch,
  currentMatchCorrupt: initialCurrentMatchCorrupt,
  stacks: emptyStacks(),
  recentMatches: sanitizeMatchList(loadJSON<unknown>(STORAGE_KEYS.recentMatches, []), 'recent_matches'),

  startNewMatch: (bluePlayerName, redPlayerName, ruleOverride) => {
    const rule = ruleOverride ?? useSettingsStore.getState().activeRule()
    // v0.4：创建比赛时固化忍者池快照与数据包元信息；
    // 之后数据包更新 / 忍者删除不影响进行中的比赛与历史显示
    const packSnapshot = buildMatchPackSnapshot()
    const match: MatchState = {
      ...startMatch(createMatch(rule, bluePlayerName, redPlayerName, { id: crypto.randomUUID(), now: Date.now() }), { now: Date.now() }),
      ...(packSnapshot.dataPack ? { dataPack: packSnapshot.dataPack } : {}),
      ninjaSnapshot: packSnapshot.ninjaSnapshot,
      resourceSnapshot: packSnapshot.resourceSnapshot,
    }
    set({ match, stacks: emptyStacks(), currentMatchCorrupt: false, privateLoadouts: {} })
    saveJSON(STORAGE_KEYS.sealedLoadouts, {})
    persistMatch(match)
    return match
  },

  continueMatch: (id) => {
    const found = get().recentMatches.find((m) => m.id === id)
    if (!found) return null
    set({ match: found, stacks: emptyStacks() })
    saveJSON(STORAGE_KEYS.currentMatch, found)
    return found
  },

  selectNinja: (ninjaId) => {
    const match = get().match
    if (!match) return { ok: false, reason: '没有进行中的比赛' }
    const ninja = match.resourceSnapshot?.ninjas.find((item) => item.id === ninjaId)
      ?? match.ninjaSnapshot?.find((item) => item.id === ninjaId)
      ?? useNinjaStore.getState().getById(ninjaId)
    const result = selectNinja(match, ninjaId, ninja, { now: Date.now() })
    if (!result.ok || !result.state) return { ok: false, reason: result.reason }
    commit(result.state)
    const lastAction = result.state.history[result.state.history.length - 1]
    playSound(lastAction?.action === 'BAN' ? 'ban' : 'select', useSettingsStore.getState().settings.soundEnabled)
    return { ok: true }
  },

  selectResource: (resourceType, resourceId) => {
    if (resourceType === 'NINJA') return get().selectNinja(resourceId)
    const match = get().match
    if (!match) return { ok: false, reason: '没有进行中的比赛' }
    if (getSealedDraft(match)) return { ok: false, reason: '请整组确认阵容，双方完成后统一公开' }
    const resource = getResource(snapshotResources(match.resourceSnapshot), resourceType, resourceId)
    const result = selectResource(match, resourceType, resourceId, resource, { now: Date.now() })
    if (!result.ok || !result.state) return { ok: false, reason: result.reason }
    commit(result.state)
    const lastAction = result.state.history[result.state.history.length - 1]
    playSound(lastAction?.action === 'BAN' ? 'ban' : 'select', useSettingsStore.getState().settings.soundEnabled)
    return { ok: true }
  },

  undo: () => {
    const match = get().match
    if (!match) return false
    const result = undo(match, get().stacks)
    if (!result.ok || !result.state) {
      if (result.reason) toast(result.reason)
      return false
    }
    set({ match: result.state, stacks: result.stacks, privateLoadouts: {} })
    saveJSON(STORAGE_KEYS.sealedLoadouts, {})
    persistMatch(result.state)
    return true
  },

  redo: () => {
    const match = get().match
    if (!match) return false
    const result = redo(match, get().stacks)
    if (!result.ok || !result.state) {
      if (result.reason) toast(result.reason)
      return false
    }
    set({ match: result.state, stacks: result.stacks, privateLoadouts: {} })
    saveJSON(STORAGE_KEYS.sealedLoadouts, {})
    persistMatch(result.state)
    return true
  },

  canUndo: () => get().stacks.past.length > 0,
  canRedo: () => get().stacks.future.length > 0,

  enterGame: () => {
    const match = get().match
    if (!match) return { ok: false, reason: '没有进行中的比赛' }
    const result = enterGame(match, { now: Date.now() })
    if (!result.ok || !result.state) return { ok: false, reason: result.reason }
    commit(result.state)
    return { ok: true }
  },

  setGameWinner: (side) => {
    const match = get().match
    if (!match) return { ok: false, reason: '没有进行中的比赛' }
    const result = setGameWinner(match, side, { now: Date.now() })
    if (!result.ok || !result.state) return { ok: false, reason: result.reason }
    commit(result.state)
    playSound('win', useSettingsStore.getState().settings.soundEnabled)
    return { ok: true }
  },

  nextGame: () => {
    const match = get().match
    if (!match) return { ok: false, reason: '没有进行中的比赛' }
    const result = nextGame(match, { now: Date.now() })
    if (!result.ok || !result.state) return { ok: false, reason: result.reason }
    commit(result.state)
    return { ok: true }
  },

  resetCurrentGame: () => {
    const match = get().match
    if (!match) return { ok: false, reason: '没有进行中的比赛' }
    const result = resetCurrentGame(match, { now: Date.now() })
    if (!result.ok || !result.state) return { ok: false, reason: result.reason }
    commit(result.state)
    return { ok: true }
  },

  resetMatch: () => {
    const match = get().match
    if (!match) return
    get().startNewMatch(match.bluePlayerName, match.redPlayerName)
  },

  deleteRecent: (id) => {
    const recent = get().recentMatches.filter((m) => m.id !== id)
    set({ recentMatches: recent })
    saveJSON(STORAGE_KEYS.recentMatches, recent)
    if (get().match?.id === id) {
      set({ match: null })
      removeKey(STORAGE_KEYS.currentMatch)
    }
  },

  clearCurrent: () => {
    set({ match: null, currentMatchCorrupt: false })
    removeKey(STORAGE_KEYS.currentMatch)
  },

  restoreBackup: (currentMatch, recentMatches) => {
    const nextRecent = recentMatches.slice(0, MAX_RECENT)
    set({ match: currentMatch, currentMatchCorrupt: false, stacks: emptyStacks(), recentMatches: nextRecent })
    if (currentMatch) saveJSON(STORAGE_KEYS.currentMatch, currentMatch)
    else removeKey(STORAGE_KEYS.currentMatch)
    saveJSON(STORAGE_KEYS.recentMatches, nextRecent)
  },

  saveExternalMatch: (match, roomId) => {
    if (!validateMatchState(match)) {
      toast('该比赛数据未通过校验，无法保存', 'error')
      return
    }
    const forHistory = match.status === 'MATCH_FINISHED' ? compactMatchForHistory(match) : match
    const recent = [forHistory, ...get().recentMatches.filter((m) => m.id !== match.id)].slice(0, MAX_RECENT)
    set({ recentMatches: recent })
    saveJSON(STORAGE_KEYS.recentMatches, recent)
    if (match.status === 'MATCH_FINISHED') useReplayStore.getState().saveFromMatch(forHistory, 'ONLINE', roomId)
  },
}))
