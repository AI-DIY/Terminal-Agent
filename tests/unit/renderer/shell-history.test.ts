import { describe, expect, it, vi } from 'vitest'
import {
  createShellHistoryStore,
  latestHistoryByHost,
  readOnlyHistoryTerminal,
} from '../../../src/renderer/src/stores/shell-history'

describe('renderer Shell history', () => {
  it('opens the first safe history record and keeps the terminal playback read-only', async () => {
    const api = createHistoryApi()
    const store = createShellHistoryStore(api)

    await store.open({ chatId: 'chat-history' })

    expect(store.state.selectedId).toBe('history-newest')
    expect(api.get).toHaveBeenCalledWith('history-newest')
    expect(readOnlyHistoryTerminal(store.state.selected)).toEqual({ readOnly: true, output: 'latest safe output' })
  })

  it('uses only opaque IDs when requesting a duplicate or reconnect', async () => {
    const api = createHistoryApi()
    const store = createShellHistoryStore(api)

    await store.duplicate('session-live')
    await store.reconnect('history-newest')

    expect(api.duplicate).toHaveBeenCalledWith('session-live')
    expect(api.reconnect).toHaveBeenCalledWith('history-newest')
    expect(JSON.stringify(api.duplicate.mock.calls)).not.toContain('credential-placeholder')
    expect(JSON.stringify(api.reconnect.mock.calls)).not.toContain('credential-placeholder')
  })

  it('revalidates reconnect eligibility before opening transport and reflects lost authority', async () => {
    const api = createHistoryApi()
    const store = createShellHistoryStore(api)
    await store.open({ chatId: 'chat-history' })

    api.get.mockResolvedValueOnce({
      ...summary({ id: 'history-newest', hostname: 'web-01', endedAt: '2026-08-16T08:02:00.000Z', reconnectable: false }),
      output: 'latest safe output',
    })

    await expect(store.reconnect('history-newest')).rejects.toThrow('Shell 历史重连不可用。')

    expect(api.get).toHaveBeenLastCalledWith('history-newest')
    expect(api.reconnect).not.toHaveBeenCalled()
    expect(store.state.records).toEqual([
      expect.objectContaining({ id: 'history-newest', reconnectable: false }),
      expect.objectContaining({ id: 'history-old', reconnectable: true }),
    ])
    expect(JSON.stringify(store.state)).not.toContain('credential-placeholder')
  })

  it('refreshes displayed reconnect eligibility from safe summaries and releases its timer', async () => {
    const api = createHistoryApi()
    const store = createShellHistoryStore(api)
    await store.open({ chatId: 'chat-history' })
    api.list.mockResolvedValueOnce([
      summary({ id: 'history-newest', hostname: 'web-01', endedAt: '2026-08-16T08:02:00.000Z', reconnectable: false }),
      summary({ id: 'history-old', hostname: 'web-01', endedAt: '2026-08-16T08:01:00.000Z' }),
    ])

    let intervalCallback: (() => void) | undefined
    const clearInterval = vi.fn()
    const refreshableStore = store as typeof store & {
      startEligibilityRefresh(scheduler: {
        setInterval(callback: () => void, delay: number): number
        clearInterval(handle: number): void
      }): () => void
    }

    expect(refreshableStore.startEligibilityRefresh).toBeTypeOf('function')
    if (typeof refreshableStore.startEligibilityRefresh !== 'function') return
    const stop = refreshableStore.startEligibilityRefresh({
      setInterval: (callback, delay) => {
        intervalCallback = callback
        expect(delay).toBe(5_000)
        return 42
      },
      clearInterval,
    })
    const getCallsBeforeRefresh = api.get.mock.calls.length

    intervalCallback?.()
    await vi.waitFor(() => {
      expect(store.state.records[0]).toMatchObject({ id: 'history-newest', reconnectable: false })
    })

    expect(api.get).toHaveBeenCalledTimes(getCallsBeforeRefresh)
    stop()
    expect(clearInterval).toHaveBeenCalledWith(42)
    expect(JSON.stringify(store.state)).not.toContain('credential-placeholder')
  })

  it('retains the newest history record for each host when a historical chat is selected', () => {
    const history = latestHistoryByHost([
      summary({ id: 'history-web-old', hostname: 'web-01', endedAt: '2026-08-16T08:01:00.000Z' }),
      summary({ id: 'history-web-new', hostname: 'web-01', endedAt: '2026-08-16T08:02:00.000Z' }),
      summary({ id: 'history-db', hostname: 'db-01', endedAt: '2026-08-16T08:03:00.000Z' }),
    ])

    expect(history.map(record => record.id)).toEqual(['history-db', 'history-web-new'])
  })

  it('refreshes cached reconnect availability from the current history request', async () => {
    const api = createHistoryApi()
    const store = createShellHistoryStore(api)

    await store.open({ chatId: 'chat-history' })
    api.list.mockResolvedValueOnce([
      summary({ id: 'history-newest', hostname: 'web-01', endedAt: '2026-08-16T08:02:00.000Z', reconnectable: false }),
    ])
    api.get.mockImplementation(async (historyId: string) => ({
      ...summary({ id: historyId, hostname: 'web-01', endedAt: '2026-08-16T08:02:00.000Z', reconnectable: false }),
      output: 'latest safe output',
    }))

    await store.refresh()

    expect(store.state.records).toEqual([
      expect.objectContaining({ id: 'history-newest', reconnectable: false }),
    ])
    expect(store.state.selected).toEqual(expect.objectContaining({ id: 'history-newest', reconnectable: false }))
    expect(JSON.stringify(store.state)).not.toContain('credential-placeholder')
  })
})

function createHistoryApi() {
  return {
    list: vi.fn().mockResolvedValue([
      summary({ id: 'history-newest', hostname: 'web-01', endedAt: '2026-08-16T08:02:00.000Z' }),
      summary({ id: 'history-old', hostname: 'web-01', endedAt: '2026-08-16T08:01:00.000Z' }),
    ]),
    get: vi.fn().mockImplementation(async (historyId: string) => ({
      ...summary({ id: historyId, hostname: 'web-01', endedAt: '2026-08-16T08:02:00.000Z' }),
      output: 'latest safe output',
    })),
    duplicate: vi.fn().mockResolvedValue({ id: 'session-copy', hostname: 'web-01', mode: 'copilot' }),
    reconnect: vi.fn().mockResolvedValue({ id: 'session-reconnected', hostname: 'web-01', mode: 'copilot', chatId: 'chat-history' }),
  }
}

function summary(input: { id: string; hostname: string; endedAt: string; reconnectable?: boolean }) {
  return {
    id: input.id,
    chatId: 'chat-history',
    hostname: input.hostname,
    title: input.hostname,
    startedAt: '2026-08-16T08:00:00.000Z',
    endedAt: input.endedAt,
    status: 'closed' as const,
    preview: 'safe preview',
    reconnectable: input.reconnectable ?? true,
  }
}
