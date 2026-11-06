import { matchFormatLabel } from '@bp-core'
import { Link } from 'react-router-dom'
import { History, RotateCcw, Settings2 } from 'lucide-react'
import type { MatchState } from '@/types/match'
import { getPhase } from '@/engine/bpEngine'
import { useTimerStore } from '@/store/timerStore'
import { ScoreBoard } from '@/components/match/ScoreBoard'

interface BPHeaderProps {
  match: MatchState
  onOpenHistory: () => void
  onOpenReset: () => void
}

/** 赛事信息栏：品牌 | BO3 · GAME · 规则 | 比分 | 操作（尽量矮） */
export function BPHeader({ match, onOpenHistory, onOpenReset }: BPHeaderProps) {
  const clearTimer = useTimerStore((s) => s.clear)
  const phase = getPhase(match)

  const iconBtn =
    'rounded border border-border-muted p-1.5 text-fog-400 transition-colors hover:bg-surface-2 hover:text-fog-100'

  return (
    <header className="border-b border-border-muted bg-ink-900/90 backdrop-blur">
      <div className="mx-auto flex h-12 w-full max-w-[1500px] items-center justify-between gap-3 px-2.5 lg:px-5">
        <div className="flex items-center gap-3">
          <Link to="/" className="flex items-center gap-1.5" aria-label="返回首页">
            <span className="flex h-7 w-7 items-center justify-center rounded bg-gradient-to-br from-blue-team/30 to-surface-1 text-xs font-bold text-blue-team-soft ring-1 ring-blue-team/40">
              忍
            </span>
            <span className="hidden text-sm font-bold tracking-wide text-fog-100 sm:block">忍界 BP</span>
          </Link>
          <span className="hidden items-center gap-1.5 text-[11px] tracking-widest text-fog-600 md:flex">
            <span className="font-semibold text-gold-accent">GAME {phase.gameNumber}</span>
            <span>/</span>
            <span>{matchFormatLabel(match.rule.bestOf)}</span>
            <span className="max-w-[160px] truncate">{match.rule.name}</span>
          </span>
        </div>

        <ScoreBoard match={match} />

        <div className="flex items-center gap-1">
          <button type="button" onClick={onOpenHistory} className={iconBtn} aria-label="历史记录" title="历史记录">
            <History size={15} />
          </button>
          <button type="button" onClick={onOpenReset} className={iconBtn} aria-label="重置比赛" title="重置比赛">
            <RotateCcw size={15} />
          </button>
          <Link
            to="/settings"
            onClick={() => clearTimer()}
            className={iconBtn}
            aria-label="规则设置"
            title="规则设置"
          >
            <Settings2 size={15} />
          </Link>
        </div>
      </div>
    </header>
  )
}
