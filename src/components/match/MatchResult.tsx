import type { ReactNode } from 'react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Copy, Download, Play, Share2, Trophy } from 'lucide-react'
import type { MatchState } from '@/types/match'
import { sideAtPosition, sideLabel, playerName } from '@bp-core'
import { buildShareText, groupHistoryByGame } from '@/engine/historyEngine'
import { exportMatchResult } from '@/engine/bpEngine'
import { useNinjaLookup, useResourceLookup } from '@/hooks/useNinjaLookup'
import { copyToClipboard, downloadTextFile } from '@/utils/clipboard'
import { fileTimestamp, formatTime } from '@/utils/format'
import { toast } from '@/store/toastStore'
import { downloadReplay, useReplayStore } from '@/replay/replayStore'
import { ShareReplayDialog } from '@/components/replay/ShareReplayDialog'
import type { ReplaySource } from '@bp-core'

interface MatchResultProps {
  match: MatchState
  /** 额外操作按钮（重新开始 / 返回首页等） */
  extraActions?: ReactNode
  replaySource?: ReplaySource
  roomId?: string
}

/** 完整赛果展示：BP 页结束态与 /result/:id 页共用 */
export function MatchResult({ match, extraActions, replaySource = 'LOCAL', roomId }: MatchResultProps) {
  const navigate = useNavigate()
  const [shareOpen, setShareOpen] = useState(false)
  const { nameOf } = useNinjaLookup(match)
  const resourceNameOf = useResourceLookup(match)
  const finished = match.status === 'MATCH_FINISHED'
  const winner = match.score.blue >= match.rule.winsRequired ? 'BLUE' : match.score.red >= match.rule.winsRequired ? 'RED' : null

  const handleCopy = async () => {
    const ok = await copyToClipboard(buildShareText(match, nameOf, resourceNameOf))
    toast(ok ? '赛果文本已复制到剪贴板' : '复制失败，请手动复制', ok ? 'success' : 'error')
  }

  const handleExport = () => {
    downloadTextFile(
      `match-${fileTimestamp(match.createdAt)}.json`,
      JSON.stringify(exportMatchResult(match), null, 2),
    )
    toast('比赛 JSON 已导出', 'success')
  }

  const ensureReplay = () => useReplayStore.getState().saveFromMatch(match, replaySource, roomId)

  return (
    <section className="rounded-xl border border-ink-600 bg-ink-800/70 p-5 lg:p-8">
      {/* 总比分 */}
      <div className="flex flex-col items-center gap-2">
        <span className="flex items-center gap-1.5 text-xs font-bold tracking-widest text-gold">
          <Trophy size={14} /> 比赛结束 · {match.rule.name}
        </span>
        <div className="flex items-center gap-4">
          <span className={`text-sm font-semibold ${winner === 'BLUE' ? 'text-side-blue-soft' : 'text-fog-500'}`}>
            {match.bluePlayerName}
          </span>
          <span className="text-4xl font-black tabular-nums tracking-wider text-fog-100">
            {match.score.blue}
            <span className="mx-2 text-fog-600">:</span>
            {match.score.red}
          </span>
          <span className={`text-sm font-semibold ${winner === 'RED' ? 'text-side-red-soft' : 'text-fog-500'}`}>
            {match.redPlayerName}
          </span>
        </div>
        {finished && winner && (
          <p className={`text-lg font-bold ${winner === 'BLUE' ? 'text-side-blue-soft' : 'text-side-red-soft'}`}>
            {sideLabel(match, winner)}胜利 · {playerName(match, winner)}
          </p>
        )}
        {match.dataPack?.packVersion && (
          <p className="text-[10px] text-fog-600">数据版本：{match.dataPack.packVersion}</p>
        )}
      </div>

      {/* 各局详情 */}
      <div className="mt-6 space-y-4">
        {match.games.map((game) => (
          <div key={game.gameNumber} className="rounded-lg border border-ink-600 bg-ink-900/60 p-4">
            <div className="mb-3 flex items-center justify-between">
              <h4 className="text-xs font-bold tracking-widest text-fog-300">GAME {game.gameNumber}</h4>
              {game.winner && (
                <span
                  className={`rounded px-2 py-0.5 text-[10px] font-bold ${
                    sideAtPosition(match, game.winner, game.gameNumber) === 'BLUE' ? 'bg-side-blue/20 text-side-blue-soft' : 'bg-side-red/20 text-side-red-soft'
                  }`}
                >
                  {sideLabel(match, game.winner, game.gameNumber)}获胜
                </span>
              )}
            </div>
            <div className="grid gap-3 text-xs sm:grid-cols-2">
              <div>
                <p className="mb-1 text-[10px] font-semibold tracking-widest text-fog-600">BAN</p>
                <p className={sideAtPosition(match, 'BLUE', game.gameNumber) === 'BLUE' ? 'text-side-blue-soft' : 'text-side-red-soft'}>{sideLabel(match, 'BLUE', game.gameNumber)}：{game.blue.bans.map(nameOf).join('、') || '无'}</p>
                <p className={sideAtPosition(match, 'RED', game.gameNumber) === 'BLUE' ? 'text-side-blue-soft' : 'text-side-red-soft'}>{sideLabel(match, 'RED', game.gameNumber)}：{game.red.bans.map(nameOf).join('、') || '无'}</p>
              </div>
              <div className="sm:col-span-2 grid gap-2 sm:grid-cols-2">
                {(['BLUE', 'RED'] as const).map((side) => {
                  const player = side === 'BLUE' ? game.blue : game.red
                  const scrolls = player.resources?.SECRET_SCROLL?.picks ?? []
                  const summons = player.resources?.SUMMON?.picks ?? []
                  if (!scrolls.length && !summons.length) return null
                  return (
                    <div key={side} className={sideAtPosition(match, side, game.gameNumber) === 'BLUE' ? 'text-side-blue-soft' : 'text-side-red-soft'}>
                      <p>{sideLabel(match, side, game.gameNumber)}秘卷：{scrolls.map((id) => resourceNameOf('SECRET_SCROLL', id)).join('、') || '无'}</p>
                      <p>{sideLabel(match, side, game.gameNumber)}通灵：{summons.map((id, index) => `${index + 1}.${resourceNameOf('SUMMON', id)}`).join('  ') || '无'}</p>
                    </div>
                  )
                })}
              </div>
              <div>
                <p className="mb-1 text-[10px] font-semibold tracking-widest text-fog-600">阵容</p>
                <p className={sideAtPosition(match, 'BLUE', game.gameNumber) === 'BLUE' ? 'text-side-blue-soft' : 'text-side-red-soft'}>
                  {sideLabel(match, 'BLUE', game.gameNumber)}：{game.blue.picks.map((id, i) => `${i + 1}.${nameOf(id)}`).join('  ') || '无'}
                </p>
                <p className={sideAtPosition(match, 'RED', game.gameNumber) === 'BLUE' ? 'text-side-blue-soft' : 'text-side-red-soft'}>
                  {sideLabel(match, 'RED', game.gameNumber)}：{game.red.picks.map((id, i) => `${i + 1}.${nameOf(id)}`).join('  ') || '无'}
                </p>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* 完整 BP 历史 */}
      <div className="mt-6">
        <h4 className="mb-2 text-xs font-bold tracking-widest text-fog-300">BP 记录</h4>
        <div className="space-y-3">
          {groupHistoryByGame(match).map((group) => (
            <div key={group.gameNumber}>
              <p className="text-[10px] font-bold tracking-widest text-fog-600">GAME {group.gameNumber}</p>
              <ol className="mt-1 space-y-0.5">
                {group.actions.map((action, i) => (
                  <li key={action.id} className="flex items-center gap-2 text-xs text-fog-300">
                    <span className="w-6 text-right tabular-nums text-fog-600">{String(i + 1).padStart(2, '0')}</span>
                    <span className={sideAtPosition(match, action.side, group.gameNumber) === 'BLUE' ? 'text-side-blue-soft' : 'text-side-red-soft'}>
                      {sideLabel(match, action.side, group.gameNumber)}
                    </span>
                    <span className={action.action === 'BAN' ? 'text-side-red' : 'text-emerald-400/80'}>
                      {action.action === 'BAN' ? 'BAN' : 'PICK'}
                    </span>
                    <span className="text-fog-100">{resourceNameOf(action.resourceType ?? 'NINJA', action.resourceId ?? action.ninjaId)}</span>
                    <span className="ml-auto text-[10px] tabular-nums text-fog-600">{formatTime(action.timestamp)}</span>
                  </li>
                ))}
              </ol>
            </div>
          ))}
          {match.history.length === 0 && <p className="text-xs text-fog-600">暂无记录</p>}
        </div>
      </div>

      {/* 操作 */}
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1.5 rounded-lg border border-ink-500 px-4 py-2 text-sm text-fog-300 transition-colors hover:bg-ink-600"
        >
          <Copy size={14} /> 复制结果
        </button>
        <button
          type="button"
          onClick={handleExport}
          className="flex items-center gap-1.5 rounded-lg border border-ink-500 px-4 py-2 text-sm text-fog-300 transition-colors hover:bg-ink-600"
        >
          <Download size={14} /> 导出 JSON
        </button>
        {finished && <>
          <button type="button" onClick={() => { const replay = ensureReplay(); if (replay) navigate(`/replay/${replay.replayId}`) }} className="flex items-center gap-1.5 rounded bg-blue-team px-4 py-2 text-sm font-bold text-white"><Play size={14} /> 复盘</button>
          <button type="button" onClick={() => { const replay = ensureReplay(); if (replay) { downloadReplay(replay); toast('Replay JSON 已导出', 'success') } }} className="flex items-center gap-1.5 rounded border border-blue-team/50 px-4 py-2 text-sm text-blue-team-soft"><Download size={14} /> 导出复盘</button>
          <button type="button" onClick={() => { if (ensureReplay()) setShareOpen(true) }} className="flex items-center gap-1.5 rounded border border-gold-accent/50 px-4 py-2 text-sm text-gold-accent"><Share2 size={14} /> 分享</button>
        </>}
        {extraActions}
      </div>
      {finished && (() => { const replay = useReplayStore.getState().get(match.id); return replay ? <ShareReplayDialog replay={replay} open={shareOpen} onClose={() => setShareOpen(false)} /> : null })()}
    </section>
  )
}
