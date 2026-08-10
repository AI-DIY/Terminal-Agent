import { describe, expect, it, vi } from 'vitest'
import type { AgentGoalContext, AgentStreamEvent } from '../../../src/main/agent/agent-contracts'
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
        software: { nginx: '1.25' },
        processes: [],
        installLocations: {},
        services: { 'nginx.service': 'active running' },
        logLocations: [],
        configurationHashes: {},
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

  it('rejects facts belonging to a different host', async () => {
    const scheduler = new AgentScheduler({ stream: vi.fn() })

    await expect(scheduler.start({
      goal: '检查服务',
      session: { id: 'session-a', hostname: 'api-prod' },
      facts: {
        hostname: 'web-prod', observedAt: '2026-08-09T00:00:00.000Z', software: {}, processes: [],
        installLocations: {}, services: {}, logLocations: [], configurationHashes: {},
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
        hostname: 'api-prod', observedAt: '2026-08-09T00:00:00.000Z', software: {}, processes: [],
        installLocations: {}, services: {}, logLocations: [], configurationHashes: {},
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
        hostname: 'api-prod', observedAt: '2026-08-09T00:00:00.000Z', software: {}, processes: [],
        installLocations: {}, services: {}, logLocations: [], configurationHashes: {},
      },
      signal: controller.signal,
    }, vi.fn())

    expect(model.stream).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }), expect.any(Function))
  })
})
