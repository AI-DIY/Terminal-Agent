import { describe, expect, it, vi } from 'vitest'
import { ModelProviderRouter } from '../../../src/main/model/model-provider-router'

describe('ModelProviderRouter', () => {
  it('adapts Ollama JSONL streaming into text deltas', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(
      '{"message":{"content":"你好"},"done":false}\n{"message":{"content":"世界"},"done":true}\n',
      { status: 200, headers: { 'content-type': 'application/x-ndjson' } },
    ))
    const router = new ModelProviderRouter(fetcher)
    const onDelta = vi.fn()

    await router.stream({ provider: 'ollama', endpoint: 'http://127.0.0.1:11434/api/chat', model: 'qwen', contextLimit: 8_000, apiKey: null }, [{ role: 'user', content: 'ping' }], onDelta)

    expect(onDelta.mock.calls.map(([delta]) => delta).join('')).toBe('你好世界')
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:11434/api/chat', expect.objectContaining({ body: expect.stringContaining('"stream":true') }))
  })

  it('uses the OpenAI-compatible adapter for llama.cpp and keeps errors free of credentials', async () => {
    const key = 'tenant-secret'
    const fetcher = vi.fn().mockResolvedValue(new Response(`bad ${key}`, { status: 401 }))
    const router = new ModelProviderRouter(fetcher)

    await expect(router.verify({ provider: 'llama-cpp', endpoint: 'http://127.0.0.1:8080/v1/chat/completions', model: 'qwen', contextLimit: 8_000, apiKey: key }))
      .rejects.not.toThrow(key)
  })

  it('does not return an Ollama error body that could contain another configured credential', async () => {
    const apiKey = 'ollama-active-credential'
    const otherKey = 'ollama-other-credential'
    const errorBody = JSON.stringify({ supplied: apiKey, api_key: otherKey })
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(errorBody, { status: 401 }))
      .mockResolvedValueOnce(new Response(errorBody, { status: 401 }))
    const router = new ModelProviderRouter(fetcher)

    const firstError = await router.verify({ provider: 'ollama', endpoint: 'http://127.0.0.1:11434/api/chat', model: 'qwen', contextLimit: 8_000, apiKey }).catch(error => error as Error)
    const secondError = await router.verify({ provider: 'ollama', endpoint: 'http://127.0.0.1:11434/api/chat', model: 'qwen', contextLimit: 8_000, apiKey }).catch(error => error as Error)

    for (const error of [firstError, secondError]) {
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).not.toContain(apiKey)
      expect((error as Error).message).not.toContain(otherKey)
    }
  })
})
