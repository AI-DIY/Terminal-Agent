import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ModelConfigurationError } from '../../../src/main/agent/agent-model-runtime'
import { registerAgentHandlers } from '../../../src/main/agent/register-agent-handlers'
import { registerSessionObservation } from '../../../src/main/observation/register-session-observation'
import { SessionService } from '../../../src/main/ssh/session-service'
import type { AgentStreamEvent } from '../../../src/shared/contracts'

const { handle, removeHandler } = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn() }))

vi.mock('electron', () => ({ ipcMain: { handle, removeHandler } }))

const facts = {
  hostname: 'api-prod', observedAt: '2026-08-09T00:00:00.000Z',
}

describe('registerAgentHandlers', () => {
  beforeEach(() => {
    handle.mockReset()
    removeHandler.mockReset()
  })

  it('starts only a trusted session, relays stream events, and saves a generated candidate before it is displayed', async () => {
    const scheduler = {
      start: vi.fn(async (_context, publish) => {
        publish({ kind: 'delta', content: '{"analysis":"正在分析"}' })
        publish({
          kind: 'proposal', analysis: '服务正常', evidenceStrategy: ['检查服务状态'],
          candidate: { id: 'candidate-1', sessionId: 'session-a', command: 'systemctl status nginx', explanation: '只读检查' },
        })
      }),
    }
    const candidates = { save: vi.fn() }
    const sender = { send: vi.fn() }
    const dispose = registerAgentHandlers(
      scheduler,
      { snapshot: () => [{ id: 'session-a', hostname: 'api-prod', mode: 'copilot' }], observedHostname: () => 'api-prod' },
      { snapshot: vi.fn().mockResolvedValue(facts) },
      candidates,
      sender as never,
    )
    const start = handle.mock.calls.find(([channel]) => channel === 'agent:start')?.[1] as (event: { sender: unknown }, request: unknown) => Promise<void>

    await start({ sender }, { sessionId: 'session-a', runId: '550e8400-e29b-41d4-a716-446655440001', goal: '检查 nginx 服务' })

    expect(scheduler.start).toHaveBeenCalledWith(expect.objectContaining({
      goal: '检查 nginx 服务', session: { id: 'session-a', hostname: 'api-prod' }, facts,
    }), expect.any(Function))
    expect(candidates.save).toHaveBeenCalledWith({ id: 'candidate-1', sessionId: 'session-a', command: 'systemctl status nginx' })
    expect(sender.send).toHaveBeenCalledWith('agent:delta', { sessionId: 'session-a', runId: '550e8400-e29b-41d4-a716-446655440001', content: '{"analysis":"正在分析"}' })
    expect(sender.send).toHaveBeenCalledWith('agent:proposal', expect.objectContaining({ sessionId: 'session-a', runId: '550e8400-e29b-41d4-a716-446655440001', candidate: expect.objectContaining({ id: 'candidate-1' }) }))
    await expect(start({ sender: {} }, { sessionId: 'session-a', runId: '550e8400-e29b-41d4-a716-446655440001', goal: '检查 nginx 服务' })).rejects.toThrow('Untrusted renderer')

    dispose()
    expect(removeHandler).toHaveBeenCalledWith('agent:start')
  })

  it('forwards an explicitly supplied image flag to the scheduler', async () => {
    const scheduler = { start: vi.fn().mockResolvedValue(undefined) }
    const sender = { send: vi.fn() }
    const dispose = registerAgentHandlers(
      scheduler,
      { snapshot: () => [{ id: 'session-a', hostname: 'api-prod', mode: 'copilot' }], observedHostname: () => 'api-prod' },
      { snapshot: vi.fn().mockResolvedValue(facts) },
      { save: vi.fn() },
      sender as never,
    )
    const start = handle.mock.calls.find(([channel]) => channel === 'agent:start')?.[1] as (event: { sender: unknown }, request: unknown) => Promise<void>

    await start({ sender }, { sessionId: 'session-a', runId: '550e8400-e29b-41d4-a716-446655440008', goal: '检查图片', hasImages: true })

    expect(scheduler.start).toHaveBeenCalledWith(expect.objectContaining({ hasImages: true }), expect.any(Function))
    dispose()
  })

  it('publishes the no-configuration error without exposing failure details', async () => {
    const sender = { send: vi.fn() }
    const dispose = registerAgentHandlers(
      { start: vi.fn().mockRejectedValue(new ModelConfigurationError('missing key sk-real-key')) },
      { snapshot: () => [{ id: 'session-a', hostname: 'api-prod', mode: 'copilot' }], observedHostname: () => 'api-prod' },
      { snapshot: vi.fn().mockResolvedValue(facts) },
      { save: vi.fn() },
      sender as never,
    )
    const start = handle.mock.calls.find(([channel]) => channel === 'agent:start')?.[1] as (event: { sender: unknown }, request: unknown) => Promise<void>

    await start({ sender }, { sessionId: 'session-a', runId: '550e8400-e29b-41d4-a716-446655440002', goal: '检查 nginx 服务' })

    expect(sender.send).toHaveBeenCalledWith('agent:error', {
      sessionId: 'session-a',
      runId: '550e8400-e29b-41d4-a716-446655440002',
      message: '未配置 AI 模型。请前往设置完成模型连接后重试。',
    })
    expect(JSON.stringify(sender.send.mock.calls)).not.toContain('sk-real-key')
    dispose()
  })

  it('forwards token-looking stream and proposal content to the existing candidate workflow', async () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvcHMifQ.signature'
    const sender = { send: vi.fn() }
    const candidates = { save: vi.fn() }
    const dispose = registerAgentHandlers(
      { start: vi.fn(async (_context, publish) => {
        publish({ kind: 'delta', content: `Authorization: Bearer ${jwt}` })
        publish({
          kind: 'proposal', analysis: '正常', evidenceStrategy: [],
          candidate: { id: 'candidate-1', sessionId: 'session-a', command: `curl -H "Authorization: Bearer ${jwt}" https://api.example.test`, explanation: '检查' },
        })
      }) },
      { snapshot: () => [{ id: 'session-a', hostname: 'api-prod', mode: 'copilot' }], observedHostname: () => 'api-prod' },
      { snapshot: vi.fn().mockResolvedValue(facts) },
      candidates,
      sender as never,
    )
    const start = handle.mock.calls.find(([channel]) => channel === 'agent:start')?.[1] as (event: { sender: unknown }, request: unknown) => Promise<void>

    await start({ sender }, { sessionId: 'session-a', runId: '550e8400-e29b-41d4-a716-446655440003', goal: '检查服务' })

    expect(JSON.stringify(sender.send.mock.calls)).toContain(jwt)
    expect(sender.send).toHaveBeenCalledWith('agent:delta', expect.objectContaining({ content: `Authorization: Bearer ${jwt}` }))
    expect(sender.send).toHaveBeenCalledWith('agent:proposal', expect.objectContaining({ candidate: expect.objectContaining({ command: expect.stringContaining(jwt) }) }))
    expect(candidates.save).toHaveBeenCalledWith(expect.objectContaining({ command: expect.stringContaining(jwt) }))
    dispose()
  })

  it('does not request facts by a route host before observation has completed', async () => {
    const sender = { send: vi.fn() }
    const factsSource = { snapshot: vi.fn().mockResolvedValue(facts) }
    const dispose = registerAgentHandlers(
      { start: vi.fn() },
      { snapshot: () => [{ id: 'session-a', hostname: '10.0.0.12', mode: 'copilot' }], observedHostname: () => undefined },
      factsSource,
      { save: vi.fn() },
      sender as never,
    )
    const start = handle.mock.calls.find(([channel]) => channel === 'agent:start')?.[1] as (event: { sender: unknown }, request: unknown) => Promise<void>

    await start({ sender }, { sessionId: 'session-a', runId: '550e8400-e29b-41d4-a716-446655440005', goal: '检查服务' })

    expect(factsSource.snapshot).not.toHaveBeenCalled()
    expect(sender.send).toHaveBeenCalledWith('agent:error', {
      sessionId: 'session-a',
      runId: '550e8400-e29b-41d4-a716-446655440005',
      message: '当前会话尚未收集到主机事实。请稍后重试。',
    })
    dispose()
  })

  it('does not make an IP session available to the agent without a host memory gate', async () => {
    const shell = createShell()
    const sessions = new SessionService({
      connect: vi.fn().mockResolvedValue({
        close: vi.fn(),
        openShell: vi.fn().mockResolvedValue(shell),
        execute: vi.fn((command: string) => Promise.resolve(command === 'hostname' ? 'api-prod\n' : '')),
      }),
    }, { load: vi.fn() })
    const factsSource = {
      observe: vi.fn(),
      snapshot: vi.fn().mockResolvedValue(facts),
    }
    registerSessionObservation(sessions, factsSource)
    const session = await sessions.connect({
      host: '10.0.0.12', port: 22, username: 'ops', auth: { kind: 'password', password: '' },
    })
    await new Promise(resolve => setImmediate(resolve))
    expect(sessions.snapshot()).toEqual([expect.objectContaining({ id: session.id, hostname: '10.0.0.12' })])
    expect(sessions.snapshot()[0]).not.toHaveProperty('observedHostname')
    expect(factsSource.observe).not.toHaveBeenCalled()

    const sender = { send: vi.fn() }
    const scheduler = { start: vi.fn() }
    const dispose = registerAgentHandlers(
      scheduler,
      sessions,
      factsSource,
      { save: vi.fn() },
      sender as never,
    )
    const start = handle.mock.calls.find(([channel]) => channel === 'agent:start')?.[1] as (event: { sender: unknown }, request: unknown) => Promise<void>

    await start({ sender }, { sessionId: session.id, runId: '550e8400-e29b-41d4-a716-446655440004', goal: '检查服务' })

    expect(factsSource.snapshot).not.toHaveBeenCalled()
    expect(scheduler.start).not.toHaveBeenCalled()
    expect(sender.send).toHaveBeenCalledWith('agent:error', {
      sessionId: session.id,
      runId: '550e8400-e29b-41d4-a716-446655440004',
      message: '当前会话尚未收集到主机事实。请稍后重试。',
    })
    dispose()
  })

  it('does not read cached facts for a new request while host memory collection is disabled', async () => {
    const sender = { send: vi.fn() }
    const factsSource = { snapshot: vi.fn().mockResolvedValue(facts) }
    const scheduler = { start: vi.fn() }
    const dispose = registerAgentHandlers(
      scheduler,
      { snapshot: () => [{ id: 'session-a', hostname: 'api-prod', mode: 'copilot' }], observedHostname: () => 'api-prod' },
      factsSource,
      { save: vi.fn() },
      sender as never,
      undefined,
      { hostMemory: { canCollect: vi.fn().mockResolvedValue(false) } },
    )
    const start = handle.mock.calls.find(([channel]) => channel === 'agent:start')?.[1] as (event: { sender: unknown }, request: unknown) => Promise<void>

    await start({ sender }, { sessionId: 'session-a', runId: '550e8400-e29b-41d4-a716-446655440015', goal: '检查服务' })

    expect(factsSource.snapshot).not.toHaveBeenCalled()
    expect(scheduler.start).not.toHaveBeenCalled()
    expect(sender.send).toHaveBeenCalledWith('agent:error', expect.objectContaining({ sessionId: 'session-a', runId: '550e8400-e29b-41d4-a716-446655440015' }))
    dispose()
  })

  it('does not read cached facts when the observed host authorization is revoked during lookup', async () => {
    let releaseSnapshot!: (value: typeof facts) => void
    let authorized = true
    const sender = { send: vi.fn() }
    const factsSource = { snapshot: vi.fn(() => new Promise<typeof facts>(resolve => { releaseSnapshot = resolve })) }
    const scheduler = { start: vi.fn() }
    const dispose = registerAgentHandlers(
      scheduler,
      { snapshot: () => [{ id: 'session-a', hostname: '192.0.2.10', mode: 'copilot' }], observedHostname: () => 'api-prod' },
      factsSource,
      { save: vi.fn() },
      sender as never,
      undefined,
      { hostMemory: {
        canCollect: vi.fn().mockResolvedValue(true),
        canObserveHost: vi.fn(async () => authorized),
      } },
    )
    const start = handle.mock.calls.find(([channel]) => channel === 'agent:start')?.[1] as (event: { sender: unknown }, request: unknown) => Promise<void>

    const run = start({ sender }, { sessionId: 'session-a', runId: '550e8400-e29b-41d4-a716-446655440016', goal: '检查服务' })
    await vi.waitFor(() => expect(factsSource.snapshot).toHaveBeenCalledOnce())
    authorized = false
    releaseSnapshot(facts)
    await run

    expect(scheduler.start).not.toHaveBeenCalled()
    expect(sender.send).toHaveBeenCalledWith('agent:error', expect.objectContaining({
      sessionId: 'session-a', runId: '550e8400-e29b-41d4-a716-446655440016',
    }))
    dispose()
  })

  it('drops delayed A1 callbacks after A2 becomes the current run before saving a candidate', async () => {
    const callbacks: Array<(event: AgentStreamEvent) => void> = []
    const complete: Array<() => void> = []
    const scheduler = {
      start: vi.fn((_context, publish) => new Promise<void>(resolve => {
        callbacks.push(publish)
        complete.push(resolve)
      })),
    }
    const sender = { send: vi.fn() }
    const candidates = { save: vi.fn() }
    const dispose = registerAgentHandlers(
      scheduler,
      { snapshot: () => [{ id: 'session-a', hostname: '10.0.0.12', mode: 'copilot' }], observedHostname: () => 'api-prod' },
      { snapshot: vi.fn().mockResolvedValue(facts) },
      candidates,
      sender as never,
    )
    const start = handle.mock.calls.find(([channel]) => channel === 'agent:start')?.[1] as (event: { sender: unknown }, request: unknown) => Promise<void>
    const first = start({ sender }, { sessionId: 'session-a', runId: '550e8400-e29b-41d4-a716-446655440006', goal: '首次分析' })
    await vi.waitFor(() => expect(callbacks).toHaveLength(1))
    const second = start({ sender }, { sessionId: 'session-a', runId: '550e8400-e29b-41d4-a716-446655440007', goal: '再次分析' })
    await vi.waitFor(() => expect(callbacks).toHaveLength(2))

    callbacks[0]({
      kind: 'proposal', analysis: '过期分析', evidenceStrategy: [],
      candidate: { id: 'candidate-a1', sessionId: 'session-a', command: 'id', explanation: '旧请求' },
    })

    expect(candidates.save).not.toHaveBeenCalled()
    expect(sender.send).not.toHaveBeenCalledWith('agent:proposal', expect.objectContaining({ runId: '550e8400-e29b-41d4-a716-446655440006' }))

    callbacks[1]({
      kind: 'proposal', analysis: '当前分析', evidenceStrategy: [],
      candidate: { id: 'candidate-a2', sessionId: 'session-a', command: 'uptime', explanation: '当前请求' },
    })
    complete[0]()
    complete[1]()
    await Promise.all([first, second])

    expect(candidates.save).toHaveBeenCalledExactlyOnceWith({ id: 'candidate-a2', sessionId: 'session-a', command: 'uptime' })
    expect(sender.send).toHaveBeenCalledWith('agent:proposal', expect.objectContaining({ sessionId: 'session-a', runId: '550e8400-e29b-41d4-a716-446655440007' }))
    dispose()
  })

  it('sends an autonomous candidate through the execution gateway before publishing it, without saving a human confirmation candidate', async () => {
    const order: string[] = []
    const scheduler = {
      start: vi.fn(async (_context, publish) => {
        await publish({
          kind: 'proposal', analysis: '服务可安全检查', evidenceStrategy: ['读取服务状态'],
          candidate: { id: 'candidate-auto', sessionId: 'session-a', command: 'systemctl status nginx', explanation: '只读检查' },
        })
      }),
    }
    const sender = { send: vi.fn((channel: string) => { order.push(channel) }) }
    const candidates = { save: vi.fn() }
    const executionGateway = {
      execute: vi.fn(async request => {
        order.push('gateway:execute')
        return { kind: 'sent' as const, request }
      }),
    }
    const dispose = registerAgentHandlers(
      scheduler,
      { snapshot: () => [{ id: 'session-a', hostname: 'api-prod', mode: 'autonomous' }], observedHostname: () => 'api-prod' },
      { snapshot: vi.fn().mockResolvedValue(facts) },
      candidates,
      sender as never,
      executionGateway,
    )
    const start = handle.mock.calls.find(([channel]) => channel === 'agent:start')?.[1] as (event: { sender: unknown }, request: unknown) => Promise<void>

    await start({ sender }, { sessionId: 'session-a', runId: '550e8400-e29b-41d4-a716-446655440008', goal: '检查 nginx' })

    expect(executionGateway.execute).toHaveBeenCalledWith({ sessionId: 'session-a', command: 'systemctl status nginx' })
    expect(candidates.save).not.toHaveBeenCalled()
    expect(order).toEqual(['gateway:execute', 'agent:proposal'])
    expect(sender.send).toHaveBeenCalledWith('agent:proposal', expect.objectContaining({
      sessionId: 'session-a', runId: '550e8400-e29b-41d4-a716-446655440008', autonomousExecution: true,
    }))
    dispose()
  })

  it('invalidates a pending run on session close so delayed callbacks cannot save or publish', async () => {
    const callbacks: Array<(event: AgentStreamEvent) => void> = []
    const complete: Array<() => void> = []
    let closed: ((event: { sessionId: string }) => void) | undefined
    const unsubscribeClosed = vi.fn()
    const scheduler = {
      start: vi.fn((_context, publish) => new Promise<void>(resolve => {
        callbacks.push(publish)
        complete.push(resolve)
      })),
    }
    const sender = { send: vi.fn() }
    const candidates = { save: vi.fn() }
    const dispose = registerAgentHandlers(
      scheduler,
      {
        snapshot: () => [{ id: 'session-a', hostname: 'api-prod', mode: 'copilot' }],
        observedHostname: () => 'api-prod',
        onClosed: vi.fn(listener => { closed = listener; return unsubscribeClosed }),
      },
      { snapshot: vi.fn().mockResolvedValue(facts) },
      candidates,
      sender as never,
    )
    const start = handle.mock.calls.find(([channel]) => channel === 'agent:start')?.[1] as (event: { sender: unknown }, request: unknown) => Promise<void>
    const run = start({ sender }, { sessionId: 'session-a', runId: '550e8400-e29b-41d4-a716-446655440009', goal: '检查服务' })
    await vi.waitFor(() => expect(callbacks).toHaveLength(1))

    closed?.({ sessionId: 'session-a' })
    callbacks[0]({
      kind: 'proposal', analysis: '过期分析', evidenceStrategy: [],
      candidate: { id: 'candidate-closed', sessionId: 'session-a', command: 'id', explanation: '旧会话' },
    })
    complete[0]()
    await run

    expect(candidates.save).not.toHaveBeenCalled()
    expect(sender.send).not.toHaveBeenCalled()
    dispose()
    expect(unsubscribeClosed).toHaveBeenCalledOnce()
  })

  it('aborts an earlier A1 model run when A2 starts for the same session without publishing an A1 error', async () => {
    const contexts: Array<{ signal?: AbortSignal }> = []
    const scheduler = {
      start: vi.fn((context: { signal?: AbortSignal }) => new Promise<void>(resolve => {
        contexts.push(context)
        context.signal?.addEventListener('abort', () => resolve(), { once: true })
      })),
    }
    const sender = { send: vi.fn() }
    const dispose = registerAgentHandlers(
      scheduler,
      { snapshot: () => [{ id: 'session-a', hostname: 'api-prod', mode: 'copilot' }], observedHostname: () => 'api-prod' },
      { snapshot: vi.fn().mockResolvedValue(facts) },
      { save: vi.fn() },
      sender as never,
    )
    const start = handle.mock.calls.find(([channel]) => channel === 'agent:start')?.[1] as (event: { sender: unknown }, request: unknown) => Promise<void>
    const first = start({ sender }, { sessionId: 'session-a', runId: '550e8400-e29b-41d4-a716-446655440010', goal: '首次分析' })
    await vi.waitFor(() => expect(contexts).toHaveLength(1))
    const second = start({ sender }, { sessionId: 'session-a', runId: '550e8400-e29b-41d4-a716-446655440011', goal: '再次分析' })
    await vi.waitFor(() => expect(contexts).toHaveLength(2))

    expect(contexts[0].signal?.aborted).toBe(true)
    expect(sender.send).not.toHaveBeenCalledWith('agent:error', expect.objectContaining({ runId: '550e8400-e29b-41d4-a716-446655440010' }))

    dispose()
    await Promise.all([first, second])
  })

  it('aborts the active model run on session close without publishing a late error', async () => {
    let closed: ((event: { sessionId: string }) => void) | undefined
    let signal: AbortSignal | undefined
    const scheduler = {
      start: vi.fn((context: { signal?: AbortSignal }) => new Promise<void>(resolve => {
        signal = context.signal
        context.signal?.addEventListener('abort', () => resolve(), { once: true })
      })),
    }
    const sender = { send: vi.fn() }
    const dispose = registerAgentHandlers(
      scheduler,
      {
        snapshot: () => [{ id: 'session-a', hostname: 'api-prod', mode: 'copilot' }],
        observedHostname: () => 'api-prod',
        onClosed: vi.fn(listener => { closed = listener; return vi.fn() }),
      },
      { snapshot: vi.fn().mockResolvedValue(facts) },
      { save: vi.fn() },
      sender as never,
    )
    const start = handle.mock.calls.find(([channel]) => channel === 'agent:start')?.[1] as (event: { sender: unknown }, request: unknown) => Promise<void>
    const run = start({ sender }, { sessionId: 'session-a', runId: '550e8400-e29b-41d4-a716-446655440012', goal: '检查服务' })
    await vi.waitFor(() => expect(signal).toBeDefined())

    closed?.({ sessionId: 'session-a' })

    expect(signal?.aborted).toBe(true)
    await run
    expect(sender.send).not.toHaveBeenCalled()
    dispose()
  })

  it('aborts a timed-out model run and reports one public timeout error', async () => {
    let signal: AbortSignal | undefined
    const scheduler = {
      start: vi.fn((context: { signal?: AbortSignal }) => new Promise<void>(resolve => {
        signal = context.signal
        context.signal?.addEventListener('abort', () => resolve(), { once: true })
      })),
    }
    const sender = { send: vi.fn() }
    const dispose = registerAgentHandlers(
      scheduler,
      { snapshot: () => [{ id: 'session-a', hostname: 'api-prod', mode: 'copilot' }], observedHostname: () => 'api-prod' },
      { snapshot: vi.fn().mockResolvedValue(facts) },
      { save: vi.fn() },
      sender as never,
      undefined,
      { timeoutMs: 1 },
    )
    const start = handle.mock.calls.find(([channel]) => channel === 'agent:start')?.[1] as (event: { sender: unknown }, request: unknown) => Promise<void>
    const run = start({ sender }, { sessionId: 'session-a', runId: '550e8400-e29b-41d4-a716-446655440013', goal: '检查服务' })

    await vi.waitFor(() => expect(signal?.aborted).toBe(true))
    await run

    expect(sender.send).toHaveBeenCalledWith('agent:error', {
      sessionId: 'session-a',
      runId: '550e8400-e29b-41d4-a716-446655440013',
      message: 'AI 分析超时。请稍后重试。',
    })
    dispose()
  })

  it('times out a suspended facts lookup, then ignores its late result without starting the scheduler', async () => {
    let resolveFacts: ((value: typeof facts) => void) | undefined
    const controller = new AbortController()
    const scheduler = { start: vi.fn() }
    const sender = { send: vi.fn() }
    const dispose = registerAgentHandlers(
      scheduler,
      { snapshot: () => [{ id: 'session-a', hostname: 'api-prod', mode: 'copilot' }], observedHostname: () => 'api-prod' },
      { snapshot: vi.fn(() => new Promise<typeof facts>(resolve => { resolveFacts = resolve })) },
      { save: vi.fn() },
      sender as never,
      undefined,
      { timeoutMs: 1, createAbortController: () => controller },
    )
    const start = handle.mock.calls.find(([channel]) => channel === 'agent:start')?.[1] as (event: { sender: unknown }, request: unknown) => Promise<void>
    const run = start({ sender }, { sessionId: 'session-a', runId: '550e8400-e29b-41d4-a716-446655440014', goal: '检查服务' })

    await vi.waitFor(() => expect(controller.signal.aborted).toBe(true))
    expect(sender.send).toHaveBeenCalledExactlyOnceWith('agent:error', {
      sessionId: 'session-a',
      runId: '550e8400-e29b-41d4-a716-446655440014',
      message: 'AI 分析超时。请稍后重试。',
    })

    resolveFacts?.(facts)
    await run
    expect(scheduler.start).not.toHaveBeenCalled()
    expect(sender.send).toHaveBeenCalledTimes(1)
    dispose()
  })
})

function createShell() {
  return {
    close: vi.fn(), write: vi.fn(), resize: vi.fn(),
    onData: vi.fn(), onClose: vi.fn(),
  }
}
