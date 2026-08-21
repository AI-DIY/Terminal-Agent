import { redactSensitiveText } from '../agent/sensitive-data'
import type { ChatMessage } from '../model/chat-completions-client'

export type ChatContextInput = {
  messages: readonly { role: 'user' | 'assistant' | 'system'; content: string; createdAt?: string }[]
  shells?: readonly { hostname: string; title: string; status: 'open' | 'closed' }[]
  facts?: readonly { hostname: string; scope?: string; values?: Record<string, unknown> }[]
  audit?: readonly { kind: string; label: string; at?: string }[]
  maxMessages?: number
}


export function buildChatContext(input: ChatContextInput): ChatMessage[] {
  const maxMessages = Math.max(1, Math.min(input.maxMessages ?? 20, 100))
  const metadata = {
    shells: (input.shells ?? []).filter(shell => shell.status === 'open').map(shell => ({ hostname: redactSensitiveText(shell.hostname), title: redactSensitiveText(shell.title), status: shell.status })),
    facts: (input.facts ?? []).map(fact => ({ hostname: redactSensitiveText(fact.hostname), scope: fact.scope, values: sanitizeObject(fact.values ?? {}) })),
    audit: (input.audit ?? []).map(item => ({ kind: redactSensitiveText(item.kind), label: redactSensitiveText(item.label), ...(item.at ? { at: item.at } : {}) })),
  }
  const recent = [...input.messages]
    .slice(-maxMessages)
    .map(message => ({ role: message.role, content: redactChatText(message.content) }))
  return [
    {
      role: 'system',
      content: `你是 Terminal-Agent 的全局运维助手。只使用脱敏消息、Shell 显示元数据、用户允许的结构化主机事实和近期审计；不得索取、推测或输出密码、私钥、令牌、API Key、临时路径或原始终端历史。上下文元数据：${JSON.stringify(metadata)}`,
    },
    ...recent,
  ]
}

function redactChatText(value: string): string {
  if (/\bbearer\s+/i.test(value)) return value.replace(/(\bbearer\s+)[^\s]+/ig, '$1[REDACTED]')
  return redactSensitiveText(value)
}

function sanitizeObject(value: Record<string, unknown>): Record<string, unknown> {
  return sanitizeRecord(value, 0) as Record<string, unknown>
}

function sanitizeRecord(value: unknown, depth: number): unknown {
  if (depth > 5) return '[TRUNCATED]'
  if (typeof value === 'string') return redactSensitiveText(value)
  if (Array.isArray(value)) return value.slice(0, 100).map(item => sanitizeRecord(item, depth + 1))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, child]) => {
    if (/password|passphrase|private.?key|token|api.?key|secret|credential|raw.?terminal|raw.?output|terminal.?output|command.?output|terminal.?history|stdout|stderr/i.test(key)) return ['[REDACTED FIELD]', '[REDACTED]']
    return [redactSensitiveText(key), sanitizeRecord(child, depth + 1)]
  }))
}
