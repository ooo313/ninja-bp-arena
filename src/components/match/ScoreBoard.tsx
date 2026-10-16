import { sideAtPosition, playerName, playerScore } from '@bp-core'
import type { MatchState } from '@/types/match'
import { getPhase } from '@/engine/bpEngine'

interface ScoreBoardProps {
  match: MatchState
}

/** 顶栏比分：蓝方 X : Y 红方 + GAME n */
export function ScoreBoard({ match }: ScoreBoardProps) {
  const phase = getPhase(match)
  const left = sideAtPosition(match, 'BLUE'), right = sideAtPosition(match, 'RED')
  const matchOver = match.status === 'MATCH_FINISHED'
  return (
    <div data-testid="scoreboard" className="flex items-center gap-2 sm:gap-4">
      <div className="flex flex-col items-end leading-tight sm:items-center">
        <span className="text-xs font-semibold text-side-blue-soft sm:text-sm">{playerName(match, left)}</span>
        <span className="text-[9px] tracking-widest text-fog-600">BLUE</span>
      </div>
      <div className="flex flex-col items-center">
        <span
          key={`${playerScore(match, left)}-${playerScore(match, right)}`}
          className="score-pop text-lg font-bold tabular-nums tracking-wider text-fog-100 sm:text-2xl"
        >
          {playerScore(match, left)}
          <span className="mx-1.5 text-fog-600">:</span>
          {playerScore(match, right)}
        </span>
        <span className="text-[9px] tracking-widest text-fog-600">
          {matchOver ? 'MATCH FINISHED' : `GAME ${phase.gameNumber} / BO${match.rule.bestOf}`}
        </span>
      </div>
      <div className="flex flex-col items-start leading-tight sm:items-center">
        <span className="text-xs font-semibold text-side-red-soft sm:text-sm">{playerName(match, right)}</span>
        <span className="text-[9px] tracking-widest text-fog-600">RED</span>
      </div>
    </div>
  )
}
