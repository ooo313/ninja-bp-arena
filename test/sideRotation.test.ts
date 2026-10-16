import { describe, expect, it } from 'vitest'
import { getNinjaCardStatus } from '../supabase/functions/_shared/bp-core/bpEngine'
import { WUDOU_LOADOUT_RULE, FULL_LOADOUT_DEMO_RULE, DEFAULT_RULE, cloneRule } from '../src/data/defaultRules'
import { applyRoomCommand, buildShareText, canSelectNinja, createMatch, enterGame, getGameSequence, getPhase, nextGame, normalizeBattleRule, playerName, playerScore, resetCurrentGame, restartMatch, revealSealedLoadouts, selectResource, setGameWinner, sideAtPosition, startMatch, validateBattleRule, validateMatchState, type MatchState, type RoomCommandContext, type Side } from '../supabase/functions/_shared/bp-core/index'

const resources = {
  ninjas: Array.from({ length: 60 }, (_, i) => ({ id: `n${i}`, name: `n${i}`, quality: 'A' as const, tags: [], enabled: true })),
  secretScrolls: Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, name: `s${i}`, tags: [], enabled: true })),
  summons: Array.from({ length: 6 }, (_, i) => ({ id: `m${i}`, name: `m${i}`, tags: [], enabled: true })),
}
function ninjaDraft(match: MatchState) {
  let state = match
  for (const item of resources.ninjas) {
    if (getPhase(state).resourceType !== 'NINJA') break
    if (canSelectNinja(state, item.id, item).allowed) state = selectResource(state, 'NINJA', item.id, item).state!
  }
  return state
}
function ready(match: MatchState) {
  let state = ninjaDraft(match)
  for (const prefix of ['s', 'm']) state = revealSealedLoadouts(state, { BLUE: [0,1,2].map((i) => prefix+i), RED: [2,1,0].map((i) => prefix+i) }, resources, state.updatedAt+1, { BLUE:'b', RED:'r' }).state!
  return state
}
function finish(match: MatchState, winner: Side) { return setGameWinner(enterGame(ready(match)).state!, winner).state! }
const picks = ['BLUE', 'RED', 'RED', 'BLUE', 'BLUE', 'RED']

describe('选人顺序与逐局自动换边', () => {
  it('首局左1右2左2右1；BO5每局左方先选，原选手每局互换身份位置', () => {
    const rule = { ...cloneRule(WUDOU_LOADOUT_RULE), bestOf: 5, winsRequired: 3 }
    let match = startMatch(createMatch(rule, '甲', '乙'))
    for (let game = 1; game <= 5; game++) {
      expect(match.currentGame).toBe(game)
      const left = sideAtPosition(match, 'BLUE')
      expect(left).toBe(game % 2 ? 'BLUE' : 'RED')
      expect(playerName(match, left)).toBe(game % 2 ? '甲' : '乙')
      const sequence = getGameSequence(match, game).filter((step) => step.resourceType === 'NINJA' && step.action === 'PICK')
      expect(sequence.map((step) => sideAtPosition(match, step.side))).toEqual(picks)
      expect(getGameSequence(match, game).filter((step) => step.action === 'BAN')).toHaveLength(game === 1 ? 4 : 0)
      match = finish(match, game % 2 ? 'BLUE' : 'RED')
      expect(validateMatchState(match)).toBe(true)
      if (game < 5) match = nextGame(match).state!
    }
    expect(match.score).toEqual({ blue: 3, red: 2 })
    expect(match.bluePlayerName).toBe('甲')
    expect(match.redPlayerName).toBe('乙')
    expect(match.status).toBe('MATCH_FINISHED')
  })
  it('换边后在线操作权限跟随原座位，左方选手有首选权限，另一位不能抢选', () => {
    const match = nextGame(finish(startMatch(createMatch(WUDOU_LOADOUT_RULE, '甲', '乙')), 'BLUE')).state!
    expect(getPhase(match).side).toBe('RED')
    expect(playerScore(match, sideAtPosition(match, 'BLUE'))).toBe(0)
    expect(playerScore(match, sideAtPosition(match, 'RED'))).toBe(1)
    const ctx: RoomCommandContext = { match, revision: 9, roomStatus: 'ACTIVE', expiresAt: 10000, mySeat:'BLUE', isHost: true, myUserId:'a', hostUserId:'a', seatMembers: { BLUE:{userId:'a',displayName:'甲'}, RED:{userId:'b',displayName:'乙'} }, pendingUndo:null, ninjas:resources.ninjas, resources, now:1000 }
    const cmd = { type:'SELECT_RESOURCE' as const, roomId:'r', commandId:'c', expectedRevision:9, payload:{resourceType:'NINJA' as const, resourceId:'n10'} }
    expect(applyRoomCommand(ctx, cmd).status).toBe('REJECTED')
    const result = applyRoomCommand({ ...ctx, mySeat:'RED', myUserId:'b', isHost:false }, cmd)
    expect(result.status).toBe('APPLIED')
  })
  it('次局秘卷和通灵仍同时公开，原选手的顺序、跨局锁定和比分不会串位', () => {
    const first = finish(startMatch(createMatch(WUDOU_LOADOUT_RULE, '甲', '乙')), 'BLUE')
    const second = nextGame(first).state!
    expect(canSelectNinja(second, first.games[0].blue.picks[0]).allowed).toBe(false)
    const state = ready(second)
    expect(state.games[1].red.resources?.SECRET_SCROLL?.picks).toEqual(['s2','s1','s0'])
    expect(state.games[1].red.resources?.SUMMON?.picks).toEqual(['m2','m1','m0'])
    const leftNinja = resources.ninjas.find((item) => item.id === state.games[1].red.picks[0])!
    expect(getNinjaCardStatus(state, leftNinja)).toMatchObject({ status:'BLUE_PICKED', reason:'蓝方已选择' })
    expect(state.history.filter((a) => a.gameNumber === 2 && a.resourceType === 'SECRET_SCROLL')[0].side).toBe('RED')
    expect(validateMatchState(state)).toBe(true)
    expect(sideAtPosition(JSON.parse(JSON.stringify(state)), 'BLUE')).toBe('RED')
    expect(sideAtPosition(resetCurrentGame(state).state!, 'BLUE')).toBe('RED')
    expect(sideAtPosition(restartMatch(state), 'BLUE')).toBe('BLUE')
    expect(buildShareText(state, (id) => id)).toContain('左侧蓝方：乙；右侧红方：甲')
  })
  it('旧规则未启用时保持原顺序；顺序辅助资源也会随换边交换先后手', () => {
    for (const rule of [DEFAULT_RULE, FULL_LOADOUT_DEMO_RULE]) {
      const match = createMatch(rule)
      expect(getGameSequence(match, 2).find((a) => a.action === 'PICK')?.side).toBe('RED')
      expect(sideAtPosition({ ...match, currentGame:2 }, 'BLUE')).toBe('BLUE')
    }
    const rule = { ...cloneRule(FULL_LOADOUT_DEMO_RULE), swapSidesEachGame:true }
    const match = createMatch(rule)
    for (const type of ['SECRET_SCROLL','SUMMON']) expect(getGameSequence(match, 2).find((a) => a.resourceType === type)?.side).toBe('RED')
    expect(normalizeBattleRule(rule).swapSidesEachGame).toBe(true)
    expect(validateBattleRule({ ...rule, swapSidesEachGame:'yes' } as never)).not.toEqual([])
  })
})
