import { useEffect, useState } from 'react'
import { useTimerStore } from '@/store/timerStore'

interface CountdownTimerProps {
  seconds: number
  running: boolean
  className?: string
  /** 在线模式：服务端权威 deadline（提供时优先于本地 timerStore） */
  deadlineOverride?: number | null
}

/**
 * 倒计时展示组件。
 *
 * 时间源：
 * - 本地模式：timerStore 里持久化的 deadlineAt 时间戳
 * - 在线模式：服务端权威 deadline（deadlineOverride）
 * 剩余秒数 = ceil((deadline - now) / 1000)，刷新页面后恢复真实剩余时间；
 * deadline 已过 → 剩余 0，由比赛工作区推进超时阶段；
 * 每 500ms 的本地 tick 只发生在本组件内部，不会带动忍者池重渲染。
 */
export function CountdownTimer({ seconds, running, className = '', deadlineOverride }: CountdownTimerProps) {
  const storeDeadline = useTimerStore((s) => s.deadlineAt)
  const deadlineAt = deadlineOverride !== undefined ? deadlineOverride : storeDeadline
  const [now, setNow] = useState(() => Date.now())

  const active = running && typeof deadlineAt === 'number'

  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(timer)
  }, [active, deadlineAt])

  const remaining =
    typeof deadlineAt === 'number' ? Math.max(0, Math.ceil((deadlineAt - now) / 1000)) : 0
  const expired = remaining <= 0

  if (deadlineAt === null) return null

  const total = Math.max(1, seconds)
  const progress = Math.max(0, Math.min(1, remaining / total))
  const warning = remaining <= 10 && !expired
  const radius = 26
  const circumference = 2 * Math.PI * radius

  return (
    <div role="timer" aria-live="off" aria-label={`剩余 ${remaining} 秒`} className={`relative ${warning ? 'timer-warning' : ''} ${className}`}>
      <svg width="64" height="64" viewBox="0 0 64 64" className="-rotate-90">
        <circle cx="32" cy="32" r={radius} fill="none" stroke="currentColor" strokeWidth="4" className="text-ink-600" />
        <circle
          cx="32"
          cy="32"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - progress)}
          className={expired || warning ? 'text-side-red' : 'text-gold'}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <span className={`text-base font-bold tabular-nums ${expired || warning ? 'text-side-red' : 'text-fog-100'}`}>
          {remaining}
        </span>
      </div>
    </div>
  )
}
