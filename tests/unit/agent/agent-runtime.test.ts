import { describe, expect, it, vi } from 'vitest'
import { AgentModelRuntime, ModelConfigurationError, UnsafeAgentOutputError } from '../../../src/main/agent/agent-model-runtime'

const request = {
  goal: '检查 nginx，密码是 hunter2，令牌为 sk-secret-token，API Key is alpha beta',
  sessionId: 'session-a',
  hostname: 'api-prod',
  facts: {
    hostname: 'api-prod',
    observedAt: '2026-08-09T00:00:00.000Z',
    connectionIp: '192.0.2.10',
    operatingSystem: { name: 'Linux', version: '6.1.0' },
    cpu: { model: 'Example CPU', architecture: 'x86_64', logicalCores: 8 },
    memory: { totalBytes: 8_589_934_592 },
    disks: [{ name: 'sda', totalBytes: 128_000_000_000 }],
    networkInterfaces: [{ name: 'eth0', addresses: ['192.0.2.10'] }],
    processes: [{ name: 'nginx', pid: 42, workingDirectory: '/usr/sbin' }],
    currentUser: 'root',
    workingDirectory: '/srv/apps/api',
    services: { 'nginx.service': 'active running', PASSWORD: 'correct horse battery staple' },
  },
  terminalExcerpt: 'FULL TERMINAL TRANSCRIPT password=do-not-send',
}

describe('AgentModelRuntime', () => {
  it('resolves the active routed profile through ModelProfileService before streaming', async () => {
    const client = { stream: vi.fn(async (_settings, _messages, onDelta) => onDelta('{"analysis":"正常","evidenceStrategy":[],"candidate":null}')) }
    const resolveRoute = vi.fn().mockResolvedValue({
      id: 'vlm-1', kind: 'vlm', provider: 'ollama', name: 'vision', model: 'llava',
      endpoint: 'http://127.0.0.1:11434/api/chat', maxImages: 4, apiKey: null,
    })
    const runtime = new AgentModelRuntime(
      { load: vi.fn().mockResolvedValue(null) },
      client,
      () => 'candidate-1',
      { resolveRoute },
    )

    await runtime.stream({ ...request, hasImages: true }, vi.fn())

    expect(resolveRoute).toHaveBeenCalledWith({ hasImages: true })
    expect(client.stream).toHaveBeenCalledWith(expect.objectContaining({ provider: 'ollama', model: 'llava' }), expect.anything(), expect.any(Function))
  })
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
        cpu: { model: githubToken, architecture: awsKey, logicalCores: 8 },
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
    )
    expect(client.stream.mock.calls[0]).toHaveLength(3)
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

  it('accepts a single fenced JSON response from a standard Chat Completions model', async () => {
    const client = { stream: vi.fn(async (_settings, _messages, onDelta) => onDelta('```json\n{"analysis":"服务正常","evidenceStrategy":[],"candidate":null}\n```')) }
    const runtime = new AgentModelRuntime({ load: vi.fn().mockResolvedValue({
      endpoint: 'https://api.openai.com/v1/chat/completions', model: 'compatible-model', apiKey: 'sk-real-key', contextLimit: 12_000,
    }) }, client, () => 'candidate-1')
    const events: unknown[] = []

    await runtime.stream(request, event => events.push(event))

    expect(events).toContainEqual(expect.objectContaining({ kind: 'proposal', analysis: '服务正常' }))
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

    expect(client.stream).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.any(Function), undefined, controller.signal)
  })
})
