import { useMemo, useState } from 'react'
import type { BattleRule, BPSequenceStep, DraftResourceType, ResourceDraftRule } from '@bp-core'
import { analyzeRuleFeasibility, getResourceDraftRules, RESOURCE_TYPE_LABEL } from '@bp-core'
import { DEFAULT_RULE, FULL_LOADOUT_DEMO_RULE, WUDOU_LOADOUT_RULE, cloneRule } from '@/data/defaultRules'
import { useNinjaStore } from '@/store/ninjaStore'
import { useDataPackStore } from '@/dataPack/store'
import { builtInPack } from '@/dataPack/loader'
import { BUILT_IN_PACK_ID } from '@/dataPack/types'
import { countEnabledResources } from '@bp-core'

const TYPES: DraftResourceType[] = ['NINJA', 'SECRET_SCROLL', 'SUMMON']
const fieldClass = 'rounded border border-border-strong bg-ink-900 px-2 py-1.5 text-sm text-fog-100'

function defaultDraft(type: DraftResourceType): ResourceDraftRule {
  const slots = type === 'SUMMON' ? 3 : 1
  return {
    resourceType: type, enabled: true, slotsPerSide: slots,
    sequence: [{ side: 'BLUE', action: 'PICK', count: slots }, { side: 'RED', action: 'PICK', count: slots }],
    crossGameLock: false, uniqueAcrossSides: true,
    banPersistence: false, banOnlyFirstGame: false, resetEachGame: true,
  }
}

export function RuleEditor({ draft, onChange, onSave, onRestore }: {
  draft: BattleRule
  onChange: (rule: BattleRule) => void
  onSave: () => void
  onRestore: () => void
}) {
  const [advanced, setAdvanced] = useState(false)
  const ninjas = useNinjaStore((state) => state.ninjas)
  const activePackId = useDataPackStore((state) => state.activePackId)
  const installedPacks = useDataPackStore((state) => state.installedPacks)
  const activePack = useMemo(() => activePackId === BUILT_IN_PACK_ID ? builtInPack() : installedPacks.find((pack) => pack.manifest.id === activePackId) ?? null, [activePackId, installedPacks])
  const drafts = getResourceDraftRules(draft)
  const available = useMemo(() => ({
    ninjas: countEnabledResources(ninjas),
    secretScrolls: countEnabledResources(activePack?.secretScrolls ?? []),
    summons: countEnabledResources(activePack?.summons ?? []),
  }), [ninjas, activePack])
  const analysis = analyzeRuleFeasibility(draft, available)

  const updateDraft = (type: DraftResourceType, patch: Partial<ResourceDraftRule>) => {
    const current = drafts.find((item) => item.resourceType === type) ?? defaultDraft(type)
    const next = [...drafts.filter((item) => item.resourceType !== type), { ...current, ...patch }]
      .sort((a, b) => TYPES.indexOf(a.resourceType) - TYPES.indexOf(b.resourceType))
    const ninja = next.find((item) => item.resourceType === 'NINJA')
    onChange({
      ...draft, id: 'custom-bp-rule', name: 'Custom（自定义示例）', version: '2.0-custom',
      resourceDrafts: next,
      ...(ninja ? {
        banSequence: ninja.sequence.filter((step) => step.action === 'BAN'),
        pickSequence: ninja.sequence.filter((step) => step.action === 'PICK'),
        bansPerPlayer: ninja.sequence.filter((step) => step.action === 'BAN' && step.side === 'BLUE').reduce((n, step) => n + step.count, 0),
        picksPerPlayer: ninja.slotsPerSide,
        banOnlyFirstGame: Boolean(ninja.banOnlyFirstGame),
        banPersistence: ninja.banPersistence,
        usedNinjaLocked: ninja.crossGameLock,
      } : {}),
    })
  }

  const changeSlots = (item: ResourceDraftRule, slots: number) => {
    const bans = item.sequence.filter((step) => step.action === 'BAN')
    const first = item.sequence.find((step) => step.action === 'PICK')?.side ?? 'BLUE'
    const second = first === 'RED' ? 'BLUE' : 'RED'
    updateDraft(item.resourceType, { slotsPerSide: slots, sequence: [
      ...bans, { side: first, action: 'PICK', count: slots }, { side: second, action: 'PICK', count: slots },
    ] })
  }

  const changeBans = (item: ResourceDraftRule, side: 'BLUE' | 'RED', count: number) => {
    const counts = { BLUE: 0, RED: 0 }
    for (const step of item.sequence) if (step.action === 'BAN') counts[step.side] += step.count
    counts[side] = count
    const bans: BPSequenceStep[] = (['BLUE', 'RED'] as const)
      .filter((team) => counts[team] > 0)
      .map((team) => ({ side: team, action: 'BAN', count: counts[team] }))
    updateDraft(item.resourceType, { sequence: [...bans, ...item.sequence.filter((step) => step.action === 'PICK')] })
  }

  const preview = useMemo(() => Array.from({ length: draft.bestOf }, (_, index) => ({
    game: index + 1,
    groups: drafts.filter((item) => item.enabled && (index === 0 || item.resetEachGame)).map((item) => ({
      type: item.resourceType,
      steps: item.sequence.filter((step) => index === 0 || !item.banOnlyFirstGame || step.action !== 'BAN'),
    })),
  })), [draft.bestOf, drafts])

  return (
    <div className="space-y-5">
      <p className="text-xs text-fog-500">规则为玩家自定义示例，不代表官方赛事规则。保存仅影响新比赛。</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs text-fog-300">模板
          <select className={fieldClass} value={draft.id === DEFAULT_RULE.id ? 'NINJA' : draft.id === FULL_LOADOUT_DEMO_RULE.id ? 'FULL' : draft.id === WUDOU_LOADOUT_RULE.id && draft.version === WUDOU_LOADOUT_RULE.version ? 'WUDOU' : 'CUSTOM'} onChange={(event) => {
            if (event.target.value === 'NINJA') onChange(cloneRule(DEFAULT_RULE))
            if (event.target.value === 'FULL') onChange(cloneRule(FULL_LOADOUT_DEMO_RULE))
            if (event.target.value === 'WUDOU') onChange(cloneRule(WUDOU_LOADOUT_RULE))
          }}>
            <option value="NINJA">Ninja Only（示例）</option>
            <option value="FULL">Full Loadout Demo（示例）</option>
            <option value="WUDOU">武斗完整阵容（同时盲选）</option>
            <option value="CUSTOM">Custom（自定义）</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-fog-300">赛制
          <select className={fieldClass} value={draft.bestOf} onChange={(event) => {
            const bestOf = Number(event.target.value)
            onChange({ ...draft, bestOf, winsRequired: (bestOf + 1) / 2, id: 'custom-bp-rule', name: 'Custom（自定义示例）' })
          }}>
            {[1, 3, 5].map((value) => <option key={value} value={value}>BO{value} · 先胜 {(value + 1) / 2} 局</option>)}
          </select>
        </label>
      </div>

      <label className="flex items-center gap-2 text-xs text-fog-300"><input type="checkbox" checked={Boolean(draft.swapSidesEachGame)} onChange={(event) => onChange({ ...draft, swapSidesEachGame: event.target.checked })} />每局结束后交换左右位置与先后手</label>
      <p className="text-xs text-fog-500">步骤中的蓝/红表示当局左/右位置；换边后选手随位置交换，比分、跨局锁定和在线身份仍归原选手。秘卷、通灵的同时盲选不设先后手。</p>
      {TYPES.map((type) => {
        const item = drafts.find((entry) => entry.resourceType === type)
        if (!item && type !== 'NINJA') return <label key={type} className="flex items-center gap-2 text-sm text-fog-300"><input type="checkbox" checked={false} onChange={() => updateDraft(type, defaultDraft(type))} />启用{RESOURCE_TYPE_LABEL[type]}</label>
        if (!item) return null
        const bans = (side: 'BLUE' | 'RED') => item.sequence.filter((step) => step.action === 'BAN' && step.side === side).reduce((n, step) => n + step.count, 0)
        return <section key={type} className="rounded border border-border-muted bg-ink-800/50 p-3">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h3 className="text-sm font-bold text-fog-100">{RESOURCE_TYPE_LABEL[type]}</h3>
            {type !== 'NINJA' && <label className="flex items-center gap-2 text-xs text-fog-300"><input type="checkbox" checked={item.enabled} onChange={(event) => updateDraft(type, { enabled: event.target.checked })} />启用</label>}
          </div>
          {item.enabled && <>
            {type !== 'NINJA' && <label className="mb-3 flex flex-col gap-1 text-xs text-fog-300">选择方式
              <select className={fieldClass} aria-label={`${RESOURCE_TYPE_LABEL[type]}选择方式`} value={item.selectionMode ?? 'SEQUENTIAL'} onChange={(event) => updateDraft(type, event.target.value === 'SIMULTANEOUS' ? {
                selectionMode: 'SIMULTANEOUS', uniqueAcrossSides: false, resetEachGame: true,
                sequence: [{ side: 'BLUE', action: 'PICK', count: item.slotsPerSide }, { side: 'RED', action: 'PICK', count: item.slotsPerSide }],
              } : { selectionMode: 'SEQUENTIAL' })}><option value="SEQUENTIAL">双方依次选择，即时公开</option><option value="SIMULTANEOUS">双方同时盲选，确认后统一公开</option></select>
              {item.selectionMode === 'SIMULTANEOUS' && <span className="text-fog-500">每方内部不重复；双方可以选择相同资源；每局重新选择。</span>}
            </label>}
            <div className="grid grid-cols-2 gap-3 text-xs text-fog-300 sm:grid-cols-3">
              <label className="flex flex-col gap-1">每方上场槽位<input className={fieldClass} type="number" min="1" max="12" value={item.slotsPerSide} onChange={(event) => changeSlots(item, Number(event.target.value))} /></label>
              {(['BLUE', 'RED'] as const).map((side) => <label key={side} className="flex flex-col gap-1">{side === 'BLUE' ? '蓝方' : '红方'} Ban 数<input disabled={item.selectionMode === 'SIMULTANEOUS'} className={fieldClass} type="number" min="0" max="12" value={bans(side)} onChange={(event) => changeBans(item, side, Number(event.target.value))} /></label>)}
            </div>
            <div className="mt-3 grid gap-2 text-xs text-fog-300 sm:grid-cols-2">
              {([
                ['crossGameLock', '跨局已使用资源锁定'],
                ['uniqueAcrossSides', '双方不可选择同一资源'],
                ['banPersistence', 'Ban 跨局持续生效'],
                ['banOnlyFirstGame', '仅第一局执行 Ban'],
                ['resetEachGame', '每局重新选择阵容'],
              ] as const).map(([key, label]) => <label key={key} className="flex items-center gap-2"><input type="checkbox" disabled={item.selectionMode === 'SIMULTANEOUS' && (key === 'uniqueAcrossSides' || key === 'resetEachGame')} checked={Boolean(item[key])} onChange={(event) => updateDraft(type, { [key]: event.target.checked })} />{label}</label>)}
            </div>
            {advanced && item.selectionMode !== 'SIMULTANEOUS' && <div className="mt-4 space-y-2 border-t border-border-muted pt-3">
              <p className="text-xs font-semibold text-fog-300">完整 Draft Sequence · 顺序即执行顺序</p>
              {item.sequence.map((step, index) => <div key={index} className="flex flex-wrap items-center gap-2">
                <span className="w-6 text-xs text-fog-600">{index + 1}.</span>
                <select className={fieldClass} aria-label={`${RESOURCE_TYPE_LABEL[type]}第${index + 1}步阵营`} value={step.side} onChange={(event) => updateDraft(type, { sequence: item.sequence.map((entry, i) => i === index ? { ...entry, side: event.target.value as 'BLUE' | 'RED' } : entry) })}><option value="BLUE">蓝方</option><option value="RED">红方</option></select>
                <select className={fieldClass} aria-label={`${RESOURCE_TYPE_LABEL[type]}第${index + 1}步动作`} value={step.action} onChange={(event) => updateDraft(type, { sequence: item.sequence.map((entry, i) => i === index ? { ...entry, action: event.target.value as 'BAN' | 'PICK' } : entry) })}><option value="BAN">Ban</option><option value="PICK">Pick</option></select>
                <input className={`${fieldClass} w-16`} type="number" min="1" max="12" aria-label={`${RESOURCE_TYPE_LABEL[type]}第${index + 1}步数量`} value={step.count} onChange={(event) => updateDraft(type, { sequence: item.sequence.map((entry, i) => i === index ? { ...entry, count: Number(event.target.value) } : entry) })} />
                <button type="button" className="text-xs text-red-team-soft underline" onClick={() => updateDraft(type, { sequence: item.sequence.filter((_, i) => i !== index) })}>移除</button>
              </div>)}
              <button type="button" className="text-xs text-gold-accent underline" onClick={() => updateDraft(type, { sequence: [...item.sequence, { side: 'BLUE', action: 'PICK', count: 1 }] })}>+ 添加步骤</button>
            </div>}
          </>}
        </section>
      })}

      <div className="grid gap-3 text-xs text-fog-300 sm:grid-cols-2">
        <label className="flex items-center gap-2"><input type="checkbox" checked={draft.timerEnabled} onChange={(event) => onChange({ ...draft, timerEnabled: event.target.checked })} />每个 Draft 步骤倒计时</label>
        {draft.timerEnabled && <label className="flex items-center gap-2">秒数<input className={`${fieldClass} w-20`} type="number" min="5" max="600" value={draft.timerSeconds} onChange={(event) => onChange({ ...draft, timerSeconds: Number(event.target.value) })} /></label>}
      </div>
      <button type="button" aria-expanded={advanced} className="text-xs text-gold-accent underline" onClick={() => setAdvanced(!advanced)}>{advanced ? '收起高级步骤编辑' : '展开高级步骤编辑'}</button>

      <section className="rounded border border-border-muted bg-ink-900/60 p-3 text-xs">
        <h3 className="mb-2 font-bold text-fog-100">规则预览 · BO{draft.bestOf}</h3>
        <div className="max-h-52 space-y-2 overflow-y-auto">
          {preview.map(({ game, groups }) => <div key={game}><p className="font-semibold text-gold-accent">GAME {game}{draft.swapSidesEachGame && <span> · {game % 2 === 0 ? '双方已交换左右位置' : game > 1 ? '双方换回首局位置' : '首局位置'}</span>}</p>
            {groups.length ? groups.map(({ type, steps }) => <p key={type} className="text-fog-400">{RESOURCE_TYPE_LABEL[type]}：{drafts.find((item) => item.resourceType === type)?.selectionMode === 'SIMULTANEOUS' ? `双方同时盲选各 ${drafts.find((item) => item.resourceType === type)?.slotsPerSide} 个 → 双方确认后公开` : steps.map((step) => `${step.side === 'BLUE' ? '蓝方' : '红方'} ${step.action} ×${step.count}`).join(' → ') || '沿用上一局'}</p>) : <p className="text-fog-400">沿用上一局阵容</p>}
            <p className="text-fog-600">READY → PLAYING → RESULT</p>
          </div>)}
        </div>
        <p className="mt-2 text-fog-400">最少可用资源：忍者 {analysis.requiredResources.ninjas} / 秘卷 {analysis.requiredResources.secretScrolls} / 通灵 {analysis.requiredResources.summons}</p>
      </section>
      {analysis.errors.length > 0 && <div role="alert" className="rounded border border-red-team/40 bg-red-team/10 p-3 text-xs text-red-team-soft"><p className="font-bold">规则暂不可保存</p>{analysis.errors.map((error, i) => <p key={`${i}-${error}`}>· {error}</p>)}</div>}
      {analysis.warnings.map((warning) => <p key={warning} className="text-xs text-gold-accent">{warning}</p>)}
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={onSave} disabled={analysis.errors.length > 0} className="rounded bg-blue-team px-4 py-2 text-xs font-bold text-white disabled:cursor-not-allowed disabled:opacity-40">保存规则</button>
        <button type="button" onClick={onRestore} className="rounded border border-border-strong px-4 py-2 text-xs text-fog-300">恢复 Ninja Only 示例</button>
      </div>
    </div>
  )
}
