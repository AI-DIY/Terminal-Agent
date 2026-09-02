import type { ChatMessage } from '../model/chat-completions-client'
import type { ChatMessageContent } from '../../shared/chat-content'
import {
  modelDisplayName,
  modelHostname,
  projectModelFacts,
  sanitizeModelContent,
  stripIpLiterals,
} from '../../shared/model-context'
import { resolveModelShellTargets } from '../../shared/model-shell-target'

export type ChatContextInput = {
  messages: readonly { role: 'user' | 'assistant' | 'system'; content: ChatMessageContent; createdAt?: string; messageType?: string; executionPlan?: unknown }[]
  shells?: readonly { hostname: string; observedHostname?: string; title: string; status: 'open' | 'closed'; displayLabel?: string; ordinal?: number; recentLines?: readonly string[] }[]
  facts?: readonly { hostname: string; scope?: string; values?: Record<string, unknown> }[]
  audit?: readonly { kind: string; label: string; at?: string }[]
  maxMessages?: number
}

export function buildChatContext(input: ChatContextInput): ChatMessage[] {
  const maxMessages = Math.max(1, Math.min(input.maxMessages ?? 20, 100))
  const metadata = {
    shells: projectShells(input.shells ?? []),
    facts: projectFacts(input.facts ?? []),
    audit: (input.audit ?? []).map(item => ({
      kind: stripIpLiterals(item.kind),
      label: stripIpLiterals(item.label),
      ...(item.at ? { at: stripIpLiterals(item.at) } : {}),
    })),
  }
  // A compaction summary is a durable context boundary. The transcript stays
  // available in the UI, while future model requests receive the summary and
  // only the conversation that followed it.
  const compacted = messagesSinceLatestSummary(input.messages, maxMessages)
  const recent = compacted
    .slice(-maxMessages)
    .map(message => ({
      role: message.role,
      // Keep ordinary user text intact; only application-generated history is
      // projected so an explicitly supplied target is not silently rewritten.
      content: message.role === 'user' && !message.messageType
        ? (typeof message.content === 'string' ? message.content : structuredClone(message.content))
        : sanitizeModelContent(typeof message.content === 'string' ? message.content : structuredClone(message.content)),
    }))
  return [
    {
      role: 'system',
      content: `你是 Terminal-Agent 的全局运维助手。任务上下文：${JSON.stringify(metadata)}`,
    },
    ...recent,
  ]
}

function messagesSinceLatestSummary<T extends { messageType?: string }>(messages: readonly T[], maxMessages: number): T[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.messageType === 'context_summary') {
      // Keep the summary itself even when the post-summary transcript is
      // longer than the rolling message window.  It is the durable boundary
      // that explains the omitted history to the next model request.
      const summary = messages[index]
      const following = messages.slice(index + 1)
      return [summary, ...following.slice(-(Math.max(0, maxMessages - 1)))]
    }
  }
  return [...messages]
}

type ContextShell = NonNullable<ChatContextInput['shells']>[number]
type ContextFact = NonNullable<ChatContextInput['facts']>[number]

function projectShells(shells: readonly ContextShell[]): Array<Record<string, unknown>> {
  const liveShells = shells.filter(shell => shell.status === 'open')
  const targets = resolveModelShellTargets(liveShells.map(shell => ({
    hostname: shell.hostname,
    observedHostname: shell.observedHostname,
    displayName: shell.title,
  })))
  return liveShells.map((shell, index) => {
    const observedHostname = modelHostname(shell.observedHostname)
    const hostname = targets[index]!
    return {
      hostname,
      ...(observedHostname ? { observedHostname } : {}),
      title: modelDisplayName(shell.title, hostname),
      ...(shell.displayLabel ? { displayLabel: modelDisplayName(shell.displayLabel, hostname) } : {}),
      ...(shell.ordinal !== undefined ? { ordinal: shell.ordinal } : {}),
      ...(shell.recentLines ? { recentLines: shell.recentLines.map(stripIpLiterals) } : {}),
    }
  })
}

function projectFacts(facts: readonly ContextFact[]): Array<{ hostname: string; scope?: string; values?: Record<string, unknown> }> {
  const byHostname = new Map<string, { hostname: string; scope?: string; values?: Record<string, unknown> }>()
  for (const fact of facts) {
    const hostname = modelHostname(fact.hostname)
    if (!hostname) continue
    const values = projectModelFacts(fact.values ?? {}) as Record<string, unknown>
    const previous = byHostname.get(hostname)
    const scope = previous?.scope ?? sanitizeScope(fact.scope)
    const mergedValues = { ...(previous?.values ?? {}), ...values }
    byHostname.set(hostname, {
      hostname,
      ...(scope !== undefined ? { scope } : {}),
      ...(Object.keys(mergedValues).length > 0 ? { values: mergedValues } : {}),
    })
  }
  return [...byHostname.values()]
}

function sanitizeScope(value: string | undefined): string | undefined {
  const sanitized = value ? stripIpLiterals(value).trim() : ''
  return sanitized || undefined
}
