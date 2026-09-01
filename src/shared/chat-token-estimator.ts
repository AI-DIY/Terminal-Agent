import type { ChatMessageContent } from './chat-content'

/** Deterministic, conservative estimate shared by the chat runtime and workspace UI. */
export function estimateChatTokens(value: string): number {
  let cjk = 0
  let other = ''
  for (const character of value) {
    if (/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(character)) cjk += 1
    else other += character
  }
  if (!other) return cjk
  const compact = other.trim()
  return cjk + (compact ? Math.ceil(compact.length / 4) : 0)
}

export function estimateChatMessages(messages: readonly { content: ChatMessageContent }[]): number {
  return messages.reduce((total, message) => {
    const text = typeof message.content === 'string'
      ? message.content
      : message.content.filter(part => part.type === 'text').map(part => part.text).join('')
    return total + 4 + estimateChatTokens(text)
  }, 0)
}
