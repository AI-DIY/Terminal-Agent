import { describe, expect, it, vi } from 'vitest'
import { ChatCompletionsClient } from '../../../src/main/model/chat-completions-client'

describe('ChatCompletionsClient', () => {
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
    )).rejects.toThrow('HTTP 401: invalid API key')
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
