import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { LogIn, Plus, WifiOff } from 'lucide-react'
import { useOnlineRoomStore } from '@/online/onlineRoomStore'
import { useSettingsStore } from '@/store/settingsStore'
import { DEFAULT_RULE, FULL_LOADOUT_DEMO_RULE, WUDOU_LOADOUT_RULE, cloneRule } from '@/data/defaultRules'
import { describeSequence } from '@/engine/ruleEngine'
import { toast } from '@/store/toastStore'

/** /online —— 在线 BP 入口：创建房间 / 加入房间 */
export default function OnlineHubPage() {
  const navigate = useNavigate()
  const configOk = useOnlineRoomStore((s) => s.configOk)
  const createRoom = useOnlineRoomStore((s) => s.createRoom)
  const joinRoom = useOnlineRoomStore((s) => s.joinRoom)
  // 注意：selector 不能直接调 activeRule()（每次返回新对象会无限重渲染）
  const customRule = useSettingsStore((s) => s.customRule)
  const [ruleTemplate, setRuleTemplate] = useState<'CURRENT' | 'FULL_LOADOUT' | 'WUDOU'>('CURRENT')
  const rule = cloneRule(ruleTemplate === 'WUDOU' ? WUDOU_LOADOUT_RULE : ruleTemplate === 'FULL_LOADOUT' ? FULL_LOADOUT_DEMO_RULE : (customRule ?? DEFAULT_RULE))

  const [displayName, setDisplayName] = useState('')
  const [seat, setSeat] = useState<'BLUE' | 'RED'>('BLUE')
  const [joinCode, setJoinCode] = useState('')
  const [joinSeat, setJoinSeat] = useState<'AUTO' | 'BLUE' | 'RED' | 'OBSERVER'>('AUTO')
  const [creating, setCreating] = useState(false)
  const [joining, setJoining] = useState(false)
  const [cooldownUntil, setCooldownUntil] = useState(0)

  const handleCreate = async () => {
    setCreating(true)
    const result = await createRoom({ displayName: displayName || (seat === 'BLUE' ? '蓝方玩家' : '红方玩家'), seat, rule })
    setCreating(false)
    if (!result.ok || !result.code) {
      if (result.error?.includes('INSUFFICIENT_NINJA_POOL')) {
        toast('当前忍者池可用数量不足以完成整场比赛，请先补充忍者池', 'error')
      } else {
        toast(result.error ?? '创建失败', 'error')
      }
      return
    }
    navigate(`/room/${result.code}`)
  }

  const handleJoin = async () => {
    const now = Date.now()
    if (now < cooldownUntil) return
    setJoining(true)
    setCooldownUntil(now + 3000) // 客户端冷却：房间码暴力尝试的第一道缓坡
    const result = await joinRoom({ code: joinCode.trim().toUpperCase(), seat: joinSeat, displayName: displayName || '玩家' })
    setJoining(false)
    if (!result.ok) {
      toast(result.error ?? '加入失败', 'error')
      return
    }
    navigate(`/room/${joinCode.trim().toUpperCase()}`)
  }

  if (!configOk) {
    return (
      <div className="mx-auto w-full max-w-lg px-4 py-20 text-center">
        <WifiOff size={32} className="mx-auto text-fog-600" />
        <h1 className="mt-4 text-lg font-bold text-fog-100">在线模式尚未配置</h1>
        <p className="mt-2 text-sm leading-relaxed text-fog-500">
          需要 Supabase 环境变量（VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY）才能使用在线 BP。
          本地 BP 不受影响，完全可以离线使用。
        </p>
        <p className="mt-4 text-xs text-fog-600">配置方法见 README「在线 BP 设置」。</p>
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-4 pb-16">
      <header className="mt-6">
        <h1 className="text-xl font-bold text-fog-100">在线 BP</h1>
        <p className="mt-1 text-xs text-fog-600">
          创建房间后把房间号发给对手，双方各自操作自己的阵营，Ban/Pick 实时同步。观战者可只读观看。
        </p>
      </header>

      <div className="mt-4 rounded-lg border border-border-muted bg-surface-1/50 p-5">
        <h2 className="text-sm font-bold text-fog-100">比赛规则（当前模板）</h2>
        <select aria-label="房间规则模板" value={ruleTemplate} onChange={(event) => setRuleTemplate(event.target.value as typeof ruleTemplate)} className="mt-2 rounded border border-ink-500 bg-ink-900 px-3 py-1.5 text-xs text-fog-100">
          <option value="CURRENT">Ninja Only（当前规则）</option>
          <option value="FULL_LOADOUT">Full Loadout Demo（示例）</option>
          <option value="WUDOU">武斗完整阵容（同时盲选）</option>
        </select>
        <p className="mt-1 text-xs text-fog-500">Ban：{describeSequence(rule.banSequence)}</p>
        <p className="text-xs text-fog-500">Pick：{describeSequence(rule.pickSequence)}</p>
        <p className="mt-1 text-[11px] text-fog-600">
          BO{rule.bestOf} · 先胜 {rule.winsRequired} 局 · {rule.timerEnabled ? `每步 ${rule.timerSeconds} 秒` : '无倒计时'}
          （可在「规则设置」中修改，创建房间时固化）
        </p>
      </div>

      <section className="mt-4 rounded-lg border border-border-muted bg-surface-1/50 p-5">
        <h2 className="text-sm font-bold text-fog-100">创建房间</h2>
        <div className="mt-3 space-y-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-fog-300">你的名称（1~20 字）</span>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={20}
              placeholder={seat === 'BLUE' ? '蓝方玩家' : '红方玩家'}
              className="rounded border border-border-strong bg-ink-900 px-3 py-2 text-sm text-fog-100 focus:border-blue-team/60 focus:outline-none"
            />
          </label>
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-fog-300">选择阵营：</span>
            {(['BLUE', 'RED'] as const).map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={seat === s}
                onClick={() => setSeat(s)}
                className={`rounded border px-4 py-1.5 text-xs font-bold transition-colors ${
                  seat === s
                    ? s === 'BLUE'
                      ? 'border-blue-team bg-blue-team/20 text-blue-team-soft'
                      : 'border-red-team bg-red-team/20 text-red-team-soft'
                    : 'border-border-strong text-fog-500 hover:bg-surface-2'
                }`}
              >
                {s === 'BLUE' ? '蓝方' : '红方'}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={creating}
            className="flex w-full items-center justify-center gap-2 rounded bg-blue-team px-4 py-2.5 text-sm font-bold text-white transition-colors hover:brightness-110 disabled:opacity-50"
          >
            <Plus size={15} /> {creating ? '正在创建……' : '创建房间'}
          </button>
        </div>
      </section>

      <section className="mt-4 rounded-lg border border-border-muted bg-surface-1/50 p-5">
        <h2 className="text-sm font-bold text-fog-100">加入房间</h2>
        <div className="mt-3 space-y-3">
          <div className="flex gap-2">
            <input
              type="text"
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z2-9]/g, ''))}
              maxLength={6}
              placeholder="房间号，如 7K3M9Q"
              aria-label="房间号"
              className="w-40 rounded border border-border-strong bg-ink-900 px-3 py-2 text-center font-mono text-lg tracking-[0.3em] text-fog-100 focus:border-blue-team/60 focus:outline-none"
            />
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={20}
              placeholder="你的名称（可选）"
              aria-label="你的名称"
              className="flex-1 rounded border border-border-strong bg-ink-900 px-3 py-2 text-sm text-fog-100 focus:border-blue-team/60 focus:outline-none"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-medium text-fog-300">席位：</span>
            {(
              [
                ['AUTO', '自动分配'],
                ['BLUE', '蓝方'],
                ['RED', '红方'],
                ['OBSERVER', '观战'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={joinSeat === value}
                onClick={() => setJoinSeat(value)}
                className={`rounded border px-3 py-1 transition-colors ${
                  joinSeat === value
                    ? 'border-blue-team/60 bg-blue-team/15 text-blue-team-soft'
                    : 'border-border-strong text-fog-500 hover:bg-surface-2'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => void handleJoin()}
            disabled={joining || joinCode.length < 4 || Date.now() < cooldownUntil}
            className="flex w-full items-center justify-center gap-2 rounded border border-blue-team/50 bg-blue-team/10 px-4 py-2.5 text-sm font-bold text-blue-team-soft transition-colors hover:bg-blue-team/20 disabled:opacity-40"
          >
            <LogIn size={15} /> {joining ? '正在加入……' : '加入房间'}
          </button>
        </div>
      </section>
    </div>
  )
}
