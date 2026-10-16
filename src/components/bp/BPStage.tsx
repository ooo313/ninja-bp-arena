import { sideAtPosition, sideLabel, playerScore } from '@bp-core'
import type { MatchState } from '@/types/match'
import { getPhase } from '@/engine/bpEngine'
import { CountdownTimer } from './CountdownTimer'
import { getResourceDraftRules, RESOURCE_TYPE_LABEL } from '@bp-core'


/** 序列步骤条：整局 Ban/Pick 流程一览（已完成 / 进行中 / 待执行） */
function SequenceStrip({ match }: { match: MatchState }) {
  const phase = getPhase(match)
  const steps = phase.expanded.reduce<Array<{ step: (typeof phase.expanded)[number]; start: number; count: number }>>((groups, step, index) => {
    const last = groups[groups.length - 1]
    if (last?.step.stepIndex === step.stepIndex) last.count += 1
    else groups.push({ step, start: index, count: 1 })
    return groups
  }, [])
  return (
    <div className="flex max-h-24 flex-wrap items-center justify-center gap-1 overflow-y-auto" aria-label="本局 BP 序列">
      {steps.map(({ step, start, count }) => {
        const done = start + count <= phase.totalDone
        const current = start <= phase.totalDone && phase.totalDone < start + count
        const isBan = step.action === 'BAN'
        return (
          <span
            key={step.stepIndex}
            aria-current={current ? 'step' : undefined}
            title={`${sideLabel(match, step.side)} ${isBan ? '禁用' : '选择'}${RESOURCE_TYPE_LABEL[step.resourceType]} ×${count} · ${done ? '已完成' : current ? '当前' : '待执行'}`}
            className={`flex h-6 min-w-12 items-center justify-center rounded-sm px-1.5 text-[10px] font-bold transition-colors ${
              current
                ? isBan
                  ? 'bg-side-red text-white ring-1 ring-side-red/60'
                  : 'bg-side-blue text-white ring-1 ring-side-blue/60'
                : done
                  ? isBan
                    ? 'bg-side-red/20 text-side-red-soft/70'
                    : 'bg-side-blue/20 text-side-blue-soft/70'
                  : 'bg-ink-700 text-fog-600'
            }`}
          >
            <span className="opacity-70">{step.resourceType === 'NINJA' ? '忍' : step.resourceType === 'SECRET_SCROLL' ? '卷' : '灵'}</span>
            {isBan ? '禁' : '选'}×{count}
            <span className="ml-0.5 opacity-70">{sideAtPosition(match, step.side) === 'BLUE' ? '蓝' : '红'}</span>
          </span>
        )
      })}
    </div>
  )
}

interface BPStageProps {
  match: MatchState
  /** 超时遮罩是否激活（激活时给出恢复操作，不代替玩家选择） */
  timeoutActive: boolean
  onResumeTimeout: () => void
  onRestartTimer: () => void
  onTimerExpire: () => void
  /** 在线模式：服务端权威 deadline（本地为 undefined → 用 timerStore） */
  deadlineOverride?: number | null
  className?: string
}

/**
 * 中央阶段区：比分之下最重要的信息 —— 当前行动方与动作。
 * 版式强调「BLUE BAN / 蓝方禁用阶段」的赛事语感，配倒计时与流程条。
 */
export function BPStage({
  match,
  timeoutActive,
  onResumeTimeout,
  onRestartTimer,
  onTimerExpire,
  deadlineOverride,
  className = '',
}: BPStageProps) {
  const phase = getPhase(match)
  const rule = match.rule
  const inBP = phase.status === 'BANNING' || phase.status === 'PICKING'

  const sideText = phase.side ? sideLabel(match, phase.side) : ''
  const actionEn = phase.action === 'BAN' ? 'BAN' : 'PICK'
  const actionCn = phase.action === 'BAN' ? '禁用阶段' : '选择阶段'
  const resourceLabel = phase.resourceType ? RESOURCE_TYPE_LABEL[phase.resourceType] : '资源'
  const isNinja = phase.resourceType === 'NINJA'
  const remainText =
    phase.remainingInStep > 1
      ? `还需选择 ${phase.remainingInStep} ${isNinja ? '名忍者' : `个${resourceLabel}`}`
      : `请选择 1 ${isNinja ? '名忍者' : `个${resourceLabel}`}`
  const timerSeconds = getResourceDraftRules(rule).find((item) => item.resourceType === phase.resourceType)?.timerSeconds ?? rule.timerSeconds

  return (
    <section
      className={`flex flex-col items-center gap-2.5 rounded-lg border border-ink-600 bg-ink-800/60 px-4 py-3.5 ${className}`}
      aria-live="polite"
    >
      <div className="flex items-center gap-2 text-[11px] tracking-widest text-fog-600">
        <span>BO{rule.bestOf}</span>
        <span className="text-ink-400">/</span>
        <span className="font-semibold text-gold">GAME {phase.gameNumber}</span>
        <span className="text-ink-400">/</span>
        <span>比分 蓝 {playerScore(match, sideAtPosition(match, 'BLUE'))} : {playerScore(match, sideAtPosition(match, 'RED'))} 红</span>
        <span className="text-ink-400">/</span>
        <span className="max-w-[180px] truncate">{rule.name}</span>
      </div>

      {inBP ? (
        <>
          <div className="flex items-center gap-3.5">
            <CountdownTimer
              seconds={timerSeconds}
              running={inBP}
              onExpire={onTimerExpire}
              deadlineOverride={deadlineOverride}
            />
            <div className="text-left">
              <p
                className={`text-xl font-black leading-tight tracking-wide lg:text-2xl ${
                  (phase.side && sideAtPosition(match, phase.side)) === 'BLUE' ? 'text-side-blue-soft' : 'text-side-red-soft'
                }`}
              >
                {(phase.side && sideAtPosition(match, phase.side)) === 'BLUE' ? 'BLUE' : 'RED'} {actionEn}
              </p>
              <p className="mt-1 text-[10px] font-bold tracking-[0.2em] text-fog-600">
                {RESOURCE_TYPE_LABEL[phase.resourceType!].toUpperCase()} · {phase.doneInStep + 1} / {phase.stepCount}
              </p>
              <p className="mt-0.5 text-sm font-medium text-fog-100">
                {timeoutActive ? '操作超时 · 管理员可继续操作' : `${sideText}${isNinja ? '' : resourceLabel}${actionCn} · ${remainText}`}
              </p>
            </div>
          </div>
          {timeoutActive && (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onResumeTimeout}
                className="rounded bg-side-blue px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-side-blue/85"
              >
                继续选择
              </button>
              <button
                type="button"
                onClick={onRestartTimer}
                className="rounded border border-ink-500 px-3 py-1.5 text-xs text-fog-300 transition-colors hover:bg-ink-600"
              >
                重新计时
              </button>
            </div>
          )}
          <SequenceStrip match={match} />
        </>
      ) : (
        <p className="py-1.5 text-lg font-bold tracking-wide text-fog-100 lg:text-xl">
          {phase.status === 'READY' && '双方阵容已锁定'}
          {phase.status === 'PLAYING' && '本局比赛进行中'}
          {phase.status === 'COMPLETED' && '本局已记录胜负'}
        </p>
      )}
    </section>
  )
}
