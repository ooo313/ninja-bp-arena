import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, History, LayoutGrid, Maximize, Search, Undo2, Volume2, VolumeX } from 'lucide-react'
import { Link } from 'react-router-dom'
import { canSelectResource, getCurrentGame, getPhase, getPlayerResourceState, getResourceCardStatus, getResourceDraftRules, RESOURCE_TYPE_LABEL, type DraftResource, type DraftResourceType, type Side } from '@bp-core'
import { useMatchSource } from '@/matchSource/context'
import { useNinjaStore } from '@/store/ninjaStore'
import { useSettingsStore } from '@/store/settingsStore'
import { useDataPackStore } from '@/dataPack/store'
import { useTimerStore } from '@/store/timerStore'
import { resolveResourceAsset } from '@/dataPack/assetResolver'
import { normalizeForSearch, searchRank } from '@/utils/format'
import { toast } from '@/store/toastStore'
import { arenaAsset, displaySlots, pageItems, resourceArt } from './presentation'
import auxiliaryData from '@/data/arenaAuxiliary.json'
import { checkSealedChoice, getSealedDraft, snapshotResources } from '@bp-core'
import './arena.css'

interface Props {
  onlineBanner?: ReactNode
  onClassic: () => void
  onHistory: () => void
  onReset: () => void
  onWinner: (side: Side) => void
  onResults: () => void
  onTimerExpire: () => void
  onTimerRestart: () => void
  onResumeTimeout: () => void
  timeoutActive: boolean
}
const TYPE_ORDER: DraftResourceType[] = ['NINJA', 'SECRET_SCROLL', 'SUMMON']
const EMPTY_RESOURCES: DraftResource[] = []

/** Presentation only. Confirmation delegates the unchanged command to MatchSource. */
export function GameArena({ onlineBanner, onClassic, onHistory, onReset, onWinner, onResults, onTimerExpire, onTimerRestart, onResumeTimeout, timeoutActive }: Props) {
  const source = useMatchSource()
  const match = source.match!
  const phase = getPhase(match)
  const game = getCurrentGame(match)
  const storeNinjas = useNinjaStore((state) => state.ninjas)
  const settings = useSettingsStore((state) => state.settings)
  const ninjas = source.matchNinjas ?? storeNinjas
  const [viewType, setViewType] = useState<DraftResourceType>(phase.resourceType ?? 'NINJA')
  const [quality, setQuality] = useState('ALL')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const [preview, setPreview] = useState<{ type: DraftResourceType; id: string; revision: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const confirming = useRef(false)
  const sealed = getSealedDraft(match)
  const [localSide, setLocalSide] = useState<Side>('BLUE')
  const actingSide: Side = source.mode === 'online' ? source.mySeat === 'RED' ? 'RED' : 'BLUE' : localSide
  const [draftSlots, setDraftSlots] = useState<Record<string, (string | null)[]>>({})
  const [editingSlot, setEditingSlot] = useState<{ key: string; index: number }>({ key: '', index: 0 })
  const draftKey = sealed ? `${sealed.key}:${actingSide}` : ''
  const ownLocked = sealed && source.privateLoadouts?.[actingSide]?.phase_key === sealed.key ? source.privateLoadouts[actingSide] : undefined
  const slotIds = ownLocked?.resource_ids ?? draftSlots[draftKey] ?? Array.from({ length: sealed?.count ?? 0 }, () => null)
  const activeSlot = editingSlot.key === draftKey ? editingSlot.index : 0
  const batchComplete = Boolean(sealed && slotIds.length === sealed.count && slotIds.every(Boolean))
  const resources = snapshotResources(match.resourceSnapshot)
  const drafts = getResourceDraftRules(match.rule).filter((draft) => draft.enabled)
  const inDraft = phase.status === 'BANNING' || phase.status === 'PICKING'
  const activeType = phase.resourceType ?? 'NINJA'
  useEffect(() => { setViewType(activeType); setPage(0); setSearch('') }, [activeType])
  const pool = viewType === 'NINJA' ? ninjas : source.matchResources?.[viewType] ?? EMPTY_RESOURCES
  const filtered = useMemo(() => {
    const query = normalizeForSearch(search)
    return pool.filter((resource) => (quality === 'ALL' || viewType !== 'NINJA' || ('quality' in resource && resource.quality === quality)) && (!query || searchRank(resource, query) < Infinity))
  }, [pool, quality, search, viewType])
  const visible = pageItems(filtered, page)
  const selected = preview?.type === viewType && preview.revision === match.updatedAt ? pool.find((resource) => resource.id === preview.id) : undefined
  const check = selected ? sealed ? checkSealedChoice(match, actingSide, viewType, selected.id, resources, slotIds.filter((id, index): id is string => Boolean(id) && index !== activeSlot)) : canSelectResource(match, viewType, selected.id, selected) : undefined
  const canConfirm = inDraft && activeType === viewType && source.canOperate && !ownLocked && !busy && !source.pendingCommand && !timeoutActive && (selected ? Boolean(check?.allowed) : Boolean(sealed && batchComplete))
  const canControl = source.mode === 'local' || Boolean(source.isHost && source.connection === 'connected' && !source.pendingCommand)
  const title = phase.status === 'BANNING' ? '禁用' + RESOURCE_TYPE_LABEL[activeType] + '选择' : inDraft ? `${RESOURCE_TYPE_LABEL[activeType]}选择` : phase.status === 'READY' ? '准备战斗' : phase.status === 'PLAYING' ? '对战进行中' : match.status === 'MATCH_FINISHED' ? '比赛结束' : '本局结束'
  const titleArt = inDraft ? phase.status === 'BANNING' ? activeType === 'NINJA' ? 'title-ban.webp' : undefined : activeType === 'SECRET_SCROLL' ? 'title-scroll.webp' : activeType === 'SUMMON' ? 'title-summon.webp' : 'title-pick.webp' : phase.status === 'READY' ? 'title-ready.webp' : undefined
  const timeSeconds = drafts.find((draft) => draft.resourceType === activeType)?.timerSeconds ?? match.rule.timerSeconds
  const resourceById = (id: string | null, type: DraftResourceType = 'NINJA') => id ? (type === 'NINJA' ? ninjas : source.matchResources?.[type] ?? []).find((item) => item.id === id) : undefined

  const confirm = async () => {
    if (!canConfirm || confirming.current) return
    if (sealed && selected) {
      const next = [...slotIds]; next[activeSlot] = selected.id
      setDraftSlots((previous) => ({ ...previous, [draftKey]: next }))
      const empty = next.findIndex((id) => !id)
      setEditingSlot({ key: draftKey, index: empty < 0 ? activeSlot : empty })
      setPreview(null)
      return
    }
    confirming.current = true; setBusy(true)
    try {
      const result = await Promise.resolve(sealed ? source.submitLoadout?.(actingSide, sealed.resourceType, slotIds as string[]) ?? { ok: false, reason: '当前页面不支持整组确认，请刷新' } : selected ? viewType === 'NINJA' ? source.selectNinja(selected.id) : source.selectResource(viewType, selected.id) : { ok: false })
      if (result.ok) {
        setPreview(null)
        if (sealed && source.mode === 'local') setLocalSide(actingSide === 'BLUE' ? 'RED' : 'BLUE')
      }
      else toast(result.reason ?? '选择未完成，请确认当前回合', 'error')
    } catch { toast('操作未确认，请检查连接后重试', 'error') }
    finally { confirming.current = false; setBusy(false) }
  }
  const control = async (operation: () => ReturnType<typeof source.enterGame>, hostOnly = true) => {
    if ((hostOnly && !canControl) || confirming.current || (source.mode === 'online' && (source.connection !== 'connected' || source.pendingCommand))) return
    confirming.current = true; setBusy(true)
    try { const result = await Promise.resolve(operation()); if (!result.ok) toast(result.reason ?? '操作未完成', 'error') }
    catch { toast('操作未确认，请检查连接后重试', 'error') }
    finally { confirming.current = false; setBusy(false) }
  }
  const fullscreen = async () => {
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen() }
    catch { toast('当前浏览器不支持全屏显示', 'info') }
  }
  const status = busy || source.pendingCommand ? '正在确认，请稍候…' : ownLocked ? '己方已确认 · 等待对手完成后统一公开' : timeoutActive && inDraft ? '本轮计时结束 · 等待处理' : sealed && (source.mode === 'local' || source.mySeat === 'BLUE' || source.mySeat === 'RED') ? selected ? `已预览：${selected.name} · 点击选择放入第 ${activeSlot + 1} 个位置` : batchComplete ? `已选满 ${sealed.count} 个 · 确认整组后等待双方公开` : `选择第 ${activeSlot + 1} 个${RESOURCE_TYPE_LABEL[sealed.resourceType]} · 尚未提交` : source.mode === 'online' && !source.isMyTurn && inDraft ? `等待${phase.side === 'BLUE' ? '1P' : '2P'}操作` : selected ? `已预览：${selected.name} · 点击选择确认` : inDraft ? '先点选头像预览，再点击「选择」确认' : phase.status === 'READY' ? '阵容锁定 · 准备进入战斗' : '本场配置与进度已保留'

  const visibleLoadout = (side: Side, type: 'SECRET_SCROLL' | 'SUMMON') => {
    const confirmed = getPlayerResourceState(side === 'BLUE' ? game.blue : game.red, type).picks
    if (confirmed.length) return confirmed
    if (sealed?.resourceType !== type || side !== actingSide || (source.mode === 'online' && source.mySeat !== side)) return []
    const ids = [...slotIds]
    if (selected && viewType === type && !ownLocked) ids[activeSlot] = selected.id
    return ids
  }
  const editSlot = (index: number) => { setEditingSlot({ key: draftKey, index }); setPreview(null) }
  const renderSummons = (side: Side) => {
    const rule = drafts.find((draft) => draft.resourceType === 'SUMMON')
    if (!rule) return null
    const ids = visibleLoadout(side, 'SUMMON')
    const slots = Array.from({ length: rule.slotsPerSide }, (_, index) => index)
    if (side === 'BLUE') slots.reverse()
    return <div className={`arena-summons arena-summons-${side.toLowerCase()}`} aria-label={`${side === 'BLUE' ? '蓝方' : '红方'}通灵顺序`}><span className="arena-summon-label">通灵兽</span>{slots.map((index) => {
      const item = resourceById(ids[index] ?? null, 'SUMMON')
      return <button key={index} className="arena-summon-slot" disabled={!sealed || sealed.resourceType !== 'SUMMON' || side !== actingSide || !source.canOperate || Boolean(ownLocked)} onClick={() => editSlot(index)} aria-label={`${side === 'BLUE' ? '蓝方' : '红方'}第${index + 1}个通灵${item ? ` ${item.name}` : ' 未公开'}`}>{item ? <ResourceImage resource={item} className="arena-summon-icon" /> : <b>?</b>}<i>{index + 1}</i><small>{item?.name ?? '待选择'}</small></button>
    })}</div>
  }

  const renderTeam = (side: Side) => {
    const banning = phase.status === 'BANNING' && activeType === 'NINJA'
    const ids = displaySlots(match, side, 'NINJA', banning)
    const nextSlot = ids.findIndex((id) => id === null)
    const ordered = ids.map((id, index) => ({ id, index }))
    if (side === 'BLUE') ordered.reverse()
    return <div className={`arena-team arena-team-${side.toLowerCase()}`} data-slots={ids.length} aria-label={`${side === 'BLUE' ? '蓝方' : '红方'}${banning ? '禁用' : '出战'}阵容`}>
      {ordered.map(({ id, index }) => {
        const isPreview = !id && index === nextSlot && phase.side === side && viewType === 'NINJA' && selected && inDraft
        const resource = isPreview ? selected : resourceById(id)
        return <div key={index} className={`arena-fighter ${resource ? 'has-character' : ''} ${isPreview ? 'is-preview' : ''} ${banning && id ? 'is-sealed' : ''}`} style={{ width: `${100 / ids.length}%` }}>
          <div className="arena-fighter-glow" />
          {resource ? <ResourceImage resource={resource} portrait className="arena-portrait" /> : <img src={arenaAsset(`silhouette-${side.toLowerCase()}.webp`)} alt="等待选择" className="arena-silhouette" />}
          {banning && id && <img src={arenaAsset(`seal-${side.toLowerCase()}.webp`)} alt="已封印" className="arena-seal" />}
          <div className="arena-fighter-caption">{index < 3 ? <img src={arenaAsset(`${side.toLowerCase()}-${index + 1}.webp`)} alt={`${index + 1}`} /> : <b className="arena-slot-number">{index + 1}</b>}<span title={resource?.name}>{resource?.name.includes('「') ? <><em>[{resource.name.split('「')[1].replace('」','')}]</em><strong>{resource.name.split('「')[0]}</strong></> : resource?.name ?? '等待选择'}</span>{isPreview && <small>预览 · 待确认</small>}</div>
          {!banning && drafts.some((draft) => draft.resourceType === 'SECRET_SCROLL' && index < draft.slotsPerSide) && (() => {
            const id = visibleLoadout(side, 'SECRET_SCROLL')[index]
            const scroll = resourceById(id ?? null, 'SECRET_SCROLL')
            return <button className="arena-fighter-scroll" aria-label={`${side === 'BLUE' ? '蓝方' : '红方'}第${index + 1}位忍者秘卷${scroll ? ` ${scroll.name}` : ' 未公开'}`} disabled={!sealed || sealed.resourceType !== 'SECRET_SCROLL' || side !== actingSide || !source.canOperate || Boolean(ownLocked)} onClick={() => editSlot(index)}>{scroll ? <ResourceImage resource={scroll} className="arena-scroll-icon" /> : <b>?</b>}<small>{scroll?.name ?? '秘卷'}</small></button>
          })()}
        </div>
      })}
      {!banning && drafts.some((draft) => draft.resourceType === 'SECRET_SCROLL' && draft.slotsPerSide > ids.length) && <div className="arena-overflow-scrolls" aria-label={`${side === 'BLUE' ? '蓝方' : '红方'}其他秘卷`}><small>其他秘卷</small>{Array.from({ length: (drafts.find((draft) => draft.resourceType === 'SECRET_SCROLL')?.slotsPerSide ?? 0) - ids.length }, (_, offset) => {
        const index = ids.length + offset
        const item = resourceById(visibleLoadout(side, 'SECRET_SCROLL')[index] ?? null, 'SECRET_SCROLL')
        return <button key={index} title={item?.name ?? '未公开'} disabled={sealed?.resourceType !== 'SECRET_SCROLL' || side !== actingSide || !source.canOperate || Boolean(ownLocked)} onClick={() => editSlot(index)} aria-label={`${side === 'BLUE' ? '蓝方' : '红方'}第${index + 1}个秘卷 ${item?.name ?? '未公开'}`}>{item ? <ResourceImage resource={item} className="arena-scroll-icon" /> : index + 1}</button>
      })}</div>}
    </div>
  }

  return <div className="game-shell">
    <div className="arena-toolbar"><Link to="/" aria-label="返回首页"><ArrowLeft size={15} /></Link><span>忍界 BP</span><small>GAME {match.currentGame} · {match.score.blue} : {match.score.red}</small><div className="arena-tools-right"><button onClick={() => useSettingsStore.getState().update({ soundEnabled: !settings.soundEnabled })} aria-label={settings.soundEnabled ? '关闭音效' : '开启音效'}>{settings.soundEnabled ? <Volume2 size={15} /> : <VolumeX size={15} />}</button><button onClick={onHistory} aria-label="查看 BP 记录"><History size={15} /></button><button disabled={!source.canUndo || busy} onClick={() => void control(source.undo, false)} aria-label="撤销上一步"><Undo2 size={15} /></button><button onClick={onClassic} disabled={Boolean(sealed)} title={sealed ? '同时选择阶段使用阵容编辑界面' : '切换经典界面'} aria-label="切换经典界面"><LayoutGrid size={15} /></button><button onClick={() => void fullscreen()} aria-label="全屏显示"><Maximize size={15} /></button></div></div>
    <section className={`game-arena ${drafts.some((draft) => draft.resourceType === 'SUMMON') ? 'has-loadout' : ''}`} aria-label="武斗赛 BP 选人界面" style={{ backgroundImage: `url("${arenaAsset('background.webp')}")` }}>
      <div className="arena-clouds" aria-hidden="true"><img src={arenaAsset('cloud.webp')} /><img src={arenaAsset('cloud.webp')} /></div>
      <div className="arena-player arena-player-blue"><span>{match.bluePlayerName}</span><span className="arena-player-emblem"><img src={arenaAsset('one-p.webp')} alt="1P 蓝方" /></span></div>
      <div className="arena-player arena-player-red"><span className="arena-player-emblem"><img src={arenaAsset('two-p.webp')} alt="2P 红方" /></span><span>{match.redPlayerName}</span></div>
      {renderSummons('BLUE')}{renderSummons('RED')}
      <div className="arena-heading"><h1>{titleArt ? <img src={arenaAsset(titleArt)} alt={title} /> : title}</h1>{inDraft && match.rule.timerEnabled ? <ArenaCountdown seconds={timeSeconds} deadline={source.mode === 'online' ? source.onlineDeadline : undefined} onExpire={onTimerExpire} /> : <span className="arena-round-label">{inDraft ? '不限时' : `${match.score.blue} : ${match.score.red}`}</span>}</div>
      <div className="arena-stage">{renderTeam('BLUE')}{renderTeam('RED')}</div>
      {source.pendingUndo && <div className="arena-online-notice">{onlineBanner}</div>}
      {inDraft && viewType !== 'NINJA' && selected && <div className="arena-aux-preview" aria-live="polite"><ResourceImage resource={selected} className="arena-aux-art" /><span>{selected.name}</span><small>预览 · 尚未提交</small></div>}
      <div className="arena-stage-divider" />
      <div className="arena-step-hint" aria-live="polite"><i className={phase.side === 'RED' ? 'red' : ''} />{sealed ? `双方同时选择${RESOURCE_TYPE_LABEL[sealed.resourceType]}` : inDraft ? `${phase.side === 'BLUE' ? '1P' : '2P'} · ${phase.action === 'BAN' ? '禁用' : '选择'}${RESOURCE_TYPE_LABEL[activeType]}` : title}<span>{status}</span></div>
      {sealed && <div className="arena-draft-editor" aria-label="己方阵容编辑">{source.mode === 'local' && <div className="arena-local-sides">{(['BLUE','RED'] as const).map((side) => <button key={side} aria-pressed={actingSide === side} onClick={() => { setLocalSide(side); setPreview(null) }}>{side === 'BLUE' ? '蓝方操作' : '红方操作'}</button>)}</div>}{(source.mode === 'local' || source.mySeat === 'BLUE' || source.mySeat === 'RED') ? slotIds.map((id, index) => <button key={index} disabled={Boolean(ownLocked) || busy || !source.canOperate} aria-pressed={activeSlot === index} onClick={() => editSlot(index)} aria-label={`编辑第${index + 1}个${RESOURCE_TYPE_LABEL[sealed.resourceType]}`}>{sealed.resourceType === 'SECRET_SCROLL' ? `${index + 1}号忍者` : `通灵${index + 1}`} · {resourceById(id, sealed.resourceType)?.name ?? '待选择'}</button>) : <span>双方选择中 · 确认后统一公开</span>}</div>}
      {inDraft && timeoutActive && <div className="arena-timeout"><span>本轮计时结束</span><button disabled={!canControl} onClick={onTimerRestart}>重新计时</button>{source.mode === 'local' && <button onClick={onResumeTimeout}>继续操作</button>}</div>}
      {inDraft ? <>
        <div className={`arena-pool ${sealed ? 'is-sealed-draft' : ''}`} role="grid" aria-label={`${RESOURCE_TYPE_LABEL[viewType]}资源列表`}>
          {visible.items.map((resource) => {
            const eligibility = sealed ? checkSealedChoice(match, actingSide, viewType, resource.id, resources, slotIds.filter((id, index): id is string => Boolean(id) && index !== activeSlot)) : canSelectResource(match, viewType, resource.id, resource)
            const state = getResourceCardStatus(match, viewType, resource).status
            const highlighted = selected?.id === resource.id
            const locked = !eligibility.allowed || !source.canOperate || Boolean(ownLocked) || busy || Boolean(source.pendingCommand) || timeoutActive
            return <button key={resource.id} type="button" role="gridcell" data-resource-card data-state={state} aria-label={`预览${RESOURCE_TYPE_LABEL[viewType]} ${resource.name}`} aria-pressed={highlighted} disabled={locked} title={`${resource.name}${eligibility.reason ? ' · ' + eligibility.reason : ''}`} className={`arena-card ${highlighted ? 'is-active' : ''} ${state !== 'AVAILABLE' ? 'state-' + state.toLowerCase() : ''}`} onClick={() => setPreview({ type: viewType, id: resource.id, revision: match.updatedAt })}>
              <ResourceImage resource={resource} className="arena-card-image" />
              {'quality' in resource && <b className={`arena-rank rank-${resource.quality}`}>{String(resource.quality)}</b>}
              {state === 'BANNED' && <span className="arena-card-seal">封</span>}
              {(state === 'BLUE_PICKED' || state === 'RED_PICKED') && <span className="arena-card-badge">已选</span>}
              {state === 'USED' && <span className="arena-card-badge">已出战</span>}
              {viewType !== 'NINJA' && <span className="arena-card-name">{resource.name}</span>}
            </button>
          })}
          {visible.items.length === 0 && <p className="arena-empty">没有符合条件的{RESOURCE_TYPE_LABEL[viewType]}，请调整搜索或筛选。</p>}
        </div>
        <button className="arena-page-arrow previous" disabled={visible.page === 0} onClick={() => setPage(visible.page - 1)} aria-label="上一页"><img src={arenaAsset('arrow.webp')} alt="" /></button><button className="arena-page-arrow next" disabled={visible.page === visible.pages - 1} onClick={() => setPage(visible.page + 1)} aria-label="下一页"><img src={arenaAsset('arrow.webp')} alt="" /></button>
        <div className="arena-pagination"><span>{visible.page + 1} / {visible.pages}</span><i />{filtered.length} 位{RESOURCE_TYPE_LABEL[viewType]}</div>
      </> : <div className="arena-between-rounds"><span>{phase.status === 'READY' ? '双方阵容已锁定' : phase.status === 'PLAYING' ? '对战进行中' : match.status === 'MATCH_FINISHED' ? `${match.score.blue > match.score.red ? match.bluePlayerName : match.redPlayerName} 获胜` : '等待进入下一局'}</span><small>{phase.status === 'READY' ? '确认阵容后，由房主开始战斗' : '记录胜者，准备下一回合'}</small>{phase.status === 'PLAYING' && <div><button disabled={!canControl || busy} onClick={() => onWinner('BLUE')}>蓝方获胜</button><button disabled={!canControl || busy} onClick={() => onWinner('RED')}>红方获胜</button></div>}</div>}
      <div className="arena-footer" aria-hidden="true" />
      <div className="arena-filters" aria-label="品质筛选">{viewType === 'NINJA' ? ['ALL','S','A','B','C'].map((value) => <button key={value} className={quality === value ? 'selected' : ''} aria-pressed={quality === value} onClick={() => { setQuality(value); setPage(0) }}>{value === 'ALL' ? '全部' : value + '级'}</button>) : TYPE_ORDER.filter((type) => drafts.some((draft) => draft.resourceType === type)).map((type) => <button key={type} className={viewType === type ? 'selected' : ''} onClick={() => { setViewType(type); setPage(0) }}>{RESOURCE_TYPE_LABEL[type]}</button>)}</div>
      {inDraft && <label className="arena-search"><Search size={15} /><input aria-label={`搜索${RESOURCE_TYPE_LABEL[viewType]}`} value={search} onChange={(event) => { setSearch(event.target.value); setPage(0) }} placeholder={`搜索${RESOURCE_TYPE_LABEL[viewType]}`} /></label>}
      <div className="arena-confirm-wrap">{inDraft ? <button className={`arena-confirm ${sealed && !selected ? 'group-confirm' : ''}`} disabled={!canConfirm} onClick={() => void confirm()}>{busy || source.pendingCommand ? '确认中…' : ownLocked ? '等待对手' : sealed && batchComplete && !selected ? `确认${RESOURCE_TYPE_LABEL[sealed.resourceType]}` : '选择'}</button> : phase.status === 'READY' ? <button className="arena-confirm" disabled={!canControl || busy} onClick={() => void control(source.enterGame)}>准备战斗</button> : phase.status === 'COMPLETED' && match.status !== 'MATCH_FINISHED' ? <button className="arena-confirm" disabled={!canControl || busy} onClick={() => void control(source.nextGame)}>下一局</button> : <button className="arena-confirm" onClick={match.status === 'MATCH_FINISHED' ? onResults : onHistory}>{match.status === 'MATCH_FINISHED' ? '比赛结果' : '比赛记录'}</button>}</div>
      {!inDraft && <button className="arena-reset" onClick={onReset}>重新开始</button>}
    </section>
    <p className="arena-footnote">玩家自制 BP 工具 · 角色与界面素材来自用户提供的游戏资源及官网 · {source.mode === 'online' ? '在线操作以服务器确认为准' : '本地模式'}</p>
  </div>
}

function ResourceImage({ resource, portrait = false, className }: { resource: DraftResource; portrait?: boolean; className: string }) {
  const [failed, setFailed] = useState<string[]>([])
  const meta = resourceArt(resource)
  const assetBaseUrl = useDataPackStore((state) => state.activePack()?.manifest.assetBaseUrl)
  const resolved = resolveResourceAsset(resource, assetBaseUrl ? { assetBaseUrl } : null)
  const options = portrait ? [meta?.localPortrait ? arenaAsset(meta.localPortrait) : undefined, meta?.portrait, resolved, meta?.icon] : [meta?.localIcon && (!resolved || resolved === meta.icon) ? arenaAsset(meta.localIcon) : undefined, resolved, meta?.icon]
  const url = options.find((option) => option && !failed.includes(option))
  const sprite = (auxiliaryData as Record<string, { x: number; y: number; width: number; height: number; sheetWidth: number; sheetHeight: number; sourceAvatar?: string | null }>)[resource.id]
  if (sprite && (!resolved || resolved === sprite.sourceAvatar || /^\/assets\/(summons|secret-scrolls)\//.test(resolved))) {
    return <span role="img" aria-label={resource.name} className={className} style={{ display: 'block', backgroundImage: `url("${arenaAsset('auxiliary.webp')}")`, backgroundRepeat: 'no-repeat', backgroundSize: `${sprite.sheetWidth / sprite.width * 100}% ${sprite.sheetHeight / sprite.height * 100}%`, backgroundPosition: `${sprite.x / (sprite.sheetWidth - sprite.width) * 100}% ${sprite.y / (sprite.sheetHeight - sprite.height) * 100}%` }} />
  }
  return url ? <img src={url} alt={resource.name} className={className} decoding="async" loading={portrait ? 'eager' : 'lazy'} onError={() => setFailed((previous) => [...previous, url])} /> : <span className={`${className} arena-image-placeholder`}>{resource.name.slice(0, 2)}</span>
}

function ArenaCountdown({ seconds, deadline, onExpire }: { seconds: number; deadline?: number | null; onExpire: () => void }) {
  const localDeadline = useTimerStore((state) => state.deadlineAt)
  const effectiveDeadline = deadline !== undefined ? deadline : localDeadline
  const [now, setNow] = useState(Date.now)
  const expired = useRef<number | null>(null)
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 250); return () => window.clearInterval(timer) }, [])
  const remaining = effectiveDeadline ? Math.min(seconds, Math.max(0, Math.ceil((effectiveDeadline - now) / 1000))) : seconds
  useEffect(() => { if (effectiveDeadline && remaining === 0 && expired.current !== effectiveDeadline) { expired.current = effectiveDeadline; onExpire() } }, [effectiveDeadline, remaining, onExpire])
  return <span className={`arena-countdown ${remaining <= 10 ? 'warning' : ''}`} role="timer" aria-label={`剩余 ${remaining} 秒`}>{remaining}</span>
}
