import { describe, expect, it } from 'vitest'
import { applyRoomCommand, checkSealedChoice, cloneMatch, createMatch, getMinimumRequiredResources, getPhase, getSealedDraft, revealSealedLoadouts, selectResource, startMatch, undoLastAction, validateBattleRule, validateMatchState, validateSealedLoadout, type BattleResources, type MatchState, type RoomCommandContext } from '../supabase/functions/_shared/bp-core/index'
import { DEFAULT_RULE, FULL_LOADOUT_DEMO_RULE, WUDOU_LOADOUT_RULE } from '../src/data/defaultRules'

const resources: BattleResources = {
  ninjas: Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, name: `忍者${i}`, quality: 'A', tags: [], enabled: true })),
  secretScrolls: Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, name: `秘卷${i}`, tags: [], enabled: true })),
  summons: Array.from({ length: 5 }, (_, i) => ({ id: `m${i}`, name: `通灵${i}`, tags: [], enabled: true })),
}
function scrollPhase(rule = WUDOU_LOADOUT_RULE) {
  let match = startMatch(createMatch(rule, '蓝', '红', { id: 'sealed-test', now: 1000 }))
  let i = 0
  while (getPhase(match).resourceType === 'NINJA') {
    const item = resources.ninjas[i++]
    match = selectResource(match, 'NINJA', item.id, item).state!
  }
  return match
}
const commands = { BLUE: 'blue-command', RED: 'red-command' }
function reveal(match: MatchState, prefix: string) {
  const result = revealSealedLoadouts(match, { BLUE: [0,1,2].map((i) => prefix+i), RED: [2,1,0].map((i) => prefix+i) }, resources, 2000, commands)
  expect(result.ok).toBe(true)
  return result.state!
}

describe('同时盲选与原规则兼容', () => {
  it('新模板只改变辅助资源；旧模板和最小池要求保持原样', () => {
    expect(validateBattleRule(WUDOU_LOADOUT_RULE)).toEqual([])
    expect(WUDOU_LOADOUT_RULE.resourceDrafts![0]).toEqual(FULL_LOADOUT_DEMO_RULE.resourceDrafts![0])
    expect(getMinimumRequiredResources(WUDOU_LOADOUT_RULE)).toEqual({ ninjas: 22, secretScrolls: 3, summons: 3 })
    expect(getSealedDraft(scrollPhase(FULL_LOADOUT_DEMO_RULE))).toBeNull()
    expect(DEFAULT_RULE.resourceDrafts).toBeUndefined()
  })
  it('人数、重复、停用、错误阶段由同一套规则校验，不能提前选择通灵', () => {
    const match = scrollPhase()
    expect(getSealedDraft(match)?.count).toBe(3)
    expect(validateSealedLoadout(match, 'RED', 'SECRET_SCROLL', ['s0','s1'], resources)).toBeTruthy()
    expect(validateSealedLoadout(match, 'RED', 'SECRET_SCROLL', ['s0','s1','s1'], resources)).toContain('不能重复')
    expect(validateSealedLoadout(match, 'RED', 'SUMMON', ['m0','m1','m2'], resources)).toBeTruthy()
    expect(validateSealedLoadout(match, 'RED', 'SECRET_SCROLL', ['s0','s1','missing'], resources)).toBeTruthy()
    expect(checkSealedChoice(match, 'RED', 'SECRET_SCROLL', 's0', resources).allowed).toBe(true)
    expect(validateSealedLoadout(match, 'BLUE', 'SECRET_SCROLL', ['s0','s1','s2'], { ...resources, secretScrolls: resources.secretScrolls.map((item) => ({ ...item, enabled: false })) })).toBeTruthy()
  })
  it('双方一次公开三个秘卷，逐个对应忍者，随后同时选择通灵并保留顺序', () => {
    const before = scrollPhase()
    const original = JSON.stringify(before)
    const scrolls = reveal(before, 's')
    expect(JSON.stringify(before)).toBe(original)
    expect(scrolls.games[0].blue.resources?.SECRET_SCROLL?.picks).toEqual(['s0','s1','s2'])
    expect(scrolls.games[0].red.resources?.SECRET_SCROLL?.picks).toEqual(['s2','s1','s0'])
    expect(scrolls.history.length).toBe(before.history.length + 6)
    expect(getSealedDraft(scrolls)?.resourceType).toBe('SUMMON')
    expect(validateMatchState(scrolls)).toBe(true)
    const ready = reveal(scrolls, 'm')
    expect(getPhase(ready).status).toBe('READY')
    expect(ready.games[0].red.resources?.SUMMON?.picks).toEqual(['m2','m1','m0'])
    expect(validateMatchState(ready)).toBe(true)
  })
  it('撤销按整组回退，不能留下已经公开的半组秘密选择', () => {
    const before = scrollPhase()
    const revealed = reveal(before, 's')
    const undone = undoLastAction(revealed, { now: 4000 }).state!
    expect(undone.history).toEqual(before.history)
    expect(undone.games[0].blue.resources?.SECRET_SCROLL?.picks).toEqual([])
    expect(undone.games[0].red.resources?.SECRET_SCROLL?.picks).toEqual([])
    expect(getSealedDraft(undone)?.resourceType).toBe('SECRET_SCROLL')
    expect(getSealedDraft(undone)?.key).not.toBe(getSealedDraft(before)?.key)
    expect(validateMatchState(undone)).toBe(true)
  })
  it('失败时不产生半组状态，修改槽位数仍按自定义规则执行', () => {
    const match = scrollPhase()
    expect(revealSealedLoadouts(match, { BLUE: ['s0','s1','s2'], RED: ['s0','s0','s1'] }, resources, 2000, commands).ok).toBe(false)
    expect(match.games[0].blue.resources).toBeUndefined()
    const rule = cloneMatch(WUDOU_LOADOUT_RULE)
    const scrolls = rule.resourceDrafts![1]
    scrolls.slotsPerSide = 2
    scrolls.sequence = [{ side: 'RED', action: 'PICK', count: 2 }, { side: 'BLUE', action: 'PICK', count: 2 }]
    expect(validateBattleRule(rule)).toEqual([])
    const result = revealSealedLoadouts(scrollPhase(rule), { BLUE: ['s1','s0'], RED: ['s0','s2'] }, resources, 2000, commands)
    expect(result.state?.games[0].blue.resources?.SECRET_SCROLL?.picks).toEqual(['s1','s0'])
  })
  it('拒绝冲突配置，但切回顺序选择后允许原来的 Ban 和双方排他规则', () => {
    const rule = cloneMatch(WUDOU_LOADOUT_RULE)
    rule.resourceDrafts![1].uniqueAcrossSides = true
    expect(validateBattleRule(rule).length).toBeGreaterThan(0)
    rule.resourceDrafts![1].selectionMode = 'SEQUENTIAL'
    expect(validateBattleRule(rule)).toEqual([])
  })
  it('不能绕过私密提交端点，使用旧的单次 SELECT_RESOURCE 提前公开', () => {
    const match = scrollPhase()
    const ctx: RoomCommandContext = { match, revision: 0, roomStatus: 'ACTIVE', expiresAt: 10_000, mySeat: 'BLUE', isHost: true, myUserId: 'blue', hostUserId: 'blue', seatMembers: { BLUE: { userId: 'blue', displayName: '蓝' }, RED: { userId: 'red', displayName: '红' } }, pendingUndo: null, ninjas: resources.ninjas, resources, now: 2000 }
    const outcome = applyRoomCommand(ctx, { commandId: 'one', roomId: 'room', expectedRevision: 0, type: 'SELECT_RESOURCE', payload: { resourceType: 'SECRET_SCROLL', resourceId: 's0' } })
    expect(outcome.status).toBe('REJECTED')
    expect(match.history).toHaveLength(10)
  })
})
