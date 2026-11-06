import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Pause, Play, RotateCcw } from 'lucide-react'
import { reconstructReplayAt, replayStepForGame, type BPReplay, type DraftResourceType } from '@bp-core'

interface Props {
  replay: BPReplay
  shared?: boolean
}

const TYPE_TEXT: Record<DraftResourceType, string> = { NINJA: '忍者', SECRET_SCROLL: '秘卷', SUMMON: '通灵' }

export function ReplayViewer({ replay, shared }: Props) {
  const [step, setStep] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const state = useMemo(() => reconstructReplayAt(replay, step), [replay, step])
  const resources = useMemo(() => new Map(replay.resourceSnapshot.map((item) => [`${item.resourceType}:${item.id}`, item])), [replay])
  const nameOf = (type: DraftResourceType, id: string) => resources.get(`${type}:${id}`)?.name ?? id

  useEffect(() => {
    if (!playing) return
    if (step >= replay.actions.length) { setPlaying(false); return }
    const timer = window.setTimeout(() => setStep((value) => Math.min(value + 1, replay.actions.length)), 1000 / speed)
    return () => window.clearTimeout(timer)
  }, [playing, replay.actions.length, speed, step])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return
      if (event.code === 'Space') { event.preventDefault(); setPlaying((value) => !value) }
      else if (event.key === 'ArrowLeft') setStep((value) => Math.max(0, value - 1))
      else if (event.key === 'ArrowRight') setStep((value) => Math.min(replay.actions.length, value + 1))
      else if (event.key === 'Home') setStep(0)
      else if (event.key === 'End') setStep(replay.actions.length)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [replay.actions.length])

  const currentAction = step > 0 ? replay.actions[step - 1] : null
  return (
    <section aria-label="BP 复盘播放器" className="overflow-hidden rounded-xl border border-border-strong bg-surface-1">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border-muted px-4 py-3">
        <div>
          <p className="text-xs font-black tracking-[0.28em] text-gold-accent">REPLAY</p>
          <p className="mt-1 text-[11px] text-fog-500">{shared ? '用户分享的 BP 记录' : `${replay.source} · 只读复盘`} · Step {step}/{replay.actions.length}</p>
        </div>
        <div className="flex items-center gap-3 text-center">
          <span className="max-w-28 truncate text-sm font-semibold text-blue-team-soft">{replay.players.blue}</span>
          <strong className="text-3xl tabular-nums text-fog-100">{state.score.blue} : {state.score.red}</strong>
          <span className="max-w-28 truncate text-sm font-semibold text-red-team-soft">{replay.players.red}</span>
        </div>
      </header>
      {replay.publicBans?.length ? <p className="px-4 pt-3 text-xs text-gold-accent">全场公 Ban · {replay.publicBans.map((id) => nameOf('NINJA', id)).join('、')}</p> : null}

      <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <div className="space-y-4">
          <div className="rounded-lg border border-border-muted bg-ink-900/60 p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-bold tracking-widest text-fog-200">GAME {state.currentGame}</h2>
              {currentAction ? (
                <span className={currentAction.side === 'BLUE' ? 'text-blue-team-soft' : 'text-red-team-soft'}>
                  {currentAction.side} {currentAction.type}
                </span>
              ) : <span className="text-fog-600">初始状态</span>}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {(['BLUE', 'RED'] as const).map((sideName) => {
                const game = state.games.find((item) => item.gameNumber === state.currentGame)
                const side = sideName === 'BLUE' ? game?.blue : game?.red
                return <div key={sideName} className={`rounded border p-3 ${sideName === 'BLUE' ? 'border-blue-team/25' : 'border-red-team/25'}`}>
                  <p className={`mb-2 text-xs font-bold ${sideName === 'BLUE' ? 'text-blue-team-soft' : 'text-red-team-soft'}`}>{sideName}</p>
                  {(['NINJA', 'SECRET_SCROLL', 'SUMMON'] as const).map((type) => {
                    const picks = side?.[type].picks ?? []
                    const bans = side?.[type].bans ?? []
                    if (!picks.length && !bans.length) return null
                    return <div key={type} className="mb-2 text-xs leading-relaxed">
                      <p className="text-fog-600">{TYPE_TEXT[type]}</p>
                      {bans.length > 0 && <p className="text-red-team-soft/75">BAN · {bans.map((id) => nameOf(type, id)).join('、')}</p>}
                      {picks.length > 0 && <p className="text-fog-200">PICK · {picks.map((id) => nameOf(type, id)).join('、')}</p>}
                    </div>
                  })}
                </div>
              })}
            </div>
            {currentAction && <div className="mt-4 rounded bg-surface-2 px-3 py-2 text-sm text-fog-200" aria-live="polite">
              {currentAction.side} {currentAction.type}
              {currentAction.resourceType && currentAction.resourceId ? ` · ${TYPE_TEXT[currentAction.resourceType]} · ${nameOf(currentAction.resourceType, currentAction.resourceId)}` : ` · GAME ${currentAction.gameNumber} 胜者`}
              {currentAction.timestamp ? <time className="ml-2 text-xs text-fog-600">{new Date(currentAction.timestamp).toLocaleTimeString()}</time> : null}
            </div>}
            {state.complete && <p className="mt-4 text-center text-sm font-bold text-gold-accent">最终比分 {replay.finalScore.blue} : {replay.finalScore.red} · {replay.winner} 胜</p>}
          </div>

          <div className="sticky bottom-2 z-10 flex flex-wrap items-center justify-center gap-2 rounded-lg border border-border-strong bg-ink-900/95 p-3 shadow-xl">
            <button type="button" aria-label="重置复盘" onClick={() => { setPlaying(false); setStep(0) }} className="rounded border border-border-strong p-2 text-fog-300"><RotateCcw size={16} /></button>
            <button type="button" aria-label="上一步" disabled={step === 0} onClick={() => setStep((value) => Math.max(0, value - 1))} className="rounded border border-border-strong p-2 text-fog-300 disabled:opacity-30"><ChevronLeft size={16} /></button>
            <button type="button" aria-label={playing ? '暂停' : '播放'} onClick={() => setPlaying((value) => !value)} className="flex items-center gap-1.5 rounded bg-blue-team px-4 py-2 text-xs font-bold text-white">
              {playing ? <Pause size={15} /> : <Play size={15} />} {playing ? '暂停' : '播放'}
            </button>
            <button type="button" aria-label="下一步" disabled={step === replay.actions.length} onClick={() => setStep((value) => Math.min(replay.actions.length, value + 1))} className="rounded border border-border-strong p-2 text-fog-300 disabled:opacity-30"><ChevronRight size={16} /></button>
            <label className="ml-1 text-xs text-fog-500">速度 <select aria-label="播放速度" value={speed} onChange={(event) => setSpeed(Number(event.target.value))} className="rounded border border-border-strong bg-surface-2 px-2 py-1 text-fog-200"><option value={0.5}>0.5×</option><option value={1}>1×</option><option value={2}>2×</option></select></label>
          </div>
        </div>

        <aside className="max-h-[36rem] overflow-y-auto rounded-lg border border-border-muted bg-ink-900/50 p-3" aria-label="操作时间轴">
          <div className="mb-3 flex flex-wrap gap-1">
            {replay.games.map((game) => <button type="button" key={game.gameNumber} onClick={() => setStep(replayStepForGame(replay, game.gameNumber))} className="rounded border border-border-strong px-2 py-1 text-[11px] text-fog-300">GAME {game.gameNumber}</button>)}
          </div>
          <ol className="space-y-1">
            {replay.actions.map((action, index) => <li key={action.id}>
              <button type="button" onClick={() => setStep(index + 1)} aria-current={step === index + 1 ? 'step' : undefined} className={`w-full rounded px-2 py-2 text-left text-xs ${step === index + 1 ? 'bg-blue-team/15 ring-1 ring-blue-team/40' : 'hover:bg-surface-2'}`}>
                <span className="mr-2 tabular-nums text-fog-600">{index + 1}</span>
                <span className={action.side === 'BLUE' ? 'text-blue-team-soft' : 'text-red-team-soft'}>{action.side}</span>
                <span className="mx-1 text-fog-400">{action.type}</span>
                <span className="text-fog-200">{action.resourceType && action.resourceId ? nameOf(action.resourceType, action.resourceId) : `GAME ${action.gameNumber}`}</span>
              </button>
            </li>)}
          </ol>
        </aside>
      </div>
    </section>
  )
}
