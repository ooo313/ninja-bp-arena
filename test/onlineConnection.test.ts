import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMatch, startMatch } from '../supabase/functions/_shared/bp-core/bpEngine'
import { DEFAULT_RULE } from '../src/data/defaultRules'

const mocks = vi.hoisted(() => ({
  fetchSnapshot: vi.fn(), sendCommand: vi.fn(), channels: [] as Array<{
    emit: (status: string) => Promise<void>; on: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>; track: ReturnType<typeof vi.fn>;
  }>,
}))
vi.mock('../src/lib/supabase', () => ({
  isOnlineConfigured: true,
  supabase: {
    channel: vi.fn(() => {
      let callback: (status: string) => Promise<void>
      const channel = {
        emit: async (status: string) => { await callback(status) },
        on: vi.fn().mockReturnThis(),
        subscribe: vi.fn((cb) => { callback = cb; return channel }),
        track: vi.fn().mockResolvedValue('ok'),
      }
      mocks.channels.push(channel)
      return channel
    }),
    // Real removeChannel emits CLOSED; reproduce that ordering explicitly.
    removeChannel: vi.fn(async (channel) => { await channel.emit('CLOSED') }),
  },
}))
vi.mock('../src/online/roomClient', () => ({ roomApi: { fetchSnapshot: mocks.fetchSnapshot, sendCommand: mocks.sendCommand } }))
vi.mock('../src/store/ninjaStore', () => ({ useNinjaStore: { getState: vi.fn() } }))
vi.mock('../src/dataPack/store', () => ({ useDataPackStore: { getState: vi.fn() }, parseRoomNinjaSnapshot: () => ({ valid: true, ninjas: [] }) }))
import { useOnlineRoomStore as store } from '../src/online/onlineRoomStore'

const match = startMatch(createMatch(DEFAULT_RULE))
const snapshot = (revision = 0) => ({
  room: { id: 'room-a', code: 'ABCDEF', status: 'ACTIVE', match_state: match, revision, pending_action: null,
    expires_at: '2030-01-01', host_user_id: 'host', pool: [], resource_snapshot: { ninjas: [], secretScrolls: [], summons: [] } },
  members: [{ user_id: 'host', seat: 'BLUE', display_name: 'Host' }],
})
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('window', { setInterval, clearInterval, setTimeout, clearTimeout })
  vi.stubGlobal('navigator', { onLine: true })
  mocks.channels.length = 0
  mocks.fetchSnapshot.mockReset().mockResolvedValue(snapshot())
  mocks.sendCommand.mockReset()
  store.setState({ userId: 'host' })
})
afterEach(async () => { store.getState().leaveRoom(); await Promise.resolve(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('online room connection lifecycle', () => {
  it('ignores CLOSED and late SUBSCRIBED from a removed channel', async () => {
    await store.getState().enterRoom('room-a', 'ABCDEF')
    const old = mocks.channels[0]
    await store.getState().enterRoom('room-a', 'ABCDEF')
    const count = mocks.fetchSnapshot.mock.calls.length
    await old.emit('CLOSED'); await old.emit('SUBSCRIBED')
    expect(store.getState().connection).toBe('connected')
    expect(store.getState().realtimeConnected).toBe(false)
    expect(mocks.fetchSnapshot).toHaveBeenCalledTimes(count)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(mocks.channels).toHaveLength(2)
  })
  it('keeps HTTP polling usable when the socket times out, without replacing it', async () => {
    await store.getState().enterRoom('room-a', 'ABCDEF')
    await mocks.channels[0].emit('TIMED_OUT')
    await Promise.resolve(); await Promise.resolve()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(store.getState().connection).toBe('connected')
    expect(store.getState().realtimeConnected).toBe(false)
    expect(mocks.channels).toHaveLength(1)
    expect(mocks.fetchSnapshot.mock.calls.length).toBeGreaterThanOrEqual(3)
  })
  it('tolerates one failed refresh and recovers on the next successful read', async () => {
    await store.getState().enterRoom('room-a', 'ABCDEF')
    mocks.fetchSnapshot.mockRejectedValueOnce(new Error('temporary failure'))
    await store.getState().refreshSnapshot()
    expect(store.getState().connection).toBe('connected')
    await store.getState().refreshSnapshot()
    expect(store.getState().connection).toBe('connected')
  })
  it('merges concurrent refreshes and fetches once more for a notification during the read', async () => {
    await store.getState().enterRoom('room-a', 'ABCDEF')
    const waiting = deferred<ReturnType<typeof snapshot>>()
    mocks.fetchSnapshot.mockImplementationOnce(() => waiting.promise).mockResolvedValue(snapshot(2))
    const a = store.getState().refreshSnapshot()
    const b = store.getState().refreshSnapshot()
    const c = store.getState().refreshSnapshot()
    expect(mocks.fetchSnapshot).toHaveBeenCalledTimes(2)
    waiting.resolve(snapshot(1))
    await Promise.all([a,b,c]); await Promise.resolve(); await Promise.resolve()
    expect(mocks.fetchSnapshot).toHaveBeenCalledTimes(3)
    expect(store.getState().revision).toBe(2)
  })
  it('preserves fixed resource and unchanged match references while polling', async () => {
    await store.getState().enterRoom('room-a', 'ABCDEF')
    const before = store.getState()
    mocks.fetchSnapshot.mockResolvedValue(structuredClone(snapshot()))
    await store.getState().refreshSnapshot()
    expect(store.getState().match).toBe(before.match)
    expect(store.getState().roomResources).toBe(before.roomResources)
    expect(store.getState().onlineNinjaIds).toBe(before.onlineNinjaIds)
  })
  it('ignores an old entry request after a newer session has entered the same room', async () => {
    const old = deferred<ReturnType<typeof snapshot>>()
    mocks.fetchSnapshot.mockImplementationOnce(() => old.promise)
    const first = store.getState().enterRoom('room-a', 'ABCDEF')
    await store.getState().enterRoom('room-a', 'ABCDEF')
    old.resolve(snapshot(9)); await first
    expect(store.getState().revision).toBe(0)
    expect(mocks.channels).toHaveLength(1)
  })
  it('keeps business rejection separate from connection failure', async () => {
    await store.getState().enterRoom('room-a', 'ABCDEF')
    mocks.sendCommand.mockRejectedValue(Object.assign(new Error('Not your turn'), { code: 'NOT_YOUR_TURN' }))
    const result = await store.getState().sendCommand('SELECT_NINJA', { ninjaId: 'ninja-1' })
    expect(result.ok).toBe(false)
    expect(store.getState().connection).toBe('connected')
    expect(store.getState().pendingCommand).toBeNull()
  })
  it('does not revive a departed room when a command finishes late', async () => {
    await store.getState().enterRoom('room-a', 'ABCDEF')
    const command = deferred<{ status: string; match: typeof match; revision: number }>()
    mocks.sendCommand.mockReturnValue(command.promise)
    const pending = store.getState().sendCommand('SELECT_NINJA', { ninjaId: 'ninja-1' })
    store.getState().leaveRoom()
    command.resolve({ status: 'APPLIED', match, revision: 1 })
    await pending; await vi.advanceTimersByTimeAsync(15_000)
    expect(store.getState().connection).toBe('idle')
    expect(store.getState().roomId).toBeNull()
    expect(mocks.channels).toHaveLength(1)
  })
  it('does not overwrite a browser offline event with a late command success', async () => {
    await store.getState().enterRoom('room-a', 'ABCDEF')
    const command = deferred<{ status: string; match: typeof match; revision: number }>()
    mocks.sendCommand.mockReturnValue(command.promise)
    const pending = store.getState().sendCommand('SELECT_NINJA', { ninjaId: 'ninja-1' })
    vi.stubGlobal('navigator', { onLine: false })
    store.getState().markOffline()
    command.resolve({ status: 'APPLIED', match, revision: 1 }); await pending
    expect(store.getState().connection).toBe('offline')
  })
})
