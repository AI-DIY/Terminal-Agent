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

export class ChatCompletionsClient {
  constructor(private readonly fetcher: Fetcher = fetch) {}

  async stream(
    settings: ModelSettingsInput,
    messages: ChatMessage[],
    onDelta: (content: string) => void,
    responseFormat?: ChatCompletionResponseFormat,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await this.fetcher(settings.endpoint, {
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

    if (!response.ok) {
      const preview = (await response.text()).slice(0, 512)
      throw new Error(`HTTP ${response.status}: ${preview}`)
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
