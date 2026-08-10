import type { ModelSettingsInput } from '../../shared/validation'

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
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
      response = await this.fetcher(settings.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${settings.apiKey}`,
          'Content-Type': 'application/json',
        },
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
      throw new ModelConnectionError(`模型连接失败（HTTP ${response.status}）：${safePreview(await response.text(), settings.apiKey)}`)
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
      response = await this.fetcher(settings.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${settings.apiKey}`,
          'Content-Type': 'application/json',
        },
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
      throw new ModelConnectionError(`模型连接失败（HTTP ${response.status}）：${safePreview(await response.text(), settings.apiKey)}`)
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

      const payload = JSON.parse(data) as { choices?: Array<{ delta?: { content?: unknown } }> }
      const content = payload.choices?.[0]?.delta?.content
      if (typeof content === 'string' && content.length > 0) {
        onDelta(content)
      }
    }
  }
}

function safePreview(value: string, apiKey: string): string {
  const withConfiguredKeyRedacted = apiKey ? value.split(apiKey).join('[REDACTED]') : value
  const safe = withConfiguredKeyRedacted
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/\b(api[ _-]?key|token|password)\s*[:=]\s*\S+/gi, '$1=[REDACTED]')
    .trim()
    .slice(0, 512)
  return safe || '接口未返回可显示的错误详情。'
}
