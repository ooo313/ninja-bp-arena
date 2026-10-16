import { sideAtPosition } from '@bp-core'
import { Eye } from 'lucide-react'
import { getPhase, RESOURCE_TYPE_LABEL } from '@bp-core'
import { useMatchSource } from '@/matchSource/context'
import { useOnlineRoomStore } from '@/online/onlineRoomStore'
import { PlayerPanel } from '@/components/bp/PlayerPanel'
import { BPStage } from '@/components/bp/BPStage'
import { ScoreBoard } from '@/components/match/ScoreBoard'

/** 只读 16:9 赛事画面；本组件不渲染、也不持有任何命令入口。 */
export function PresentationView({ code }: { code: string }) {
  const source = useMatchSource()
  const connection = useOnlineRoomStore((state) => state.connection)
  const match = source.match
  if (!match) {
    return <main className="flex min-h-screen items-center justify-center bg-arena-bg text-fog-300">房间 {code} 等待比赛开始</main>
  }
  const phase = getPhase(match)
  return (
    <main data-testid="presentation-view" className="min-h-screen overflow-hidden bg-arena-bg p-4 text-fog-100 lg:p-8">
      <div className="mx-auto flex min-h-[calc(100vh-2rem)] max-w-[1920px] flex-col rounded-2xl border border-border-muted bg-ink-900/80 p-4 shadow-2xl lg:min-h-[calc(100vh-4rem)] lg:p-7">
        <header className="flex items-center justify-between border-b border-border-muted pb-4">
          <div>
            <p className="text-xs font-bold tracking-[0.3em] text-gold-accent">NINJA BP ARENA · PRESENTATION</p>
            <p className="mt-1 font-mono text-xs text-fog-600">ROOM {code}</p>
          </div>
          <ScoreBoard match={match} />
          <div className="text-right">
            <p className="flex items-center justify-end gap-1.5 text-xs font-bold text-violet-300"><Eye size={14} /> 观战展示 · 只读</p>
            <p className="mt-1 text-[10px] text-fog-600">{connection === 'connected' ? 'CONNECTED' : connection === 'offline' ? 'DISCONNECTED' : 'SYNCING'}</p>
          </div>
        </header>
        <div className="grid flex-1 items-stretch gap-5 py-5 lg:grid-cols-[minmax(300px,1fr)_minmax(420px,1.35fr)_minmax(300px,1fr)]">
          <PlayerPanel side={sideAtPosition(match, 'BLUE')} />
          <div className="flex flex-col justify-center gap-5">
            <BPStage match={match} timeoutActive={false} onResumeTimeout={() => undefined} onRestartTimer={() => undefined} onTimerExpire={() => undefined} deadlineOverride={source.onlineDeadline} />
            <section className="rounded-xl border border-border-muted bg-surface-1/60 p-6 text-center">
              <p className="text-xs tracking-[0.25em] text-fog-600">CURRENT PHASE</p>
              <p className="mt-3 text-3xl font-black tracking-wide text-fog-100">
                {phase.side ? `${sideAtPosition(match, phase.side)} ${phase.action}` : phase.status}
              </p>
              <p className="mt-2 text-sm text-fog-400">{phase.resourceType ? RESOURCE_TYPE_LABEL[phase.resourceType] : '比赛状态'} · GAME {phase.gameNumber}</p>
            </section>
          </div>
          <PlayerPanel side={sideAtPosition(match, 'RED')} />
        </div>
      </div>
    </main>
  )
}
