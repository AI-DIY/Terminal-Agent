import { describe, expect, it, vi } from 'vitest'
import { createTerminalAgentApi } from '../../../src/preload/api'
import type { ShellHistoryDetail } from '../../../src/shared/contracts'

const ssoConfiguration = {
  enabled: true,
  loginPageUrl: 'https://login.example.test',
  platformUrlMatcher: { mode: 'exact' as const, value: 'https://platform.example.test' },
  userInfoUrlMatcher: { mode: 'regex' as const, value: '^https://platform\\.example\\.test/api/me$' },
  employeeIdField: 'employee.id',
  nameField: 'profile.name',
}

const authenticatedSsoState = {
  state: 'authenticated' as const,
  identity: { employeeId: 'E-42', name: 'Ada Lovelace' },
}

function createIpc() {
  return { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }
}

describe('SSO preload API', () => {
  it('exposes only a frozen SSO namespace and validates save input before IPC', async () => {
    const ipc = createIpc()
    ipc.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'sso:state:get') return authenticatedSsoState
      return ssoConfiguration
    })
    const api = createTerminalAgentApi(ipc)

    expect(Object.isFrozen(api.sso)).toBe(true)
    expect(Object.keys(api.sso)).toEqual(['getConfig', 'saveConfig', 'getState', 'retry', 'onState'])
    await expect(api.sso.saveConfig({
      enabled: true,
      loginPageUrl: '',
      platformUrlMatcher: { mode: 'invalid', value: '' },
      userInfoUrlMatcher: { mode: 'exact', value: '' },
      employeeIdField: '',
      nameField: '',
    } as never)).rejects.toThrow()
    expect(ipc.invoke).not.toHaveBeenCalled()

    await expect(api.sso.getConfig()).resolves.toEqual(ssoConfiguration)
    await expect(api.sso.saveConfig(ssoConfiguration, 'continue')).resolves.toEqual(ssoConfiguration)
    await expect(api.sso.saveConfig(ssoConfiguration, 'invalid' as never)).rejects.toThrow()
    await expect(api.sso.getState()).resolves.toEqual(authenticatedSsoState)
    await api.sso.retry()

    expect(ipc.invoke).toHaveBeenNthCalledWith(1, 'sso:config:get')
    expect(ipc.invoke).toHaveBeenNthCalledWith(2, 'sso:config:save', ssoConfiguration, 'continue')
    expect(ipc.invoke).toHaveBeenNthCalledWith(3, 'sso:state:get')
    expect(ipc.invoke).toHaveBeenNthCalledWith(4, 'sso:retry')
  })

  it('validates SSO IPC responses and event payloads before exposing them', async () => {
    const ipc = createIpc()
    ipc.invoke.mockResolvedValue({ state: 'authenticated', unexpected: true })
    const api = createTerminalAgentApi(ipc)

    await expect(api.sso.getConfig()).rejects.toThrow()
    await expect(api.sso.getState()).rejects.toThrow()
    const listener = vi.fn()
    const unsubscribe = api.sso.onState(listener)
    const wrapper = ipc.on.mock.calls.find(([channel]) => channel === 'sso:state')?.[1]

    wrapper?.({}, authenticatedSsoState)
    expect(listener).toHaveBeenCalledWith(authenticatedSsoState)
    expect(() => wrapper?.({}, { state: 'authenticated', identity: { employeeId: '', name: 'Ada' } })).toThrow()
    unsubscribe()

    expect(ipc.removeListener).toHaveBeenCalledWith('sso:state', wrapper)
  })
})

describe('chat preload API', () => {
  it('freezes the chat domain and routes only named chat operations', async () => {
    const ipc = createIpc()
    const api = createTerminalAgentApi(ipc)
    const create = { requestId: 'create-1', title: 'chat' }
    const mode = { requestId: 'mode-1', chatId: 'chat-1', mode: 'autonomous' as const }
    const remove = { requestId: 'remove-1', chatId: 'chat-1' }
    const rename = { requestId: 'rename-1', chatId: 'chat-1', title: '任务名称' }
    const pin = { requestId: 'pin-1', chatId: 'chat-1' }
    const bind = { requestId: 'bind-1', chatId: 'chat-1', sessionId: 's1' }
    const transfer = { requestId: 'transfer-1', sourceChatId: 'chat-1', targetChatId: 'chat-2', sessionIds: ['s1', 's2'] }
    const createConversation = { requestId: 'conversation-create-1', chatId: 'chat-1' }
    const switchConversation = { requestId: 'conversation-switch-1', chatId: 'chat-1', targetSessionId: 'conversation-1' }

    expect(Object.isFrozen(api)).toBe(true)
    expect(Object.isFrozen(api.chats)).toBe(true)
    await api.chats.list()
    await api.chats.create(create)
    await api.chats.get('chat-1')
    await api.chats.listConversationSessions('chat-1')
    await api.chats.createConversationSession(createConversation)
    await api.chats.switchConversationSession(switchConversation)
    await api.chats.resolveSession({ sessionId: 's1' })
    await api.chats.setMode(mode)
    await api.chats.remove(remove)
    await api.chats.updateTitle(rename)
    await api.chats.pin(pin)
    await api.chats.unpin(pin)
    await api.chats.bindSession(bind)
    await api.chats.transferSessions(transfer)

    expect(ipc.invoke).toHaveBeenNthCalledWith(1, 'chats:list')
    expect(ipc.invoke).toHaveBeenNthCalledWith(2, 'chats:create', create)
    expect(ipc.invoke).toHaveBeenNthCalledWith(3, 'chats:get', 'chat-1')
    expect(ipc.invoke).toHaveBeenNthCalledWith(4, 'chats:conversation-sessions:list', 'chat-1')
    expect(ipc.invoke).toHaveBeenNthCalledWith(5, 'chats:conversation-sessions:create', createConversation)
    expect(ipc.invoke).toHaveBeenNthCalledWith(6, 'chats:conversation-sessions:switch', switchConversation)
    expect(ipc.invoke).toHaveBeenNthCalledWith(7, 'chats:resolve-session', { sessionId: 's1' })
    expect(ipc.invoke).toHaveBeenNthCalledWith(8, 'chats:set-mode', mode)
    expect(ipc.invoke).toHaveBeenNthCalledWith(9, 'chats:remove', remove)
    expect(ipc.invoke).toHaveBeenNthCalledWith(10, 'chats:update-title', rename)
    expect(ipc.invoke).toHaveBeenNthCalledWith(11, 'chats:pin', pin)
    expect(ipc.invoke).toHaveBeenNthCalledWith(12, 'chats:unpin', pin)
    expect(ipc.invoke).toHaveBeenNthCalledWith(13, 'chats:bind-session', bind)
    expect(ipc.invoke).toHaveBeenNthCalledWith(14, 'chats:transfer-sessions', transfer)
  })

  it('unsubscribes the exact listener wrapper registered for chat changes', () => {
    const ipc = createIpc()
    const api = createTerminalAgentApi(ipc)
    const listener = vi.fn()
    const unsubscribe = api.chats.onChanged(listener)
    const wrapper = ipc.on.mock.calls.find(([channel]) => channel === 'chats:changed')?.[1]

    const event = { revision: 2, kind: 'removed' as const, chatId: 'chat-1' }
    wrapper?.({}, event)
    unsubscribe()

    expect(listener).toHaveBeenCalledWith(event)
    expect(ipc.removeListener).toHaveBeenCalledWith('chats:changed', wrapper)
  })

  it('validates chat runtime events before exposing them to the renderer', () => {
    const ipc = createIpc()
    const api = createTerminalAgentApi(ipc)
    const listener = vi.fn()
    api.chat.onEvent(listener)
    const wrapper = ipc.on.mock.calls.find(([channel]) => channel === 'chat:event')?.[1]

    const valid = { kind: 'chat:delta', chatId: 'chat-1', runId: '30303030-3030-4030-8030-303030303030', messageId: 'message-1', content: 'safe' }
    wrapper?.({}, valid)
    expect(listener).toHaveBeenCalledWith(valid)
    expect(() => wrapper?.({}, { ...valid, runId: 'not-a-uuid' })).toThrow()
    const validError = { kind: 'chat:error', chatId: 'chat-1', runId: '30303030-3030-4030-8030-303030303030', messageId: 'message-1', error: 'safe error', retryable: true }
    wrapper?.({}, validError)
    expect(listener).toHaveBeenCalledWith(validError)
    expect(() => wrapper?.({}, { ...validError, messageId: undefined })).toThrow()
    expect(listener).toHaveBeenCalledTimes(2)
  })
})

describe('diagnostics preload API', () => {
  it('routes only fixed zero-argument diagnostic commands and validates public errors', async () => {
    const ipc = createIpc()
    const api = createTerminalAgentApi(ipc)
    const listener = vi.fn()

    expect(Object.isFrozen(api.diagnostics)).toBe(true)
    await api.diagnostics.openRendererDevTools()
    await api.diagnostics.openNodeInspector()
    const unsubscribe = api.diagnostics.onError(listener)
    const wrapper = ipc.on.mock.calls.find(([channel]) => channel === 'diagnostics:error')?.[1]
    wrapper?.({}, '无法打开诊断窗口。请关闭后重试。')
    unsubscribe()

    expect(ipc.invoke).toHaveBeenNthCalledWith(1, 'diagnostics:open-renderer-devtools')
    expect(ipc.invoke).toHaveBeenNthCalledWith(2, 'diagnostics:open-node-inspector')
    expect(listener).toHaveBeenCalledWith('无法打开诊断窗口。请关闭后重试。')
    expect(ipc.removeListener).toHaveBeenCalledWith('diagnostics:error', wrapper)
    expect(Object.keys(api.diagnostics)).not.toContain('open')
    expect(() => wrapper?.({}, '')).toThrow()
  })

  it('writes opt-in IPC timing records without logging invocation payloads', async () => {
    const ipc = createIpc()
    ipc.invoke.mockResolvedValue([])
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    try {
      const api = createTerminalAgentApi(ipc)
      expect(api.diagnostics.isIpcTracingEnabled()).toBe(false)
      api.diagnostics.setIpcTracing(true)
      await api.chats.list()

      expect(api.diagnostics.isIpcTracingEnabled()).toBe(true)
      expect(info).toHaveBeenCalledWith(expect.stringContaining('[TA IPC] tracing enabled'))
      expect(debug).toHaveBeenCalledWith(expect.stringMatching(/^\[TA IPC #\d+\] -> chats:list$/))
      expect(debug).toHaveBeenCalledWith(expect.stringMatching(/^\[TA IPC #\d+\] <- chats:list ok \d+ms$/))
      expect(debug.mock.calls.flat().join(' ')).not.toContain('undefined')
      expect(debug.mock.calls.flat().join(' ')).not.toContain('payload')
    } finally {
      debug.mockRestore()
      info.mockRestore()
    }
  })
})

describe('Shell history preload API', () => {
  it('freezes the Shell history domain and routes list/get plus ID-only duplicate and reconnect operations', async () => {
    const ipc = createIpc()
    const api = createTerminalAgentApi(ipc)

    expect(Object.isFrozen(api.shellHistory)).toBe(true)
    const typedGet: (historyId: string) => Promise<ShellHistoryDetail> = api.shellHistory.get
    expect(typedGet).toBe(api.shellHistory.get)
    await api.shellHistory.list({ chatId: 'chat-a', hostname: 'web-01' })
    await api.shellHistory.get('history-a')
    await api.shellHistory.duplicate('session-live')
    await api.shellHistory.reconnect('history-a')

    expect(ipc.invoke).toHaveBeenNthCalledWith(1, 'shell-history:list', { chatId: 'chat-a', hostname: 'web-01' })
    expect(ipc.invoke).toHaveBeenNthCalledWith(2, 'shell-history:get', 'history-a')
    expect(ipc.invoke).toHaveBeenNthCalledWith(3, 'shell-history:duplicate', 'session-live')
    expect(ipc.invoke).toHaveBeenNthCalledWith(4, 'shell-history:reconnect', 'history-a')
  })

  it('unsubscribes the exact Shell history change listener wrapper', () => {
    const ipc = createIpc()
    const api = createTerminalAgentApi(ipc)
    const listener = vi.fn()
    const unsubscribe = api.shellHistory.onChanged(listener)
    const wrapper = ipc.on.mock.calls.find(([channel]) => channel === 'shell-history:changed')?.[1]
    const event = { kind: 'error' as const, message: 'Shell 历史保存失败，实时连接未受影响。' }

    wrapper?.({}, event)
    unsubscribe()

    expect(listener).toHaveBeenCalledWith(event)
    expect(ipc.removeListener).toHaveBeenCalledWith('shell-history:changed', wrapper)
  })
})

describe('legacy model preload API', () => {
  it('rejects plaintext API keys before invoking legacy model IPC', () => {
    const ipc = createIpc()
    const api = createTerminalAgentApi(ipc)
    const unsafeInput = {
      endpoint: 'https://api.openai.com/v1/chat/completions',
      model: 'gpt-5',
      contextLimit: 8_000,
      apiKey: 'legacy-secret',
    }

    expect(() => api.settings.saveModel(unsafeInput as never)).toThrow()
    expect(() => api.settings.testModel(unsafeInput as never)).toThrow()
    expect(ipc.invoke).not.toHaveBeenCalled()
  })
})

describe('model profile preload API', () => {
  const profileInput = {
    name: 'Primary', kind: 'llm' as const, provider: 'openai' as const, model: 'gpt-5',
    endpoint: 'https://api.openai.com/v1/chat/completions', contextLimit: 8_000,
  }
  const profileResponse = {
    id: 'llm-1', name: 'Primary', kind: 'llm' as const, provider: 'openai' as const, model: 'gpt-5',
    endpoint: 'https://api.openai.com/v1/chat/completions', contextLimit: 8_000, hasApiKey: true, active: true,
  }

  it('parses temporary API keys before sending profile save and test requests', async () => {
    const ipc = createIpc()
    ipc.invoke.mockResolvedValue(profileResponse)
    const api = createTerminalAgentApi(ipc)

    await api.settings.models.save({ ...profileInput, apiKey: '  direct-key  ' })
    await api.settings.models.test({ ...profileInput, apiKey: '  direct-key  ' })

    expect(ipc.invoke).toHaveBeenNthCalledWith(1, 'settings:models:save', { ...profileInput, apiKey: 'direct-key' })
    expect(ipc.invoke).toHaveBeenNthCalledWith(2, 'settings:models:test', { ...profileInput, apiKey: 'direct-key' })
  })

  it('does not expose an unexpected API key included in a profile test response', async () => {
    const ipc = createIpc()
    ipc.invoke.mockResolvedValue({ model: 'gpt-5', apiKey: 'response-secret' })
    const api = createTerminalAgentApi(ipc)

    await expect(api.settings.models.test({ ...profileInput, apiKey: 'request-secret' })).resolves.toEqual({ model: 'gpt-5' })
  })

  it('projects every profile response to public fields without mutating raw IPC data', async () => {
    const ipc = createIpc()
    const obsoleteReferenceField = ['apiKey', 'ProfileId'].join('')
    const rawProfile = {
      id: 'llm-1', name: 'Primary', kind: 'llm', provider: 'openai', model: 'gpt-5',
      endpoint: 'https://api.openai.com/v1/chat/completions', contextLimit: 8_000,
      hasApiKey: true, active: true, apiKey: 'response-secret', [obsoleteReferenceField]: 'legacy-llm', unexpected: 'discard-me',
    }
    ipc.invoke.mockImplementation(async (channel: string) => channel === 'settings:models:list' ? [rawProfile] : rawProfile)
    const api = createTerminalAgentApi(ipc)

    const list = await api.settings.models.list('llm')
    const found = await api.settings.models.get('llm-1')
    const saved = await api.settings.models.save({ ...profileInput, apiKey: 'request-secret' })
    const activated = await api.settings.models.activate('llm-1')
    const cleared = await api.settings.models.clearApiKey('llm-1')

    const expected = {
      id: 'llm-1', name: 'Primary', kind: 'llm', provider: 'openai', model: 'gpt-5',
      endpoint: 'https://api.openai.com/v1/chat/completions', contextLimit: 8_000, hasApiKey: true, active: true,
    }
    expect(list).toEqual([expected])
    expect(found).toEqual(expected)
    expect(saved).toEqual(expected)
    expect(activated).toEqual(expected)
    expect(cleared).toEqual(expected)
    expect(rawProfile).toMatchObject({ apiKey: 'response-secret', unexpected: 'discard-me' })
    expect(rawProfile).toHaveProperty(obsoleteReferenceField, 'legacy-llm')
  })

  it.each([
    'https://user:secret@example.test/v1/chat/completions',
    'https://example.test/v1/chat/completions?api_key=secret',
    'https://example.test/v1/api_key/chat/completions',
    'https://example.test/v1/chat/completions#secret',
  ])('rejects a profile response endpoint that can contain credentials: %s', async endpoint => {
    const ipc = createIpc()
    ipc.invoke.mockResolvedValue([{ ...profileResponse, endpoint }])
    const api = createTerminalAgentApi(ipc)

    await expect(api.settings.models.list('llm')).rejects.toThrow()
  })

  it('exposes a strict clear-key request without retaining a key-import API', async () => {
    const ipc = createIpc()
    ipc.invoke.mockResolvedValue(profileResponse)
    const api = createTerminalAgentApi(ipc)

    await api.settings.models.clearApiKey('  llm-1  ')

    expect(ipc.invoke).toHaveBeenCalledWith('settings:models:key:clear', { id: 'llm-1' })
    expect(Object.keys(api.settings.models)).not.toContain(['import', 'ApiKey'].join(''))
    expect(() => api.settings.models.clearApiKey('')).toThrow()
  })

  it('rejects obsolete key-profile references before profile IPC', () => {
    const ipc = createIpc()
    const api = createTerminalAgentApi(ipc)

    const obsoleteReferenceField = ['apiKey', 'ProfileId'].join('')
    expect(() => api.settings.models.save({ ...profileInput, [obsoleteReferenceField]: 'shared-llm' } as never)).toThrow()
    expect(ipc.invoke).not.toHaveBeenCalled()
  })
})

describe('host memory preload API', () => {
  it('rejects synthetic bare credentials in inbound updates and outbound host DTOs', async () => {
    const values = [
      'github_pat_' + '0'.repeat(82),
      ...['gho_', 'ghu_', 'ghs_', 'ghr_'].map(prefix => prefix + '0'.repeat(36)),
      'ASIA' + '0'.repeat(16),
      'glpat-' + '0'.repeat(20),
      'npm_' + '0'.repeat(36),
      'xoxb-' + '0'.repeat(10) + '-' + '0'.repeat(10) + '-' + '0'.repeat(12),
      'sk_live_' + '0'.repeat(24),
      'rk_live_' + '0'.repeat(24),
      'dckr_pat_' + '0'.repeat(36),
      'aws-secret-access-key=' + 'A'.repeat(40),
    ]
    for (const value of values) {
      const unsafe = {
        hostname: 'api-prod',
        observedAt: '2026-08-18T00:00:00.000Z',
        operatingSystem: { name: 'Linux', version: value },
      }
      const inboundIpc = createIpc()
      await expect(createTerminalAgentApi(inboundIpc).settings.memory.update('api-prod', unsafe)).rejects.toThrow()
      expect(inboundIpc.invoke).not.toHaveBeenCalled()

      const listIpc = createIpc()
      listIpc.invoke.mockResolvedValue([unsafe])
      await expect(createTerminalAgentApi(listIpc).settings.memory.list()).rejects.toThrow()

      const snapshotIpc = createIpc()
      snapshotIpc.invoke.mockResolvedValue(unsafe)
      await expect(createTerminalAgentApi(snapshotIpc).settings.memory.getHost('api-prod')).rejects.toThrow()
    }

    for (const key of ['rawOutput', 'terminalOutput', 'stdout', 'stderr', 'commandOutput', 'terminalHistory']) {
      const unsafe = {
        hostname: 'api-prod',
        observedAt: '2026-08-18T00:00:00.000Z',
        legacyFacts: { software: { [key]: 'synthetic terminal output' } },
      }
      const inboundIpc = createIpc()
      await expect(createTerminalAgentApi(inboundIpc).settings.memory.update('api-prod', unsafe)).rejects.toThrow()
      expect(inboundIpc.invoke).not.toHaveBeenCalled()

      const listIpc = createIpc()
      listIpc.invoke.mockResolvedValue([unsafe])
      await expect(createTerminalAgentApi(listIpc).settings.memory.list()).rejects.toThrow()

      const snapshotIpc = createIpc()
      snapshotIpc.invoke.mockResolvedValue(unsafe)
      await expect(createTerminalAgentApi(snapshotIpc).settings.memory.getHost('api-prod')).rejects.toThrow()
    }
  })

  it('accepts only opaque consent tokens for acknowledgement and dismissal', async () => {
    const ipc = createIpc()
    const api = createTerminalAgentApi(ipc)
    const token = 'a'.repeat(43)

    await api.settings.acknowledgeHostMemory(token)
    await api.settings.dismissHostMemory(token)
    await expect(api.settings.acknowledgeHostMemory('api-prod')).rejects.toThrow()

    expect(ipc.invoke).toHaveBeenNthCalledWith(1, 'host-memory:acknowledge', token)
    expect(ipc.invoke).toHaveBeenNthCalledWith(2, 'host-memory:dismiss', token)
  })

  it('validates disclosure payloads before exposing them to the renderer', () => {
    const ipc = createIpc()
    const api = createTerminalAgentApi(ipc)
    const listener = vi.fn()
    api.settings.onHostMemoryDisclosure(listener)
    const wrapper = ipc.on.mock.calls.find(([channel]) => channel === 'host-memory:disclosure')?.[1]

    wrapper?.({}, { token: 'a'.repeat(43), hostIdentity: '10.0.0.1' })
    expect(listener).toHaveBeenCalledWith({ token: 'a'.repeat(43), hostIdentity: '10.0.0.1' })
    expect(() => wrapper?.({}, { token: 'not-a-token', hostIdentity: '10.0.0.1' })).toThrow()
  })

  it('recovers pending disclosures and exposes typed invalidation events', async () => {
    const ipc = createIpc()
    ipc.invoke.mockResolvedValue([{ token: 'a'.repeat(43), hostIdentity: '192.0.2.10' }])
    const api = createTerminalAgentApi(ipc)
    await expect(api.settings.pendingHostMemoryDisclosures()).resolves.toEqual([{ token: 'a'.repeat(43), hostIdentity: '192.0.2.10' }])
    expect(ipc.invoke).toHaveBeenCalledWith('host-memory:pending')
    const listener = vi.fn()
    api.settings.onHostMemoryInvalidation(listener)
    const wrapper = ipc.on.mock.calls.find(([channel]) => channel === 'host-memory:invalidation')?.[1]
    wrapper?.({}, { token: 'a'.repeat(43) })
    expect(listener).toHaveBeenCalledWith({ token: 'a'.repeat(43) })
    expect(() => wrapper?.({}, { token: 'invalid' })).toThrow()
  })
})
