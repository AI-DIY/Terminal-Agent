import type { ModelProvider, ModelRouting } from '../../shared/validation'
import type { ChatMessage, ChatCompletionResponseFormat, Fetcher } from './chat-completions-client'
import { ChatCompletionsClient, ModelConnectionError } from './chat-completions-client'
import type { ChatMessageContent } from '../../shared/chat-content'

export type ProviderModelSettings = {
  endpoint: string
  model: string
  contextLimit: number
  apiKey: string | null
  provider?: ModelProvider
}

export type ModelRouteSelection = {
  routing: ModelRouting
  hasImages: boolean
  llm: ProviderModelSettings | null
  vlm: ProviderModelSettings | null
}

export class ModelProviderRouter {
  private readonly chatCompletions: ChatCompletionsClient
  private readonly fetcher: Fetcher

  constructor(fetcher: Fetcher = fetch) {
    this.fetcher = fetcher
    this.chatCompletions = new ChatCompletionsClient(fetcher)
  }

  resolve(selection: ModelRouteSelection): ProviderModelSettings {
    const profile = selection.routing === 'vision-only' || selection.hasImages ? selection.vlm : selection.llm
    if (!profile) {
      const kind = selection.routing === 'vision-only' || selection.hasImages ? 'VLM' : 'LLM'
      throw new Error(`No active ${kind} model profile`)
    }
    return profile
  }

  select(selection: ModelRouteSelection): ProviderModelSettings {
    return this.resolve(selection)
  }

  route(selection: ModelRouteSelection): ProviderModelSettings {
    return this.resolve(selection)
  }

  async verify(settings: ProviderModelSettings): Promise<{ model: string }> {
    const provider = settings.provider ?? 'openai'
    if (provider !== 'ollama') {
      return this.chatCompletions.verify({
        endpoint: settings.endpoint,
        model: settings.model,
        contextLimit: settings.contextLimit,
        apiKey: settings.apiKey ?? '',
      })
    }

    let response: Response
    try {
      response = await this.request(settings, false)
    } catch {
      throw new ModelConnectionError('模型连接失败（网络或 TLS）。请检查接口地址、网络代理和证书。')
    }
    if (!response.ok) {
      throw httpFailure(response.status)
    }
    return { model: settings.model }
  }

  async stream(
    settings: ProviderModelSettings,
    messages: ChatMessage[],
    onDelta: (content: string) => void,
    responseFormat?: ChatCompletionResponseFormat,
    signal?: AbortSignal,
  ): Promise<void> {
    if ((settings.provider ?? 'openai') !== 'ollama') {
      await this.chatCompletions.stream({
        endpoint: settings.endpoint,
        model: settings.model,
        contextLimit: settings.contextLimit,
        apiKey: settings.apiKey ?? '',
      }, messages, onDelta, responseFormat, signal)
      return
    }

    let response: Response
    try {
      response = await this.request(settings, true, messages, signal)
    } catch (error) {
      if ((error as { name?: unknown }).name === 'AbortError') throw error
      throw new ModelConnectionError('模型连接失败（网络或 TLS）。请检查接口地址、网络代理和证书。')
    }
    if (!response.ok) {
      throw httpFailure(response.status)
    }
    if (!response.body) throw new Error('Ollama response body is empty')

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const chunk = await reader.read()
      buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done })
      buffer = consumeJsonLines(buffer, onDelta)
      if (chunk.done) break
    }
    if (buffer.trim()) consumeJsonLine(buffer.trim(), onDelta)
  }

  private request(
    settings: ProviderModelSettings,
    stream: boolean,
    messages: ChatMessage[] = [{ role: 'user', content: 'ping' }],
    signal?: AbortSignal,
  ): Promise<Response> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`
    return this.fetcher(settings.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: settings.model, messages: (settings.provider ?? 'openai') === 'ollama' ? messages.map(toOllamaMessage) : messages, stream }),
      ...(signal ? { signal } : {}),
    })
  }
}

function toOllamaMessage(message: ChatMessage): { role: ChatMessage['role']; content: string; images?: string[] } {
  if (typeof message.content === 'string') return { role: message.role, content: message.content }
  const text: string[] = []
  const images: string[] = []
  for (const part of message.content) {
    if (part.type === 'text') text.push(part.text)
    else {
      const match = /^data:image\/[^;]+;base64,(.+)$/i.exec(part.image_url.url)
      if (match?.[1]) images.push(match[1])
    }
  }
  return { role: message.role, content: text.join(''), ...(images.length ? { images } : {}) }
}

function consumeJsonLines(buffer: string, onDelta: (content: string) => void): string {
  const lines = buffer.split(/\r?\n/)
  const remainder = lines.pop() ?? ''
  for (const line of lines) consumeJsonLine(line, onDelta)
  return remainder
}

function consumeJsonLine(line: string, onDelta: (content: string) => void): void {
  const trimmed = line.trim()
  if (!trimmed) return
  try {
    const payload = JSON.parse(trimmed) as { message?: { content?: unknown }; response?: unknown }
    const content = payload.message?.content ?? payload.response
    if (typeof content === 'string' && content.length > 0) onDelta(content)
  } catch {
    throw new ModelConnectionError('模型连接失败：Ollama 返回了无效的 JSONL 数据。')
  }
}

function httpFailure(status: number): ModelConnectionError {
  return new ModelConnectionError(`模型连接失败（HTTP ${status}）。请检查模型配置和访问权限。`)
}
