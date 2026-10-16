import { sideAtPosition } from '@bp-core'
import type { Side } from '@/types/bp'
import type { MatchState } from '@/types/match'

interface PlayingStageProps {
  match: MatchState
  /** 点击「XX获胜」后由 BPPage 弹出二次确认 */
  onRequestWinner: (side: Side) => void
}

/** 比赛进行中：本局胜负记录入口（带二次确认） */
export function PlayingStage({ match, onRequestWinner }: PlayingStageProps) {
  const game = match.games[match.games.length - 1]
  return (
    <section className="rounded-xl border border-ink-600 bg-ink-800/70 p-6 text-center lg:p-8">
      <p className="text-xs tracking-widest text-fog-600">GAME {game.gameNumber} · IN PROGRESS</p>
      <h2 className="mt-2 text-lg font-bold text-fog-100 lg:text-xl">本局比赛进行中</h2>
      <p className="mt-1 text-xs text-fog-500">对局结束后，由裁判 / 管理员记录本局胜者</p>
      <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={() => onRequestWinner(sideAtPosition(match, 'BLUE'))}
          className="rounded-lg bg-side-blue px-6 py-2.5 text-sm font-bold text-white transition-all hover:brightness-110 active:scale-[0.98]"
        >
          蓝方获胜
        </button>
        <button
          type="button"
          onClick={() => onRequestWinner(sideAtPosition(match, 'RED'))}
          className="rounded-lg bg-side-red px-6 py-2.5 text-sm font-bold text-white transition-all hover:brightness-110 active:scale-[0.98]"
        >
          红方获胜
        </button>
      </div>
      <p className="mt-3 text-xs text-fog-600">点击后需二次确认，防止误触</p>
    </section>
  )
}
