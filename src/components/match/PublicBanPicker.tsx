import { useMemo, useState } from 'react'
import type { Ninja } from '@bp-core'
import { compareNinjaQuality, normalizeForSearch, searchRank } from '@/utils/format'

export function PublicBanPicker({ ninjas, selected, limit, onChange }: {
  ninjas: Ninja[]
  selected: string[]
  limit: number
  onChange: (ids: string[]) => void
}) {
  const [search, setSearch] = useState('')
  const pool = useMemo(() => ninjas.filter((ninja) => ninja.enabled && !ninja.deprecated).sort(compareNinjaQuality), [ninjas])
  const query = normalizeForSearch(search)
  const visible = pool.filter((ninja) => searchRank(ninja, query) < Infinity)
  return (
    <fieldset className="space-y-2 rounded-lg border border-border-muted p-3 text-xs text-fog-300">
      <legend className="px-1 font-bold text-fog-100">赛前公 Ban</legend>
      <p>双方全场禁用 · 已选 {selected.length} / {limit} 名。可以留空。</p>
      {selected.length > 0 && <div className="flex flex-wrap gap-1" aria-label="已选公 Ban">
        {selected.map((id) => <button key={id} type="button" className="rounded bg-red-team/20 px-2 py-1 text-red-team-soft"
          aria-label={'移除公 Ban ' + (pool.find((ninja) => ninja.id === id)?.name ?? id)}
          onClick={() => onChange(selected.filter((item) => item !== id))}>
          {pool.find((ninja) => ninja.id === id)?.name ?? id} ×
        </button>)}
      </div>}
      {limit > 0 ? <>
        <input className="w-full rounded border border-border-muted bg-ink-900 px-2 py-1.5" aria-label="搜索公 Ban 忍者"
          placeholder="搜索公 Ban 忍者" value={search} onChange={(event) => setSearch(event.target.value)} />
        <div className="flex max-h-28 flex-wrap gap-1 overflow-y-auto" aria-label="可选公 Ban 忍者">
          {visible.map((ninja) => {
            const active = selected.includes(ninja.id)
            return <button key={ninja.id} type="button" aria-pressed={active} disabled={!active && selected.length >= limit}
              className={`rounded border px-2 py-1 disabled:opacity-40 ${active ? 'border-red-team text-red-team-soft' : 'border-border-muted hover:border-gold-accent'}`}
              onClick={() => onChange(active ? selected.filter((id) => id !== ninja.id) : [...selected, ninja.id])}>{ninja.name}</button>
          })}
          {visible.length === 0 && <span className="text-fog-500">没有匹配的忍者</span>}
        </div>
      </> : <p className="text-fog-500">当前资源池需要保留全部可用忍者供 BP 使用。</p>}
    </fieldset>
  )
}
