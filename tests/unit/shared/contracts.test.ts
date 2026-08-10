import { beforeEach, describe, expect, it, vi } from 'vitest'
import { terminalAgentNamespace } from '../../../src/preload/api'
import { agentExecutionRequestSchema, agentStartRequestSchema, candidateConfirmationRequestSchema, sessionModeSchema } from '../../../src/shared/contracts'

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
})
