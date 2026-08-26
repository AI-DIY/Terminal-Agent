import type { ModelSettingsInput } from '../../shared/validation'
import type { ChatMessageContent } from '../../shared/chat-content'

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant'
  content: ChatMessageContent | any
}

export type Fetcher = typeof fetch

export type ChatCompletionResponseFormat = {
  type: 'json_schema'
  json_schema: {
    name: string
    strict: true
    schema: Record<string, unknown>
  }
}

export class ModelConnectionError extends Error {}

export class ChatCompletionsClient {
  constructor(private readonly fetcher: Fetcher = fetch) {}

  async verify(settings: ModelSettingsInput): Promise<{ model: string }> {
    let response: Response
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`
      response = await this.fetcher(settings.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: settings.model,
          messages: [{ role: 'user', content: 'ping' }],
          stream: false,
        }),
      })
    } catch {
      throw new ModelConnectionError('模型连接失败（网络或 TLS）。请检查接口地址、网络代理和证书。')
    }

    if (!response.ok) {
      throw httpFailure(response.status)
    }
    return { model: settings.model }
  }

  async stream(
    settings: ModelSettingsInput,
    messages: ChatMessage[],
    onDelta: (content: string) => void,
    responseFormat?: ChatCompletionResponseFormat,
    signal?: AbortSignal,
  ): Promise<void> {
    let response: Response
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`
      response = await this.fetcher(settings.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: settings.model,
          messages,
          stream: true,
          ...(responseFormat ? { response_format: responseFormat } : {}),
        }),
        ...(signal ? { signal } : {}),
      })
    } catch (error) {
      if ((error as { name?: unknown }).name === 'AbortError') throw error
      throw new ModelConnectionError('模型连接失败（网络或 TLS）。请检查接口地址、网络代理和证书。')
    }

    if (!response.ok) {
      throw httpFailure(response.status)
    }

    if (!response.body) {
      throw new Error('OpenAI Chat Completions response body is empty')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let done = false

    while (!done) {
      const chunk = await reader.read()
      if (chunk.done) {
        break
      }

      buffer += decoder.decode(chunk.value, { stream: true })
      const result = this.consumeEvents(buffer, onDelta)
      buffer = result.remaining
      done = result.done
    }

    if (!done) {
      this.consumeEvents(buffer + decoder.decode(), onDelta)
    }
  }

  private consumeEvents(buffer: string, onDelta: (content: string) => void): { remaining: string; done: boolean } {
    let remaining = buffer

    while (true) {
      const separator = remaining.match(/\r?\n\r?\n/)
      if (!separator || separator.index === undefined) {
        return { remaining, done: false }
      }

      const event = remaining.slice(0, separator.index)
      remaining = remaining.slice(separator.index + separator[0].length)
      const data = event
        .split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart())
        .join('\n')

      if (!data) {
        continue
      }
      if (data === '[DONE]') {
        return { remaining: '', done: true }
      }

      let payload: { choices?: Array<{ delta?: { content?: unknown } }> }
      try {
        payload = JSON.parse(data) as { choices?: Array<{ delta?: { content?: unknown } }> }
      } catch {
        throw new ModelConnectionError('模型连接失败：模型服务返回了无效的 SSE 数据。')
      }
      const content = payload.choices?.[0]?.delta?.content
      if (typeof content === 'string' && content.length > 0) {
        onDelta(content)
      }
    }
  }
}

function httpFailure(status: number): ModelConnectionError {
  return new ModelConnectionError(`模型连接失败（HTTP ${status}）。请检查模型配置和访问权限。`)
}
