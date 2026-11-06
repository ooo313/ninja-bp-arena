import { useEffect, useRef, useState, type RefObject } from 'react'
import { DRAFT_TIMEOUT_GRACE_MS, getPhase, getSealedDraft, type Side } from '@bp-core'
import type { MatchSource } from '@/matchSource/context'
import { useOnlineRoomStore } from '@/online/onlineRoomStore'
import { useBPStore } from '@/store/bpStore'
import { useTimerStore } from '@/store/timerStore'
import { useSettingsStore } from '@/store/settingsStore'
import { toast } from '@/store/toastStore'
import { playSound } from '@/utils/sound'

export interface TimeoutPreview {
  phaseKey: string
  updatedAt: number
  resourceId?: string
  loadouts: Partial<Record<Side, (string | null)[]>>
}

export function useDraftTimeout(source: MatchSource, preview: RefObject<TimeoutPreview | null>) {
  const localDeadline = useTimerStore((state) => state.deadlineAt)
  const localPhaseKey = useTimerStore((state) => state.phaseKey)
  const online = source.mode === 'online'
  const match = source.match
  const phase = match ? getPhase(match) : null
  const sealed = match ? getSealedDraft(match) : null
  const phaseKey = sealed?.key ?? phase?.phaseKey
  const sealedType = sealed?.resourceType
  const deadline = match?.rule.timerEnabled && phase?.side
    ? online ? source.onlineDeadline : localPhaseKey === phase.phaseKey ? localDeadline : null
    : null
  const ownsTurn = !online || source.isMyTurn
  const connected = !online || source.connection === 'connected'
  const seat = source.mySeat
  const [expiredDeadline, setExpiredDeadline] = useState<number | null>(null)
  const announced = useRef<number | null>(null)
  const updatedAt = match?.updatedAt

  useEffect(() => {
    if (!deadline || !phaseKey) return
    const markExpired = window.setTimeout(() => {
      setExpiredDeadline(deadline)
      if (announced.current !== deadline) {
        announced.current = deadline
        playSound('timeout', useSettingsStore.getState().settings.soundEnabled)
      }
    }, Math.max(0, deadline - Date.now()))
    if (!connected) return () => window.clearTimeout(markExpired)

    let cancelled = false
    let timer: number
    const resolve = async () => {
      const current = preview.current
      const choices = current?.phaseKey === phaseKey && current.updatedAt === updatedAt ? current : null
      if (!online) {
        const result = useBPStore.getState().expireDraft(choices?.loadouts ?? {}, choices?.resourceId)
        if (!result.ok) toast(result.reason ?? '超时自动确认未完成', 'error')
        return
      }
      const result = await useOnlineRoomStore.getState().sendCommand('EXPIRE_DRAFT', {
        phaseKey, deadline,
        resourceId: ownsTurn ? choices?.resourceId : undefined,
        resourceIds: sealedType && (seat === 'BLUE' || seat === 'RED') ? choices?.loadouts[seat] ?? [] : undefined,
      })
      if (!cancelled && !result.ok) timer = window.setTimeout(resolve, 1_250)
    }
    timer = window.setTimeout(resolve, Math.max(0, deadline + (ownsTurn ? 0 : DRAFT_TIMEOUT_GRACE_MS) + (online ? 150 : 0) - Date.now()))
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      window.clearTimeout(markExpired)
    }
  }, [deadline, phaseKey, updatedAt, online, ownsTurn, connected, sealedType, seat, preview])

  return Boolean(deadline && expiredDeadline === deadline)
}
