export type MarkdownInline =
  | { type: 'text'; value: string }
  | { type: 'line-break' }
  | { type: 'code'; value: string }
  | { type: 'strong'; children: MarkdownInline[] }
  | { type: 'emphasis'; children: MarkdownInline[] }
  | { type: 'strikethrough'; children: MarkdownInline[] }
  | { type: 'link'; href: string; children: MarkdownInline[] }

export type MarkdownBlock =
  | { type: 'paragraph'; content: MarkdownInline[] }
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; content: MarkdownInline[] }
  | { type: 'code'; language?: string; value: string }
  | { type: 'quote'; content: MarkdownInline[] }
  | { type: 'unordered-list'; items: MarkdownInline[][] }
  | { type: 'ordered-list'; start: number; items: MarkdownInline[][] }
  | { type: 'table'; header: MarkdownInline[][]; rows: MarkdownInline[][][] }
  | { type: 'thematic-break' }

const headingPattern = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/
const unorderedListPattern = /^\s*[-+*]\s+(.+)$/
const orderedListPattern = /^\s*(\d+)[.)]\s+(.+)$/
const fencePattern = /^ {0,3}(`{3,}|~{3,})\s*(.*?)\s*$/
const thematicBreakPattern = /^ {0,3}(?:[-*_]\s*){3,}$/
type InlineDelimiter = '`' | '**' | '__' | '~~' | '*' | '_' | '](' | ')'
type InlineDelimiterSearch = { find: (delimiter: InlineDelimiter, start: number) => number }

/**
 * Converts the small, useful Markdown subset used in chat replies into data
 * that Vue can render with text interpolation. Model-provided HTML never
 * becomes DOM markup.
 */
export function parseSafeMarkdown(value: string): MarkdownBlock[] {
  const lines = value.replace(/\r\n?/g, '\n').split('\n')
  const blocks: MarkdownBlock[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (!line.trim()) {
      index += 1
      continue
    }

    const fence = fencePattern.exec(line)
    if (fence) {
      const codeLines: string[] = []
      const marker = fence[1] ?? '```'
      const closingPattern = marker[0] === '`' ? /^ {0,3}`{3,}\s*$/ : /^ {0,3}~{3,}\s*$/
      index += 1
      while (index < lines.length && !closingPattern.test(lines[index] ?? '')) {
        codeLines.push(lines[index] ?? '')
        index += 1
      }
      if (index < lines.length) index += 1
      const language = (fence[2] ?? '').trim()
      blocks.push({ type: 'code', ...(language ? { language } : {}), value: codeLines.join('\n') })
      continue
    }

    const heading = headingPattern.exec(line)
    if (heading) {
      blocks.push({
        type: 'heading',
        level: heading[1]!.length as 1 | 2 | 3 | 4 | 5 | 6,
        content: parseInline(heading[2] ?? ''),
      })
      index += 1
      continue
    }

    if (thematicBreakPattern.test(line)) {
      blocks.push({ type: 'thematic-break' })
      index += 1
      continue
    }

    if (line.trimStart().startsWith('>')) {
      const quoteLines: string[] = []
      while (index < lines.length) {
        const quote = /^\s*>\s?(.*)$/.exec(lines[index] ?? '')
        if (!quote) break
        quoteLines.push(quote[1] ?? '')
        index += 1
      }
      blocks.push({ type: 'quote', content: parseInline(quoteLines.join('\n')) })
      continue
    }

    const unordered = unorderedListPattern.exec(line)
    if (unordered) {
      const items: MarkdownInline[][] = []
      while (index < lines.length) {
        const item = unorderedListPattern.exec(lines[index] ?? '')
        if (!item) break
        items.push(parseInline(item[1] ?? ''))
        index += 1
      }
      blocks.push({ type: 'unordered-list', items })
      continue
    }

    const ordered = orderedListPattern.exec(line)
    if (ordered) {
      const items: MarkdownInline[][] = []
      const start = Number(ordered[1]) || 1
      while (index < lines.length) {
        const item = orderedListPattern.exec(lines[index] ?? '')
        if (!item) break
        items.push(parseInline(item[2] ?? ''))
        index += 1
      }
      blocks.push({ type: 'ordered-list', start, items })
      continue
    }

    if (isTableStart(lines, index)) {
      const header = splitTableRow(line).map(parseInline)
      const rows: MarkdownInline[][][] = []
      index += 2
      while (index < lines.length && looksLikeTableRow(lines[index] ?? '')) {
        rows.push(splitTableRow(lines[index] ?? '').map(parseInline))
        index += 1
      }
      blocks.push({ type: 'table', header, rows })
      continue
    }

    const paragraphLines = [line]
    index += 1
    while (index < lines.length && !isBlockStart(lines, index)) {
      paragraphLines.push(lines[index] ?? '')
      index += 1
    }
    blocks.push({ type: 'paragraph', content: parseInline(paragraphLines.join('\n')) })
  }

  return blocks
}

function parseInline(value: string): MarkdownInline[] {
  const segments: MarkdownInline[] = []
  const textParts: string[] = []
  const delimiters = createInlineDelimiterSearch(value)
  const linkResults = new Map<string, string | null>()
  let index = 0
  let textStart = 0

  const appendLiteral = (end: number): void => {
    if (end > textStart) textParts.push(value.slice(textStart, end))
  }

  const flushText = (): void => {
    if (textParts.length === 0) return
    segments.push({ type: 'text', value: textParts.join('') })
    textParts.length = 0
  }

  while (index < value.length) {
    const character = value[index] ?? ''
    if (character === '\\' && index + 1 < value.length) {
      appendLiteral(index)
      textParts.push(value[index + 1] ?? '')
      index += 2
      textStart = index
      continue
    }

    if (character === '\n') {
      appendLiteral(index)
      flushText()
      segments.push({ type: 'line-break' })
      index += 1
      textStart = index
      continue
    }

    if (character === '`') {
      const closing = delimiters.find('`', index + 1)
      if (closing > index + 1) {
        appendLiteral(index)
        flushText()
        segments.push({ type: 'code', value: value.slice(index + 1, closing) })
        index = closing + 1
        textStart = index
        continue
      }
    }

    const paired = parsePairedInline(value, index, '**', 'strong', delimiters)
      ?? parsePairedInline(value, index, '__', 'strong', delimiters)
      ?? parsePairedInline(value, index, '~~', 'strikethrough', delimiters)
      ?? parsePairedInline(value, index, '*', 'emphasis', delimiters)
      ?? parsePairedInline(value, index, '_', 'emphasis', delimiters)
    if (paired) {
      appendLiteral(index)
      flushText()
      segments.push(paired.segment)
      index = paired.nextIndex
      textStart = index
      continue
    }

    if (character === '[') {
      const labelEnd = delimiters.find('](', index + 1)
      const urlEnd = labelEnd === -1 ? -1 : delimiters.find(')', labelEnd + 2)
      if (labelEnd > index + 1 && urlEnd > labelEnd + 2) {
        const linkKey = `${labelEnd}:${urlEnd}`
        let href = linkResults.get(linkKey)
        if (href === undefined) {
          href = safeMarkdownHref(value.slice(labelEnd + 2, urlEnd))
          linkResults.set(linkKey, href)
        }
        if (href) {
          appendLiteral(index)
          flushText()
          segments.push({ type: 'link', href, children: parseInline(value.slice(index + 1, labelEnd)) })
          index = urlEnd + 1
          textStart = index
          continue
        }
      }
    }

    index += 1
  }

  appendLiteral(value.length)
  flushText()
  return segments
}

/**
 * Inline parsing advances left-to-right, so each delimiter's next occurrence
 * can be discovered once and reused instead of rescanning the remaining
 * content for every candidate. A separate instance is created for recursive
 * link-label parsing, where offsets belong to a different string.
 */
function createInlineDelimiterSearch(value: string): InlineDelimiterSearch {
  const lastMatches = new Map<string, number | undefined>()

  return {
    find(delimiter, start): number {
      let match = lastMatches.get(delimiter)
      if (match === undefined) {
        match = value.indexOf(delimiter, start)
      } else {
        while (match !== -1 && match < start) {
          match = value.indexOf(delimiter, match + 1)
        }
      }
      lastMatches.set(delimiter, match)
      return match
    },
  }
}

function parsePairedInline(
  value: string,
  index: number,
  delimiter: '**' | '__' | '~~' | '*' | '_',
  type: 'strong' | 'strikethrough' | 'emphasis',
  delimiters: InlineDelimiterSearch,
): { segment: MarkdownInline; nextIndex: number } | null {
  if (!value.startsWith(delimiter, index)) return null
  const closing = delimiters.find(delimiter, index + delimiter.length)
  if (closing <= index + delimiter.length) return null
  const children = parseInline(value.slice(index + delimiter.length, closing))
  return {
    segment: { type, children },
    nextIndex: closing + delimiter.length,
  }
}

function safeMarkdownHref(value: string): string | null {
  const href = value.trim()
  if (!href || !/^(https?:|mailto:)/i.test(href) || containsUnsafeUrlCharacters(href)) return null
  try {
    const parsed = new URL(href)
    return ['http:', 'https:', 'mailto:'].includes(parsed.protocol) ? parsed.href : null
  } catch {
    return null
  }
}

function containsUnsafeUrlCharacters(value: string): boolean {
  return [...value].some(character => {
    const code = character.charCodeAt(0)
    return /\s/.test(character) || code < 0x20 || code === 0x7f
  })
}

function isTableStart(lines: readonly string[], index: number): boolean {
  const header = lines[index] ?? ''
  const divider = lines[index + 1] ?? ''
  if (!looksLikeTableRow(header)) return false
  const headerCells = splitTableRow(header)
  const dividerCells = splitTableRow(divider)
  return headerCells.length > 0
    && headerCells.length === dividerCells.length
    && dividerCells.every(cell => /^:?-{3,}:?$/.test(cell))
}

function looksLikeTableRow(value: string): boolean {
  return value.includes('|')
}

function splitTableRow(value: string): string[] {
  const trimmed = value.trim()
  const withoutEdges = trimmed.replace(/^\|/, '').replace(/\|$/, '')
  return withoutEdges.split('|').map(cell => cell.trim())
}

function isBlockStart(lines: readonly string[], index: number): boolean {
  const line = lines[index] ?? ''
  return !line.trim()
    || fencePattern.test(line)
    || headingPattern.test(line)
    || thematicBreakPattern.test(line)
    || line.trimStart().startsWith('>')
    || unorderedListPattern.test(line)
    || orderedListPattern.test(line)
    || isTableStart(lines, index)
}
