import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Copy, DoorClosed, Save } from 'lucide-react'
import { useOnlineRoomStore } from '@/online/onlineRoomStore'
import { roomApi } from '@/online/roomClient'
import { describeSequence } from '@/engine/ruleEngine'
import { OnlineMatchSource } from '@/matchSource/OnlineMatchSource'
import { BPWorkspace } from '@/components/bp/BPWorkspace'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { toast } from '@/store/toastStore'
import { copyToClipboard } from '@/utils/clipboard'
import { useBPStore } from '@/store/bpStore'
import { useDataPackStore } from '@/dataPack/store'
import { builtInPack } from '@/dataPack/loader'
import { BUILT_IN_PACK_ID } from '@/dataPack/types'
import { PresentationView } from '@/components/presentation/PresentationView'

/** /room/:code —— 在线房间（加入面板 / 等待室 / BP / 结果 / 观战） */
export default function RoomPage({ presentation = false }: { presentation?: boolean }) {
  const { code = '' } = useParams<{ code: string }>()
  const [searchParams] = useSearchParams()
  const preferObserver = presentation || searchParams.get('watch') === '1'

  const configOk = useOnlineRoomStore((s) => s.configOk)
  const roomStatus = useOnlineRoomStore((s) => s.roomStatus)
  const roomCode = useOnlineRoomStore((s) => s.roomCode)
  const lastError = useOnlineRoomStore((s) => s.lastError)
  const ensureAuth = useOnlineRoomStore((s) => s.ensureAuth)
  const joinRoom = useOnlineRoomStore((s) => s.joinRoom)
  const enterRoom = useOnlineRoomStore((s) => s.enterRoom)
  const leaveRoom = useOnlineRoomStore((s) => s.leaveRoom)

  const [phase, setPhase] = useState<'joining' | 'join-panel' | 'in-room' | 'error'>('joining')
  const [displayName, setDisplayName] = useState('')
  const [joinSeat, setJoinSeat] = useState<'AUTO' | 'OBSERVER'>(preferObserver ? 'OBSERVER' : 'AUTO')
  const [joinError, setJoinError] = useState<string | null>(null)
  const inFlight = useRef(false)

  const roomCodeUpper = code.toUpperCase()

  useEffect(() => {
    if (!configOk) return
    let cancelled = false
    inFlight.current = true
    void (async () => {
      const authOk = await ensureAuth()
      if (!authOk || cancelled) return
      // 刷新恢复：匿名会话保持时若已是成员，直接进入；否则显示加入面板
      try {
        const existingId = await roomApi.fetchRoomIdByCode(roomCodeUpper)
        if (cancelled) return
        if (existingId) {
          const entered = await enterRoom(existingId, roomCodeUpper)
          if (cancelled) return
          if (entered.ok) {
            setPhase('in-room')
            inFlight.current = false
            return
          }
          setJoinError(entered.error ?? '进入房间失败')
        }
      } catch {
        /* 未加入过 → 走加入面板 */
      }
      if (!cancelled && presentation) {
        const joined = await joinRoom({ code: roomCodeUpper, seat: 'OBSERVER', displayName: '赛事展示' })
        if (joined.ok) {
          setPhase('in-room')
          inFlight.current = false
          return
        }
        setJoinError(joined.error ?? '无法进入赛事展示')
      }
      if (!cancelled) {
        setPhase('join-panel')
        inFlight.current = false
      }
    })()
    return () => {
      cancelled = true
    }
  }, [roomCodeUpper, configOk, ensureAuth, enterRoom, joinRoom, presentation])

  // 离开页面时清理订阅（数据库成员记录保留，刷新/重连可自动恢复席位）
  useEffect(() => () => leaveRoom(), [leaveRoom])

  const handleJoin = async () => {
    if (inFlight.current) return
    inFlight.current = true
    const result = await joinRoom({
      code: roomCodeUpper,
      seat: joinSeat,
      displayName: displayName || '玩家',
    })
    inFlight.current = false
    if (!result.ok) {
      setJoinError(result.error ?? '加入失败')
      return
    }
    setPhase('in-room')
  }

  if (!configOk) {
    return (
      <div className="px-4 py-20 text-center text-sm text-fog-500">
        在线模式尚未配置，请参考 README「在线 BP 设置」。
      </div>
    )
  }

  if (phase === 'joining') {
    return <div className="px-4 py-20 text-center text-sm text-fog-500">正在进入房间……</div>
  }

  // 房间级错误（不存在 / 过期 / 关闭 / 网络）
  if (phase === 'error' || (roomStatus === null && lastError && phase !== 'join-panel')) {
    return (
      <div className="px-4 py-20 text-center">
        <p className="text-sm text-fog-300">{lastError?.message ?? '房间不可用'}</p>
        <Link to="/online" className="mt-4 inline-block rounded bg-blue-team px-4 py-2 text-xs font-bold text-white">
          返回在线 BP
        </Link>
      </div>
    )
  }

  if (phase === 'in-room' && roomStatus === 'CLOSED') {
    return (
      <div className="px-4 py-20 text-center">
        <DoorClosed size={30} className="mx-auto text-fog-600" />
        <p className="mt-3 text-sm font-semibold text-fog-100">房间已关闭</p>
        <p className="mt-1 text-xs text-fog-600">房主已结束该房间，感谢使用。</p>
        <Link to="/online" className="mt-4 inline-block rounded bg-blue-team px-4 py-2 text-xs font-bold text-white">
          返回在线 BP
        </Link>
      </div>
    )
  }

  if (phase === 'in-room' && presentation) {
    return (
      <OnlineMatchSource>
        <PresentationView code={roomCode ?? roomCodeUpper} />
      </OnlineMatchSource>
    )
  }

  if (phase === 'in-room' && roomStatus === 'WAITING') {
    return <WaitingRoom code={roomCode ?? roomCodeUpper} />
  }

  if (phase === 'in-room') {
    return <OnlineRoomBody code={roomCode ?? roomCodeUpper} />
  }

  // 加入面板
  if (presentation) {
    return <div className="px-4 py-20 text-center text-sm text-fog-400">无法自动进入赛事展示：{joinError ?? '房间不可用'}</div>
  }
  return (
    <div className="mx-auto w-full max-w-md px-4 py-16">
      <h1 className="text-lg font-bold text-fog-100">加入房间 {roomCodeUpper}</h1>
      <div className="mt-4 space-y-3 rounded-lg border border-border-muted bg-surface-1/50 p-5">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-fog-300">你的名称（1~20 字）</span>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={20}
            placeholder="玩家"
            className="rounded border border-border-strong bg-ink-900 px-3 py-2 text-sm text-fog-100 focus:border-blue-team/60 focus:outline-none"
          />
        </label>
        <div className="flex items-center gap-2 text-xs">
          {(
            [
              ['AUTO', '自动分配席位'],
              ['OBSERVER', '以观战身份进入'],
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
        {joinError && (
          <p className="rounded border border-red-team/40 bg-red-team/10 p-2 text-xs text-red-team-soft">{joinError}</p>
        )}
        <button
          type="button"
          onClick={() => void handleJoin()}
          disabled={inFlight.current}
          className="w-full rounded bg-blue-team px-4 py-2.5 text-sm font-bold text-white hover:brightness-110 disabled:opacity-50"
        >
          加入房间
        </button>
        <Link to="/online" className="block text-center text-xs text-fog-600 hover:text-fog-300">
          返回在线 BP
        </Link>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 等待室
// ---------------------------------------------------------------------------

function WaitingRoom({ code }: { code: string }) {
  const members = useOnlineRoomStore((s) => s.members)
  const presence = useOnlineRoomStore((s) => s.presence)
  const mySeat = useOnlineRoomStore((s) => s.mySeat)
  const isHost = useOnlineRoomStore((s) => s.isHost)
  const sendCommand = useOnlineRoomStore((s) => s.sendCommand)
  const match = useOnlineRoomStore((s) => s.match)
  const connection = useOnlineRoomStore((s) => s.connection)
  const realtimeConnected = useOnlineRoomStore((s) => s.realtimeConnected)
  const roomPackMetadata = useOnlineRoomStore((s) => s.roomPackMetadata)
  const activePackId = useDataPackStore((s) => s.activePackId)
  const installedPacks = useDataPackStore((s) => s.installedPacks)
  const localPack = useMemo(() => {
    if (activePackId === 'CUSTOM') return null
    if (activePackId === BUILT_IN_PACK_ID) return builtInPack()
    return installedPacks.find((pack) => pack.manifest.id === activePackId) ?? null
  }, [activePackId, installedPacks])
  const [starting, setStarting] = useState(false)

  const blue = members.find((m) => m.seat === 'BLUE')
  const red = members.find((m) => m.seat === 'RED')
  const observers = members.filter((m) => m.seat === 'OBSERVER')
  const bothReady = Boolean(blue && red)
  const inviteUrl = new URL(`${import.meta.env.BASE_URL}room/${code}`, location.origin).href
  const online = (userId: string) => Boolean(presence[userId])

  // v0.4：房主数据包与本机不同 → 会话级提示（绝不修改本地池）
  const packMismatch = Boolean(
    roomPackMetadata && (
      !localPack ||
      roomPackMetadata.packId !== localPack.manifest.id ||
      (roomPackMetadata.schemaVersion !== undefined && roomPackMetadata.schemaVersion !== localPack.manifest.schemaVersion) ||
      (roomPackMetadata.packVersion !== undefined && roomPackMetadata.packVersion !== localPack.manifest.version) ||
      (roomPackMetadata.checksum !== undefined && roomPackMetadata.checksum !== localPack.manifest.checksum)
    ),
  )

  const copy = async (text: string, label: string) => {
    const ok = await copyToClipboard(text)
    toast(ok ? `${label}已复制` : '复制失败', ok ? 'success' : 'error')
  }

  const start = async () => {
    setStarting(true)
    const r = await sendCommand('START_MATCH')
    setStarting(false)
    if (!r.ok && r.reason) toast(r.reason, 'error')
  }

  return (
    <div className="mx-auto w-full max-w-lg px-4 py-10">
      <div className="text-center">
        <p className="text-xs tracking-[0.3em] text-fog-600">WAITING ROOM</p>
        <p className="mt-2 font-mono text-4xl font-black tracking-[0.25em] text-fog-100">{code}</p>
        <div className="mt-3 flex items-center justify-center gap-2 text-xs">
          <span className={connection === 'connected' ? 'text-emerald-400' : 'text-fog-500'}>
            ● {connection === 'connected' ? realtimeConnected ? '已连接' : '已连接（轮询同步）' : '正在同步'}
          </span>
          <button type="button" onClick={() => void copy(code, '房间号')} className="text-fog-500 underline underline-offset-2 hover:text-fog-300">
            复制房间号
          </button>
          <button type="button" onClick={() => void copy(inviteUrl, '邀请链接')} className="text-fog-500 underline underline-offset-2 hover:text-fog-300">
            复制邀请链接
          </button>
          <button type="button" onClick={() => void copy(`${inviteUrl}/presentation`, '赛事展示链接')} className="text-violet-300 underline underline-offset-2 hover:text-violet-200">
            复制展示链接
          </button>
        </div>
      </div>

      <div className="mt-6 space-y-2">
        {(
          [
            ['BLUE', blue],
            ['RED', red],
          ] as const
        ).map(([seat, member]) => {
          const isBlue = seat === 'BLUE'
          return (
            <div
              key={seat}
              className={`flex items-center justify-between rounded-lg border px-4 py-3 ${
                isBlue ? 'border-blue-team/40 bg-blue-team/5' : 'border-red-team/40 bg-red-team/5'
              }`}
            >
              <div>
                <p className={`text-[10px] font-bold tracking-[0.2em] ${isBlue ? 'text-blue-team-soft' : 'text-red-team-soft'}`}>
                  {isBlue ? 'BLUE 蓝方' : 'RED 红方'}
                </p>
                <p className="text-sm font-semibold text-fog-100">
                  {member?.display_name ?? '等待加入……'}
                </p>
              </div>
              {member ? (
                <span className={`text-xs ${online(member.user_id) ? 'text-emerald-400' : 'text-fog-600'}`}>
                  ● {online(member.user_id) ? 'ONLINE' : '离线'}
                </span>
              ) : null}
            </div>
          )
        })}
        <p className="text-center text-xs text-fog-600">
          观战：{observers.length} 人{mySeat === 'OBSERVER' ? '（你以观战身份进入）' : ''}
        </p>
      </div>

      {match && (
        <div className="mt-5 rounded-lg border border-border-muted bg-surface-1/50 p-4 text-xs text-fog-500">
          <p className="font-semibold text-fog-300">{match.rule.name}</p>
          <p>BO{match.rule.bestOf} · 先胜 {match.rule.winsRequired} 局</p>
          <p>Ban：{describeSequence(match.rule.banSequence)}</p>
          <p>Pick：{describeSequence(match.rule.pickSequence)}</p>
          <p className="mt-1 border-t border-border-muted pt-1">
            忍者数据：{roomPackMetadata?.packVersion ?? '未标记（旧房间）'}
            {roomPackMetadata?.packVersion && roomPackMetadata.packVersion !== localPack?.manifest.version && (
              <span className="ml-1 text-gold-accent">（与本机当前 {localPack?.manifest.version ?? '自定义数据'} 不同）</span>
            )}
          </p>
        </div>
      )}

      {packMismatch && (
        <p className="mt-3 rounded border border-gold-accent/40 bg-gold-accent/10 p-2.5 text-xs text-gold-accent">
          房间使用的数据版本与你当前不同。本房间将临时使用房主的忍者数据（仅会话内生效，不会修改你的本地数据包）。
        </p>
      )}

      {isHost ? (
        <button
          type="button"
          onClick={() => void start()}
          disabled={!bothReady || starting}
          className="mt-6 w-full rounded bg-gold px-4 py-3 text-sm font-bold text-ink-950 transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {starting ? '正在开始……' : bothReady ? '开始比赛' : '等待对方加入后开始'}
        </button>
      ) : (
        <p className="mt-6 text-center text-xs text-fog-600">等待房主开始比赛……</p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 房间主体（BP 工作区 + 房间信息条 + 结束操作）
// ---------------------------------------------------------------------------

function OnlineRoomBody({ code }: { code: string }) {
  const roomCode = useOnlineRoomStore((s) => s.roomCode) ?? code
  const roomId = useOnlineRoomStore((s) => s.roomId)
  const connection = useOnlineRoomStore((s) => s.connection)
  const realtimeConnected = useOnlineRoomStore((s) => s.realtimeConnected)
  const pendingCommand = useOnlineRoomStore((s) => s.pendingCommand)
  const roomStatus = useOnlineRoomStore((s) => s.roomStatus)
  const isHost = useOnlineRoomStore((s) => s.isHost)
  const match = useOnlineRoomStore((s) => s.match)
  const sendCommand = useOnlineRoomStore((s) => s.sendCommand)
  const navigate = useNavigate()
  const [closeOpen, setCloseOpen] = useState(false)
  void navigate

  const inviteUrl = new URL(`${import.meta.env.BASE_URL}room/${roomCode}`, location.origin).href
  const copy = async (text: string, label: string) => {
    const ok = await copyToClipboard(text)
    toast(ok ? `${label}已复制` : '复制失败', ok ? 'success' : 'error')
  }

  const saveToLocal = () => {
    if (!match) return
    useBPStore.getState().saveExternalMatch(match, roomId ?? undefined)
    toast('Replay 已保存，可打开、导出或生成分享链接', 'success')
  }

  const connectionText =
    connection === 'connected' ? pendingCommand ? '正在确认操作' : realtimeConnected ? '已连接' : '已连接（轮询同步）'
      : connection === 'syncing' ? '正在同步' : connection === 'reconnecting' ? '正在重连'
        : connection === 'connecting' ? '正在连接' : connection === 'idle' ? '未连接' : '离线'

  return (
    <OnlineMatchSource>
      <div className="mx-auto flex w-full max-w-[1500px] flex-wrap items-center gap-2 px-2.5 pt-2 lg:px-5">
        <Link to="/" className="text-xs text-fog-600 hover:text-fog-300">
          ← 首页
        </Link>
        <span className="rounded border border-border-strong bg-surface-1 px-2 py-0.5 font-mono text-xs tracking-[0.2em] text-fog-100">
          {roomCode}
        </span>
        <span
          className={`text-xs ${
            connection === 'connected' ? 'text-emerald-400' : connection === 'syncing' ? 'text-gold-accent' : 'text-red-team-soft'
          }`}
        >
          ● {connectionText}
        </span>
        <button type="button" onClick={() => void copy(inviteUrl, '邀请链接')} className="flex items-center gap-1 text-xs text-fog-500 hover:text-fog-300">
          <Copy size={12} /> 复制邀请
        </button>
        {roomStatus === 'FINISHED' && (
          <button
            type="button"
            onClick={saveToLocal}
            className="flex items-center gap-1 rounded border border-gold-accent/40 px-2 py-0.5 text-xs text-gold-accent hover:bg-gold-accent/10"
          >
            <Save size={12} /> 保存 Replay
          </button>
        )}
        {isHost && (
          <button type="button" onClick={() => setCloseOpen(true)} className="ml-auto flex items-center gap-1 text-xs text-fog-600 hover:text-red-team-soft">
            <DoorClosed size={12} /> 关闭房间
          </button>
        )}
      </div>
      <BPWorkspace />
      <ConfirmDialog
        open={closeOpen}
        title="关闭房间？"
        message="关闭后所有成员将无法继续操作或加入，此操作不可恢复。"
        confirmText="关闭房间"
        danger
        onConfirm={() => {
          void sendCommand('CLOSE_ROOM').then((r) => {
            if (r.ok) {
              toast('房间已关闭', 'success')
              navigate('/')
            } else if (r.reason) {
              toast(r.reason, 'error')
            }
          })
        }}
        onClose={() => setCloseOpen(false)}
      />
    </OnlineMatchSource>
  )
}
