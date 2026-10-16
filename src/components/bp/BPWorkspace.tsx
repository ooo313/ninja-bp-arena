import { sideAtPosition, sideLabel } from '@bp-core'
import { useEffect, useMemo, useState } from 'react'
import { Navigate } from 'react-router-dom'
import type { Side } from '@/types/bp'
import { getPhase } from '@/engine/bpEngine'
import { useNinjaStore } from '@/store/ninjaStore'
import { useSettingsStore } from '@/store/settingsStore'
import { toast } from '@/store/toastStore'
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts'
import { BPHeader } from '@/components/bp/BPHeader'
import { BPStage } from '@/components/bp/BPStage'
import { BPControlBar } from '@/components/bp/BPControlBar'
import { PlayerPanel } from '@/components/bp/PlayerPanel'
import { MobileTeamBar } from '@/components/bp/MobileTeamBar'
import { BPHistoryDrawer } from '@/components/bp/BPHistoryDrawer'
import { ReadyStage } from '@/components/bp/ReadyStage'
import { PlayingStage } from '@/components/bp/PlayingStage'
import { NinjaGrid, type StatusFilter } from '@/components/ninja/NinjaGrid'
import { NinjaSearch } from '@/components/ninja/NinjaSearch'
import { NinjaFilter, type QualityFilter } from '@/components/ninja/NinjaFilter'
import { GameResultDialog } from '@/components/match/GameResultDialog'
import { MatchResult } from '@/components/match/MatchResult'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { Dialog } from '@/components/common/Dialog'
import { useMatchSource } from '@/matchSource/context'
import { syncLocalTimer } from '@/matchSource/LocalMatchSource'
import { useOnlineRoomStore } from '@/online/onlineRoomStore'
import { useBPStore } from '@/store/bpStore'
import { playSound } from '@/utils/sound'
import { normalizeForSearch, searchRank } from '@/utils/format'
import { CheckCircle2, Hourglass } from 'lucide-react'
import { ResourceGrid } from '@/components/resource/ResourceGrid'
import { GameArena } from '@/components/arena/GameArena'
import { getSealedDraft } from '@bp-core'
import { canSelectResource, getResourceCardStatus, getResourceDraftRules, RESOURCE_TYPE_LABEL, type DraftResource, type DraftResourceType } from '@bp-core'

const QUALITY_ORDER = { S: 0, A: 1, B: 2, C: 3 } as const

/**
 * BP 工作区（本地 / 在线共用）。
 * 一切操作通过 MatchSource 抽象：本地 = 直接执行；在线 = 发送服务端命令。
 */
export function BPWorkspace() {
  const source = useMatchSource()
  const match = source.match
  const storeNinjas = useNinjaStore((s) => s.ninjas)
  // v0.4 显示权威：本地 = 比赛快照；在线 = 房间 Ninja Snapshot；都缺失才用本地池
  const ninjas = source.matchNinjas ?? storeNinjas
  const settings = useSettingsStore((s) => s.settings)
  const isOnline = source.mode === 'online'
  const gameView = settings.bpView !== 'classic' || Boolean(match && getSealedDraft(match))

  const [search, setSearch] = useState('')
  const [quality, setQuality] = useState<QualityFilter>('ALL')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL')
  const [enabledOnly, setEnabledOnly] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [resetOpen, setResetOpen] = useState(false)
  const [winnerConfirm, setWinnerConfirm] = useState<Side | null>(null)
  const [resultOpen, setResultOpen] = useState(false)
  const [timeoutActive, setTimeoutActive] = useState(false)
  const [inspected, setInspected] = useState<{ type: DraftResourceType; resource: DraftResource } | null>(null)

  useKeyboardShortcuts({
    onEscape: () => setSearch(''),
    onUndo: isOnline ? undefined : () => { void source.undo() },
    onRedo: isOnline ? undefined : () => { void source.redo() },
  })

  const filteredNinjas = useMemo(() => {
    let pool = ninjas
    // 在线模式：以房间忍者池快照为准（服务端按它校验）
    if (isOnline && source.onlineNinjaIds) {
      const ids = new Set(source.onlineNinjaIds)
      pool = pool.filter((n) => ids.has(n.id))
    }
    const query = normalizeForSearch(search)
    let list = pool
    if (query) list = list.filter((n) => searchRank(n, query) < Infinity)
    if (enabledOnly) list = list.filter((n) => n.enabled && !n.deprecated)
    if (quality !== 'ALL') list = list.filter((n) => n.quality === quality)
    if (settings.ninjaSort === 'name') {
      list = [...list].sort((a, b) => (query ? searchRank(a, query) - searchRank(b, query) : 0) || a.name.localeCompare(b.name, 'zh-Hans-CN'))
    } else {
      list = [...list].sort(
        (a, b) =>
          (query ? searchRank(a, query) - searchRank(b, query) : 0) ||
          (a.sortOrder ?? 0) - (b.sortOrder ?? 0) ||
          QUALITY_ORDER[a.quality] - QUALITY_ORDER[b.quality] ||
          a.name.localeCompare(b.name, 'zh-Hans-CN'),
      )
    }
    return list
  }, [ninjas, search, quality, settings.ninjaSort, isOnline, source.onlineNinjaIds, enabledOnly])

  // 计时器：本地模式由客户端持久化 deadline；在线模式使用服务端权威 deadline
  const bpPhase = match ? getPhase(match) : null
  const activeResourceType = bpPhase?.resourceType ?? 'NINJA'
  const [viewedResourceType, setViewedResourceType] = useState<DraftResourceType>(activeResourceType)
  useEffect(() => setViewedResourceType(activeResourceType), [activeResourceType])
  const filteredResources = useMemo(() => {
    if (viewedResourceType === 'NINJA') return [] as DraftResource[]
    const pool = source.matchResources?.[viewedResourceType] ?? []
    const query = normalizeForSearch(search)
    return pool
      .filter((item) => (!enabledOnly || (item.enabled && !item.deprecated)) && searchRank(item, query) < Infinity)
      .sort((a, b) => (query ? searchRank(a, query) - searchRank(b, query) : 0) || (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name, 'zh-Hans-CN'))
  }, [viewedResourceType, search, source.matchResources, enabledOnly])
  const inBPNow = bpPhase ? bpPhase.status === 'BANNING' || bpPhase.status === 'PICKING' : false
  useEffect(() => {
    if (!match) return
    if (source.mode === 'local') syncLocalTimer(match, inBPNow)
    setTimeoutActive(false)
  }, [match, source.mode, inBPNow])

  if (!match) return <Navigate to="/" replace />

  const phase = getPhase(match)
  const inBP = phase.status === 'BANNING' || phase.status === 'PICKING'

  const handlePick = (ninjaId: string) => {
    if (isOnline) {
      if (source.pendingCommand) {
        toast('正在确认上一步操作……', 'info')
        return
      }
      if (source.connection === 'offline') {
        toast('连接已断开，正在重新连接', 'error')
        return
      }
      if (!source.isMyTurn) {
        // 本地状态可能滞后（Realtime 事件在途）：先强制重拉权威快照再判断一次
        void (async () => {
          await source.resync?.()
          if (!useOnlineRoomStore.getState().isMyTurnNow()) {
            toast('等待对方选择……', 'info')
            return
          }
          const result = await Promise.resolve(source.selectNinja(ninjaId))
          if (!result.ok && result.reason) {
            toast(result.reason, 'error')
            return
          }
          setTimeoutActive(false)
        })()
        return
      }
    }
    void Promise.resolve(source.selectNinja(ninjaId)).then((result) => {
      if (!result.ok && result.reason) {
        toast(result.reason, 'error')
        return
      }
      setTimeoutActive(false)
    })
  }

  const handleResourcePick = (resourceType: DraftResourceType, resourceId: string) => {
    if (isOnline && !source.isMyTurn) {
      toast('等待对方选择……', 'info')
      return
    }
    void Promise.resolve(source.selectResource(resourceType, resourceId)).then((result) => {
      if (!result.ok && result.reason) toast(result.reason, 'error')
      setTimeoutActive(false)
    })
  }

  const handleConfirmWinner = (side: Side) => {
    void Promise.resolve(source.setGameWinner(side)).then((result) => {
      if (!result.ok) {
        if (result.reason) toast(result.reason, 'error')
        return
      }
      setTimeoutActive(false)
      if (isOnline) {
        const status = useOnlineRoomStore.getState().match?.status
        if (status !== 'MATCH_FINISHED') setResultOpen(true)
      } else if (useBPStore.getState().match?.status !== 'MATCH_FINISHED') {
        setResultOpen(true)
      }
    })
  }

  const handleTimerExpire = () => {
    setTimeoutActive(true)
    playSound('timeout', settings.soundEnabled)
  }

  const deadlineOverride = isOnline ? (source.onlineDeadline ?? null) : undefined
  const waitingOther = isOnline && inBP && !source.isMyTurn
  const enabledResourceTypes = getResourceDraftRules(match.rule).filter((rule) => rule.enabled).map((rule) => rule.resourceType)
  const interactionReason = viewedResourceType !== phase.resourceType
    ? `当前阶段为${phase.resourceType ? RESOURCE_TYPE_LABEL[phase.resourceType] : '其他资源'}`
    : source.mySeat === 'OBSERVER'
      ? '观战模式不可操作'
      : waitingOther
        ? `等待${phase.side ? sideLabel(match, phase.side) : '对方'}选择`
        : !source.canOperate ? '当前席位不可操作' : undefined

  const stage = (
    <BPStage
      match={match}
      timeoutActive={timeoutActive}
      onResumeTimeout={() => setTimeoutActive(false)}
      onRestartTimer={() => {
        source.restartTimer()
        setTimeoutActive(false)
      }}
      onTimerExpire={handleTimerExpire}
      deadlineOverride={deadlineOverride}
      className="sticky top-0 z-20 shadow-lg shadow-arena-bg/40 lg:static lg:shadow-none"
    />
  )

  return (
    <div className={gameView ? 'min-h-screen' : 'flex min-h-screen flex-col pb-14 lg:pb-0'}>
      {gameView ? <GameArena
        onlineBanner={isOnline ? <OnlineBanners /> : undefined}
        onClassic={() => useSettingsStore.getState().update({ bpView: 'classic' })}
        onHistory={() => setHistoryOpen(true)}
        onReset={() => setResetOpen(true)}
        onWinner={setWinnerConfirm}
        onResults={() => {
          if (match.status === 'MATCH_FINISHED') useSettingsStore.getState().update({ bpView: 'classic' })
          else setResultOpen(true)
        }}
        onTimerExpire={handleTimerExpire}
        onTimerRestart={() => { source.restartTimer(); setTimeoutActive(false) }}
        onResumeTimeout={() => setTimeoutActive(false)}
        timeoutActive={timeoutActive}
      /> : <>
      <button type="button" onClick={() => useSettingsStore.getState().update({ bpView: 'game' })} className="absolute right-3 top-2 z-40 rounded border border-gold-accent/40 bg-surface-1 px-2 py-1 text-xs text-gold-accent">游戏界面</button>
      <BPHeader match={match} onOpenHistory={() => setHistoryOpen(true)} onOpenReset={() => setResetOpen(true)} />

      {/* 在线：轮到谁操作 / 撤销请求横幅 */}
      {isOnline && <OnlineBanners />}

      <main className="mx-auto w-full max-w-[1500px] flex-1 px-2.5 py-3 lg:px-5 lg:py-4">
        <div className="grid gap-3 lg:grid-cols-[minmax(280px,320px)_minmax(0,1fr)_minmax(280px,320px)] lg:gap-4">
          <div className="hidden lg:order-1 lg:block">
            <PlayerPanel side={sideAtPosition(match, 'BLUE')} />
          </div>
          <div className="hidden lg:order-3 lg:block">
            <PlayerPanel side={sideAtPosition(match, 'RED')} />
          </div>

          <div className="space-y-3 lg:order-2">
            {stage}
            <MobileTeamBar match={match} />

            {inBP && (
              <section className="space-y-2">
                <div className="flex items-center gap-1 rounded-lg border border-border-muted bg-surface-1/60 p-1" role="tablist" aria-label="资源类型">
                  {enabledResourceTypes.map((type) => (
                    <button key={type} type="button" role="tab" aria-selected={viewedResourceType === type} onClick={() => setViewedResourceType(type)} className={`flex-1 rounded px-3 py-1.5 text-xs font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-accent ${viewedResourceType === type ? 'bg-gold-accent text-ink-950' : 'text-fog-400 hover:bg-ink-700'}`}>
                      {RESOURCE_TYPE_LABEL[type]}{phase.resourceType === type ? ' · 当前' : ''}
                    </button>
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <NinjaSearch value={search} onChange={setSearch} ariaLabel={`搜索${RESOURCE_TYPE_LABEL[viewedResourceType]}`} placeholder={`搜索${RESOURCE_TYPE_LABEL[viewedResourceType]}名称、别名或标签…`} />
                  <button type="button" aria-pressed={enabledOnly} onClick={() => setEnabledOnly((value) => !value)} className={`rounded border border-ink-500 px-2 py-1.5 text-xs ${enabledOnly ? 'bg-gold-accent text-ink-950' : 'text-fog-400'}`}>仅启用</button>
                  {viewedResourceType === 'NINJA' && <NinjaFilter value={quality} onChange={setQuality} />}
                  {viewedResourceType === 'NINJA' && (
                  <div className="flex items-center gap-1 rounded-lg border border-ink-500 bg-ink-800 p-1" role="group" aria-label="状态筛选">
                    {(
                      [
                        ['ALL', '全部'],
                        ['AVAILABLE', '可用'],
                        ['BANNED', '已Ban'],
                        ['PICKED', '已选'],
                        ['USED', '已使用'],
                      ] as const
                    ).map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        aria-pressed={statusFilter === value}
                        onClick={() => setStatusFilter(value)}
                        className={`rounded px-2 py-1 text-xs transition-colors ${
                          statusFilter === value ? 'bg-gold-accent text-ink-950' : 'text-fog-500 hover:bg-ink-600 hover:text-fog-100'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  )}
                  {viewedResourceType === 'NINJA' && (
                  <select
                    value={settings.ninjaSort}
                    onChange={(e) => useSettingsStore.getState().update({ ninjaSort: e.target.value as 'quality' | 'name' })}
                    aria-label="排序方式"
                    className="rounded-lg border border-ink-500 bg-ink-800 px-2 py-1.5 text-xs text-fog-300 focus:outline-none"
                  >
                    <option value="quality">品质排序</option>
                    <option value="name">名称排序</option>
                  </select>
                  )}
                </div>
                <div className={waitingOther ? 'opacity-70' : ''}>
                  {viewedResourceType === 'NINJA' ? (
                    <NinjaGrid
                      ninjas={filteredNinjas}
                      match={match}
                      statusFilter={statusFilter}
                      onPick={(ninja) => handlePick(ninja.id)}
                      onInspect={(ninja) => setInspected({ type: 'NINJA', resource: ninja })}
                      disabledReason={interactionReason}
                    />
                  ) : (
                    <ResourceGrid
                      resources={filteredResources}
                      resourceType={viewedResourceType}
                      match={match}
                      canSelect={!interactionReason}
                      lockedReason={interactionReason}
                      onSelect={(resource) => handleResourcePick(viewedResourceType, resource.id)}
                      onInspect={(resource) => setInspected({ type: viewedResourceType, resource })}
                    />
                  )}
                </div>
              </section>
            )}

            {phase.status === 'READY' && <ReadyStage match={match} />}
            {phase.status === 'PLAYING' && <PlayingStage match={match} onRequestWinner={setWinnerConfirm} />}
            {phase.status === 'COMPLETED' && match.status !== 'MATCH_FINISHED' && (
              <section className="rounded-lg border border-border-muted bg-surface-1/60 p-6 text-center">
                <p className="text-sm font-semibold text-fog-100">本局胜负已记录</p>
                <button
                  type="button"
                  onClick={() => setResultOpen(true)}
                  className="mt-3 rounded bg-blue-team px-5 py-2 text-sm font-bold text-white transition-colors hover:brightness-110"
                >
                  查看结果 / 进入下一局
                </button>
              </section>
            )}
            {match.status === 'MATCH_FINISHED' && (
              <MatchResult
                match={match}
                replaySource={isOnline ? 'ONLINE' : 'LOCAL'}
                roomId={isOnline ? useOnlineRoomStore.getState().roomId ?? undefined : undefined}
                extraActions={
                  <button
                    type="button"
                    onClick={() => setResetOpen(true)}
                    className="rounded bg-blue-team px-4 py-2 text-sm font-medium text-white transition-colors hover:brightness-110"
                  >
                    重新开始
                  </button>
                }
              />
            )}
          </div>
        </div>
      </main>

      <BPControlBar match={match} onOpenHistory={() => setHistoryOpen(true)} />
      </>}

      {/* 弹层 */}
      <BPHistoryDrawer open={historyOpen} onClose={() => setHistoryOpen(false)} />
      <GameResultDialog match={match} open={resultOpen} onClose={() => setResultOpen(false)} />
      <Dialog open={!!inspected} onClose={() => setInspected(null)} title={inspected ? `${RESOURCE_TYPE_LABEL[inspected.type]}详情 · ${inspected.resource.name}` : '资源详情'}>
        {inspected && <div className="space-y-2 text-sm text-fog-300">
          <p>名称：{inspected.resource.name}</p>
          {'quality' in inspected.resource && <p>品质：{inspected.resource.quality}</p>}
          {inspected.resource.aliases?.length ? <p>别名：{inspected.resource.aliases.join('、')}</p> : null}
          {inspected.resource.tags?.length ? <p>标签：{inspected.resource.tags.join('、')}</p> : null}
          {'series' in inspected.resource && inspected.resource.series?.length ? <p>系列：{inspected.resource.series.join('、')}</p> : null}
          <p>状态：{getResourceCardStatus(match, inspected.type, inspected.resource).reason || '可用'}</p>
          <p>当前操作：{source.mySeat === 'OBSERVER' ? '观战只读' : canSelectResource(match, inspected.type, inspected.resource.id, inspected.resource).reason ?? '可以选择'}</p>
        </div>}
      </Dialog>
      <ConfirmDialog
        open={!!winnerConfirm}
        title={`确认 Game ${phase.gameNumber} ${winnerConfirm ? sideLabel(match, winnerConfirm) : ''}获胜？`}
        message="确认后将记录本局比分，此操作可通过撤销回退。"
        confirmText="确认获胜"
        onConfirm={() => winnerConfirm && handleConfirmWinner(winnerConfirm)}
        onClose={() => setWinnerConfirm(null)}
      />
      <ConfirmDialog
        open={resetOpen}
        title="重置比赛？"
        message={
          isOnline
            ? '将以相同规则与选手开始一场全新比赛（在线模式下由服务端执行）。'
            : '当前比赛进度将被清空，并以相同规则与选手开始一场新比赛。'
        }
        confirmText="重置"
        danger
        onConfirm={() => {
          source.resetMatch()
          setTimeoutActive(false)
          toast('比赛已重置', 'success')
        }}
        onClose={() => setResetOpen(false)}
      />
    </div>
  )
}

/** 在线模式顶部横幅：回合提示 + 撤销请求 */
function OnlineBanners() {
  const source = useMatchSource()
  const match = source.match
  if (!match) return null
  const phase = getPhase(match)
  const inBP = phase.status === 'BANNING' || phase.status === 'PICKING'
  const pending = source.pendingUndo
  const connectionLabel = source.connection === 'connected' ? 'CONNECTED · 已连接' : source.connection === 'syncing' ? 'SYNCING · 正在同步' : source.connection === 'reconnecting' ? 'RECONNECTING · 正在重连' : source.connection === 'offline' ? 'DISCONNECTED · 连接已断开' : 'CONNECTING · 正在连接'

  return (
    <div className="mx-auto w-full max-w-[1500px] px-2.5 pt-2 lg:px-5">
      <div className="mb-1.5 flex flex-wrap items-center justify-center gap-2 text-[10px] font-bold tracking-wider">
        <span className={`rounded border px-2 py-1 ${source.connection === 'connected' ? 'border-emerald-500/35 bg-emerald-500/10 text-emerald-400' : source.connection === 'offline' ? 'border-red-team/40 bg-red-team/10 text-red-team-soft' : 'border-gold-accent/40 bg-gold-accent/10 text-gold-accent'}`}>{connectionLabel}</span>
        {source.mySeat === 'OBSERVER' && <span className="rounded border border-violet-500/40 bg-violet-500/10 px-2 py-1 text-violet-300">观战模式 · 只读</span>}
      </div>
      {source.isMyTurn && inBP && source.canOperate && (
        <div className="flex items-center justify-center gap-1.5 rounded border border-gold-accent/40 bg-gold-accent/10 py-1.5 text-xs font-bold text-gold-accent">
          <CheckCircle2 size={13} /> 轮到你操作（{source.mySeat === 'BLUE' || source.mySeat === 'RED' ? sideLabel(match, source.mySeat) : '观众'}）
        </div>
      )}
      {inBP && !source.isMyTurn && !pending && (
        <div className="flex items-center justify-center gap-1.5 rounded border border-border-muted bg-surface-1/60 py-1.5 text-xs text-fog-500">
          <Hourglass size={12} className="animate-pulse" /> 等待{phase.side ? sideLabel(match, phase.side) : '对方'}选择……
        </div>
      )}
      {pending && pending.requestedByUserId === source.myUserId && (
        <div className="flex items-center justify-center gap-2 rounded border border-gold-accent/40 bg-gold-accent/10 py-1.5 text-xs text-gold-accent">
          已发送撤销请求，等待对方处理
          <button
            type="button"
            onClick={() =>
              void Promise.resolve(useOnlineRoomStore.getState().sendCommand('REJECT_UNDO')).then((r) => {
                if (!r.ok && r.reason) toast(r.reason, 'error')
              })
            }
            className="text-fog-500 underline underline-offset-2 hover:text-fog-300"
          >
            撤回请求
          </button>
        </div>
      )}
      {pending && pending.requestedByUserId !== source.myUserId && (
        <div className="flex flex-wrap items-center justify-center gap-2 rounded border border-gold-accent/40 bg-gold-accent/10 py-1.5 text-xs text-gold-accent">
          {pending.requestedBy === 'BLUE' || pending.requestedBy === 'RED' ? sideLabel(match, pending.requestedBy) : '观众'}请求撤销上一步
          <button
            type="button"
            onClick={() => {
              void Promise.resolve(useOnlineRoomStore.getState().sendCommand('CONFIRM_UNDO')).then((res) => {
                if (!res.ok && res.reason) toast(res.reason, 'error')
              })
            }}
            className="rounded bg-gold-accent px-2.5 py-0.5 font-bold text-ink-950 hover:brightness-110"
          >
            接受
          </button>
          <button
            type="button"
            onClick={() => {
              void Promise.resolve(useOnlineRoomStore.getState().sendCommand('REJECT_UNDO')).then((res) => {
                if (!res.ok && res.reason) toast(res.reason, 'error')
              })
            }}
            className="rounded border border-gold-accent/50 px-2.5 py-0.5 text-gold-accent hover:bg-gold-accent/10"
          >
            拒绝
          </button>
        </div>
      )}
    </div>
  )
}
