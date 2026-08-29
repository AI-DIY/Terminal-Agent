import { describe, expect, it, vi } from 'vitest'
import { buildStructuredShellContext, StructuredChatAgent } from '../../../src/main/chat/structured-chat-agent'

const request = {
  messages: [{ role: 'user' as const, content: '检查服务' }],
  availableHostnames: ['web-02'],
}

describe('StructuredChatAgent', () => {
  it('projects online task associations in stored order with connection-title display labels', () => {
    expect(buildStructuredShellContext([
      { sessionId: 'first', hostname: 'web-01', title: 'primary', status: 'open' },
      { sessionId: 'second', hostname: 'web-01', title: 'secondary', status: 'open' },
      { sessionId: 'closed', hostname: 'db-01', title: 'closed', status: 'closed' },
    ], [
      { id: 'second', hostname: 'web-01', title: 'secondary' },
      { id: 'first', hostname: 'web-01', title: 'primary' },
      { id: 'closed', hostname: 'db-01', title: 'closed' },
    ])).toEqual([
      { hostname: 'web-01', title: 'primary', displayLabel: 'primary #1', ordinal: 1 },
      { hostname: 'web-01', title: 'secondary', displayLabel: 'secondary #2', ordinal: 2 },
    ])
  })

  it('carries recent output lines into each matching online Shell context entry', () => {
    expect(buildStructuredShellContext([
      { sessionId: 'first', hostname: 'web-01', title: 'primary', status: 'open' },
    ], [
      { id: 'first', hostname: 'web-01', title: 'primary', recentLines: ['last command', 'result'] },
    ])).toEqual([
      {
        hostname: 'web-01',
        title: 'primary',
        displayLabel: 'primary',
        ordinal: 1,
        recentLines: ['last command', 'result'],
      },
    ])
  })

  it('carries the observed hostname as the canonical AI target identity', () => {
    expect(buildStructuredShellContext([
      { sessionId: 'first', hostname: '127.0.0.1', title: 'AI中台_10.54.98.34', status: 'open' },
      { sessionId: 'second', hostname: '127.0.0.1', title: 'AI中台_98.29', status: 'open' },
    ], [
      { id: 'first', hostname: '127.0.0.1', title: 'AI中台_10.54.98.34', observedHostname: 'web-prod' },
      { id: 'second', hostname: '127.0.0.1', title: 'AI中台_98.29', observedHostname: 'db-prod' },
    ])).toMatchObject([
      { hostname: 'web-prod', observedHostname: 'web-prod' },
      { hostname: 'db-prod', observedHostname: 'db-prod' },
    ])
  })

  it('returns the first valid JSON response without exposing provider deltas', async () => {
    const complete = vi.fn().mockResolvedValue('{"version":1,"reply":"已准备。","plan":null}')
    await expect(new StructuredChatAgent({ complete }).run(request)).resolves.toMatchObject({ reply: '已准备。', plan: null })
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('repairs invalid JSON twice at most and fails after the third model call', async () => {
    const complete = vi.fn().mockResolvedValueOnce('{not json').mockResolvedValueOnce('{still invalid').mockResolvedValueOnce('{also invalid')
    await expect(new StructuredChatAgent({ complete }).run(request)).rejects.toThrow('AI 未能生成可执行计划，请重试。')
    expect(complete).toHaveBeenCalledTimes(3)
  })

  it('repairs a plan that targets an offline hostname', async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce('{"version":1,"reply":"准备","plan":{"title":"检查","steps":[{"target":"missing-host","explanation":"检查","command":"pwd"}]}}')
      .mockResolvedValueOnce('{"version":1,"reply":"准备","plan":{"title":"检查","steps":[{"target":"web-02","explanation":"检查","command":"pwd"}]}}')
    await expect(new StructuredChatAgent({ complete }).run(request)).resolves.toMatchObject({ plan: { steps: [{ target: 'web-02' }] } })
    expect(complete).toHaveBeenCalledTimes(2)
  })

  it('reports bounded thinking and repairing stages without exposing generated JSON', async () => {
    const stages: string[] = []
    const complete = vi.fn()
      .mockResolvedValueOnce('{not json')
      .mockResolvedValueOnce('{"version":1,"reply":"完成","plan":null}')
    await expect(new StructuredChatAgent({ complete, onStage: stage => stages.push(stage) }).run(request)).resolves.toMatchObject({ reply: '完成' })
    expect(stages).toEqual(['thinking', 'repairing', 'thinking', 'observing'])
    expect(stages.every(stage => ['thinking', 'executing', 'observing', 'repairing'].includes(stage))).toBe(true)
    expect(stages.join(' ')).not.toContain('{')
  })

  it('gives the model hostname-based display labels while retaining hostname targets', async () => {
    let system = ''
    const complete = vi.fn(async messages => {
      system = String(messages[0]?.content ?? '')
      return '{"version":1,"reply":"完成","plan":{"title":"检查","steps":[{"target":"web-01","explanation":"检查","command":"pwd"}]}}'
    })
    await expect(new StructuredChatAgent({ complete }).run({
      ...request,
      availableHostnames: ['web-01'],
      availableShells: [{ hostname: 'web-01', title: '10.54.98.34', displayLabel: 'web-01 #1', ordinal: 1 }],
    })).resolves.toMatchObject({ plan: { steps: [{ target: 'web-01' }] } })
    expect(system).toContain('web-01 #1')
    expect(system).toContain('displayLabel')
    expect(system).toContain('target')
  })
})
