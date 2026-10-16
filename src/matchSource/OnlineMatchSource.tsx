import { useEffect, useMemo, type ReactNode } from 'react'
import { computeTimerPhaseKey, getPhase, getSealedDraft, snapshotResources, toOnlineNinjaSnapshots } from '@bp-core'
import { useOnlineRoomStore } from '@/online/onlineRoomStore'
import { MatchSourceProvider, type MatchSource } from './context'

/**
 * 在线模式 MatchSource：一切操作转为语义命令，由服务端（Shared BP Core）
 * 验证并应用；本组件不产生任何本地状态修改。操作为异步（等待服务端确认）。
 */
export function OnlineMatchSource({ children }: { children: ReactNode }) {
  useEffect(() => {
    const onOffline = () => useOnlineRoomStore.getState().markOffline()
    const onOnline = () => {
      const state = useOnlineRoomStore.getState()
      if (state.roomId && state.roomCode) void state.enterRoom(state.roomId, state.roomCode)
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') void useOnlineRoomStore.getState().refreshSnapshot()
    }
    window.addEventListener('offline', onOffline)
    window.addEventListener('online', onOnline)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('offline', onOffline)
      window.removeEventListener('online', onOnline)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])
  const authoritativeMatch = useOnlineRoomStore((s) => s.match)
  const mySeat = useOnlineRoomStore((s) => s.mySeat)
  const isHost = useOnlineRoomStore((s) => s.isHost)
  const userId = useOnlineRoomStore((s) => s.userId)
  const connection = useOnlineRoomStore((s) => s.connection)
  const pendingCommand = useOnlineRoomStore((s) => s.pendingCommand)
  const pendingUndo = useOnlineRoomStore((s) => s.pendingUndo)
  const roomStatus = useOnlineRoomStore((s) => s.roomStatus)
  const onlineNinjaIds = useOnlineRoomStore((s) => s.onlineNinjaIds)
  const roomNinjas = useOnlineRoomStore((s) => s.roomNinjas)
  const roomPackMetadata = useOnlineRoomStore((s) => s.roomPackMetadata)
  const roomResources = useOnlineRoomStore((s) => s.roomResources)
  const privateLoadout = useOnlineRoomStore((s) => s.privateLoadout)

  // v0.4：房间 Ninja Snapshot 是显示权威（服务端按它校验，双方必然一致）；
  // 旧房间（只有 {id,enabled}）回退本地池按 id 过滤
  const matchNinjas = roomNinjas ?? undefined
  // 把会话级房间快照挂到展示用 MatchState。服务端权威 match_state 不需要
  // 重复存这份数据，但卡槽、历史与结果组件都能统一走 useNinjaLookup。
  const match = useMemo(() => {
    if (!authoritativeMatch) return null
    return {
      ...authoritativeMatch,
      ...(roomPackMetadata ? { dataPack: roomPackMetadata } : {}),
      ...(roomNinjas ? { ninjaSnapshot: toOnlineNinjaSnapshots(roomNinjas) } : {}),
      ...(roomResources ? { resourceSnapshot: roomResources } : {}),
    }
  }, [authoritativeMatch, roomNinjas, roomPackMetadata, roomResources])
  const resources = snapshotResources(roomResources ?? match?.resourceSnapshot)

  const phase = match ? getPhase(match) : null
  const sealed = match ? getSealedDraft(match) : null
  const isMyTurn = Boolean(
    match &&
      roomStatus === 'ACTIVE' &&
      match.status === 'IN_PROGRESS' &&
      (mySeat === 'BLUE' || mySeat === 'RED') &&
      (sealed ? privateLoadout?.phase_key !== sealed.key : phase?.side === mySeat) &&
      !phase?.sequenceComplete,
  )
  const canOperate = isMyTurn && connection === 'connected' && !pendingCommand
  const legacyKey = phase && match ? `${match.id}:G${phase.gameNumber}:${phase.sequenceComplete ? 'DONE' : `${phase.resourceType}:S${phase.stepIndex ?? 0}`}` : null
  const onlineDeadline =
    match?.timer && (match.timer.phaseKey === computeTimerPhaseKey(match) || match.timer.phaseKey === legacyKey) ? match.timer.deadlineAt : null

  const source: MatchSource = {
    mode: 'online',
    match,
    selectNinja: (ninjaId) => useOnlineRoomStore.getState().sendCommand('SELECT_NINJA', { ninjaId }),
    selectResource: (resourceType, resourceId) => useOnlineRoomStore.getState().sendCommand('SELECT_RESOURCE', { resourceType, resourceId }),
    submitLoadout: (_side, resourceType, resourceIds) => useOnlineRoomStore.getState().sendCommand('SUBMIT_LOADOUT', { resourceType, resourceIds, phaseKey: sealed?.key }),
    privateLoadouts: privateLoadout && privateLoadout.phase_key === sealed?.key ? { [privateLoadout.side]: privateLoadout } : {},
    undo: () => useOnlineRoomStore.getState().sendCommand('REQUEST_UNDO'),
    redo: () => ({ ok: false, reason: '在线模式暂不支持重做' }),
    canUndo: Boolean(match && match.history.length > 0 && roomStatus === 'ACTIVE'),
    canRedo: false,
    enterGame: () => useOnlineRoomStore.getState().sendCommand('ENTER_GAME'),
    setGameWinner: (side) => useOnlineRoomStore.getState().sendCommand('SET_GAME_WINNER', { side }),
    nextGame: () => useOnlineRoomStore.getState().sendCommand('NEXT_GAME'),
    resetMatch: () => void useOnlineRoomStore.getState().sendCommand('RESET_MATCH'),
    restartTimer: () => void useOnlineRoomStore.getState().sendCommand('RESTART_TIMER'),
    mySeat,
    isHost,
    isMyTurn,
    canOperate,
    pendingCommand,
    onlineDeadline,
    connection,
    pendingUndo,
    myUserId: userId,
    onlineNinjaIds,
    matchNinjas,
    matchResources: { NINJA: matchNinjas ?? resources.ninjas, SECRET_SCROLL: resources.secretScrolls, SUMMON: resources.summons },
    resync: () => useOnlineRoomStore.getState().refreshSnapshot(),
  }

  return <MatchSourceProvider value={source}>{children}</MatchSourceProvider>
}
