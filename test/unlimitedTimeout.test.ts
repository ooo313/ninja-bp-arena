import { describe, expect, it } from 'vitest'
import {
  applyRoomCommand, completeTimedOutStep, createMatch, enterGame, getPhase, nextGame,
  rebuildTimer, setGameWinner, sideAtPosition, startMatch, validateMatchState,
  type MatchState, type RoomCommand, type RoomCommandContext,
} from '../supabase/functions/_shared/bp-core/index'
import { DEFAULT_RULE } from '../src/data/defaultRules'

const pool = Array.from({ length: 16 }, (_, i) => ({ id: 'n' + i, enabled: true }))
const now = 1_800_000_000_000

function playGame(match: MatchState) {
  let state = match
  while (!getPhase(state).sequenceComplete) {
    const result = completeTimedOutStep(state, pool, undefined, now)
    expect(result.ok).toBe(true)
    state = result.state!
  }
  return setGameWinner(enterGame(state).state!, 'BLUE').state!
}

describe('无限局', () => {
  it('允许复用时继续到第九局，换边与累计比分保持一致', () => {
    const rule = { ...DEFAULT_RULE, bestOf: 0, winsRequired: 0, usedNinjaLocked: false, swapSidesEachGame: true }
    let match = startMatch(createMatch(rule))
    for (let i = 1; i <= 8; i++) {
      expect(sideAtPosition(match, 'BLUE')).toBe(i % 2 === 0 ? 'RED' : 'BLUE')
      match = playGame(match)
      expect(validateMatchState(match)).toBe(true)
      match = nextGame(match, { now }, () => pool).state!
    }
    expect(match).toMatchObject({ currentGame: 9, status: 'IN_PROGRESS', score: { blue: 8, red: 0 } })
  })

  it('开启跨局锁定时，资源耗尽后保留已有比分和当前结算', () => {
    const rule = { ...DEFAULT_RULE, bestOf: 0, winsRequired: 0 }
    const first = playGame(startMatch(createMatch(rule)))
    const second = playGame(nextGame(first, { now }, () => pool).state!)
    expect(second).toMatchObject({ currentGame: 2, status: 'IN_PROGRESS', score: { blue: 2, red: 0 } })
    expect(nextGame(second, { now }, () => pool)).toEqual({ ok: false, reason: '剩余忍者不足，下一局需要 6 个，当前可用 0 个' })
  })
})

it('服务端按自己的截止时间确认当前预览，并推进整个未完成步骤', () => {
  const first = startMatch(createMatch(DEFAULT_RULE))
  const state = completeTimedOutStep(first, pool, 'n0', now).state!
  const match = rebuildTimer(state, now)
  const deadline = match.timer!.deadlineAt!
  const context: RoomCommandContext = {
    match, revision: 4, roomStatus: 'ACTIVE', expiresAt: Infinity,
    mySeat: 'RED', isHost: false, myUserId: 'red', hostUserId: 'blue',
    seatMembers: { BLUE: null, RED: null }, pendingUndo: null, ninjas: pool, now: deadline,
  }
  const command: RoomCommand = {
    roomId: 'r', commandId: 'x', expectedRevision: 4, type: 'EXPIRE_DRAFT',
    payload: { deadline, phaseKey: getPhase(match).phaseKey, resourceId: 'n5' },
  }
  expect(applyRoomCommand({ ...context, now: deadline - 1 }, command)).toMatchObject({ code: 'DRAFT_DEADLINE' })
  expect(applyRoomCommand({ ...context, mySeat: 'BLUE' }, command)).toMatchObject({ code: 'DRAFT_DEADLINE' })
  expect(applyRoomCommand(context, { ...command, expectedRevision: 3 })).toMatchObject({ code: 'REVISION_CONFLICT' })
  const result = applyRoomCommand(context, command)
  expect(result.status).toBe('APPLIED')
  if (result.status !== 'APPLIED') throw Error(result.message)
  expect(result.match.games[0].red.bans).toEqual(['n5', 'n1'])
  expect(getPhase(result.match).side).toBe('BLUE')
  expect(result.match.timer!.deadlineAt).toBeGreaterThan(deadline)
})
