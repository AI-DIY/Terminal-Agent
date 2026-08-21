import { describe, expect, it } from 'vitest'
import { estimateChatTokens } from '../../../src/main/chat/token-estimator'

describe('token estimator', () => {
  it('uses deterministic weighted counts for Chinese and non-Chinese text', () => {
    expect(estimateChatTokens('你好世界')).toBe(4)
    expect(estimateChatTokens('hello world')).toBe(3)
    expect(estimateChatTokens('')).toBe(0)
  })
})
