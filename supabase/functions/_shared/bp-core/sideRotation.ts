import type { BattleRule, MatchState, Side } from './types.ts'

/** Involution: maps an original player to their screen color, or a screen color
 * to its current player. Never rotate database seats, scores or private rows. */
export function rotateSide(rule: Pick<BattleRule, 'swapSidesEachGame'>, gameNumber: number, side: Side): Side {
  return rule.swapSidesEachGame && gameNumber % 2 === 0 ? side === 'BLUE' ? 'RED' : 'BLUE' : side
}

export function sideAtPosition(match: MatchState, position: Side, gameNumber = match.currentGame): Side {
  return rotateSide(match.rule, gameNumber, position)
}

export function sideLabel(match: MatchState, player: Side, gameNumber = match.currentGame): string {
  return sideAtPosition(match, player, gameNumber) === 'BLUE' ? '蓝方' : '红方'
}

export function playerName(match: MatchState, player: Side): string {
  return player === 'BLUE' ? match.bluePlayerName : match.redPlayerName
}

export function playerScore(match: MatchState, player: Side): number {
  return player === 'BLUE' ? match.score.blue : match.score.red
}
