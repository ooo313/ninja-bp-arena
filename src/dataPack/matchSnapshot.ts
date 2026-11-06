import type { MatchState, OnlineNinjaSnapshot } from '@bp-core'

/**
 * 比赛 × 数据包快照（v0.4）。
 *
 * - 比赛创建时固化 ninjaSnapshot（显示权威）与 dataPack 元信息；
 *   之后数据包更新 / 忍者删除都不影响进行中与历史比赛
 * - 进行中的比赛保留完整池快照（刷新恢复、BP 网格都靠它）；
 *   保存进历史时压缩（compactMatchForHistory）：只保留实际参与
 *   （Ban / Pick 出现过）的忍者，控制「20 场 × 500 忍者」的存储体积
 */

/** 收集比赛中引用过的忍者 ID（games 的 bans/picks + history） */
export function collectReferencedNinjaIds(match: MatchState): Set<string> {
  const ids = new Set(match.publicBans ?? [])
  for (const action of match.history) ids.add(action.ninjaId)
  for (const game of match.games) {
    for (const id of game.blue.bans) ids.add(id)
    for (const id of game.blue.picks) ids.add(id)
    for (const id of game.red.bans) ids.add(id)
    for (const id of game.red.picks) ids.add(id)
  }
  return ids
}

/**
 * 历史压缩：删除整场未参与的忍者快照，保留规则 / 比分 / 局 / 历史 /
 * 玩家 / dataPack 元信息与参与忍者的显示数据。
 * 进行中的比赛绝不能压缩（ninjaSnapshot 必须完整）。
 */
export function compactMatchForHistory(match: MatchState): MatchState {
  if (!match.ninjaSnapshot && !match.resourceSnapshot) return match
  const referenced = collectReferencedNinjaIds(match)
  const byType = {
    NINJA: new Set(match.publicBans ?? []),
    SECRET_SCROLL: new Set<string>(),
    SUMMON: new Set<string>(),
  }
  for (const action of match.history) byType[action.resourceType ?? 'NINJA'].add(action.resourceId ?? action.ninjaId)
  const compacted: OnlineNinjaSnapshot[] = (match.ninjaSnapshot ?? []).filter((n) => referenced.has(n.id))
  return {
    ...match,
    ninjaSnapshot: compacted,
    ...(match.resourceSnapshot ? {
      resourceSnapshot: {
        ninjas: match.resourceSnapshot.ninjas.filter((item) => byType.NINJA.has(item.id)),
        secretScrolls: match.resourceSnapshot.secretScrolls.filter((item) => byType.SECRET_SCROLL.has(item.id)),
        summons: match.resourceSnapshot.summons.filter((item) => byType.SUMMON.has(item.id)),
      },
    } : {}),
  }
}

/** 比赛的忍者查找表（快照优先；用于名称/头像显示的 fallback 链） */
export function buildSnapshotLookup(snapshot: OnlineNinjaSnapshot[] | undefined): Map<string, OnlineNinjaSnapshot> {
  return new Map((snapshot ?? []).map((n) => [n.id, n]))
}
