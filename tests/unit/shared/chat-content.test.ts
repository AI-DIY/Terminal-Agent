import { describe, expect, it } from 'vitest'
import {
  chatContentHasImages,
  chatContentText,
  chatHistoryHasImages,
  chatImageCount,
  chatMessageContentSchema,
} from '../../../src/shared/chat-content'

const png = 'data:image/png;base64,AA=='

describe('chat message content', () => {
  it('accepts text and image_url blocks while rejecting non-image Data URLs', () => {
    expect(chatMessageContentSchema.parse([
      { type: 'text', text: '检查截图' },
      { type: 'image_url', image_url: { url: png } },
    ])).toHaveLength(2)
    expect(() => chatMessageContentSchema.parse([
      { type: 'image_url', image_url: { url: 'data:text/plain;base64,QQ==' } },
    ])).toThrow()
  })

  it('preserves pure text compatibility and excludes image data from text helpers', () => {
    expect(chatMessageContentSchema.parse('纯文本')).toBe('纯文本')
    const content = [{ type: 'text', text: '检查截图' }, { type: 'image_url', image_url: { url: png } }] as const
    expect(chatContentText(content)).toBe('检查截图')
    expect(chatImageCount(content)).toBe(1)
    expect(chatContentHasImages(content)).toBe(true)
  })

  it('detects images in current and historical message content', () => {
    expect(chatHistoryHasImages([{ content: '纯文字' }])).toBe(false)
    expect(chatHistoryHasImages([{ content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AA==' } }] }])).toBe(true)
  })

  it('limits images to eight, each decoded image to five MiB, and all Data URLs to eight million characters', () => {
    expect(() => chatMessageContentSchema.parse(Array.from({ length: 9 }, () => ({ type: 'image_url', image_url: { url: png } })))).toThrow()
    expect(() => chatMessageContentSchema.parse([
      { type: 'image_url', image_url: { url: `data:image/webp;base64,${'A'.repeat(Math.ceil((5 * 1024 * 1024 + 1) * 4 / 3))}` } },
    ])).toThrow()
    expect(() => chatMessageContentSchema.parse([
      { type: 'image_url', image_url: { url: `data:image/gif;base64,${'A'.repeat(4_000_001)}` } },
      { type: 'image_url', image_url: { url: `data:image/gif;base64,${'A'.repeat(4_000_001)}` } },
    ])).toThrow()
  })
})
