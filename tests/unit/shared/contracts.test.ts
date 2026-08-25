import { beforeEach, describe, expect, it, vi } from 'vitest'
import { terminalAgentNamespace } from '../../../src/preload/api'
import { agentExecutionRequestSchema, agentStartRequestSchema, candidateConfirmationRequestSchema, savedDirectSessionInputSchema, sessionModeSchema, chatAppendMessageRequestSchema, chatAssociateShellRequestSchema, chatBindSessionRequestSchema, chatChangedEventSchema, chatCloseAssociationRequestSchema, chatCreateRequestSchema, chatListSnapshotSchema, chatPinRequestSchema, chatRemoveRequestSchema, chatSetModeRequestSchema, chatShellAssociationSchema, chatSummarySchema, chatTimestampSchema, chatUnpinRequestSchema, chatUpdateTitleRequestSchema } from '../../../src/shared/contracts'

const { exposeInMainWorld } = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn()
}))

const { invoke, on, removeListener } = vi.hoisted(() => ({
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer: { invoke, on, removeListener },
}))

describe('sessionModeSchema', () => {
  it('accepts only the two explicit driving modes', () => {
    expect(sessionModeSchema.parse('copilot')).toBe('copilot')
    expect(sessionModeSchema.parse('autonomous')).toBe('autonomous')
    expect(() => sessionModeSchema.parse('agent')).toThrow()
  })
})

describe('agentExecutionRequestSchema', () => {
  it('allows an optional opaque confirmation marker but never accepts an empty command', () => {
    expect(agentExecutionRequestSchema.parse({ sessionId: 'session-a', command: 'id', confirmationId: 'marker-1' })).toEqual({
      sessionId: 'session-a', command: 'id', confirmationId: 'marker-1',
    })
    expect(() => agentExecutionRequestSchema.parse({ sessionId: 'session-a', command: '' })).toThrow()
  })
})

describe('candidateConfirmationRequestSchema', () => {
  it('accepts only an opaque session and candidate identifier', () => {
    expect(candidateConfirmationRequestSchema.parse({ sessionId: 'session-a', candidateId: 'candidate-1' })).toEqual({
      sessionId: 'session-a', candidateId: 'candidate-1',
    })
    expect(() => candidateConfirmationRequestSchema.parse({ sessionId: 'session-a', command: 'kill -9 1' })).toThrow()
  })
})

describe('agentStartRequestSchema', () => {
  it('requires a bounded opaque run identifier alongside the session and goal', () => {
    expect(agentStartRequestSchema.parse({ sessionId: 'session-a', runId: '550e8400-e29b-41d4-a716-446655440000', goal: '检查 nginx 服务' })).toEqual({
      sessionId: 'session-a', runId: '550e8400-e29b-41d4-a716-446655440000', goal: '检查 nginx 服务',
    })
    expect(() => agentStartRequestSchema.parse({ sessionId: 'session-a', goal: '检查 nginx 服务' })).toThrow()
    expect(() => agentStartRequestSchema.parse({ sessionId: 'session-a', runId: 'not-a-uuid', goal: '检查 nginx 服务' })).toThrow()
    expect(() => agentStartRequestSchema.parse({ sessionId: 'session-a', goal: '检查 nginx', terminalExcerpt: 'secret output' })).toThrow()
  })
})

describe('savedDirectSessionInputSchema', () => {
  it('accepts a direct password profile but never exposes an AccessClient launch type', () => {
    expect(savedDirectSessionInputSchema.parse({
      id: 'prod-api', name: '生产 API', host: 'api.example.com', port: 22, username: 'ops',
      auth: { kind: 'password', password: 'secret' },
    })).toMatchObject({ id: 'prod-api', auth: { kind: 'password' } })
    expect(() => savedDirectSessionInputSchema.parse({
      id: 'jump', name: '堡垒机', host: '127.0.0.1', port: 22022, username: '', protocol: 'raw',
    })).toThrow()
  })

  it('allows an edit to omit an unchanged direct-session password', () => {
    expect(savedDirectSessionInputSchema.parse({
      id: 'prod-api', name: '生产 API', host: 'api.example.com', port: 22, username: 'ops',
      auth: { kind: 'password' },
    })).toMatchObject({ id: 'prod-api', auth: { kind: 'password' } })
  })
})

describe('terminalAgent preload API', () => {
  beforeEach(() => {
    vi.resetModules()
    exposeInMainWorld.mockReset()
    invoke.mockReset()
    on.mockReset()
    removeListener.mockReset()
  })

  it('exposes named session methods without exposing the raw Electron bridge', async () => {
    await import('../../../src/preload/index')

    expect(exposeInMainWorld).toHaveBeenCalledOnce()
    expect(exposeInMainWorld).toHaveBeenCalledWith(terminalAgentNamespace, expect.anything())

    const [[namespace, api]] = exposeInMainWorld.mock.calls
    expect(namespace).toBe('terminalAgent')
    expect(Object.isFrozen(api)).toBe(true)
    expect(api).toHaveProperty('sessions')
    expect(api).not.toHaveProperty('ipcRenderer')
    expect(api).not.toHaveProperty('invoke')
    expect(api).not.toHaveProperty('require')
  })

  it('routes a session write through the named IPC channel', async () => {
    await import('../../../src/preload/index')
    const [, api] = exposeInMainWorld.mock.calls[0] as [string, { sessions: { write: (sessionId: string, data: string) => Promise<unknown> } }]

    await api.sessions.write('session-a', 'whoami\n')

    expect(invoke).toHaveBeenCalledWith('sessions:write', 'session-a', 'whoami\n')
  })

  it('selects a private key and subscribes to named session-close events without exposing Electron', async () => {
    await import('../../../src/preload/index')
    const [, api] = exposeInMainWorld.mock.calls[0] as [string, {
      sessions: {
        selectPrivateKey: () => Promise<unknown>
        onClosed: (listener: (event: { sessionId: string }) => void) => () => void
      }
    }]
    const listener = vi.fn()

    await api.sessions.selectPrivateKey()
    const unsubscribe = api.sessions.onClosed(listener)
    const registeredListener = on.mock.calls.find(([channel]) => channel === 'sessions:closed')?.[1]
    registeredListener?.({}, { sessionId: 'session-a' })
    unsubscribe()

    expect(invoke).toHaveBeenCalledWith('sessions:selectPrivateKey')
    expect(listener).toHaveBeenCalledWith({ sessionId: 'session-a' })
    expect(removeListener).toHaveBeenCalledWith('sessions:closed', registeredListener)
  })

  it('lists existing sessions and subscribes to sessions opened by AccessClient launches', async () => {
    invoke.mockResolvedValueOnce([{ id: 's1', hostname: 'bastion-target', title: '生产终端', mode: 'copilot' }])
    await import('../../../src/preload/index')
    const [, api] = exposeInMainWorld.mock.calls[0] as [string, {
      sessions: {
        list: () => Promise<unknown>
        onOpened: (listener: (session: { id: string }) => void) => () => void
      }
    }]
    const listener = vi.fn()

    await expect(api.sessions.list()).resolves.toEqual([
      { id: 's1', hostname: 'bastion-target', title: '生产终端', mode: 'copilot' },
    ])
    const unsubscribe = api.sessions.onOpened(listener)
    const registeredListener = on.mock.calls.find(([channel]) => channel === 'sessions:opened')?.[1]
    registeredListener?.({}, { id: 's2', hostname: '127.0.0.1', title: 'Raw 22022', mode: 'copilot' })
    unsubscribe()

    expect(invoke).toHaveBeenCalledWith('sessions:list')
    expect(listener).toHaveBeenCalledWith({ id: 's2', hostname: '127.0.0.1', title: 'Raw 22022', mode: 'copilot' })
    expect(removeListener).toHaveBeenCalledWith('sessions:opened', registeredListener)
  })

  it('routes direct session-book actions only through named profile IPC channels', async () => {
    await import('../../../src/preload/index')
    const [, api] = exposeInMainWorld.mock.calls[0] as [string, {
      sessions: {
        listProfiles: () => Promise<unknown>
        saveProfile: (profile: unknown) => Promise<unknown>
        openProfile: (id: string) => Promise<unknown>
        deleteProfile: (id: string) => Promise<unknown>
      }
    }]
    const profile = {
      id: 'prod-api', name: '生产 API', host: 'api.example.com', port: 22, username: 'ops',
      auth: { kind: 'password', password: 'secret' },
    }

    await api.sessions.listProfiles()
    await api.sessions.saveProfile(profile)
    await api.sessions.openProfile('prod-api')
    await api.sessions.deleteProfile('prod-api')

    expect(invoke).toHaveBeenCalledWith('sessions:profiles:list')
    expect(invoke).toHaveBeenCalledWith('sessions:profiles:save', profile)
    expect(invoke).toHaveBeenCalledWith('sessions:profiles:open', 'prod-api')
    expect(invoke).toHaveBeenCalledWith('sessions:profiles:delete', 'prod-api')
  })

  it('tests a model connection through a named settings channel without persisting it', async () => {
    await import('../../../src/preload/index')
    const [, api] = exposeInMainWorld.mock.calls[0] as [string, {
      settings: { testModel: (input: unknown) => Promise<unknown> }
    }]
    const input = { endpoint: 'https://compatible.example/v1/chat/completions', model: 'compatible-model', contextLimit: 8_000 }

    await api.settings.testModel(input)

    expect(invoke).toHaveBeenCalledWith('settings:model:test', input)
  })

  it('exposes only named AccessClient launch-error methods', async () => {
    invoke.mockResolvedValueOnce(['无法建立 AccessClient 会话。请检查启动参数、连接状态和本次凭据。'])
    await import('../../../src/preload/index')
    const [, api] = exposeInMainWorld.mock.calls[0] as [string, {
      accessClient: {
        errors: () => Promise<unknown>
        onError: (listener: (message: string) => void) => () => void
      }
    }]
    const listener = vi.fn()

    await expect(api.accessClient.errors()).resolves.toEqual(['无法建立 AccessClient 会话。请检查启动参数、连接状态和本次凭据。'])
    const unsubscribe = api.accessClient.onError(listener)
    const registeredListener = on.mock.calls.find(([channel]) => channel === 'access-client:error')?.[1]
    registeredListener?.({}, '无法建立 AccessClient 会话。请检查启动参数、连接状态和本次凭据。')
    unsubscribe()

    expect(invoke).toHaveBeenCalledWith('access-client:errors')
    expect(listener).toHaveBeenCalledWith('无法建立 AccessClient 会话。请检查启动参数、连接状态和本次凭据。')
    expect(removeListener).toHaveBeenCalledWith('access-client:error', registeredListener)
  })

  it('exposes only named bastion catalog and launch methods', async () => {
    invoke
      .mockResolvedValueOnce({ available: false, systems: [], message: '未配置堡垒机目录来源。' })
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ kind: 'opened', sessionId: 's-2' })
    await import('../../../src/preload/index')
    const [, api] = exposeInMainWorld.mock.calls[0] as [string, {
      accessClient: {
        catalog: () => Promise<unknown>
        hosts: (systemId: string) => Promise<unknown>
        launch: (request: unknown) => Promise<unknown>
      }
    }]

    await expect(api.accessClient.catalog()).resolves.toEqual({ available: false, systems: [], message: '未配置堡垒机目录来源。' })
    await expect(api.accessClient.hosts('orders')).resolves.toEqual([])
    await expect(api.accessClient.launch({ kind: 'host', target: 'web-01.example.internal' })).resolves.toEqual({ kind: 'opened', sessionId: 's-2' })

    expect(invoke).toHaveBeenNthCalledWith(1, 'access-client:bastion:catalog')
    expect(invoke).toHaveBeenNthCalledWith(2, 'access-client:bastion:hosts', 'orders')
    expect(invoke).toHaveBeenNthCalledWith(3, 'access-client:bastion:launch', { kind: 'host', target: 'web-01.example.internal' })
  })
})

describe('durable chat navigation contracts', () => {
  it.each([
    ['pin', chatPinRequestSchema],
    ['unpin', chatUnpinRequestSchema],
  ])('accepts only opaque request and chat identifiers for %s requests', (_label, schema) => {
    const request = { requestId: 'pin-1', chatId: 'chat-1' }

    expect(schema.parse(request)).toEqual(request)
    expect(() => schema.parse({ ...request, pinnedAt: '2026-08-24T02:00:00.000Z' })).toThrow()
    expect(() => schema.parse({ requestId: 'pin-1' })).toThrow()
  })

  it('requires explicit task title and pin state in every renderer summary', () => {
    expect(chatSummarySchema.parse({
      id: 'task-1',
      title: '新建任务 2026-08-24 10:00:00',
      titleState: 'new',
      pinnedAt: null,
      createdAt: '2026-08-24T02:00:00.000Z',
      updatedAt: '2026-08-24T02:00:00.000Z',
      shellCount: 0,
      mode: 'copilot',
      live: false,
    })).toMatchObject({ titleState: 'new', pinnedAt: null })
  })

  const chat = {
    id: 'chat-1', title: 'chat', createdAt: '2026-08-16T08:00:00.000Z', updatedAt: '2026-08-16T08:00:00.000Z',
    titleState: 'custom' as const, pinnedAt: null,
    shellCount: 0, mode: 'copilot' as const, live: false, messages: [], shells: [],
  }
  const chatSummary = {
    id: chat.id, title: chat.title, createdAt: chat.createdAt, updatedAt: chat.updatedAt,
    titleState: chat.titleState, pinnedAt: chat.pinnedAt,
    shellCount: chat.shellCount, mode: chat.mode, live: chat.live,
  }

  it('requires monotonic revisions on list snapshots and changed events', () => {
    expect(chatListSnapshotSchema.parse({ revision: 3, chats: [chatSummary], liveChatId: null })).toEqual({ revision: 3, chats: [chatSummary], liveChatId: null })
    expect(chatChangedEventSchema.parse({ revision: 4, kind: 'updated', chat, liveChatId: chat.id })).toEqual({ revision: 4, kind: 'updated', chat, liveChatId: chat.id })
    expect(chatChangedEventSchema.parse({ revision: 5, kind: 'removed', chatId: chat.id, liveChatId: null })).toEqual({ revision: 5, kind: 'removed', chatId: chat.id, liveChatId: null })
    expect(() => chatChangedEventSchema.parse({ revision: 4, kind: 'updated', chat })).toThrow()
    expect(() => chatChangedEventSchema.parse({ kind: 'updated', chat })).toThrow()
    expect(() => chatListSnapshotSchema.parse({ revision: -1, chats: [], liveChatId: null })).toThrow()
  })

  it('lets renderer identify only an existing session and never supply shell metadata', () => {
    expect(chatBindSessionRequestSchema.parse({ requestId: 'bind-1', chatId: 'chat-1', sessionId: 's1' })).toEqual({
      requestId: 'bind-1', chatId: 'chat-1', sessionId: 's1',
    })
    expect(() => chatBindSessionRequestSchema.parse({
      requestId: 'bind-1', chatId: 'chat-1', sessionId: 's1', hostname: 'forged',
    })).toThrow()
  })

  it('accepts an atomic fallback target while rejecting duplicate sessions and self-transfer', async () => {
    const { chatTransferSessionsRequestSchema } = await import('../../../src/shared/contracts')
    expect(chatTransferSessionsRequestSchema.parse({
      requestId: 'transfer-1', sourceChatId: 'chat-1', targetChatId: 'chat-2', sessionIds: ['s1', 's2'],
    })).toEqual({
      requestId: 'transfer-1', sourceChatId: 'chat-1', targetChatId: 'chat-2', sessionIds: ['s1', 's2'],
    })
    expect(() => chatTransferSessionsRequestSchema.parse({
      requestId: 'transfer-1', sourceChatId: 'chat-1', targetChatId: 'chat-2', sessionIds: ['s1', 's1'],
    })).toThrow()
    expect(() => chatTransferSessionsRequestSchema.parse({
      requestId: 'transfer-1', sourceChatId: 'chat-1', targetChatId: 'chat-1', sessionIds: ['s1'],
    })).toThrow()
    expect(chatTransferSessionsRequestSchema.parse({
      requestId: 'transfer-fallback', sourceChatId: 'chat-1', sessionIds: ['s1', 's2'],
    })).toEqual({
      requestId: 'transfer-fallback', sourceChatId: 'chat-1', sessionIds: ['s1', 's2'],
    })
  })

  it('strictly versions workspace responses and active-session ownership queries', async () => {
    const contracts = await import('../../../src/shared/contracts') as unknown as Record<string, {
      parse(value: unknown): unknown
    }>
    expect(contracts.chatWorkspaceSnapshotSchema.parse({ revision: 4, chat, liveChatId: chat.id })).toEqual({ revision: 4, chat, liveChatId: chat.id })
    expect(contracts.chatSessionResolutionSchema.parse({ revision: 4, sessionId: 's1', chat, liveChatId: chat.id })).toEqual({ revision: 4, sessionId: 's1', chat, liveChatId: chat.id })
    expect(contracts.chatSessionResolutionSchema.parse({ revision: 4, sessionId: 'unowned', chat: null, liveChatId: null })).toEqual({ revision: 4, sessionId: 'unowned', chat: null, liveChatId: null })
    expect(() => contracts.chatWorkspaceSnapshotSchema.parse({ revision: 4, chat })).toThrow()
    expect(() => contracts.chatResolveSessionRequestSchema.parse({ sessionId: 's1', chatId: 'forged' })).toThrow()
  })
})

describe('chatTimestampSchema', () => {
  it('accepts only real canonical four-digit UTC millisecond timestamps', () => {
    expect(chatTimestampSchema.parse('2026-08-16T08:00:00.000Z')).toBe('2026-08-16T08:00:00.000Z')
    expect(chatTimestampSchema.parse('9999-12-31T23:59:59.999Z')).toBe('9999-12-31T23:59:59.999Z')
    for (const timestamp of [
      '2026-08-16T16:00:00.000+08:00',
      '2026-08-16T08:00:00Z',
      '2026-08-16T08:00:00.00Z',
      '2026-02-30T08:00:00.000Z',
      '+010000-01-01T00:00:00.000Z',
    ]) {
      expect(() => chatTimestampSchema.parse(timestamp)).toThrow()
    }
  })
})

describe('chat contracts', () => {
  it('rejects unknown input fields and credentials in renderer chat DTOs', () => {
    expect(() => chatCreateRequestSchema.parse({ requestId: 'req-1', credential: 'secret' })).toThrow()
    expect(() => chatSetModeRequestSchema.parse({ requestId: 'req-1', chatId: 'chat-1', mode: 'copilot', reconnect: 'ssh' })).toThrow()
    expect(() => chatShellAssociationSchema.parse({
      id: 'assoc-1', chatId: 'chat-1', sessionId: 's1', historyId: 'history-1',
      hostname: 'host', title: 'shell', status: 'open', associatedAt: '2026-08-16T08:00:00.000Z',
      password: 'secret',
    })).toThrow()
  })

  it('keeps every chat write request object strict', () => {
    const requests = [
      [chatCreateRequestSchema, { requestId: 'create-1' }],
      [chatAppendMessageRequestSchema, { requestId: 'message-1', chatId: 'chat-1', role: 'user', content: 'hello', state: 'complete' }],
      [chatUpdateTitleRequestSchema, { requestId: 'title-1', chatId: 'chat-1', title: 'title' }],
      [chatSetModeRequestSchema, { requestId: 'mode-1', chatId: 'chat-1', mode: 'copilot' }],
      [chatAssociateShellRequestSchema, { requestId: 'shell-1', chatId: 'chat-1', historyId: 'history-1', hostname: 'host', title: 'shell' }],
      [chatCloseAssociationRequestSchema, { requestId: 'close-1', chatId: 'chat-1', associationId: 'association-1' }],
      [chatRemoveRequestSchema, { requestId: 'remove-1', chatId: 'chat-1' }],
    ] as const
    for (const [schema, request] of requests) {
      expect(() => schema.parse({ ...request, privateKey: 'secret', apiKey: 'secret', reconnect: { password: 'secret' } })).toThrow()
    }
  })
})
