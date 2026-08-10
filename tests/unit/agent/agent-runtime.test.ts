import { describe, expect, it, vi } from 'vitest'
import { AgentModelRuntime, ModelConfigurationError, UnsafeAgentOutputError } from '../../../src/main/agent/agent-model-runtime'

const request = {
  goal: '检查 nginx，密码是 hunter2，令牌为 sk-secret-token，API Key is alpha beta',
  sessionId: 'session-a',
  hostname: 'api-prod',
  facts: {
    hostname: 'api-prod',
    observedAt: '2026-08-09T00:00:00.000Z',
    software: { nginx: '1.25.1' },
    processes: [{ name: 'nginx', status: 'running' }],
    installLocations: { nginx: '/etc/nginx' },
    services: { 'nginx.service': 'active', PASSWORD: 'correct horse battery staple' },
    logLocations: ['/var/log/nginx/access.log'],
    configurationHashes: { '/etc/nginx/nginx.conf': 'sha256:abc123' },
  },
  terminalExcerpt: 'FULL TERMINAL TRANSCRIPT password=do-not-send',
}

describe('AgentModelRuntime', () => {
  it('does not include bearer, GitHub, AWS, or labelled credentials in model messages', async () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvcHMiLCJyb2xlIjoiYWRtaW4ifQ.signature'
    const githubToken = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890'
    const awsKey = 'AKIAIOSFODNN7EXAMPLE'
    const privateKey = '-----BEGIN PRIVATE KEY-----\nprivate-key-material\n-----END PRIVATE KEY-----'
    const client = { stream: vi.fn(async (_settings, _messages, onDelta) => {
      onDelta('{"analysis":"服务正常","evidenceStrategy":[],"candidate":null}')
    }) }
    const runtime = new AgentModelRuntime({ load: vi.fn().mockResolvedValue({
      endpoint: 'http://localhost:11434/v1/chat/completions', model: 'local-model', apiKey: 'local-key', contextLimit: 12_000,
    }) }, client, () => 'candidate-1')

    await runtime.stream({
      ...request,
      goal: `Authorization: Bearer ${jwt}; GitHub ${githubToken}; AWS ${awsKey}; password=correct horse; API Key=local-key; ${privateKey}`,
      facts: {
        ...request.facts,
        software: { github: githubToken, aws: awsKey },
        services: { Authorization: `Bearer ${jwt}`, password: 'correct horse', privateKey },
      },
    }, vi.fn())

    const messages = client.stream.mock.calls[0]?.[1] as Array<{ content: string }>
    const modelInput = JSON.stringify(messages)
    for (const secret of [jwt, githubToken, awsKey, 'correct horse', 'private-key-material']) {
      expect(modelInput).not.toContain(secret)
    }
  })

  it('redacts cross-chunk stream output and rejects a proposal with a credential-bearing command', async () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvcHMifQ.signature'
    const client = { stream: vi.fn(async (_settings, _messages, onDelta) => {
      const result = JSON.stringify({ analysis: '正常', evidenceStrategy: [], candidate: { command: `echo ${jwt}`, explanation: '检查' } })
      const split = result.indexOf(jwt)
      onDelta(result.slice(0, split))
      onDelta(result.slice(split))
    }) }
    const runtime = new AgentModelRuntime({ load: vi.fn().mockResolvedValue({
      endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-5-mini', apiKey: 'sk-real-key', contextLimit: 12_000,
    }) }, client, () => 'candidate-1')
    const events: unknown[] = []

    await expect(runtime.stream(request, event => events.push(event))).rejects.toThrow('sensitive')

    expect(JSON.stringify(events)).not.toContain(jwt)
    expect(events).not.toContainEqual(expect.objectContaining({ kind: 'proposal' }))
  })

  it('does not publish the tail of a multi-word password before rejecting it', async () => {
    const client = { stream: vi.fn(async (_settings, _messages, onDelta) => {
      onDelta(JSON.stringify({ analysis: 'password=correct horse battery staple', evidenceStrategy: [], candidate: null }))
    }) }
    const runtime = new AgentModelRuntime({ load: vi.fn().mockResolvedValue({
      endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-5-mini', apiKey: 'sk-real-key', contextLimit: 12_000,
    }) }, client, () => 'candidate-1')
    const events: unknown[] = []

    await expect(runtime.stream(request, event => events.push(event))).rejects.toThrow('sensitive')
    expect(JSON.stringify(events)).not.toContain('correct')
    expect(JSON.stringify(events)).not.toContain('horse battery staple')
  })

  it('uses protected model settings, streams raw deltas, and emits one saved-ready proposal from strict JSON', async () => {
    const client = {
      stream: vi.fn(async (_settings, _messages, onDelta) => {
        onDelta('{"analysis":"Nginx 正常运行","evidenceStrategy":["检查服务状态"],"candidate":{"command":"systemctl status nginx","explanation":"只读检查"}}')
      }),
    }
    const models = { load: vi.fn().mockResolvedValue({
      endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-5-mini', apiKey: 'sk-real-key', contextLimit: 12_000,
    }) }
    const runtime = new AgentModelRuntime(models, client, () => 'candidate-1')
    const events: unknown[] = []

    await runtime.stream(request, event => events.push(event))

    expect(events.filter((event): event is { kind: 'delta'; content: string } => typeof event === 'object' && event !== null && 'kind' in event && event.kind === 'delta')
      .map(event => event.content).join('')).toBe('{"analysis":"Nginx 正常运行","evidenceStrategy":["检查服务状态"],"candidate":{"command":"systemctl status nginx","explanation":"只读检查"}}')
    expect(events).toContainEqual({
      kind: 'proposal',
      analysis: 'Nginx 正常运行',
      evidenceStrategy: ['检查服务状态'],
      candidate: { id: 'candidate-1', sessionId: 'session-a', command: 'systemctl status nginx', explanation: '只读检查' },
    })
    expect(client.stream).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'sk-real-key' }),
      expect.arrayContaining([expect.objectContaining({ role: 'system' }), expect.objectContaining({ role: 'user' })]),
      expect.any(Function),
      expect.objectContaining({ type: 'json_schema', json_schema: expect.objectContaining({ strict: true }) }),
    )
    const messages = client.stream.mock.calls[0]?.[1] as Array<{ content: string }>
    const modelInput = JSON.stringify(messages)
    expect(modelInput).not.toContain('hunter2')
    expect(modelInput).not.toContain('sk-secret-token')
    expect(modelInput).not.toContain('alpha')
    expect(modelInput).not.toContain('beta')
    expect(modelInput).not.toContain('correct horse battery staple')
    expect(modelInput).not.toContain('do-not-send')
    expect(modelInput).not.toContain('FULL TERMINAL TRANSCRIPT')
    expect(messages[0]?.content).toContain('辅助驾驶会在执行前要求用户确认')
    expect(messages[0]?.content).not.toContain('待人工确认的命令')
  })

  it('fails with a clear local error before calling the model when protected settings are unavailable', async () => {
    const client = { stream: vi.fn() }
    const runtime = new AgentModelRuntime({ load: vi.fn().mockResolvedValue(null) }, client, () => 'candidate-1')

    await expect(runtime.stream(request, vi.fn())).rejects.toBeInstanceOf(ModelConfigurationError)
    expect(client.stream).not.toHaveBeenCalled()
  })

  it('rejects a non-conforming final model result instead of proposing a command', async () => {
    const client = { stream: vi.fn(async (_settings, _messages, onDelta) => onDelta('{"analysis":"missing fields"}')) }
    const runtime = new AgentModelRuntime({ load: vi.fn().mockResolvedValue({
      endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-5-mini', apiKey: 'sk-real-key', contextLimit: 12_000,
    }) }, client, () => 'candidate-1')
    const events: unknown[] = []

    await expect(runtime.stream(request, event => events.push(event))).rejects.toThrow('AI returned an invalid analysis result')
    expect(events).toEqual([{ kind: 'delta', content: '{"analysis":"missing fields"}' }])
  })

  it('does not publish credentials echoed by the model into renderer events', async () => {
    const leaked = 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature'
    const client = {
      stream: vi.fn(async (_settings, _messages, onDelta) => onDelta(JSON.stringify({
        analysis: leaked,
        evidenceStrategy: ['ghp_012345678901234567890123456789012345'],
        candidate: null,
      }))),
    }
    const runtime = new AgentModelRuntime({ load: vi.fn().mockResolvedValue({
      endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-5-mini', apiKey: 'sk-real-key', contextLimit: 12_000,
    }) }, client, () => 'candidate-1')
    const events: unknown[] = []

    await expect(runtime.stream(request, event => events.push(event))).rejects.toBeInstanceOf(UnsafeAgentOutputError)

    expect(JSON.stringify(events)).not.toContain(leaked)
    expect(JSON.stringify(events)).not.toContain('ghp_012345678901234567890123456789012345')
  })

  it('forwards the active run AbortSignal to the Chat Completions client', async () => {
    const controller = new AbortController()
    const client = { stream: vi.fn(async (_settings, _messages, onDelta) => {
      onDelta('{"analysis":"服务正常","evidenceStrategy":[],"candidate":null}')
    }) }
    const runtime = new AgentModelRuntime({ load: vi.fn().mockResolvedValue({
      endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-5-mini', apiKey: 'sk-real-key', contextLimit: 12_000,
    }) }, client, () => 'candidate-1')

    await runtime.stream({ ...request, signal: controller.signal }, vi.fn())

    expect(client.stream).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.any(Function), expect.anything(), controller.signal)
  })
})
