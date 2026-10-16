import { useMemo } from 'react'
import { X } from 'lucide-react'
import { useMatchSource } from '@/matchSource/context'
import { useNinjaLookup, useResourceLookup } from '@/hooks/useNinjaLookup'
import { groupHistoryByGame } from '@/engine/historyEngine'
import { formatTime } from '@/utils/format'
import { sideAtPosition, sideLabel } from '@bp-core'

interface BPHistoryDrawerProps {
  open: boolean
  onClose: () => void
}

/** BP 历史记录抽屉：按 Game 分组的完整操作流水（本地 / 在线共用） */
export function BPHistoryDrawer({ open, onClose }: BPHistoryDrawerProps) {
  const match = useMatchSource().match
  const { nameOf } = useNinjaLookup(match)
  const resourceNameOf = useResourceLookup(match)
  const groups = useMemo(() => (match ? groupHistoryByGame(match) : []), [match])

  if (!open || !match) return null

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="历史记录">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <aside className="absolute inset-y-0 right-0 flex w-full max-w-sm flex-col border-l border-ink-500 bg-ink-900 shadow-2xl shadow-black/60">
        <header className="flex items-center justify-between border-b border-ink-600 px-4 py-3">
          <h3 className="text-sm font-semibold tracking-wide">BP 历史记录</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭历史记录"
            className="rounded-md p-1.5 text-fog-500 transition-colors hover:bg-ink-600 hover:text-fog-100"
          >
            <X size={16} />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto p-4" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
          {groups.length === 0 && <p className="py-10 text-center text-sm text-fog-600">还没有任何操作</p>}
          {groups.map((group) => (
            <section key={group.gameNumber} className="mb-5">
              <h4 className="mb-2 flex items-center gap-2 text-[11px] font-bold tracking-widest text-gold">
                GAME {group.gameNumber}
                {group.winner && (
                  <span className={`rounded px-1.5 py-0.5 text-[9px] ${sideAtPosition(match, group.winner, group.gameNumber) === 'BLUE' ? 'bg-side-blue/20 text-side-blue-soft' : 'bg-side-red/20 text-side-red-soft'}`}>
                    {sideLabel(match, group.winner, group.gameNumber)}胜
                  </span>
                )}
              </h4>
              <ol className="space-y-1">
                {group.actions.map((action, i) => (
                  <li key={action.id} className="flex items-center gap-2 rounded-md bg-ink-800/60 px-2.5 py-1.5 text-xs">
                    <span className="w-6 text-right tabular-nums text-fog-600">{String(i + 1).padStart(2, '0')}</span>
                    <span className={`w-8 font-semibold ${sideAtPosition(match, action.side, group.gameNumber) === 'BLUE' ? 'text-side-blue-soft' : 'text-side-red-soft'}`}>
                      {sideLabel(match, action.side, group.gameNumber)}
                    </span>
                    <span
                      className={`w-10 rounded px-1 text-center text-[10px] font-bold ${
                        action.action === 'BAN' ? 'bg-side-red/20 text-side-red-soft' : 'bg-emerald-500/15 text-emerald-300'
                      }`}
                    >
                      {action.action}
                    </span>
                    <span className="flex-1 truncate text-fog-100">{action.resourceType && action.resourceType !== 'NINJA' ? resourceNameOf(action.resourceType, action.resourceId ?? action.ninjaId) : nameOf(action.ninjaId)}</span>
                    <span className="text-[10px] tabular-nums text-fog-600">{formatTime(action.timestamp)}</span>
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </div>
      </aside>
    </div>
  )
}
