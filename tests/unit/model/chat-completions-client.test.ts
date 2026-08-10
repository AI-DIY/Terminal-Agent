import { describe, expect, it, vi } from 'vitest'
import { ChatCompletionsClient } from '../../../src/main/model/chat-completions-client'

describe('ChatCompletionsClient', () => {
  it('verifies a standard non-streaming Chat Completions connection without JSON Schema extensions', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }), { status: 200 }))
    const client = new ChatCompletionsClient(fetcher)

    await expect(client.verify({ endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-5', apiKey: 'sk-test', contextLimit: 12_000 }))
      .resolves.toEqual({ model: 'gpt-5' })

    expect(fetcher).toHaveBeenCalledWith('https://api.openai.com/v1/chat/completions', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-5', messages: [{ role: 'user', content: 'ping' }], stream: false }),
    }))
  })

  it('reports a safe, actionable HTTP status when testing a model connection', async () => {
    const apiKey = 'sk-should-not-appear'
    const fetcher = vi.fn().mockResolvedValue(new Response(`invalid key ${apiKey}`, { status: 401 }))
    const client = new ChatCompletionsClient(fetcher)

    await expect(client.verify({ endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-5', apiKey, contextLimit: 12_000 }))
      .rejects.toThrow('模型连接失败（HTTP 401）')
    await expect(client.verify({ endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-5', apiKey, contextLimit: 12_000 }))
      .rejects.not.toThrow(apiKey)
  })

  it('redacts the exact configured API key even when it does not use an sk- prefix', async () => {
    const apiKey = 'tenant-credential-9aQ3'
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(`provider echoed supplied=${apiKey}`, { status: 401 }))
      .mockResolvedValueOnce(new Response(`provider echoed supplied=${apiKey}`, { status: 401 }))
    const client = new ChatCompletionsClient(fetcher)
    const settings = { endpoint: 'https://compatible.example/v1/chat/completions', model: 'compatible-model', apiKey, contextLimit: 12_000 }

    await expect(client.verify(settings)).rejects.not.toThrow(apiKey)
    await expect(client.stream(settings, [{ role: 'user', content: 'ping' }], vi.fn())).rejects.not.toThrow(apiKey)
  })

  it('turns a network failure into a diagnosable model-connection error without leaking the API key', async () => {
    const apiKey = 'sk-should-not-appear'
    const client = new ChatCompletionsClient(vi.fn().mockRejectedValue(new Error(`TLS failed for ${apiKey}`)))

    await expect(client.verify({ endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-5', apiKey, contextLimit: 12_000 }))
      .rejects.toThrow('模型连接失败（网络或 TLS）')
    await expect(client.verify({ endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-5', apiKey, contextLimit: 12_000 }))
      .rejects.not.toThrow(apiKey)
  })

  it('uses the OpenAI Chat Completions request shape and forwards text deltas', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(
      'data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
    const onDelta = vi.fn()
    const client = new ChatCompletionsClient(fetcher)

    await client.stream(
      { endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-5', apiKey: 'sk-test', contextLimit: 12_000 },
      [{ role: 'user', content: '分析这个错误' }],
      onDelta,
    )

    expect(fetcher).toHaveBeenCalledWith(
      'https://api.openai.com/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer sk-test' }),
        body: JSON.stringify({ model: 'gpt-5', messages: [{ role: 'user', content: '分析这个错误' }], stream: true }),
      }),
    )
    expect(onDelta).toHaveBeenCalledWith('你好')
  })

  it('includes the HTTP status and a bounded response preview for a rejected request', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('invalid API key', { status: 401 }))
    const client = new ChatCompletionsClient(fetcher)

    await expect(client.stream(
      { endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-5', apiKey: 'sk-test', contextLimit: 12_000 },
      [{ role: 'user', content: '分析这个错误' }],
      vi.fn(),
    )).rejects.toThrow('模型连接失败（HTTP 401）：invalid API key')
  })

  it('forwards the active run AbortSignal to fetch', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('data: [DONE]\n\n', { status: 200 }))
    const controller = new AbortController()
    const client = new ChatCompletionsClient(fetcher)

    await client.stream(
      { endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-5', apiKey: 'sk-test', contextLimit: 12_000 },
      [{ role: 'user', content: '分析这个错误' }],
      vi.fn(),
      undefined,
      controller.signal,
    )

    expect(fetcher).toHaveBeenCalledWith('https://api.openai.com/v1/chat/completions', expect.objectContaining({ signal: controller.signal }))
  })
})
