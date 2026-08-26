import type { ChatMessageContent } from '../../shared/chat-content'

/** 确定性且保守的估算：中文字符按 1 token，其余字符每 4 个按 1 token。 */
export function estimateChatTokens(value: string): number {
  let cjk = 0
  let other = ''
  for (const character of value) {
    if (/[㐀-鿿぀-ヿ가-힯]/u.test(character)) cjk += 1
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
