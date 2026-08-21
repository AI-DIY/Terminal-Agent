import { describe, expect, it, vi } from 'vitest'
import { createTerminalAgentApi } from '../../../src/preload/api'
import type { ShellHistoryDetail } from '../../../src/shared/contracts'

function createIpc() {
  return { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }
}

describe('chat preload API', () => {
  it('freezes the chat domain and routes only named chat operations', async () => {
    const ipc = createIpc()
    const api = createTerminalAgentApi(ipc)
    const create = { requestId: 'create-1', title: 'chat' }
    const mode = { requestId: 'mode-1', chatId: 'chat-1', mode: 'autonomous' as const }
    const remove = { requestId: 'remove-1', chatId: 'chat-1' }
    const bind = { requestId: 'bind-1', chatId: 'chat-1', sessionId: 's1' }
    const transfer = { requestId: 'transfer-1', sourceChatId: 'chat-1', targetChatId: 'chat-2', sessionIds: ['s1', 's2'] }

    expect(Object.isFrozen(api)).toBe(true)
    expect(Object.isFrozen(api.chats)).toBe(true)
    await api.chats.list()
    await api.chats.create(create)
    await api.chats.get('chat-1')
    await api.chats.resolveSession({ sessionId: 's1' })
    await api.chats.setMode(mode)
    await api.chats.remove(remove)
    await api.chats.bindSession(bind)
    await api.chats.transferSessions(transfer)

    expect(ipc.invoke).toHaveBeenNthCalledWith(1, 'chats:list')
    expect(ipc.invoke).toHaveBeenNthCalledWith(2, 'chats:create', create)
    expect(ipc.invoke).toHaveBeenNthCalledWith(3, 'chats:get', 'chat-1')
    expect(ipc.invoke).toHaveBeenNthCalledWith(4, 'chats:resolve-session', { sessionId: 's1' })
    expect(ipc.invoke).toHaveBeenNthCalledWith(5, 'chats:set-mode', mode)
    expect(ipc.invoke).toHaveBeenNthCalledWith(6, 'chats:remove', remove)
    expect(ipc.invoke).toHaveBeenNthCalledWith(7, 'chats:bind-session', bind)
    expect(ipc.invoke).toHaveBeenNthCalledWith(8, 'chats:transfer-sessions', transfer)
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
