import { describe, expect, it, vi } from 'vitest'
import type { AgentGoalContext, AgentStreamEvent, SchedulerModelRequest } from '../../../src/main/agent/agent-contracts'
import { AgentScheduler } from '../../../src/main/agent/scheduler'

describe('AgentScheduler', () => {
  it('uses only active hostname-keyed facts when starting a goal', async () => {
    const model = { stream: vi.fn().mockResolvedValue(undefined) }
    const scheduler = new AgentScheduler(model)

    await scheduler.start({
      goal: '分析 nginx 服务状态',
      session: { id: 'session-a', hostname: 'api-prod' },
      facts: {
        hostname: 'api-prod',
        observedAt: '2026-08-09T00:00:00.000Z',
        operatingSystem: { name: 'Linux', version: '6.1.0' },
        processes: [{ name: 'nginx', pid: 42 }],
        services: { 'nginx.service': 'active running' },
      },
    }, vi.fn())

    expect(model.stream).toHaveBeenCalledWith(expect.objectContaining({
      goal: '分析 nginx 服务状态',
      sessionId: 'session-a',
      hostname: 'api-prod',
      facts: expect.objectContaining({ hostname: 'api-prod' }),
    }), expect.any(Function))
    expect(JSON.stringify(model.stream.mock.calls)).not.toContain('apiKey')
    expect(JSON.stringify(model.stream.mock.calls)).not.toContain('privateKey')
  })

  it('projects connection addresses before handing facts to any model adapter', async () => {
    const model = { stream: vi.fn().mockResolvedValue(undefined) }
    const context: AgentGoalContext = {
      goal: '分析 nginx',
      session: { id: 'session-a', hostname: 'api-prod' },
      facts: {
        hostname: 'api-prod',
        observedAt: '2026-08-09T00:00:00.000Z',
        connectionIp: '192.0.2.10',
        networkInterfaces: [{ name: 'eth0', addresses: ['192.0.2.10'] }],
        operatingSystem: { name: 'Linux' },
        services: { 'nginx.service': 'active running' },
      },
    }

    await new AgentScheduler(model).start(context, vi.fn())

    const request = model.stream.mock.calls[0]?.[0] as SchedulerModelRequest
    expect(request.hostname).toBe('api-prod')
    expect(request.facts.hostname).toBe('api-prod')
    expect(request.facts.connectionIp).toBeUndefined()
    expect(request.facts.networkInterfaces).toBeUndefined()
    expect(JSON.stringify(request)).not.toContain('192.0.2.10')
    expect(context.facts.connectionIp).toBe('192.0.2.10')
    expect(context.facts.networkInterfaces?.[0]?.addresses).toEqual(['192.0.2.10'])
  })

  it('rejects facts belonging to a different host', async () => {
    const scheduler = new AgentScheduler({ stream: vi.fn() })

    await expect(scheduler.start({
      goal: '检查服务',
      session: { id: 'session-a', hostname: 'api-prod' },
      facts: {
        hostname: 'web-prod', observedAt: '2026-08-09T00:00:00.000Z',
      },
    }, vi.fn())).rejects.toThrow('active session hostname')
  })

  it('forwards model stream events without attaching any terminal transcript', async () => {
    const model = {
      stream: vi.fn(async (_request: unknown, publish: (event: AgentStreamEvent) => void) => {
        publish({ kind: 'delta', content: '{"analysis":"正在检查"}' })
      }),
    }
    const scheduler = new AgentScheduler(model)
    const events: AgentStreamEvent[] = []
    const context: AgentGoalContext = {
      goal: '检查 nginx',
      session: { id: 'session-a', hostname: 'api-prod' },
      facts: {
        hostname: 'api-prod', observedAt: '2026-08-09T00:00:00.000Z',
      },
    }

    await (scheduler.start as unknown as (
      context: AgentGoalContext,
      publish: (event: AgentStreamEvent) => void,
    ) => Promise<void>)(context, event => events.push(event))

    expect(events).toEqual([{ kind: 'delta', content: '{"analysis":"正在检查"}' }])
    expect(model.stream).toHaveBeenCalledWith(expect.not.objectContaining({ terminalExcerpt: expect.anything() }), expect.any(Function))
  })

  it('forwards the active run AbortSignal to the model runtime', async () => {
    const model = { stream: vi.fn().mockResolvedValue(undefined) }
    const scheduler = new AgentScheduler(model)
    const controller = new AbortController()

    await scheduler.start({
      goal: '检查 nginx',
      session: { id: 'session-a', hostname: 'api-prod' },
      facts: {
        hostname: 'api-prod', observedAt: '2026-08-09T00:00:00.000Z',
      },
      signal: controller.signal,
    }, vi.fn())

    expect(model.stream).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }), expect.any(Function))
  })

  it('isolates migrated fact collections from model adapter mutations', async () => {
    const context: AgentGoalContext = {
      goal: '检查迁移事实',
      session: { id: 'session-a', hostname: 'api-prod' },
      facts: {
        hostname: 'api-prod',
        observedAt: '2026-08-09T00:00:00.000Z',
        legacyFacts: {
          software: { nginx: '1.25' },
          processes: [{ name: 'nginx', status: 'Ssl' }],
          installLocations: { nginx: '/usr/sbin/nginx' },
          services: { 'nginx.service': 'active running' },
          logLocations: ['/var/log/nginx/error.log'],
          configurationHashes: { '/etc/nginx/nginx.conf': 'a'.repeat(64) },
        },
      },
    }
    const model = {
      stream: vi.fn(async (request: SchedulerModelRequest) => {
        request.facts.legacyFacts!.software!.nginx = 'mutated'
        request.facts.legacyFacts!.processes![0]!.status = 'R'
        request.facts.legacyFacts!.logLocations![0] = '/var/log/changed.log'
      }),
    }

    await new AgentScheduler(model).start(context, vi.fn())

    expect(context.facts.legacyFacts).toMatchObject({
      software: { nginx: '1.25' },
      processes: [{ name: 'nginx', status: 'Ssl' }],
      logLocations: ['/var/log/nginx/error.log'],
    })
  })
})
