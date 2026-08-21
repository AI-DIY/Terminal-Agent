import { describe, expect, it, vi } from 'vitest'
import { registerShellHistoryLifecycle } from '../../../src/main/shell-history/register-shell-history-lifecycle'
import { ShellHistoryService } from '../../../src/main/shell-history/shell-history-service'
import { ShellHistoryRepository } from '../../../src/main/shell-history/shell-history-repository'
import { ChatRepository } from '../../../src/main/chat/chat-repository'
import { ChatService } from '../../../src/main/chat/chat-service'
import type { ChatChangedEvent } from '../../../src/shared/contracts'
import type { ConnectedSession, TerminalClosedEvent, TerminalDataEvent } from '../../../src/main/ssh/session-service'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('Shell history lifecycle', () => {
  it('collects opened/data/closed sessions and applies a chat association added after opening', async () => {
    const events = createEventSources()
    const history = {
      attach: vi.fn(), append: vi.fn(), audit: vi.fn(), associate: vi.fn(), close: vi.fn().mockResolvedValue(undefined), reportError: vi.fn(),
    }
    const dispose = registerShellHistoryLifecycle(events.sessions, events.chats, history, {
      now: () => new Date('2026-08-16T08:02:00.000Z'),
    })

    events.historyOpened?.({ id: 'session-a', hostname: 'web-01', title: 'web-01', mode: 'copilot', connectionType: 'direct-ssh' })
    events.data?.({ sessionId: 'session-a', data: 'ready\r\n' })
    events.write?.({ sessionId: 'session-a', data: 'whoami' })
    events.write?.({ sessionId: 'session-a', data: '\r' })
    events.changed?.({
      revision: 3,
      kind: 'updated',
      liveChatId: 'chat-a',
      chat: {
        id: 'chat-a', title: '工作聊天', createdAt: '2026-08-16T08:00:00.000Z', updatedAt: '2026-08-16T08:01:00.000Z',
        shellCount: 1, mode: 'copilot', live: true, messages: [],
        shells: [{
          id: 'association-a', chatId: 'chat-a', sessionId: 'session-a', historyId: 'history-a', hostname: 'web-01', title: 'web-01',
          status: 'open', associatedAt: '2026-08-16T08:01:00.000Z',
        }],
      },
    })
    events.closed?.({ sessionId: 'session-a' })
    await vi.waitFor(() => expect(history.close).toHaveBeenCalledOnce())

    expect(history.attach).toHaveBeenCalledWith({
      sessionId: 'session-a', hostname: 'web-01', title: 'web-01', startedAt: '2026-08-16T08:02:00.000Z',
      connectionType: 'direct-ssh',
    })
    expect(history.append).toHaveBeenCalledWith({ sessionId: 'session-a', data: 'ready\r\n' })
    expect(history.audit).toHaveBeenNthCalledWith(1, { sessionId: 'session-a', data: 'whoami' })
    expect(history.audit).toHaveBeenNthCalledWith(2, { sessionId: 'session-a', data: '\r' })
    expect(history.associate).toHaveBeenCalledWith({ sessionId: 'session-a', chatId: 'chat-a', historyId: 'history-a' })
    expect(history.close).toHaveBeenCalledWith({ sessionId: 'session-a', endedAt: '2026-08-16T08:02:00.000Z' })

    dispose()
    dispose()
    expect(events.unsubscribeHistoryOpened).toHaveBeenCalledOnce()
    expect(events.unsubscribeData).toHaveBeenCalledOnce()
    expect(events.unsubscribeWrite).toHaveBeenCalledOnce()
    expect(events.unsubscribeClosed).toHaveBeenCalledOnce()
    expect(events.unsubscribeChanged).toHaveBeenCalledOnce()
  })

  it('never lets a history collector failure interrupt terminal data delivery or session closing', async () => {
    const events = createEventSources()
    const history = {
      attach: vi.fn(() => { throw new Error('collector unavailable') }),
      append: vi.fn(() => { throw new Error('password=secret') }),
      audit: vi.fn(() => { throw new Error('tmp:relative-placeholder') }),
      associate: vi.fn(() => { throw new Error('collector unavailable') }),
      close: vi.fn().mockRejectedValue(new Error('C:\\Temp\\access-client\\session.conf')),
      reportError: vi.fn(),
    }
    registerShellHistoryLifecycle(events.sessions, events.chats, history)

    expect(() => events.historyOpened?.({ id: 'session-a', hostname: 'web-01', mode: 'copilot', connectionType: 'direct-ssh' })).not.toThrow()
    expect(() => events.data?.({ sessionId: 'session-a', data: 'output' })).not.toThrow()
    expect(() => events.write?.({ sessionId: 'session-a', data: 'command' })).not.toThrow()
    expect(() => events.closed?.({ sessionId: 'session-a' })).not.toThrow()
    await vi.waitFor(() => expect(history.close).toHaveBeenCalledOnce())
  })

  it('persists a stable fallback chat/history association when a shell closes before renderer binding', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-shell-history-close-race-'))
    const path = join(directory, 'shell-history.json')
    const events = createEventSources()
    const history = new ShellHistoryService(new ShellHistoryRepository(path))
    const chats = new ChatService(new ChatRepository(join(directory, 'chat-workspaces.json')))
    try {
      registerShellHistoryLifecycle(events.sessions, chats, history, {
        now: () => new Date('2026-08-16T08:02:00.000Z'),
      })
      events.historyOpened?.({ id: 'session-race', hostname: 'web-race', title: 'web-race', mode: 'copilot', connectionType: 'direct-ssh' })
      events.data?.({ sessionId: 'session-race', data: 'safe output\r\n' })
      events.closed?.({ sessionId: 'session-race' })

      await vi.waitFor(async () => expect(await readFile(path, 'utf8')).toContain('session-race'))

      const chat = (await chats.resolveSession('session-race')).chat
      const persisted = JSON.parse(await readFile(path, 'utf8')) as { records: Array<{ id: string; chatId: string; sessionId: string }> }
      const record = persisted.records[0]
      expect(chat?.shells).toContainEqual(expect.objectContaining({ sessionId: 'session-race', chatId: record?.chatId, historyId: record?.id }))
      expect(record).toMatchObject({ sessionId: 'session-race', chatId: chat?.id })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('uses the close-event timestamp even when a fallback association resolves later', async () => {
    const events = createEventSources()
    const fallback = deferred<{ chatId: string; historyId: string }>()
    const history = {
      attach: vi.fn(), append: vi.fn(), audit: vi.fn(), associate: vi.fn(), close: vi.fn().mockResolvedValue(undefined), reportError: vi.fn(),
    }
    const chats = { ...events.chats, ensureClosedHistoryAssociation: vi.fn(() => fallback.promise) }
    let current = new Date('2026-08-16T08:00:00.000Z')
    registerShellHistoryLifecycle(events.sessions, chats, history, { now: () => current })

    events.historyOpened?.({ id: 'session-delayed-close', hostname: 'web-delayed-close', mode: 'copilot', connectionType: 'direct-ssh' })
    current = new Date('2026-08-16T08:01:00.000Z')
    events.closed?.({ sessionId: 'session-delayed-close' })
    current = new Date('2026-08-16T08:02:00.000Z')
    expect(history.close).not.toHaveBeenCalled()

    fallback.resolve({ chatId: 'chat-delayed-close', historyId: 'history-delayed-close' })
    await vi.waitFor(() => expect(history.close).toHaveBeenCalledWith({
      sessionId: 'session-delayed-close', endedAt: '2026-08-16T08:01:00.000Z',
    }))
    expect(history.associate).toHaveBeenCalledWith({ sessionId: 'session-delayed-close', chatId: 'chat-delayed-close', historyId: 'history-delayed-close' })
  })

  it('closes and reports a fixed history error when close-before-bind association fails', async () => {
    const events = createEventSources()
    const history = {
      attach: vi.fn(), append: vi.fn(), audit: vi.fn(), associate: vi.fn(), close: vi.fn().mockResolvedValue(undefined), reportError: vi.fn(),
    }
    const chats = { ...events.chats, ensureClosedHistoryAssociation: vi.fn(async () => { throw new Error('unsafe fallback failure') }) }
    registerShellHistoryLifecycle(events.sessions, chats, history, { now: () => new Date('2026-08-16T08:01:00.000Z') })

    events.historyOpened?.({ id: 'session-failed-close', hostname: 'web-failed-close', mode: 'copilot', connectionType: 'direct-ssh' })
    events.closed?.({ sessionId: 'session-failed-close' })

    await vi.waitFor(() => expect(history.close).toHaveBeenCalledWith({
      sessionId: 'session-failed-close', endedAt: '2026-08-16T08:01:00.000Z',
    }))
    expect(history.reportError).toHaveBeenCalledOnce()
  })
})

function createEventSources() {
  let historyOpened: ((session: ConnectedSession & { connectionType: 'direct-ssh' | 'access-client-ssh' | 'access-client-raw' }) => void) | undefined
  let data: ((event: TerminalDataEvent) => void) | undefined
  let write: ((event: TerminalDataEvent) => void) | undefined
  let closed: ((event: TerminalClosedEvent) => void) | undefined
  let changed: ((event: ChatChangedEvent) => void) | undefined
  const unsubscribeHistoryOpened = vi.fn()
  const unsubscribeData = vi.fn()
  const unsubscribeWrite = vi.fn()
  const unsubscribeClosed = vi.fn()
  const unsubscribeChanged = vi.fn()
  return {
    sessions: {
      onHistoryOpened: vi.fn((listener: (session: ConnectedSession & { connectionType: 'direct-ssh' | 'access-client-ssh' | 'access-client-raw' }) => void) => { historyOpened = listener; return unsubscribeHistoryOpened }),
      onData: vi.fn((listener: (event: TerminalDataEvent) => void) => { data = listener; return unsubscribeData }),
      onWrite: vi.fn((listener: (event: TerminalDataEvent) => void) => { write = listener; return unsubscribeWrite }),
      onClosed: vi.fn((listener: (event: TerminalClosedEvent) => void) => { closed = listener; return unsubscribeClosed }),
    },
    chats: {
      onChanged: vi.fn((listener: (event: ChatChangedEvent) => void) => { changed = listener; return unsubscribeChanged }),
    },
    get historyOpened() { return historyOpened },
    get data() { return data },
    get write() { return write },
    get closed() { return closed },
    get changed() { return changed },
    unsubscribeHistoryOpened,
    unsubscribeData,
    unsubscribeWrite,
    unsubscribeClosed,
    unsubscribeChanged,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(currentResolve => { resolve = currentResolve })
  return { promise, resolve }
}
