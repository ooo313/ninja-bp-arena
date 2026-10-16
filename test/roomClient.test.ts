import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ from: vi.fn() }))
vi.mock('../src/lib/supabase', () => ({ supabase: { from: mocks.from } }))
import { roomApi } from '../src/online/roomClient'
import { createMatch, getPhase, getSealedDraft, selectResource, startMatch } from '../supabase/functions/_shared/bp-core/index'
import { WUDOU_LOADOUT_RULE } from '../src/data/defaultRules'

function response<T>() {
  let resolve!: (data: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  const builder = {
    select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), abortSignal: vi.fn().mockReturnThis(),
    maybeSingle: () => promise, then: promise.then.bind(promise),
  }
  return { resolve, builder }
}
beforeEach(() => { mocks.from.mockReset() })
describe('parallel room snapshot reads', () => {
  it('only fetches a private submission for the active sealed phase and returns the RLS-filtered owner row', async () => {
    let match = startMatch(createMatch(WUDOU_LOADOUT_RULE))
    for (let i = 0; getPhase(match).resourceType === 'NINJA'; i++) {
      const item = { id: `n${i}`, name: `N${i}`, quality: 'A' as const, tags: [], enabled: true }
      match = selectResource(match, 'NINJA', item.id, item).state!
    }
    const room = response<{ data: { match_state: typeof match }; error: null }>()
    const members = response<{ data: []; error: null }>()
    const privateRow = { phase_key: getSealedDraft(match)!.key, side: 'BLUE', resource_ids: ['s0','s1','s2'] }
    const selection = response<{ data: typeof privateRow; error: null }>()
    mocks.from.mockImplementation((table: string) => table === 'rooms' ? room.builder : table === 'room_members' ? members.builder : selection.builder)
    const pending = roomApi.fetchSnapshot('room-sealed')
    room.resolve({ data: { match_state: match }, error: null }); members.resolve({ data: [], error: null })
    await vi.waitFor(() => expect(mocks.from).toHaveBeenCalledWith('room_loadout_submissions'))
    expect(selection.builder.eq).toHaveBeenCalledWith('phase_key', privateRow.phase_key)
    selection.resolve({ data: privateRow, error: null })
    expect((await pending).privateLoadout).toEqual(privateRow)
  })
  it('starts both room and member reads before either finishes', async () => {
    const room = response<{ data: null; error: null }>()
    const members = response<{ data: []; error: null }>()
    mocks.from.mockImplementation((table: string) => table === 'rooms' ? room.builder : members.builder)
    const pending = roomApi.fetchSnapshot('room-a')
    expect(mocks.from.mock.calls.map(([table]) => table)).toEqual(['rooms', 'room_members'])
    expect(room.builder.abortSignal).toHaveBeenCalled()
    expect(members.builder.abortSignal).toHaveBeenCalled()
    room.resolve({ data: null, error: null }); members.resolve({ data: [], error: null })
    await expect(pending).resolves.toEqual({ room: null, members: [], privateLoadout: null })
  })
  it('keeps database errors visible rather than returning an incomplete snapshot', async () => {
    const room = response<{ data: null; error: { message: string } }>()
    const members = response<{ data: []; error: null }>()
    mocks.from.mockImplementation((table: string) => table === 'rooms' ? room.builder : members.builder)
    const pending = roomApi.fetchSnapshot('room-a')
    room.resolve({ data: null, error: { message: 'permission denied' } }); members.resolve({ data: [], error: null })
    await expect(pending).rejects.toMatchObject({ code: 'DB_ERROR', message: 'permission denied' })
  })
  it('omits immutable resource fields during lightweight refreshes', async () => {
    const room = response<{ data: null; error: null }>()
    const members = response<{ data: []; error: null }>()
    mocks.from.mockImplementation((table: string) => table === 'rooms' ? room.builder : members.builder)
    const pending = roomApi.fetchSnapshot('room-a', false)
    const fields = room.builder.select.mock.calls[0][0]
    expect(fields).toContain('match_state')
    expect(fields).toContain('revision')
    expect(fields).not.toContain('resource_snapshot')
    expect(fields).not.toContain('pool')
    room.resolve({ data: null, error: null }); members.resolve({ data: [], error: null })
    await pending
  })
})
