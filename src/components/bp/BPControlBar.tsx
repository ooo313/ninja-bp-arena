import type { MatchState } from '@/types/match'
import { getPhase } from '@/engine/bpEngine'
import { useMatchSource } from '@/matchSource/context'
import { sideLabel } from '@bp-core'
import { toast } from '@/store/toastStore'

interface BPControlBarProps {
  match: MatchState
  onOpenHistory: () => void
}

/** 底部操作栏：移动端 sticky（含 safe-area），桌面为页尾操作区。本地/在线共用 */
export function BPControlBar({ match, onOpenHistory }: BPControlBarProps) {
  const source = useMatchSource()
  const phase = getPhase(match)
  const isOnline = source.mode === 'online'

  const phaseHint =
    phase.status === 'BANNING' || phase.status === 'PICKING'
      ? isOnline
        ? source.isMyTurn
          ? '轮到你'
          : '等待对方'
        : `${sideLabel(match, phase.side!)}${phase.action === 'BAN' ? '禁用' : '选择'}中`
      : phase.status === 'READY'
        ? '阵容已锁定'
        : phase.status === 'PLAYING'
          ? '比赛进行中'
          : '已记录胜负'

  const btn =
    'rounded border border-border-muted px-2.5 py-1.5 text-xs text-fog-300 transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-35'

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border-muted bg-ink-900/95 backdrop-blur"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="mx-auto flex w-full max-w-[1500px] items-center gap-2 px-2.5 py-1.5 lg:px-5">
        <span
          className={`truncate text-xs font-medium lg:hidden ${
            phase.status === 'PICKING' || (isOnline && source.isMyTurn)
              ? 'text-blue-team-soft'
              : phase.status === 'BANNING'
                ? 'text-red-team-soft'
                : 'text-fog-500'
          }`}
        >
          {phaseHint}
        </span>

        <div className="ml-auto flex items-center gap-1.5">
          <button type="button" onClick={onOpenHistory} className={btn}>
            历史
          </button>
          <button
            type="button"
            onClick={() => {
              void Promise.resolve(source.undo()).then((r) => {
                if (!r.ok && r.reason) toast(r.reason)
              })
            }}
            disabled={!source.canUndo || (isOnline && !!source.pendingUndo)}
            className={btn}
            title={isOnline ? '发送撤销请求（需对方确认）' : '撤销（Ctrl+Z）'}
          >
            {isOnline ? '申请撤销' : '撤销'}
          </button>
          {!isOnline && (
            <button
              type="button"
              onClick={() => {
                void Promise.resolve(source.redo()).then((r) => {
                  if (!r.ok && r.reason) toast(r.reason)
                })
              }}
              disabled={!source.canRedo}
              className={`${btn} hidden sm:block`}
            >
              重做
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
