const unsafeProperties = new Set(['__proto__', 'prototype', 'constructor'])

export type SsoFieldSegment =
  | { kind: 'property'; key: string }
  | { kind: 'index'; index: number }

export function parseSsoFieldPath(path: string): readonly SsoFieldSegment[] {
  const source = path.trim()
  if (source.length === 0 || source.length > 512) throw new Error('SSO field path cannot be empty')

  let cursor = 0
  const segments: SsoFieldSegment[] = []
  let rootPrefix = false
  if (source[cursor] === '$') {
    cursor += 1
    rootPrefix = true
    if (cursor === source.length) throw new Error('SSO field path must select a value')
  }

  let expectsSegment = true
  while (cursor < source.length) {
    const character = source[cursor]
    if (character === '.') {
      if (expectsSegment && !rootPrefix) throw new Error('Invalid SSO field path')
      cursor += 1
      expectsSegment = true
      rootPrefix = false
      continue
    }

    if (!expectsSegment && character !== '[') throw new Error('Invalid SSO field path')

    if (character === '[') {
      const parsed = parseBracketSegment(source, cursor)
      addSegment(segments, parsed.segment)
      cursor = parsed.cursor
      expectsSegment = false
      continue
    }

    const remaining = source.slice(cursor)
    const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(remaining)
    if (!match) throw new Error('Invalid SSO field path')
    addSegment(segments, { kind: 'property', key: match[0] })
    cursor += match[0].length
    expectsSegment = false
  }

  if (expectsSegment || segments.length === 0) throw new Error('Invalid SSO field path')
  return segments
}

export function readSsoField(root: unknown, path: string): string | undefined {
  let current: unknown = root
  for (const segment of parseSsoFieldPath(path)) {
    if (segment.kind === 'property') {
      if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined
      if (!Object.prototype.hasOwnProperty.call(current, segment.key)) return undefined
      current = (current as Record<string, unknown>)[segment.key]
      continue
    }

    if (!Array.isArray(current) || segment.index >= current.length) return undefined
    current = current[segment.index]
  }

  if (typeof current === 'string') {
    const value = current.trim()
    return value.length > 0 ? value : undefined
  }
  return typeof current === 'number' && Number.isFinite(current) ? String(current) : undefined
}

function parseBracketSegment(source: string, start: number): { segment: SsoFieldSegment; cursor: number } {
  let cursor = start + 1
  if (cursor >= source.length) throw new Error('Invalid SSO field path')

  const quote = source[cursor]
  if (quote === "'" || quote === '"') {
    cursor += 1
    let key = ''
    while (cursor < source.length && source[cursor] !== quote) {
      if (source[cursor] === '\\') {
        cursor += 1
        if (cursor >= source.length) throw new Error('Invalid SSO field path')
      }
      key += source[cursor]
      cursor += 1
    }
    if (cursor >= source.length || source[cursor] !== quote || source[cursor + 1] !== ']') throw new Error('Invalid SSO field path')
    if (key.length === 0) throw new Error('Invalid SSO field path')
    return { segment: propertySegment(key), cursor: cursor + 2 }
  }

  const indexStart = cursor
  while (cursor < source.length && /[0-9]/.test(source[cursor])) cursor += 1
  if (indexStart === cursor || source[cursor] !== ']') throw new Error('Invalid SSO field path')
  const index = Number(source.slice(indexStart, cursor))
  if (!Number.isSafeInteger(index)) throw new Error('Invalid SSO field path')
  return { segment: { kind: 'index', index }, cursor: cursor + 1 }
}

function addSegment(segments: SsoFieldSegment[], segment: SsoFieldSegment): void {
  if (segment.kind === 'property' && unsafeProperties.has(segment.key)) throw new Error('Unsafe SSO field path property')
  segments.push(segment)
}

function propertySegment(key: string): SsoFieldSegment {
  if (unsafeProperties.has(key)) throw new Error('Unsafe SSO field path property')
  return { kind: 'property', key }
}
