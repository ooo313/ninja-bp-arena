import type { ReactNode } from 'react'
import type { Side } from '@bp-core'
import { computeTimerPhaseKey, getResourceDraftRules, snapshotResources } from '@bp-core'
import { useBPStore } from '@/store/bpStore'
import { useNinjaStore } from '@/store/ninjaStore'
import { useTimerStore } from '@/store/timerStore'
import { getPhase } from '@bp-core'
import { MatchSourceProvider, type MatchSource } from './context'

/**
 * 本地模式 MatchSource：单机 BP 一切行为与 v0.2.0 一致
 * （bpStore 快照撤销 + timerStore 本地计时），完全离线可用。
 */
export function LocalMatchSource({ children }: { children: ReactNode }) {
  const match = useBPStore((s) => s.match)
  const canUndo = useBPStore((s) => s.stacks.past.length > 0)
  const canRedo = useBPStore((s) => s.stacks.future.length > 0)
  const ninjas = useNinjaStore((s) => s.ninjas)
  const privateLoadouts = useBPStore((s) => s.privateLoadouts)

  // v0.4：比赛创建时固化的池快照是显示权威；旧比赛（无快照）回退本地池
  const matchNinjas = match?.ninjaSnapshot
    ? match.ninjaSnapshot.map((n) => ({ ...n, tags: [] }))
    : ninjas
  const snapshot = snapshotResources(match?.resourceSnapshot)

  const source: MatchSource = {
    mode: 'local',
    match,
    matchNinjas,
    selectNinja: (ninjaId) => useBPStore.getState().selectNinja(ninjaId),
    selectResource: (resourceType, resourceId) => useBPStore.getState().selectResource(resourceType, resourceId),
    submitLoadout: (side, type, ids) => useBPStore.getState().submitLoadout(side, type, ids),
    privateLoadouts,
    matchResources: { NINJA: matchNinjas, SECRET_SCROLL: snapshot.secretScrolls, SUMMON: snapshot.summons },
    undo: () => ({ ok: useBPStore.getState().undo() }),
    redo: () => ({ ok: useBPStore.getState().redo() }),
    canUndo,
    canRedo,
    enterGame: () => useBPStore.getState().enterGame(),
    setGameWinner: (side: Side) => useBPStore.getState().setGameWinner(side),
    nextGame: () => useBPStore.getState().nextGame(),
    resetMatch: () => useBPStore.getState().resetMatch(),
    restartTimer: () => {
      const m = useBPStore.getState().match
      if (m) useTimerStore.getState().restart(m.rule.timerSeconds)
    },
    isMyTurn: true,
    canOperate: true,
    onlineDeadline: null,
  }

  return <MatchSourceProvider value={source}>{children}</MatchSourceProvider>
}

/** 本地计时器同步：phaseKey 变化才重建 deadline（供 BPWorkspace 使用） */
export function syncLocalTimer(match: NonNullable<MatchSource['match']>, inBP: boolean) {
  const phase = getPhase(match)
  const phaseKey = computeTimerPhaseKey(match)
  const seconds = getResourceDraftRules(match.rule).find((item) => item.resourceType === phase.resourceType)?.timerSeconds ?? match.rule.timerSeconds
  useTimerStore.getState().sync({
    phaseKey,
    legacyPhaseKey: `${match.id}:G${phase.gameNumber}:${phase.sequenceComplete ? 'DONE' : `${phase.resourceType}:S${phase.stepIndex ?? 0}`}`,
    seconds,
    enabled: match.rule.timerEnabled && inBP,
  })
}
