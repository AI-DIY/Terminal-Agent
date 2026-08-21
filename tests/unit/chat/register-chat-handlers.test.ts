import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerChatHandlers } from '../../../src/main/chat/register-chat-handlers'
import { ChatService } from '../../../src/main/chat/chat-service'
import type { ChatRepository } from '../../../src/main/chat/chat-repository'
import { ChatRuntime } from '../../../src/main/chat/chat-runtime'

const { handle, removeHandler } = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle, removeHandler } }))

describe('registerChatHandlers', () => {
  beforeEach(() => { handle.mockReset(); removeHandler.mockReset() })

  it('rejects every untrusted channel before reading payloads or calling the service', async () => {
    const service = { list: vi.fn(), create: vi.fn(), get: vi.fn(), resolveSession: vi.fn(), setMode: vi.fn(), remove: vi.fn(), associateSession: vi.fn(), transferSessions: vi.fn(), closeSession: vi.fn(), reconcileSessions: vi.fn(), onChanged: vi.fn(() => () => undefined) }
    const sessions = { snapshot: vi.fn(), onClosed: vi.fn(() => () => undefined) }
    const trusted = { send: vi.fn() }
    const dispose = registerChatHandlers(service as never, trusted as never, sessions as never)
    const foreignEvent = { sender: {} }
    const unreadablePayload = new Proxy({}, {
      get: () => { throw new Error('payload was parsed') },
      ownKeys: () => { throw new Error('payload was parsed') },
      getOwnPropertyDescriptor: () => { throw new Error('payload was parsed') },
    })

    await expect(handlerFor('chats:list')(foreignEvent)).rejects.toThrow('Untrusted renderer')
    expect(() => handlerFor('chats:create')(foreignEvent, unreadablePayload)).toThrow('Untrusted renderer')
    expect(() => handlerFor('chats:get')(foreignEvent, unreadablePayload)).toThrow('Untrusted renderer')
    expect(() => handlerFor('chats:resolve-session')(foreignEvent, unreadablePayload)).toThrow('Untrusted renderer')
    expect(() => handlerFor('chats:set-mode')(foreignEvent, unreadablePayload)).toThrow('Untrusted renderer')
    await expect(handlerFor('chats:remove')(foreignEvent, unreadablePayload)).rejects.toThrow('Untrusted renderer')
    await expect(handlerFor('chats:bind-session')(foreignEvent, unreadablePayload)).rejects.toThrow('Untrusted renderer')
    await expect(handlerFor('chats:transfer-sessions')(foreignEvent, unreadablePayload)).rejects.toThrow('Untrusted renderer')

    expect(service.list).not.toHaveBeenCalled()
    expect(service.create).not.toHaveBeenCalled()
    expect(service.get).not.toHaveBeenCalled()
    expect(service.resolveSession).not.toHaveBeenCalled()
    expect(service.setMode).not.toHaveBeenCalled()
    expect(service.remove).not.toHaveBeenCalled()
    expect(service.associateSession).not.toHaveBeenCalled()
    expect(service.transferSessions).not.toHaveBeenCalled()
    expect(service.reconcileSessions).not.toHaveBeenCalled()
    dispose()
  })

  it('strictly parses trusted requests and disposes every handler and event subscription once', async () => {
    const unsubscribe = vi.fn()
    let changed: ((event: { revision: number; kind: 'removed'; chatId: string }) => void) | undefined
    const service = {
      list: vi.fn(), create: vi.fn(), get: vi.fn(), resolveSession: vi.fn(), setMode: vi.fn(), remove: vi.fn(), associateSession: vi.fn(), transferSessions: vi.fn(), closeSession: vi.fn(async () => undefined), reconcileSessions: vi.fn(),
      onChanged: vi.fn((listener: (event: { revision: number; kind: 'removed'; chatId: string }) => void) => {
        changed = listener
        return unsubscribe
      }),
    }
    const unsubscribeClosed = vi.fn()
    let closed: ((event: { sessionId: string }) => void) | undefined
    const sessions = {
      snapshot: vi.fn(() => [{ id: 's1', hostname: 'real-host', observedHostname: 'observed-host', mode: 'copilot' }]),
      onClosed: vi.fn((listener: (event: { sessionId: string }) => void) => { closed = listener; return unsubscribeClosed }),
    }
    const trusted = { send: vi.fn() }
    const dispose = registerChatHandlers(service as never, trusted as never, sessions as never)
    const setMode = handle.mock.calls.find(([channel]) => channel === 'chats:set-mode')?.[1] as (event: { sender: unknown }, request: unknown) => unknown

    expect(() => setMode({ sender: trusted }, {
      requestId: 'mode-1', chatId: 'chat-1', mode: 'copilot', password: 'secret',
    })).toThrow()
    expect(service.setMode).not.toHaveBeenCalled()
    expect(changed).toBeDefined()
    changed?.({ revision: 2, chatId: 'chat-1', kind: 'removed' })
    expect(trusted.send).toHaveBeenCalledWith('chats:changed', { revision: 2, chatId: 'chat-1', kind: 'removed' })

    const bind = handlerFor('chats:bind-session')
    const resolveSession = handlerFor('chats:resolve-session')
    await resolveSession({ sender: trusted }, { sessionId: 's1' })
    expect(service.resolveSession).toHaveBeenCalledWith('s1')
    expect(() => resolveSession({ sender: trusted }, { sessionId: 's1', chatId: 'injected' })).toThrow()
    await expect(bind({ sender: trusted }, { requestId: 'bind-1', chatId: 'chat-1', sessionId: 'missing' })).rejects.toThrow('Unknown terminal session')
    await bind({ sender: trusted }, { requestId: 'bind-1', chatId: 'chat-1', sessionId: 's1' })
    expect(service.associateSession).toHaveBeenCalledWith(
      { requestId: 'bind-1', chatId: 'chat-1', sessionId: 's1' },
      { id: 's1', hostname: 'real-host', observedHostname: 'observed-host', mode: 'copilot' },
    )
    const transfer = handlerFor('chats:transfer-sessions')
    await transfer({ sender: trusted }, { requestId: 'transfer-1', sourceChatId: 'chat-1', targetChatId: 'chat-2', sessionIds: ['s1'] })
    expect(service.transferSessions).toHaveBeenCalledWith(
      { requestId: 'transfer-1', sourceChatId: 'chat-1', targetChatId: 'chat-2', sessionIds: ['s1'] },
      [{ id: 's1', hostname: 'real-host', observedHostname: 'observed-host', mode: 'copilot' }],
    )
    closed?.({ sessionId: 's1' })
    expect(service.closeSession).toHaveBeenCalledWith('s1')

    dispose()
    dispose()
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(unsubscribeClosed).toHaveBeenCalledOnce()
    for (const channel of ['chats:list', 'chats:create', 'chats:get', 'chats:resolve-session', 'chats:set-mode', 'chats:remove', 'chats:bind-session', 'chats:transfer-sessions']) {
      expect(removeHandler).toHaveBeenCalledWith(channel)
    }
    expect(removeHandler).toHaveBeenCalledTimes(8)
  })

  it('cancels an active runtime request before deleting its chat', async () => {
    const service = {
      list: vi.fn(), create: vi.fn(), get: vi.fn(), resolveSession: vi.fn(), setMode: vi.fn(), remove: vi.fn(async () => undefined),
      associateSession: vi.fn(), transferSessions: vi.fn(), closeSession: vi.fn(), reconcileSessions: vi.fn(), onChanged: vi.fn(() => () => undefined),
    }
    const runtime = { cancel: vi.fn(async () => undefined) }
    const sessions = { snapshot: vi.fn(() => []), onClosed: vi.fn(() => () => undefined) }
    const trusted = { send: vi.fn(), isDestroyed: vi.fn(() => false) }
    const dispose = registerChatHandlers(service as never, trusted as never, sessions as never, runtime as never)

    await handlerFor('chats:remove')({ sender: trusted }, { requestId: 'remove-active-chat', chatId: 'chat-active' })

    expect(runtime.cancel).toHaveBeenCalledWith('chat-active')
    expect(service.remove).toHaveBeenCalledWith({ requestId: 'remove-active-chat', chatId: 'chat-active' })
    expect(runtime.cancel.mock.invocationCallOrder[0]).toBeLessThan(service.remove.mock.invocationCallOrder[0]!)
    dispose()
  })

  it('removes a chat after cancelling a provider that never resolves', async () => {
    const service = {
      list: vi.fn(), create: vi.fn(), get: vi.fn(), resolveSession: vi.fn(), setMode: vi.fn(), remove: vi.fn(async () => undefined),
      associateSession: vi.fn(), transferSessions: vi.fn(), closeSession: vi.fn(), reconcileSessions: vi.fn(), onChanged: vi.fn(() => () => undefined),
    }
    let streamStarted!: () => void
    const started = new Promise<void>(resolve => { streamStarted = resolve })
    const runtime = new ChatRuntime({
      appendMessage: vi.fn(async (request: { requestId: string }) => ({ messageId: request.requestId })),
      updateMessage: vi.fn(async () => undefined),
      getContext: vi.fn(async () => [{ role: 'user' as const, content: 'hello' }]),
      resolveModel: vi.fn(async () => ({ endpoint: 'http://model', model: 'm', contextLimit: 100, apiKey: null })),
      stream: vi.fn(async () => { streamStarted(); await new Promise<void>(() => undefined) }),
    })
    const sessions = { snapshot: vi.fn(() => []), onClosed: vi.fn(() => () => undefined) }
    const trusted = { send: vi.fn(), isDestroyed: vi.fn(() => false) }
    const dispose = registerChatHandlers(service as never, trusted as never, sessions as never, runtime)

    const sending = handlerFor('chat:send')(
      { sender: trusted },
      { chatId: 'chat-active', runId: '31313131-3131-4131-8131-313131313131', content: 'check' },
    ) as Promise<void>
    await started
    await expect(settlesWithin(handlerFor('chats:remove')(
      { sender: trusted },
      { requestId: 'remove-active-chat', chatId: 'chat-active' },
    ) as Promise<void>)).resolves.toBeUndefined()
    await expect(settlesWithin(sending)).resolves.toBeUndefined()

    expect(service.remove).toHaveBeenCalledWith({ requestId: 'remove-active-chat', chatId: 'chat-active' })
    dispose()
  })

  it('awaits a direct chat cancel IPC request until the runtime cancellation is durable', async () => {
    const service = {
      list: vi.fn(), create: vi.fn(), get: vi.fn(), resolveSession: vi.fn(), setMode: vi.fn(), remove: vi.fn(),
      associateSession: vi.fn(), transferSessions: vi.fn(), closeSession: vi.fn(), reconcileSessions: vi.fn(), onChanged: vi.fn(() => () => undefined),
    }
    const cancellation = deferred<void>()
    const runtime = { cancel: vi.fn(() => cancellation.promise) }
    const sessions = { snapshot: vi.fn(() => []), onClosed: vi.fn(() => () => undefined) }
    const trusted = { send: vi.fn(), isDestroyed: vi.fn(() => false) }
    const dispose = registerChatHandlers(service as never, trusted as never, sessions as never, runtime as never)

    const cancelling = Promise.resolve(handlerFor('chat:cancel')({ sender: trusted }, 'chat-cancel') as Promise<void>)
    let settled = false
    void cancelling.then(() => { settled = true })
    await Promise.resolve()

    expect(runtime.cancel).toHaveBeenCalledWith('chat-cancel')
    expect(settled).toBe(false)
    cancellation.resolve()
    await expect(cancelling).resolves.toBeUndefined()
    dispose()
  })

  it('rejects a malformed chat runtime event before sending it over IPC', async () => {
    const service = {
      list: vi.fn(), create: vi.fn(), get: vi.fn(), resolveSession: vi.fn(), setMode: vi.fn(), remove: vi.fn(),
      associateSession: vi.fn(), transferSessions: vi.fn(), closeSession: vi.fn(), reconcileSessions: vi.fn(), onChanged: vi.fn(() => () => undefined),
    }
    const runtime = {
      send: vi.fn(async (_request: unknown, publish: (event: unknown) => void) => publish({
        kind: 'chat:error', chatId: 'chat-1', runId: '30303030-3030-4030-8030-303030303030', error: 'unsafe', retryable: true,
      })),
      cancel: vi.fn(async () => undefined),
    }
    const sessions = { snapshot: vi.fn(() => []), onClosed: vi.fn(() => () => undefined) }
    const trusted = { send: vi.fn(), isDestroyed: vi.fn(() => false) }
    const dispose = registerChatHandlers(service as never, trusted as never, sessions as never, runtime as never)

    await expect(handlerFor('chat:send')(
      { sender: trusted },
      { chatId: 'chat-1', runId: '30303030-3030-4030-8030-303030303030', content: 'check' },
    )).rejects.toThrow()

    expect(trusted.send).not.toHaveBeenCalledWith('chat:event', expect.anything())
    dispose()
  })

  it('reconciles a list request against sessions that became active while owner lookup was pending', async () => {
    const ownerLookup = deferred<string[]>()
    const repository = {
      listSnapshot: vi.fn().mockResolvedValue({ chats: [], liveChatId: null }),
      openSessionIds: vi.fn(() => ownerLookup.promise),
      closeSession: vi.fn(),
    }
    const service = new ChatService(repository as unknown as ChatRepository)
    let activeSessions: Array<{ id: string; hostname: string; mode: 'copilot' }> = []
    const sessions = {
      snapshot: vi.fn(() => [...activeSessions]),
      onClosed: vi.fn(() => () => undefined),
    }
    const trusted = { send: vi.fn() }
    const dispose = registerChatHandlers(service, trusted as never, sessions as never)

    const listing = handlerFor('chats:list')({ sender: trusted }) as Promise<unknown>
    await vi.waitFor(() => expect(repository.openSessionIds).toHaveBeenCalledOnce())
    activeSessions = [{ id: 'session-new', hostname: 'host-new', mode: 'copilot' }]
    ownerLookup.resolve(['session-new'])

    await expect(listing).resolves.toEqual({ revision: 0, chats: [], liveChatId: null })
    expect(repository.closeSession).not.toHaveBeenCalled()
    dispose()
  })

  it('closes transferred ownership when the session disappears before transfer commits', async () => {
    const transferPending = deferred<{ revision: number; chat: { id: string } }>()
    const service = {
      list: vi.fn(), create: vi.fn(), get: vi.fn(), resolveSession: vi.fn(), setMode: vi.fn(), remove: vi.fn(),
      associateSession: vi.fn(), transferSessions: vi.fn(() => transferPending.promise), closeSession: vi.fn(), reconcileSessions: vi.fn(),
      onChanged: vi.fn(() => () => undefined),
    }
    let activeSessions = [{ id: 's1', hostname: 'host', mode: 'copilot' as const }]
    const sessions = {
      snapshot: vi.fn(() => [...activeSessions]),
      onClosed: vi.fn(() => () => undefined),
    }
    const trusted = { send: vi.fn() }
    const dispose = registerChatHandlers(service as never, trusted as never, sessions as never)

    const transferring = handlerFor('chats:transfer-sessions')(
      { sender: trusted },
      { requestId: 'transfer-1', sourceChatId: 'chat-a', targetChatId: 'chat-b', sessionIds: ['s1'] },
    ) as Promise<unknown>
    await vi.waitFor(() => expect(service.transferSessions).toHaveBeenCalledOnce())
    activeSessions = []
    transferPending.resolve({ revision: 1, chat: { id: 'chat-b' } })

    await expect(transferring).resolves.toEqual({ revision: 1, chat: { id: 'chat-b' } })
    expect(service.closeSession).toHaveBeenCalledWith('s1')
    dispose()
  })

  it('closes bound ownership when the session disappears before bind commits', async () => {
    const bindPending = deferred<{ revision: number; chat: { id: string } }>()
    const service = {
      list: vi.fn(), create: vi.fn(), get: vi.fn(), resolveSession: vi.fn(), setMode: vi.fn(), remove: vi.fn(),
      associateSession: vi.fn(() => bindPending.promise), transferSessions: vi.fn(), closeSession: vi.fn(async () => undefined), reconcileSessions: vi.fn(),
      onChanged: vi.fn(() => () => undefined),
    }
    let activeSessions = [{ id: 's1', hostname: 'host', mode: 'copilot' as const }]
    const sessions = {
      snapshot: vi.fn(() => [...activeSessions]),
      onClosed: vi.fn(() => () => undefined),
    }
    const trusted = { send: vi.fn() }
    const dispose = registerChatHandlers(service as never, trusted as never, sessions as never)

    const binding = handlerFor('chats:bind-session')(
      { sender: trusted },
      { requestId: 'bind-1', chatId: 'chat-a', sessionId: 's1' },
    ) as Promise<unknown>
    await vi.waitFor(() => expect(service.associateSession).toHaveBeenCalledOnce())
    activeSessions = []
    bindPending.resolve({ revision: 1, chat: { id: 'chat-a' } })

    await expect(binding).resolves.toEqual({ revision: 1, chat: { id: 'chat-a' } })
    expect(service.closeSession).toHaveBeenCalledWith('s1')
    dispose()
  })

  it('reports an asynchronous association-close failure from a session event', async () => {
    const closeError = new Error('disk unavailable')
    const service = {
      list: vi.fn(), create: vi.fn(), get: vi.fn(), resolveSession: vi.fn(), setMode: vi.fn(), remove: vi.fn(),
      associateSession: vi.fn(), transferSessions: vi.fn(), closeSession: vi.fn(async () => { throw closeError }), reconcileSessions: vi.fn(),
      onChanged: vi.fn(() => () => undefined),
    }
    let closed: ((event: { sessionId: string }) => void) | undefined
    const sessions = {
      snapshot: vi.fn(() => []),
      onClosed: vi.fn((listener: (event: { sessionId: string }) => void) => { closed = listener; return () => undefined }),
    }
    const trusted = { send: vi.fn() }
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const dispose = registerChatHandlers(service as never, trusted as never, sessions as never)

    closed?.({ sessionId: 's1' })

    await vi.waitFor(() => expect(error).toHaveBeenCalledWith('Failed to close chat session association', closeError))
    error.mockRestore()
    dispose()
  })
})

function handlerFor(channel: string): (...args: unknown[]) => unknown {
  const registered = handle.mock.calls.find(([registeredChannel]) => registeredChannel === channel)?.[1]
  if (!registered) throw new Error(`Missing handler: ${channel}`)
  return registered as (...args: unknown[]) => unknown
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}

async function settlesWithin<T>(promise: Promise<T>, timeoutMs = 100): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('operation did not settle')), timeoutMs) }),
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}
