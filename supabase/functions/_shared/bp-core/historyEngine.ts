import type { MatchState } from './types.ts'
import { SIDE_TEXT, ACTION_TEXT, type BPAction } from './types.ts'
import { sideLabel, playerName, sideAtPosition } from './sideRotation.ts'
import { RESOURCE_TYPE_LABEL } from './resourceRegistry.ts'

/**
 * 历史引擎：
 * 1. 撤销 / 重做 —— 采用可靠的状态快照（完整 MatchState 克隆），
 *    撤销任何一步（Ban / Pick / 记录胜负 / 进入下一局）都能精确还原
 *    可用状态、比分、Ban/Pick、可用性、阶段、行动方与历史记录，不会出现
 *    “撤销后仍不可选”。（本地模式使用；在线模式服务端用 bpEngine.undoLastAction）
 * 2. BP 历史的可读化（Drawer 展示、结果分享文本）。
 */

export interface UndoStacks {
  past: MatchState[]
  future: MatchState[]
}

const MAX_SNAPSHOTS = 300

export function emptyStacks(): UndoStacks {
  return { past: [], future: [] }
}

/** 每次变更前记录快照；新动作会清空重做栈 */
export function recordSnapshot(stacks: UndoStacks, m: MatchState): UndoStacks {
  return {
    past: [...stacks.past.slice(-(MAX_SNAPSHOTS - 1)), m],
    future: [],
  }
}

export interface UndoResult {
  ok: boolean
  state?: MatchState
  stacks: UndoStacks
  reason?: string
}

/** 撤销：恢复到最近一次变更前的快照 */
export function undo(m: MatchState, stacks: UndoStacks): UndoResult {
  const previous = stacks.past[stacks.past.length - 1]
  if (!previous) return { ok: false, stacks, reason: '没有可撤销的操作' }
  return {
    ok: true,
    state: previous,
    stacks: {
      past: stacks.past.slice(0, -1),
      future: [...stacks.future.slice(-(MAX_SNAPSHOTS - 1)), m],
    },
  }
}

/** 重做：与撤销对称 */
export function redo(m: MatchState, stacks: UndoStacks): UndoResult {
  const next = stacks.future[stacks.future.length - 1]
  if (!next) return { ok: false, stacks, reason: '没有可重做的操作' }
  return {
    ok: true,
    state: next,
    stacks: {
      past: [...stacks.past.slice(-(MAX_SNAPSHOTS - 1)), m],
      future: stacks.future.slice(0, -1),
    },
  }
}

// ---------------------------------------------------------------------------
// 历史可读化
// ---------------------------------------------------------------------------

export interface HistoryGroup {
  gameNumber: number
  actions: BPAction[]
  winner?: 'BLUE' | 'RED'
}

/** 按 Game 分组的历史（保持时间顺序） */
export function groupHistoryByGame(m: MatchState): HistoryGroup[] {
  const groups = new Map<number, HistoryGroup>()
  for (const action of m.history) {
    let group = groups.get(action.gameNumber)
    if (!group) {
      group = { gameNumber: action.gameNumber, actions: [] }
      groups.set(action.gameNumber, group)
    }
    group.actions.push(action)
  }
  for (const g of m.games) {
    const group = groups.get(g.gameNumber)
    if (group && g.winner) group.winner = g.winner
  }
  return [...groups.values()].sort((a, b) => a.gameNumber - b.gameNumber)
}

export function formatActionText(action: BPAction, nameOf: (id: string) => string): string {
  const side = SIDE_TEXT[action.side]
  const act = ACTION_TEXT[action.action]
  const resourceType = action.resourceType ?? 'NINJA'
  return `${side} ${act}${RESOURCE_TYPE_LABEL[resourceType]} ${nameOf(action.resourceId ?? action.ninjaId)}`
}

export const SIDE_NAME: Record<'BLUE' | 'RED', string> = SIDE_TEXT

/** 生成纯文本赛果（复制 / 分享用） */
export function buildShareText(
  m: MatchState,
  nameOf: (id: string) => string,
  resourceNameOf: (type: 'SECRET_SCROLL' | 'SUMMON', id: string) => string = (_type, id) => id,
): string {
  const lines: string[] = []
  const finished = m.status === 'MATCH_FINISHED'
  const winnerSide = m.score.blue >= m.rule.winsRequired ? 'BLUE' : m.score.red >= m.rule.winsRequired ? 'RED' : null

  lines.push('忍界 BP｜武斗赛模拟结果')
  lines.push(`${m.rule.name}`)
  lines.push(m.rule.swapSidesEachGame ? `BO${m.rule.bestOf}  ${m.bluePlayerName} ${m.score.blue} : ${m.score.red} ${m.redPlayerName}` : `BO${m.rule.bestOf}  蓝方 ${m.score.blue} : ${m.score.red} 红方`)
  if (finished && winnerSide) {
    lines.push(`总胜者：${sideLabel(m, winnerSide)}（${playerName(m, winnerSide)}）`)
  }
  lines.push('')

  for (const game of m.games) {
    const blueLabel = sideLabel(m, 'BLUE', game.gameNumber), redLabel = sideLabel(m, 'RED', game.gameNumber)
    lines.push(`【GAME ${game.gameNumber}】`)
    if (m.rule.swapSidesEachGame) lines.push(`左侧蓝方：${playerName(m, sideAtPosition(m, 'BLUE', game.gameNumber))}；右侧红方：${playerName(m, sideAtPosition(m, 'RED', game.gameNumber))}`)
    const bans = [...game.blue.bans, ...game.red.bans]
    if (bans.length) {
      lines.push('【BAN】')
      lines.push(`${blueLabel}：${game.blue.bans.map(nameOf).join('、') || '无'}`)
      lines.push(`${redLabel}：${game.red.bans.map(nameOf).join('、') || '无'}`)
      lines.push('')
    }
    lines.push(`${blueLabel}：${game.blue.picks.map((id, i) => `${i + 1}. ${nameOf(id)}`).join('　') || '无'}`)
    lines.push(`${redLabel}：${game.red.picks.map((id, i) => `${i + 1}. ${nameOf(id)}`).join('　') || '无'}`)
    const blueScrolls = game.blue.resources?.SECRET_SCROLL?.picks ?? []
    const redScrolls = game.red.resources?.SECRET_SCROLL?.picks ?? []
    const blueSummons = game.blue.resources?.SUMMON?.picks ?? []
    const redSummons = game.red.resources?.SUMMON?.picks ?? []
    if (blueScrolls.length || redScrolls.length) {
      lines.push(`${blueLabel}秘卷：${blueScrolls.map((id) => resourceNameOf('SECRET_SCROLL', id)).join('、') || '无'}`)
      lines.push(`${redLabel}秘卷：${redScrolls.map((id) => resourceNameOf('SECRET_SCROLL', id)).join('、') || '无'}`)
    }
    if (blueSummons.length || redSummons.length) {
      lines.push(`${blueLabel}通灵：${blueSummons.map((id, i) => `${i + 1}. ${resourceNameOf('SUMMON', id)}`).join('　') || '无'}`)
      lines.push(`${redLabel}通灵：${redSummons.map((id, i) => `${i + 1}. ${resourceNameOf('SUMMON', id)}`).join('　') || '无'}`)
    }
    if (game.winner) lines.push(`胜者：${sideLabel(m, game.winner, game.gameNumber)}`)
    lines.push('')
  }

  lines.push('—— 本工具为玩家制作的非官方赛事 BP 辅助工具 ——')
  return lines.join('\n')
}
