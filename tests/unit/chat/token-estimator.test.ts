import { describe, expect, it } from 'vitest'
import { estimateChatTokens } from '../../../src/main/chat/token-estimator'

describe('token estimator', () => {
  it('estimates only textual parts of multimodal messages', async () => {
    const { estimateChatMessages } = await import('../../../src/main/chat/token-estimator')
    expect(estimateChatMessages([{ content: [
      { type: 'text', text: '你好' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(1000) } },
    ] }])).toBe(6)
  })
  it('uses deterministic weighted counts for Chinese and non-Chinese text', () => {
    expect(estimateChatTokens('你好世界')).toBe(4)
    expect(estimateChatTokens('hello world')).toBe(3)
    expect(estimateChatTokens('')).toBe(0)
  })
})
