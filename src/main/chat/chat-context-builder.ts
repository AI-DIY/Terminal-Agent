import type { ChatMessage } from '../model/chat-completions-client'
import type { ChatMessageContent } from '../../shared/chat-content'

export type ChatContextInput = {
  messages: readonly { role: 'user' | 'assistant' | 'system'; content: ChatMessageContent; createdAt?: string; messageType?: string; executionPlan?: unknown }[]
  shells?: readonly { hostname: string; title: string; status: 'open' | 'closed' }[]
  facts?: readonly { hostname: string; scope?: string; values?: Record<string, unknown> }[]
  audit?: readonly { kind: string; label: string; at?: string }[]
  maxMessages?: number
}

export function buildChatContext(input: ChatContextInput): ChatMessage[] {
  const maxMessages = Math.max(1, Math.min(input.maxMessages ?? 20, 100))
  const metadata = {
    shells: (input.shells ?? []).filter(shell => shell.status === 'open'),
    facts: input.facts ?? [],
    audit: input.audit ?? [],
  }
  const recent = [...input.messages]
    .slice(-maxMessages)
    .map(message => ({
      role: message.role,
      content: typeof message.content === 'string' ? message.content : structuredClone(message.content),
    }))
  return [
    {
      role: 'system',
      content: `你是 Terminal-Agent 的全局运维助手。任务上下文：${JSON.stringify(metadata)}`,
    },
    ...recent,
  ]
}
