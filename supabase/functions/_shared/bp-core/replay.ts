import type {
  BattleRule,
  DraftResourceType,
  MatchPackMetadata,
  MatchState,
  NinjaQuality,
  Side,
} from './types.ts'
import { validateStoredRule } from './matchValidator.ts'
import { isPublicBanList } from './poolRequirement.ts'

export const REPLAY_SCHEMA_VERSION = 1
export const REPLAY_IMPORT_MAX_BYTES = 2 * 1024 * 1024
export const REPLAY_SHARE_MAX_BYTES = 512 * 1024

export type ReplaySource = 'LOCAL' | 'ONLINE' | 'IMPORTED' | 'SHARED'
export type ReplayActionType = 'BAN' | 'PICK' | 'RESULT'

export interface ReplayResource {
  id: string
  name: string
  resourceType: DraftResourceType
  quality?: NinjaQuality
  asset?: string
  avatar?: string
  assetKey?: string
}

export interface ReplaySideState {
  NINJA: { bans: string[]; picks: string[] }
  SECRET_SCROLL: { bans: string[]; picks: string[] }
  SUMMON: { bans: string[]; picks: string[] }
}

export interface ReplayGame {
  gameNumber: number
  initial: { blue: ReplaySideState; red: ReplaySideState }
  winner: Side
}

export interface ReplayAction {
  id: string
  gameNumber: number
  side: Side
  type: ReplayActionType
  resourceType?: DraftResourceType
  resourceId?: string
  timestamp?: number
  sequenceIndex: number
}

export interface BPReplay {
  schemaVersion: 1
  replayId: string
  createdAt: number
  completedAt: number
  source: ReplaySource
  rule: BattleRule
  publicBans?: string[]
  players: { blue: string; red: string }
  finalScore: { blue: number; red: number }
  winner: Side
  games: ReplayGame[]
  actions: ReplayAction[]
  resourceSnapshot: ReplayResource[]
  dataPackMetadata?: MatchPackMetadata
  metadata: { matchId: string; roomId?: string; originalSource?: ReplaySource }
}

export interface ReplayBundle {
  bundleVersion: 1
  replay: BPReplay
  checksum: string
}

export interface ReplayValidation {
  ok: boolean
  errors: string[]
}

export interface ReconstructedReplay {
  step: number
  score: { blue: number; red: number }
  games: Array<{ gameNumber: number; blue: ReplaySideState; red: ReplaySideState; winner?: Side }>
  currentGame: number
  complete: boolean
}

function cloneSide(side: ReplaySideState): ReplaySideState {
  return {
    NINJA: { bans: [...side.NINJA.bans], picks: [...side.NINJA.picks] },
    SECRET_SCROLL: { bans: [...side.SECRET_SCROLL.bans], picks: [...side.SECRET_SCROLL.picks] },
    SUMMON: { bans: [...side.SUMMON.bans], picks: [...side.SUMMON.picks] },
  }
}

function sideFromGame(value: MatchState['games'][number]['blue']): ReplaySideState {
  return {
    NINJA: { bans: [...value.bans], picks: [...value.picks] },
    SECRET_SCROLL: {
      bans: [...(value.resources?.SECRET_SCROLL?.bans ?? [])],
      picks: [...(value.resources?.SECRET_SCROLL?.picks ?? [])],
    },
    SUMMON: {
      bans: [...(value.resources?.SUMMON?.bans ?? [])],
      picks: [...(value.resources?.SUMMON?.picks ?? [])],
    },
  }
}

function removeOnce(values: string[], id: string): void {
  const index = values.lastIndexOf(id)
  if (index >= 0) values.splice(index, 1)
}

function isSafeAsset(value: string): boolean {
  if (value.length > 500 || [...value].some((char) => char.charCodeAt(0) < 32)) return false
  const trimmed = value.trim()
  if (/^(?:javascript|data|file|blob):/i.test(trimmed)) return false
  if (trimmed.length >= 128 && /^[A-Za-z0-9+/=]+$/.test(trimmed)) return false
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return /^https?:/i.test(trimmed)
  return trimmed.startsWith('/') || trimmed.startsWith('./') || /^[a-zA-Z0-9_@./-]+$/.test(trimmed)
}

function safeOptional(value: string | undefined): string | undefined {
  return value && isSafeAsset(value) ? value : undefined
}

function resourceKey(type: DraftResourceType, id: string): string {
  return `${type}:${id}`
}

function snapshotLookup(match: MatchState): Map<string, ReplayResource> {
  const map = new Map<string, ReplayResource>()
  const add = (type: DraftResourceType, item: { id: string; name: string; quality?: NinjaQuality; asset?: string; avatar?: string; assetKey?: string }) => {
    map.set(resourceKey(type, item.id), {
      id: item.id,
      name: item.name,
      resourceType: type,
      ...(item.quality ? { quality: item.quality } : {}),
      ...(safeOptional(item.asset) ? { asset: safeOptional(item.asset) } : {}),
      ...(safeOptional(item.avatar) ? { avatar: safeOptional(item.avatar) } : {}),
      ...(safeOptional(item.assetKey) ? { assetKey: safeOptional(item.assetKey) } : {}),
    })
  }
  for (const item of match.resourceSnapshot?.ninjas ?? match.ninjaSnapshot ?? []) add('NINJA', item)
  for (const item of match.resourceSnapshot?.secretScrolls ?? []) add('SECRET_SCROLL', item)
  for (const item of match.resourceSnapshot?.summons ?? []) add('SUMMON', item)
  return map
}

export function createReplayFromMatch(
  match: MatchState,
  source: ReplaySource = 'LOCAL',
  metadata: { roomId?: string } = {},
): BPReplay {
  if (match.status !== 'MATCH_FINISHED') throw new Error('只有已完成比赛可以生成复盘')
  const actions: ReplayAction[] = []
  const games: ReplayGame[] = []
  const refs = new Set((match.publicBans ?? []).map((id) => resourceKey('NINJA', id)))

  for (const game of match.games) {
    if (!game.winner) continue
    const blue = sideFromGame(game.blue)
    const red = sideFromGame(game.red)
    const gameActions = match.history.filter((action) => action.gameNumber === game.gameNumber)
    for (const action of [...gameActions].reverse()) {
      const type = action.resourceType ?? 'NINJA'
      const id = action.resourceId ?? action.ninjaId
      const target = (action.side === 'BLUE' ? blue : red)[type][action.action === 'BAN' ? 'bans' : 'picks']
      removeOnce(target, id)
    }
    for (const side of [blue, red]) {
      for (const type of ['NINJA', 'SECRET_SCROLL', 'SUMMON'] as const) {
        for (const id of [...side[type].bans, ...side[type].picks]) refs.add(resourceKey(type, id))
      }
    }
    games.push({ gameNumber: game.gameNumber, initial: { blue, red }, winner: game.winner })
    for (const action of gameActions) {
      const type = action.resourceType ?? 'NINJA'
      const id = action.resourceId ?? action.ninjaId
      refs.add(resourceKey(type, id))
      actions.push({
        id: action.id,
        gameNumber: action.gameNumber,
        side: action.side,
        type: action.action,
        resourceType: type,
        resourceId: id,
        timestamp: action.timestamp,
        sequenceIndex: action.sequenceIndex,
      })
    }
    actions.push({
      id: `result-${match.id}-${game.gameNumber}`,
      gameNumber: game.gameNumber,
      side: game.winner,
      type: 'RESULT',
      sequenceIndex: gameActions.length,
    })
  }

  const lookup = snapshotLookup(match)
  const resourceSnapshot = [...refs].sort().map((key) => {
    const [resourceType, ...idParts] = key.split(':')
    const id = idParts.join(':')
    return lookup.get(key) ?? { id, name: id, resourceType: resourceType as DraftResourceType }
  })
  const winner: Side = match.score.blue > match.score.red ? 'BLUE' : 'RED'
  return {
    schemaVersion: REPLAY_SCHEMA_VERSION,
    replayId: `replay-${match.id}`,
    createdAt: match.createdAt,
    completedAt: match.updatedAt,
    source,
    rule: structuredClone(match.rule),
    ...(match.publicBans?.length ? { publicBans: [...match.publicBans] } : {}),
    players: { blue: match.bluePlayerName, red: match.redPlayerName },
    finalScore: { ...match.score },
    winner,
    games,
    actions,
    resourceSnapshot,
    ...(match.dataPack ? { dataPackMetadata: { ...match.dataPack } } : {}),
    metadata: { matchId: match.id, ...metadata },
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmpty(value: unknown, max = 160): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max
}

function validSideState(value: unknown, refs: Set<string>, errors: string[], path: string): value is ReplaySideState {
  if (!isObject(value)) { errors.push(`${path} 无效`); return false }
  let ok = true
  for (const type of ['NINJA', 'SECRET_SCROLL', 'SUMMON'] as const) {
    const draft = value[type]
    if (!isObject(draft) || !Array.isArray(draft.bans) || !Array.isArray(draft.picks)) {
      errors.push(`${path}.${type} 无效`); ok = false; continue
    }
    for (const field of ['bans', 'picks'] as const) {
      const values = draft[field]
      if (!Array.isArray(values) || values.length > 100 || !values.every((id: unknown) => nonEmpty(id, 160))) {
        errors.push(`${path}.${type}.${field} 无效`); ok = false
      } else for (const id of values as string[]) refs.add(resourceKey(type, id))
    }
  }
  return ok
}

export function validateReplay(value: unknown, maxBytes = REPLAY_IMPORT_MAX_BYTES): ReplayValidation {
  const errors: string[] = []
  let bytes = Infinity
  try { bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength } catch { errors.push('复盘无法序列化') }
  if (bytes > maxBytes) errors.push(`复盘超过 ${Math.floor(maxBytes / 1024)} KB 限制`)
  if (!isObject(value)) return { ok: false, errors: [...errors, '复盘必须是对象'] }
  if (value.schemaVersion !== REPLAY_SCHEMA_VERSION) errors.push(typeof value.schemaVersion === 'number' && value.schemaVersion > REPLAY_SCHEMA_VERSION ? '不支持未来版本复盘' : 'schemaVersion 无效')
  if (!nonEmpty(value.replayId)) errors.push('replayId 无效')
  if (!Number.isFinite(value.createdAt) || !Number.isFinite(value.completedAt) || Number(value.completedAt) < Number(value.createdAt)) errors.push('时间无效')
  if (!['LOCAL', 'ONLINE', 'IMPORTED', 'SHARED'].includes(String(value.source))) errors.push('source 无效')
  if (!validateStoredRule(value.rule)) errors.push('rule 无效')
  const rule = value.rule as BattleRule | undefined
  if (!isObject(value.players) || typeof value.players.blue !== 'string' || typeof value.players.red !== 'string' || value.players.blue.length > 80 || value.players.red.length > 80) errors.push('players 无效')
  if (!isObject(value.finalScore) || !Number.isInteger(value.finalScore.blue) || !Number.isInteger(value.finalScore.red) || Number(value.finalScore.blue) < 0 || Number(value.finalScore.red) < 0) errors.push('finalScore 无效')
  if (!['BLUE', 'RED'].includes(String(value.winner))) errors.push('winner 无效')
  if (!isObject(value.metadata) || !nonEmpty(value.metadata.matchId)) errors.push('metadata.matchId 无效')
  else {
    if (value.metadata.roomId !== undefined && !nonEmpty(value.metadata.roomId)) errors.push('metadata.roomId 无效')
    if (value.metadata.originalSource !== undefined && !['LOCAL', 'ONLINE', 'IMPORTED', 'SHARED'].includes(String(value.metadata.originalSource))) errors.push('metadata.originalSource 无效')
  }

  const snapshotKeys = new Set<string>()
  if (!Array.isArray(value.resourceSnapshot) || value.resourceSnapshot.length > 2000) errors.push('resourceSnapshot 无效或过大')
  else for (const item of value.resourceSnapshot) {
    if (!isObject(item) || !nonEmpty(item.id) || !nonEmpty(item.name, 200) || !['NINJA', 'SECRET_SCROLL', 'SUMMON'].includes(String(item.resourceType))) { errors.push('resourceSnapshot 条目无效'); continue }
    const key = resourceKey(item.resourceType as DraftResourceType, item.id as string)
    if (snapshotKeys.has(key)) errors.push(`重复资源 ${key}`)
    snapshotKeys.add(key)
    for (const field of ['asset', 'avatar', 'assetKey'] as const) if (item[field] !== undefined && (typeof item[field] !== 'string' || !isSafeAsset(item[field] as string))) errors.push(`${key} 含不安全素材地址`)
    if (item.quality !== undefined && !['S', 'A', 'B', 'C'].includes(String(item.quality))) errors.push(`${key} 品质无效`)
  }

  const referenced = new Set<string>()
  const gameNumbers = new Set<number>()
  const gameWinners = new Map<number, Side>()
  if (!Array.isArray(value.games) || value.games.length < 1 || value.games.length > 15) errors.push('games 无效或过大')
  else for (let index = 0; index < value.games.length; index += 1) {
    const game = value.games[index]
    if (!isObject(game) || game.gameNumber !== index + 1 || !['BLUE', 'RED'].includes(String(game.winner)) || !isObject(game.initial)) { errors.push(`Game ${index + 1} 无效`); continue }
    gameNumbers.add(game.gameNumber as number)
    gameWinners.set(game.gameNumber as number, game.winner as Side)
    validSideState(game.initial.blue, referenced, errors, `games[${index}].initial.blue`)
    validSideState(game.initial.red, referenced, errors, `games[${index}].initial.red`)
  }

  const ids = new Set<string>()
  const results = new Map<number, Side>()
  const lastSequence = new Map<number, number>()
  let lastGameNumber = 0
  if (!Array.isArray(value.actions) || value.actions.length > 2000) errors.push('actions 无效或过大')
  else for (const action of value.actions) {
    if (!isObject(action) || !nonEmpty(action.id) || ids.has(action.id)) { errors.push('action id 无效或重复'); continue }
    ids.add(action.id as string)
    if (!Number.isInteger(action.gameNumber) || !gameNumbers.has(action.gameNumber as number)) errors.push(`${action.id} gameNumber 无效`)
    if (Number(action.gameNumber) < lastGameNumber) errors.push(`${action.id} 跨局顺序无效`)
    lastGameNumber = Math.max(lastGameNumber, Number(action.gameNumber))
    if (!['BLUE', 'RED'].includes(String(action.side)) || !['BAN', 'PICK', 'RESULT'].includes(String(action.type))) errors.push(`${action.id} 操作无效`)
    if (!Number.isInteger(action.sequenceIndex) || Number(action.sequenceIndex) < 0) errors.push(`${action.id} sequenceIndex 无效`)
    const prior = lastSequence.get(action.gameNumber as number) ?? -1
    if (Number(action.sequenceIndex) !== prior + 1) errors.push(`${action.id} 操作顺序无效`)
    if (results.has(action.gameNumber as number)) errors.push(`${action.id} 出现在 Game RESULT 之后`)
    lastSequence.set(action.gameNumber as number, Number(action.sequenceIndex))
    if (action.timestamp !== undefined && (!Number.isFinite(action.timestamp) || Number(action.timestamp) < 0)) errors.push(`${action.id} timestamp 无效`)
    if (action.type === 'RESULT') {
      if (action.resourceId !== undefined || action.resourceType !== undefined || results.has(action.gameNumber as number)) errors.push(`${action.id} RESULT 无效`)
      results.set(action.gameNumber as number, action.side as Side)
    } else if (!['NINJA', 'SECRET_SCROLL', 'SUMMON'].includes(String(action.resourceType)) || !nonEmpty(action.resourceId)) errors.push(`${action.id} 资源引用无效`)
    else referenced.add(resourceKey(action.resourceType as DraftResourceType, action.resourceId as string))
  }
  for (const [game, winner] of gameWinners) if (results.get(game) !== winner) errors.push(`Game ${game} RESULT 与 winner 不一致`)
  if (value.publicBans !== undefined) {
    if (!isPublicBanList(value.publicBans) || (value.publicBans.length > 0 && !rule?.publicBanEnabled)) errors.push('公 Ban 列表无效')
    else for (const id of value.publicBans) {
      const key = resourceKey('NINJA', id)
      if (referenced.has(key)) errors.push('公 Ban 忍者出现在 BP 记录中')
      if (!snapshotKeys.has(key)) errors.push('公 Ban 缺少忍者快照')
    }
  }
  for (const ref of referenced) if (!snapshotKeys.has(ref)) errors.push(`缺少资源快照 ${ref}`)

  if (rule && isObject(value.finalScore)) {
    const blue = [...gameWinners.values()].filter((side) => side === 'BLUE').length
    const red = [...gameWinners.values()].filter((side) => side === 'RED').length
    if (value.finalScore.blue !== blue || value.finalScore.red !== red || Math.max(blue, red) !== rule.winsRequired || blue + red > rule.bestOf) errors.push('比分与局结果或规则不一致')
    const expected = blue > red ? 'BLUE' : 'RED'
    if (value.winner !== expected) errors.push('winner 与比分不一致')
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)] }
}

export function reconstructReplayAt(replay: BPReplay, requestedStep: number): ReconstructedReplay {
  const step = Math.max(0, Math.min(Math.trunc(requestedStep), replay.actions.length))
  const games: ReconstructedReplay['games'] = replay.games.map((game) => ({
    gameNumber: game.gameNumber,
    blue: cloneSide(game.initial.blue),
    red: cloneSide(game.initial.red),
  }))
  const score = { blue: 0, red: 0 }
  for (const action of replay.actions.slice(0, step)) {
    const game = games.find((item) => item.gameNumber === action.gameNumber)
    if (!game) continue
    if (action.type === 'RESULT') {
      game.winner = action.side
      score[action.side === 'BLUE' ? 'blue' : 'red'] += 1
    } else if (action.resourceType && action.resourceId) {
      const side = action.side === 'BLUE' ? game.blue : game.red
      side[action.resourceType][action.type === 'BAN' ? 'bans' : 'picks'].push(action.resourceId)
    }
  }
  const currentGame = step === 0 ? 1 : replay.actions[Math.min(step - 1, replay.actions.length - 1)]?.gameNumber ?? 1
  return { step, score, games, currentGame, complete: step === replay.actions.length }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

// Small synchronous SHA-256 keeps the shared core pure in Browser, Vitest and Deno.
export function sha256Canonical(value: unknown): string {
  const bytes = new TextEncoder().encode(canonical(value))
  const words: number[] = []
  const bitLength = bytes.length * 8
  const paddedLength = (((bytes.length + 9 + 63) >> 6) << 6)
  const padded = new Uint8Array(paddedLength)
  padded.set(bytes); padded[bytes.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(paddedLength - 4, bitLength >>> 0, false)
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false)
  const k = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]
  const h = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n))
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) words[i] = view.getUint32(offset + i * 4, false)
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(words[i-15],7) ^ rotr(words[i-15],18) ^ (words[i-15] >>> 3)
      const s1 = rotr(words[i-2],17) ^ rotr(words[i-2],19) ^ (words[i-2] >>> 10)
      words[i] = (words[i-16] + s0 + words[i-7] + s1) >>> 0
    }
    let [a,b,c,d,e,f,g,hh] = h
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e,6) ^ rotr(e,11) ^ rotr(e,25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (hh + s1 + ch + k[i] + words[i]) >>> 0
      const s0 = rotr(a,2) ^ rotr(a,13) ^ rotr(a,22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (s0 + maj) >>> 0
      hh=g; g=f; f=e; e=(d+t1)>>>0; d=c; c=b; b=a; a=(t1+t2)>>>0
    }
    h[0]=(h[0]+a)>>>0; h[1]=(h[1]+b)>>>0; h[2]=(h[2]+c)>>>0; h[3]=(h[3]+d)>>>0
    h[4]=(h[4]+e)>>>0; h[5]=(h[5]+f)>>>0; h[6]=(h[6]+g)>>>0; h[7]=(h[7]+hh)>>>0
  }
  return h.map((part) => part.toString(16).padStart(8, '0')).join('')
}

export function createReplayBundle(replay: BPReplay): ReplayBundle {
  return { bundleVersion: 1, replay: structuredClone(replay), checksum: `sha256:${sha256Canonical(replay)}` }
}

export function validateReplayBundle(value: unknown, maxBytes = REPLAY_IMPORT_MAX_BYTES): ReplayValidation {
  if (!isObject(value) || value.bundleVersion !== 1 || typeof value.checksum !== 'string' || !('replay' in value)) return { ok: false, errors: ['复盘文件格式无效'] }
  const validation = validateReplay(value.replay, maxBytes)
  if (value.checksum !== `sha256:${sha256Canonical(value.replay)}`) validation.errors.push('checksum 不匹配，文件可能已损坏')
  return { ok: validation.errors.length === 0, errors: validation.errors }
}

export function migrateReplayToCurrentSchema(value: unknown): { ok: true; replay: BPReplay } | { ok: false; error: string } {
  const candidate = isObject(value) && 'replay' in value ? value.replay : value
  if (!isObject(candidate)) return { ok: false, error: '复盘格式无效' }
  if (typeof candidate.schemaVersion === 'number' && candidate.schemaVersion > REPLAY_SCHEMA_VERSION) return { ok: false, error: '此复盘来自未来版本，请升级应用后再试' }
  const result = validateReplay(candidate)
  return result.ok ? { ok: true, replay: structuredClone(candidate as unknown as BPReplay) } : { ok: false, error: result.errors.join('；') }
}

export function anonymizePlayerNames(replay: BPReplay): BPReplay {
  return { ...structuredClone(replay), players: { blue: 'BLUE', red: 'RED' } }
}

export function replayStepForGame(replay: BPReplay, gameNumber: number): number {
  const index = replay.actions.findIndex((action) => action.gameNumber === gameNumber)
  if (index < 0) return replay.actions.length
  return gameNumber === 1 ? 0 : index + 1
}
