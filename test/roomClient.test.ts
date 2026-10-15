import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ from: vi.fn() }))
vi.mock('../src/lib/supabase', () => ({ supabase: { from: mocks.from } }))
import { roomApi } from '../src/online/roomClient'

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
  it('starts both room and member reads before either finishes', async () => {
    const room = response<{ data: null; error: null }>()
    const members = response<{ data: []; error: null }>()
    mocks.from.mockImplementation((table: string) => table === 'rooms' ? room.builder : members.builder)
    const pending = roomApi.fetchSnapshot('room-a')
    expect(mocks.from.mock.calls.map(([table]) => table)).toEqual(['rooms', 'room_members'])
    expect(room.builder.abortSignal).toHaveBeenCalled()
    expect(members.builder.abortSignal).toHaveBeenCalled()
    room.resolve({ data: null, error: null }); members.resolve({ data: [], error: null })
    await expect(pending).resolves.toEqual({ room: null, members: [] })
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
