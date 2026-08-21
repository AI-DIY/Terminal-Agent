/** Deterministic, conservative estimate: CJK code points cost one token, other words cost one per four chars. */
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

export function estimateChatMessages(messages: readonly { content: string }[]): number {
  return messages.reduce((total, message) => total + 4 + estimateChatTokens(message.content), 0)
}
