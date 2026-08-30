/**
 * Helpers for projecting connection data into a model-facing context.
 * Connection addresses are transport metadata and must not become host
 * identity hints in prompts or serialized model requests.
 */

export type ModelMessageLike = {
  role?: 'system' | 'user' | 'assistant' | string
  content: unknown
  messageType?: string
}

export function isIpLiteral(value: string): boolean {
  const unwrapped = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value
  return isIpv4Literal(unwrapped) || isIpv6Literal(unwrapped)
}

/** Remove IPv4/IPv6 literals while leaving surrounding hostnames and text. */
export function stripIpLiterals(value: string): string {
  const withoutBracketed = value.replace(/\[([^\x5D]+)\]/g, (whole, inner: string) => {
    // Bracketed hosts are common in URLs and SSH labels. Remove the brackets
    // together with the address so an empty `[]` placeholder is not emitted.
    return isIpLiteral(inner.replace(/\/\d{1,3}$/, '')) ? '' : whole
  })
  // First remove IPv6 candidates. The candidate expression is deliberately
  // broad; `findIpv6Span` performs strict validation and trims punctuation
  // (including a trailing dot, CIDR delimiter, or URL bracket) before
  // removing anything. This avoids leaking addresses while leaving ordinary
  // colon-delimited text such as timestamps untouched.
  const withoutIpv6 = withoutBracketed.replace(ipv6CandidatePattern, (token, _offset, source) => {
    const span = findIpv6Span(token, source, Number(_offset))
    if (!span) return token
    return `${token.slice(0, span.start)}${token.slice(span.end)}`
  })
  return withoutIpv6.replace(/\d{1,3}(?:\.\d{1,3}){3}/g, token => isIpv4Literal(token) ? '' : token)
}

// At least two colons are required for an IPv6 address. The rest is allowed
// to include zone-index characters and punctuation so that a strict parser
// can decide where the address actually ends (for example before `.example`).
const ipv6CandidatePattern = /[0-9A-Fa-f:.%][0-9A-Za-z_.:%~-]*:[0-9A-Za-z_.:%~-]*/g
const MAX_IPV6_CANDIDATE_LENGTH = 128

function findIpv6Span(token: string, source: string, offset: number): { start: number; end: number } | null {
  const limit = Math.min(token.length, MAX_IPV6_CANDIDATE_LENGTH)
  for (let start = 0; start < token.length; start += 1) {
    const absoluteStart = offset + start
    // Do not begin in the middle of an identifier. A preceding punctuation
    // character (including `[` or `=`) is a valid boundary.
    const previous = start > 0 ? token[start - 1] : source[absoluteStart - 1]
    if (previous && /[A-Za-z0-9]/.test(previous)) continue
    // A colon immediately following an identifier is usually part of that
    // identifier (for example `identifierx2001:db8::10`), not an address
    // boundary. Reject starts after that colon so a valid IPv6 suffix cannot
    // be partially removed from ordinary text.
    if (previous === ':') {
      const beforeColon = start > 1 ? token[start - 2] : source[absoluteStart - 2]
      if (beforeColon && /[A-Za-z0-9]/.test(beforeColon)) continue
    }
    if (!/[0-9A-Fa-f:]/.test(token[start]!)) continue

    const endLimit = Math.min(token.length, start + limit)
    for (let end = endLimit; end > start + 1; end -= 1) {
      const candidate = token.slice(start, end)
      if (!candidate.includes(':') || !isIpv6Literal(candidate)) continue
      const next = token[end]
      // Avoid stripping a valid prefix from an identifier such as
      // `2001:db8::1foo`; a dot, slash, bracket, port delimiter, or whitespace
      // is a normal boundary and is intentionally retained.
      if (next && /[A-Za-z0-9]/.test(next) && next !== undefined) continue
      return { start, end }
    }
  }
  return null
}

/** Normalize a model host identity and reject transport IPs. */
export function modelHostname(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/\.$/, '').toLowerCase()
  // A model identity is a DNS-style host token, never a URI, socket
  // authority, bracketed address, or other transport syntax. This also keeps
  // an embedded IPv6 value such as `host:2001:db8::1` out of the prompt.
  if (!normalized || /\s/.test(normalized) || hasControlCharacters(normalized) || /[/:\\[\]%@?#]/.test(normalized) || isIpLiteral(normalized)) return undefined
  return stripIpLiterals(normalized) === normalized ? normalized : undefined
}

/** Keep useful connection titles, but never expose an address embedded in one. */
export function modelDisplayName(value: string | undefined, hostname: string): string {
  const stripped = stripIpLiterals(value ?? '')
    .trim()
    .replace(/[\s_@:/.,-]+$/g, '')
    .trim()
  return stripped || hostname
}

export function uniqueModelHostnames(values: readonly (string | undefined)[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const hostname = modelHostname(value)
    if (!hostname || seen.has(hostname)) continue
    seen.add(hostname)
    result.push(hostname)
  }
  return result
}

/**
 * Recursively clone model-bound data, removing address-bearing fields and IP
 * literals from textual values. Hostname fields remain explicit identities.
 */
export function sanitizeModelValue(value: unknown, options: { omitIpFields?: boolean; preserveHostname?: boolean } = {}): unknown {
  if (typeof value === 'string') return stripIpLiterals(value)
  if (Array.isArray(value)) return value.map(item => sanitizeModelValue(item, options))
  if (!value || typeof value !== 'object') return value

  const result: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if (options.omitIpFields && isIpField(key)) continue
    const sanitizedKey = stripIpLiterals(key).trim()
    if (!sanitizedKey) continue
    if (options.preserveHostname !== false && isHostnameField(key) && typeof child === 'string') {
      const hostname = modelHostname(child)
      if (hostname) result[sanitizedKey] = hostname
      continue
    }
    result[sanitizedKey] = sanitizeModelValue(child, options)
  }
  return result
}

export function sanitizeModelContent(value: unknown): unknown {
  if (typeof value === 'string') return stripIpLiterals(value)
  if (isImagePart(value)) return structuredClone(value)
  if (Array.isArray(value)) {
    return value.map(part => {
      if (part && typeof part === 'object' && !Array.isArray(part) && 'type' in part && part.type === 'text' && 'text' in part && typeof part.text === 'string') {
        return sanitizeModelValue(part, { omitIpFields: true, preserveHostname: false })
      }
      // Image payloads are opaque binary data encoded as a Data URL. Never
      // rewrite them while projecting neighboring text blocks.
      if (part && typeof part === 'object' && !Array.isArray(part) && 'type' in part && part.type === 'image_url') {
        return structuredClone(part)
      }
      return sanitizeModelValue(part, { omitIpFields: true, preserveHostname: false })
    })
  }
  return sanitizeModelValue(value, { omitIpFields: true, preserveHostname: false })
}

export function sanitizeModelMessages<T extends ModelMessageLike>(messages: readonly T[]): T[] {
  return messages.map(message => ({
    ...message,
    // A user-authored message is part of the request itself. In particular,
    // an IP may be the business target the user intentionally supplied. The
    // surrounding application metadata is projected separately.
    content: message.role === 'user' && !message.messageType
      ? structuredClone(message.content)
      : sanitizeModelContent(message.content),
  })) as T[]
}

export function projectModelFacts<T>(facts: T): T {
  return sanitizeModelValue(facts, { omitIpFields: true, preserveHostname: true }) as T
}

function isImagePart(value: unknown): value is { type: 'image_url'; image_url: { url: string } } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const part = value as { type?: unknown; image_url?: unknown }
  if (part.type !== 'image_url' || !part.image_url || typeof part.image_url !== 'object') return false
  return typeof (part.image_url as { url?: unknown }).url === 'string'
}

function isHostnameField(key: string): boolean {
  const normalized = key.replace(/[_-]/g, '').toLowerCase()
  return normalized === 'hostname' || normalized === 'observedhostname'
}

function isIpField(key: string): boolean {
  const normalized = key.replace(/[_-]/g, '').toLowerCase()
  return /^(?:(?:connection|remote|local|source|destination|peer|host|server|gateway|bind|listen)?(?:ip|ips|ipaddress|ipaddresses|address|addresses)|(?:network)?interfaces?(?:ip|ips|ipaddress|ipaddresses|address|addresses)?)$/.test(normalized)
}

function isIpv4Literal(value: string): boolean {
  const parts = value.split('.')
  return parts.length === 4 && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function isIpv6Literal(value: string): boolean {
  const zoneIndex = value.indexOf('%')
  if (zoneIndex >= 0 && (value.indexOf('%', zoneIndex + 1) >= 0 || !/^[%][0-9A-Za-z_.~-]+$/.test(value.slice(zoneIndex)))) return false
  const normalized = zoneIndex >= 0 ? value.slice(0, zoneIndex) : value
  if (!normalized.includes(':') || /[^0-9a-f:.]/i.test(normalized)) return false
  const halves = normalized.split('::')
  if (halves.length > 2) return false
  const parseHalf = (half: string): number | null => {
    if (!half) return 0
    const parts = half.split(':')
    let groups = 0
    for (const [index, part] of parts.entries()) {
      if (/^[0-9a-f]{1,4}$/i.test(part)) {
        groups += 1
        continue
      }
      if (index === parts.length - 1 && isIpv4Literal(part)) {
        groups += 2
        continue
      }
      return null
    }
    return groups
  }
  const left = parseHalf(halves[0]!)
  const right = parseHalf(halves[1] ?? '')
  if (left === null || right === null) return false
  return halves.length === 2 ? left + right < 8 : left + right === 8
}

function hasControlCharacters(value: string): boolean {
  return [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
}
