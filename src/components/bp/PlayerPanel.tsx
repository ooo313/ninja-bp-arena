import { sideAtPosition } from '@bp-core'
import { useMemo } from 'react'
import { Radio } from 'lucide-react'
import type { Side } from '@/types/bp'
import { useMatchSource } from '@/matchSource/context'
import { getPhase } from '@/engine/bpEngine'
import { useNinjaLookup } from '@/hooks/useNinjaLookup'
import { BanSlot } from './BanSlot'
import { PickSlot } from './PickSlot'
import { getResourceDraftRules, getPlayerResourceState } from '@bp-core'

interface PlayerPanelProps {
  side: Side
}

/**
 * 阵容面板（桌面端左右两侧）：
 * - PICK 使用接近人物卡比例的大槽位，形成 BLUE VS RED 对阵感
 * - BAN 槽位更小、灰阶，明显区别于 Pick
 * - 当前行动方一侧轻微强化（描边 + 阴影），另一侧降低视觉权重
 * 槽位数量由当前局的规则序列推导；名字直接可见，不只显示 P1/P2/P3。
 */
export function PlayerPanel({ side }: PlayerPanelProps) {
  const source = useMatchSource()
  const match = source.match
  const { getById: ninjaById } = useNinjaLookup(match)

  const { bans, picks, hasBanPhase, acting } = useMemo(() => {
    if (!match) return { bans: [] as (string | undefined)[], picks: [] as (string | undefined)[], hasBanPhase: false, acting: false }
    const phase = getPhase(match)
    const game = match.games[match.games.length - 1]
    const player = side === 'BLUE' ? game.blue : game.red
    const steps = phase.expanded.filter((e) => e.side === side && e.resourceType === 'NINJA')
    const ninjaDraft = getResourceDraftRules(match.rule).find((item) => item.resourceType === 'NINJA' && item.enabled)
    const persistentBans = ninjaDraft?.banPersistence ? match.games.slice(0, -1).flatMap((past) => (side === 'BLUE' ? past.blue : past.red).bans) : []
    const visibleBans = [...new Set([...persistentBans, ...player.bans])]
    const banSlots = Math.max(steps.filter((e) => e.action === 'BAN').length, visibleBans.length)
    const pickSlots = ninjaDraft?.slotsPerSide ?? steps.filter((e) => e.action === 'PICK').length
    return {
      bans: Array.from({ length: banSlots }, (_, i) => visibleBans[i]),
      picks: Array.from({ length: pickSlots }, (_, i) => player.picks[i]),
      hasBanPhase: banSlots > 0,
      acting: phase.side === side && !phase.sequenceComplete,
    }
  }, [match, side])

  if (!match) return null

  const isBlue = sideAtPosition(match, side) === 'BLUE'
  const playerName = side === 'BLUE' ? match.bluePlayerName : match.redPlayerName
  const teamColor = isBlue ? 'text-blue-team-soft' : 'text-red-team-soft'
  const game = match.games[match.games.length - 1]
  const player = side === 'BLUE' ? game.blue : game.red
  const drafts = getResourceDraftRules(match.rule)
  const lockedBefore = drafts.filter((draft) => draft.enabled && draft.crossGameLock).map((draft) => {
    const ids = [...new Set(match.games.slice(0, -1).flatMap((past) => getPlayerResourceState(side === 'BLUE' ? past.blue : past.red, draft.resourceType).picks))]
    const names = ids.map((id) => draft.resourceType === 'NINJA'
      ? ninjaById(id)?.name ?? id
      : source.matchResources?.[draft.resourceType]?.find((item) => item.id === id)?.name ?? id)
    return { type: draft.resourceType, names }
  }).filter((item) => item.names.length > 0)

  return (
    <aside
      className={`flex flex-col gap-3.5 rounded-lg border bg-surface-1/70 p-3.5 transition-all ${
        acting
          ? isBlue
            ? 'border-blue-team/70 shadow-[0_0_28px_-8px] shadow-blue-team/50'
            : 'border-red-team/70 shadow-[0_0_28px_-8px] shadow-red-team/50'
          : 'border-border-muted opacity-85'
      }`}
    >
      <header className="flex items-center justify-between gap-2 border-b border-border-muted pb-2.5">
        <div className="min-w-0">
          <span className={`text-[10px] font-bold tracking-[0.2em] ${teamColor}`}>
            {isBlue ? 'BLUE' : 'RED'} · {isBlue ? '蓝方' : '红方'}
          </span>
          <p className="truncate text-base font-bold text-fog-100">{playerName}</p>
        </div>
        {acting && (
          <span className={`flex shrink-0 items-center gap-1 text-[10px] font-medium ${teamColor}`}>
            <Radio size={10} className="animate-pulse" /> 行动中
          </span>
        )}
      </header>

      {hasBanPhase && (
        <section>
          <h4 className="mb-1.5 text-[9px] font-bold tracking-[0.25em] text-fog-600">BAN · 禁用</h4>
          <div className="flex gap-2">
            {bans.map((id, i) => (
              <BanSlot key={`ban-${i}`} ninja={id ? ninjaById(id) : undefined} />
            ))}
          </div>
        </section>
      )}

      <section>
        <h4 className="mb-1.5 text-[9px] font-bold tracking-[0.25em] text-fog-600">PICK · 出战</h4>
        <div className="grid grid-cols-3 gap-2">
          {picks.map((id, i) => (
            <PickSlot key={`pick-${i}`} ninja={id ? ninjaById(id) : undefined} order={i + 1} side={sideAtPosition(match, side)} />
          ))}
        </div>
      </section>

      {(['SECRET_SCROLL', 'SUMMON'] as const).map((resourceType) => {
        const draft = drafts.find((item) => item.resourceType === resourceType && item.enabled)
        const slots = draft?.slotsPerSide ?? 0
        if (!slots) return null
        const ids = getPlayerResourceState(player, resourceType).picks
        const lookup = new Map((source.matchResources?.[resourceType] ?? []).map((item) => [item.id, item.name]))
        const bans = [...new Set(match.games.filter((past) => past.gameNumber === game.gameNumber || draft?.banPersistence).flatMap((past) => getPlayerResourceState(side === 'BLUE' ? past.blue : past.red, resourceType).bans))]
        return (
          <section key={resourceType}>
            <h4 className="mb-1.5 text-[9px] font-bold tracking-[0.25em] text-fog-600">
              {resourceType === 'SECRET_SCROLL' ? 'SECRET SCROLL · 秘卷' : 'SUMMON · 通灵'}
            </h4>
            <div className="grid grid-cols-3 gap-2">
              {Array.from({ length: slots }, (_, index) => (
                <div key={index} className="flex min-h-12 items-center justify-center rounded border border-ink-500 bg-ink-800 px-2 text-center text-xs text-fog-300">
                  {ids[index] ? (lookup.get(ids[index]) ?? ids[index]) : `${index + 1}`}
                </div>
              ))}
            </div>
            {bans.length > 0 && <p className="mt-1 text-[10px] text-fog-500">已 Ban：{bans.map((id) => lookup.get(id) ?? id).join('、')}</p>}
          </section>
        )
      })}
      {lockedBefore.length > 0 && <details className="border-t border-border-muted pt-2 text-[10px] text-fog-500">
        <summary className="cursor-pointer">跨局已用 / 锁定 · {lockedBefore.reduce((total, item) => total + item.names.length, 0)} 项</summary>
        {lockedBefore.map((item) => <p key={item.type} className="mt-1">{item.type}：{item.names.join('、')}</p>)}
      </details>}
    </aside>
  )
}
