import { describe, expect, it } from 'vitest'
import { submitPrivateLoadout } from '../supabase/functions/_shared/loadoutSubmission'
import { createMatch, getPhase, getSealedDraft, selectResource, startMatch, toBattleResourceSnapshot, type MatchState, type Side } from '../supabase/functions/_shared/bp-core/index'
import { WUDOU_LOADOUT_RULE } from '../src/data/defaultRules'

function fixture() {
  const resources = {
    ninjas: Array.from({ length: 28 }, (_, i) => ({ id: `n${i}`, name: `N${i}`, quality: 'A' as const, tags: [], enabled: true })),
    secretScrolls: Array.from({ length: 4 }, (_, i) => ({ id: `s${i}`, name: `S${i}`, tags: [], enabled: true })),
    summons: Array.from({ length: 4 }, (_, i) => ({ id: `m${i}`, name: `M${i}`, tags: [], enabled: true })),
  }
  let match = startMatch(createMatch(WUDOU_LOADOUT_RULE, '蓝', '红'))
  let i = 0
  while (getPhase(match).resourceType === 'NINJA') {
    const item = resources.ninjas[i++]
    match = selectResource(match, 'NINJA', item.id, item).state!
  }
  const room = { id: 'room', match_state: match, status: 'ACTIVE', revision: 0, resource_snapshot: toBattleResourceSnapshot(resources), expires_at: '2999-01-01' }
  const members = [{ room_id: 'room', user_id: 'blue', seat: 'BLUE' }, { room_id: 'room', user_id: 'red', seat: 'RED' }, { room_id: 'room', user_id: 'observer', seat: 'OBSERVER' }]
  type Row = Record<string, unknown>
  const submissions: Row[] = []
  const commits: { match: MatchState; revision: number }[] = []
  const db = {
    from(table: string) {
      const filters: [string, unknown][] = []
      const rows = () => {
        const data = table === 'rooms' ? [room] : table === 'room_members' ? members : table === 'room_loadout_submissions' ? submissions : (() => { throw Error(`Unexpected table ${table}`) })()
        return structuredClone((data as Row[]).filter((item) => filters.every(([key, value]) => item[key] === value)))
      }
      const query = {
        select(_columns: string) { return query },
        eq(key: string, value: unknown) { filters.push([key, value]); return query },
        async single() { return { data: rows()[0] ?? null, error: null } },
        async maybeSingle() { return { data: rows()[0] ?? null, error: null } },
        then(resolve: (value: { data: Row[]; error: null }) => unknown) { return Promise.resolve({ data: rows(), error: null }).then(resolve) },
      }
      return query
    },
    async rpc(_name: string, args: Record<string, unknown>) {
      // The real migration enforces this comparison under SELECT FOR UPDATE.
      if (room.revision !== args.p_expected_revision) return { data: null, error: { message: 'REVISION_CONFLICT' } }
      const other = submissions.find((row) => row.phase_key === args.p_phase_key && row.side !== args.p_side)
      if ((other?.command_id ?? null) !== args.p_opponent_command_id) return { data: null, error: { message: 'REVISION_CONFLICT' } }
      submissions.push({ room_id: 'room', phase_key: args.p_phase_key, user_id: args.p_user_id, side: args.p_side, command_id: args.p_command_id, resource_type: args.p_resource_type, resource_ids: args.p_resource_ids })
      if (args.p_revealed_match) room.match_state = structuredClone(args.p_revealed_match as MatchState)
      room.revision++
      commits.push({ match: structuredClone(room.match_state), revision: room.revision })
      return { data: room.revision, error: null }
    },
  }
  const phaseKey = getSealedDraft(match)!.key
  const submit = (user: string, ids = ['s0','s1','s2'], command = `${user}-command`, overrides: Record<string, unknown> = {}) => submitPrivateLoadout(db as unknown as Parameters<typeof submitPrivateLoadout>[0], user, 'room', command, { phaseKey, resourceType: 'SECRET_SCROLL', resourceIds: ids, ...overrides })
  return { room, submissions, commits, submit }
}

describe('服务端私密整组提交', () => {
  it('首位提交者只收到自己的选择，公共状态和历史均不含秘卷', async () => {
    const state = fixture()
    const response = await state.submit('blue')
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.privateLoadout).toMatchObject({ side: 'BLUE', resource_ids: ['s0','s1','s2'] })
    expect(body.match.games[0].blue.resources).toBeUndefined()
    expect(body.match.history).toHaveLength(10)
    expect(JSON.stringify(state.commits[0].match)).not.toContain('s0')
  })
  it('双方真实并发请求遇到 revision 冲突后自动重读，并只公开一次完整阵容', async () => {
    const state = fixture()
    const responses = await Promise.all([state.submit('blue'), state.submit('red', ['s2','s1','s0'])])
    expect(responses.map((r) => r.status)).toEqual([200,200])
    expect(state.commits).toHaveLength(2)
    expect(state.commits[0].match.history).toHaveLength(10)
    expect(state.commits[1].match.history).toHaveLength(16)
    expect(state.room.match_state.games[0].blue.resources?.SECRET_SCROLL?.picks).toEqual(['s0','s1','s2'])
    expect(state.room.match_state.games[0].red.resources?.SECRET_SCROLL?.picks).toEqual(['s2','s1','s0'])
    expect(getSealedDraft(state.room.match_state)?.resourceType).toBe('SUMMON')
  })
  it('重发原命令幂等，改阵容、换请求重提和复用标识均拒绝', async () => {
    const state = fixture()
    await state.submit('blue')
    expect((await state.submit('blue')).status).toBe(200)
    expect(state.commits).toHaveLength(1)
    expect((await state.submit('blue', ['s0','s1','s3'])).status).toBe(400)
    expect((await state.submit('blue', ['s0','s1','s2'], 'new-command')).status).toBe(400)
    expect(state.commits).toHaveLength(1)
  })
  it('观战者、非成员、伪造阵营、过期阶段、重复和不完整选择均拒绝', async () => {
    const state = fixture()
    for (const user of ['observer','outsider']) expect((await state.submit(user)).status).toBe(400)
    expect((await state.submit('red', ['s0','s1','s2'], 'red-forged', { side: 'BLUE' as Side })).status).toBe(400)
    expect((await state.submit('red', ['s0','s1','s2'], 'red-stale', { phaseKey: 'old-phase' })).status).toBe(409)
    expect((await state.submit('red', ['s0','s0','s2'])).status).toBe(400)
    expect((await state.submit('red', ['s0','s1'])).status).toBe(400)
    expect(state.submissions).toHaveLength(0)
  })
})
