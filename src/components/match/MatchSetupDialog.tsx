import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle } from 'lucide-react'
import { Dialog } from '@/components/common/Dialog'
import { useBPStore } from '@/store/bpStore'
import { useSettingsStore } from '@/store/settingsStore'
import { DEFAULT_RULE, FULL_LOADOUT_DEMO_RULE, WUDOU_LOADOUT_RULE, cloneRule } from '@/data/defaultRules'
import { countEnabledResources, analyzeRuleFeasibility, getResourceDraftRules, RESOURCE_TYPE_LABEL } from '@bp-core'
import { useNinjaStore } from '@/store/ninjaStore'
import type { MatchState } from '@/types/match'
import { useDataPackStore } from '@/dataPack/store'
import { builtInPack } from '@/dataPack/loader'
import { BUILT_IN_PACK_ID } from '@/dataPack/types'

interface MatchSetupDialogProps {
  open: boolean
  onClose: () => void
  /** 存在未完成比赛时提示 */
  unfinished?: MatchState | null
}

/** 首页 / 导航「开始 BP」弹窗：填写双方名称，使用当前规则模板开赛 */
export function MatchSetupDialog({ open, onClose, unfinished }: MatchSetupDialogProps) {
  const navigate = useNavigate()
  const startNewMatch = useBPStore((s) => s.startNewMatch)
  // 注意：selector 不能直接调用 activeRule()（每次返回新对象会触发无限重渲染），
  // 这里选引用再 useMemo 克隆。
  const customRule = useSettingsStore((s) => s.customRule)
  const currentRule = useMemo(() => cloneRule(customRule ?? DEFAULT_RULE), [customRule])
  const [template, setTemplate] = useState<'CURRENT' | 'FULL_LOADOUT' | 'WUDOU'>('CURRENT')
  const rule = template === 'WUDOU' ? cloneRule(WUDOU_LOADOUT_RULE) : template === 'FULL_LOADOUT' ? cloneRule(FULL_LOADOUT_DEMO_RULE) : currentRule
  const [blueName, setBlueName] = useState('')
  const [redName, setRedName] = useState('')
  // 注意：selector 不能每次返回新对象（会触发无限重渲染），这里选 ninjas 数组后计算
  const ninjas = useNinjaStore((s) => s.ninjas)
  const activePackId = useDataPackStore((s) => s.activePackId)
  const installedPacks = useDataPackStore((s) => s.installedPacks)
  const activePack = activePackId === BUILT_IN_PACK_ID ? builtInPack() : installedPacks.find((pack) => pack.manifest.id === activePackId) ?? null
  const available = {
    ninjas: countEnabledResources(ninjas),
    secretScrolls: countEnabledResources(activePack?.secretScrolls ?? []),
    summons: countEnabledResources(activePack?.summons ?? []),
  }
  const analysis = analyzeRuleFeasibility(rule, available)
  const poolInsufficient = analysis.errors.length > 0

  const handleStart = () => {
    if (poolInsufficient) return
    startNewMatch(blueName, redName, rule)
    onClose()
    navigate('/bp')
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="开始 BP · 比赛设置"
      footer={
        <>
          <button type="button" onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-fog-300 transition-colors hover:bg-ink-600">
            取消
          </button>
          <button
            type="button"
            onClick={handleStart}
            disabled={poolInsufficient}
            title={poolInsufficient ? analysis.errors[0] : undefined}
            className="rounded-lg bg-side-blue px-5 py-2 text-sm font-bold text-white transition-colors hover:bg-side-blue/85 disabled:cursor-not-allowed disabled:opacity-40"
          >
            开始比赛
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {unfinished && unfinished.status !== 'MATCH_FINISHED' && (
          <div className="flex items-start gap-2 rounded-lg border border-gold/40 bg-gold/10 p-3 text-xs text-gold">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>
              存在未完成的比赛（{unfinished.bluePlayerName} {unfinished.score.blue}:{unfinished.score.red}{' '}
              {unfinished.redPlayerName}），开始新比赛将替换当前进度。
            </span>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-fog-300">蓝方名称</span>
            <input
              type="text"
              value={blueName}
              onChange={(e) => setBlueName(e.target.value)}
              placeholder="蓝方"
              maxLength={12}
              className="rounded-lg border border-side-blue/40 bg-ink-900 px-3 py-2 text-sm text-fog-100 placeholder:text-fog-600 focus:border-side-blue focus:outline-none"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-fog-300">红方名称</span>
            <input
              type="text"
              value={redName}
              onChange={(e) => setRedName(e.target.value)}
              placeholder="红方"
              maxLength={12}
              className="rounded-lg border border-side-red/40 bg-ink-900 px-3 py-2 text-sm text-fog-100 placeholder:text-fog-600 focus:border-side-red focus:outline-none"
            />
          </label>
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-fog-300">规则模板</span>
          <select value={template} onChange={(event) => setTemplate(event.target.value as typeof template)} className="rounded-lg border border-ink-500 bg-ink-900 px-3 py-2 text-sm text-fog-100">
            <option value="CURRENT">当前规则 · {currentRule.name}</option>
            <option value="FULL_LOADOUT">Full Loadout Demo（示例）</option>
            <option value="WUDOU">武斗完整阵容（同时盲选）</option>
          </select>
          <span className="text-[10px] text-fog-600">模板均为玩家工具配置，不代表官方赛事规则。</span>
        </label>

        <div className="rounded-lg border border-ink-600 bg-ink-900/60 p-3 text-xs">
          <p className="mb-1 font-semibold text-fog-300">规则模板：{rule.name}</p>
          {getResourceDraftRules(rule).filter((draft) => draft.enabled).map((draft) => <p key={draft.resourceType} className="text-fog-500">{RESOURCE_TYPE_LABEL[draft.resourceType]}：{draft.sequence.map((step) => `${step.side === 'BLUE' ? '蓝方' : '红方'} ${step.action}×${step.count}`).join(' → ')}</p>)}
          <p className="mt-1.5 text-[10px] text-fog-600">
            BO{rule.bestOf} · 先胜 {rule.winsRequired} 局 · {rule.timerEnabled ? `每步倒计时 ${rule.timerSeconds} 秒` : '无倒计时'} ·
            可在「规则设置」中修改
          </p>
          {poolInsufficient && (
            <p className="mt-1.5 rounded border border-side-red/40 bg-side-red/10 p-2 text-[11px] text-side-red-soft">
              {analysis.errors.join('；')}。请检查规则或补充资源池。
            </p>
          )}
        </div>
      </div>
    </Dialog>
  )
}
