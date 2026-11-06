import { expect, it } from 'vitest'
import {
  applyRoomCommand, canSelectNinja, createMatch, createReplayFromMatch, enterGame, getNinjaCardStatus,
  getPhase, nextGame, selectNinja, setGameWinner, startMatch, validateMatchState, validateReplay,
  type BattleRule, type MatchState, type RoomCommandContext,
} from '../supabase/functions/_shared/bp-core/index'
import { DEFAULT_RULE } from '../src/data/defaultRules'

const ninjas = ['n1', 'n2', 'n3', 'n4', 'ban'].map((id) => ({ id, name: id, enabled: true, quality: 'A' as const, tags: [] }))
const ownRule: BattleRule = {
  ...DEFAULT_RULE,
  publicBanEnabled: true,
  swapSidesEachGame: true,
  resourceDrafts: [{
    resourceType: 'NINJA', enabled: true, slotsPerSide: 1, uniqueAcrossSides: true,
    sequence: [{ side: 'BLUE', action: 'PICK', count: 1 }, { side: 'RED', action: 'PICK', count: 1 }],
    crossGameLock: true, crossGameLockScope: 'OWN', banPersistence: false, resetEachGame: true,
  }],
}

function choose(match: MatchState, id: string) {
  const result = selectNinja(match, id, ninjas.find((item) => item.id === id))
  expect(result.ok, result.reason).toBe(true)
  return result.state!
}

it('仅己方锁定跟随选手换边，公 Ban 独立贯穿整场并保留在复盘', () => {
  let match = startMatch({ ...createMatch(ownRule), publicBans: ['ban'] })
  expect(getPhase(match).remainingInStep).toBe(1)
  expect(canSelectNinja(match, 'ban', ninjas[4]).allowed).toBe(false)
  match = choose(choose(match, 'n1'), 'n2')
  match = setGameWinner(enterGame(match).state!, 'BLUE').state!
  match = nextGame(match).state!
  expect(getPhase(match).side).toBe('RED')
  expect(canSelectNinja(match, 'n1', ninjas[0]).allowed).toBe(true)
  expect(getNinjaCardStatus(match, ninjas[1]).status).toBe('USED')
  expect(getNinjaCardStatus(match, ninjas[4]).status).toBe('BANNED')
  match = choose(choose(match, 'n1'), 'n2')
  match = setGameWinner(enterGame(match).state!, 'BLUE').state!
  expect(validateMatchState(match)).toBe(true)
  const replay = createReplayFromMatch(match)
  expect(replay.publicBans).toEqual(['ban'])
  expect(validateReplay(replay).ok).toBe(true)
})

it('无限局仅己方锁定时，双方仍可互换上一局使用的资源', () => {
  const rule = { ...ownRule, bestOf: 0, winsRequired: 0 }
  let match = choose(choose(startMatch({ ...createMatch(rule), publicBans: ['ban'] }), 'n1'), 'n2')
  match = setGameWinner(enterGame(match).state!, 'BLUE').state!
  expect(nextGame(match, { now: 10 }, () => [ninjas[0], ninjas[1], ninjas[4]]).ok).toBe(true)
})

it('房主开赛时校验公 Ban 的资源、数量和规则开关', () => {
  const context: RoomCommandContext = {
    match: createMatch(ownRule), revision: 0, roomStatus: 'WAITING', expiresAt: Infinity,
    mySeat: 'BLUE', isHost: true, myUserId: 'b', hostUserId: 'b',
    seatMembers: { BLUE: { userId: 'b', displayName: '甲' }, RED: { userId: 'r', displayName: '乙' } },
    pendingUndo: null, ninjas, now: 1_800_000_000_000,
  }
  const start = (publicBans: unknown, ctx = context) => applyRoomCommand(ctx, {
    type: 'START_MATCH', roomId: 'room', commandId: 'start', expectedRevision: 0, payload: { publicBans },
  })
  for (const invalid of ['ban', ['ban', 'ban'], ['missing'], ['n3', 'ban']]) {
    expect(start(invalid)).toMatchObject({ status: 'REJECTED' })
  }
  expect(start(['ban'], { ...context, match: createMatch({ ...ownRule, publicBanEnabled: false }) })).toMatchObject({ status: 'REJECTED' })
  expect(start(['ban'], { ...context, isHost: false })).toMatchObject({ code: 'NOT_HOST' })
  expect(start(['ban'])).toMatchObject({ status: 'APPLIED', match: { publicBans: ['ban'] } })
})
