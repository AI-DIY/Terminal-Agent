import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { parseSafeMarkdown } from '../../../src/renderer/src/components/chat/safe-markdown'

describe('safe AI Markdown rendering', () => {
  it('parses ordinary reply formatting into structural blocks and inline tokens', () => {
    const blocks = parseSafeMarkdown([
      '# 检查结果',
      '',
      '服务状态为 **正常**，请查看 [运行手册](https://example.com/runbook)。',
      '',
      '- `api` 已启动',
      '- `worker` 已启动',
      '',
      '```bash',
      'systemctl status api',
      '```',
    ].join('\n'))

    expect(blocks).toEqual([
      { type: 'heading', level: 1, content: [{ type: 'text', value: '检查结果' }] },
      {
        type: 'paragraph',
        content: [
          { type: 'text', value: '服务状态为 ' },
          { type: 'strong', children: [{ type: 'text', value: '正常' }] },
          { type: 'text', value: '，请查看 ' },
          { type: 'link', href: 'https://example.com/runbook', children: [{ type: 'text', value: '运行手册' }] },
          { type: 'text', value: '。' },
        ],
      },
      {
        type: 'unordered-list',
        items: [
          [{ type: 'code', value: 'api' }, { type: 'text', value: ' 已启动' }],
          [{ type: 'code', value: 'worker' }, { type: 'text', value: ' 已启动' }],
        ],
      },
      { type: 'code', language: 'bash', value: 'systemctl status api' },
    ])
  })

  it('keeps model HTML and unsafe link protocols as text while retaining safe links', () => {
    const html = '<img src=x onerror=alert(1)>'
    const unsafeLink = '[运行](javascript:alert(1))'
    const blocks = parseSafeMarkdown(`${html}\n\n${unsafeLink}\n\n[文档](mailto:ops@example.com)`)

    expect(blocks).toEqual([
      { type: 'paragraph', content: [{ type: 'text', value: html }] },
      { type: 'paragraph', content: [{ type: 'text', value: unsafeLink }] },
      {
        type: 'paragraph',
        content: [{ type: 'link', href: 'mailto:ops@example.com', children: [{ type: 'text', value: '文档' }] }],
      },
    ])
  })

  it('keeps delimiter-heavy assistant text within a linear search budget without timing assertions', () => {
    const openingDelimiterCount = 4_096
    const content = `${'*'.repeat(openingDelimiterCount)} plain ${'`'.repeat(openingDelimiterCount)} plain ${'['.repeat(openingDelimiterCount)}](javascript:alert(1))`
    const originalIndexOf = String.prototype.indexOf
    let inspectedCharacters = 0
    const indexOfSpy = vi.spyOn(String.prototype, 'indexOf').mockImplementation(function (
      this: string,
      searchString: string,
      position?: number,
    ): number {
      const result = originalIndexOf.call(this, searchString, position)
      if (['`', '**', '__', '~~', '*', '_', '](', ')'].includes(searchString)) {
        const start = position ?? 0
        const end = result === -1 ? this.length : result + searchString.length
        inspectedCharacters += Math.max(0, end - start)
      }
      return result
    })

    let blocks: ReturnType<typeof parseSafeMarkdown>
    try {
      blocks = parseSafeMarkdown(content)
    } finally {
      indexOfSpy.mockRestore()
    }

    expect(blocks).toEqual([{ type: 'paragraph', content: [{ type: 'text', value: content }] }])
    expect(inspectedCharacters).toBeLessThan(content.length * 12)
  })

  it('parses one safe link with a delimiter-heavy label without recursively rescanning its suffixes', () => {
    const openingDelimiterCount = 4_096
    const label = '['.repeat(openingDelimiterCount - 1)
    const content = `[${label}](https://example.com/runbook)`
    const originalSlice = String.prototype.slice
    let slicedCharacters = 0
    const sliceSpy = vi.spyOn(String.prototype, 'slice').mockImplementation(function (
      this: string,
      start?: number,
      end?: number,
    ): string {
      const result = originalSlice.call(this, start, end)
      slicedCharacters += result.length
      return result
    })

    let blocks: ReturnType<typeof parseSafeMarkdown>
    try {
      blocks = parseSafeMarkdown(content)
    } finally {
      sliceSpy.mockRestore()
    }

    expect(blocks).toEqual([
      {
        type: 'paragraph',
        content: [{ type: 'link', href: 'https://example.com/runbook', children: [{ type: 'text', value: label }] }],
      },
    ])
    expect(slicedCharacters).toBeLessThan(content.length * 5)
  })

  it('uses the structural renderer only for ordinary assistant replies', () => {
    const panel = readFileSync(new URL('../../../src/renderer/src/components/chat/GlobalChatPanel.vue', import.meta.url), 'utf8')
    const markdown = readFileSync(new URL('../../../src/renderer/src/components/chat/SafeMarkdown.vue', import.meta.url), 'utf8')
    const inline = readFileSync(new URL('../../../src/renderer/src/components/chat/MarkdownInline.vue', import.meta.url), 'utf8')

    expect(panel).toContain("import SafeMarkdown from './SafeMarkdown.vue'")
    expect(panel).toContain("<SafeMarkdown v-if=\"message.role === 'assistant' && message.messageType !== 'execution_audit'\" :content=\"assistantReply(message.content)\" />")
    expect(panel).toContain('<p v-else>{{ message.messageType === \'execution_audit\'')
    expect(panel).toContain('<section v-if="message.executionPlan" class="execution-plan plan-card"')
    expect(panel).toContain('<article v-if="progress" class="message assistant progress-message">')
    expect(markdown).not.toContain('v-html')
    expect(inline).not.toContain('v-html')
    expect(inline).toContain('rel="noopener noreferrer"')
  })
})
