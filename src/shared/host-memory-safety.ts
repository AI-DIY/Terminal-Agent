const sensitiveKeyPattern = /(?:password|passphrase|private[ _-]?key|token|api[ _-]?key|credential|secret|raw[ _-]?(?:terminal|output)|(?:terminal|command)[ _-]?(?:output|history)|stdout|stderr)/i
const sensitiveValuePattern = /(?:password|passphrase|token|api[ _-]?key|credential|secret)\s*[:=]/i
const temporaryPathPattern = /(?:^tmp:|(?:^|[\\/])(?:tmp|temp)(?:[\\/]|$)|appdata[\\/]local[\\/]temp|%temp%|%tmp%|\$tmp\b|\$temp\b)/i
const keyMaterialPathPattern = /(?:^|[\\/])(?:\.ssh|id_rsa|id_ed25519|authorized_keys|known_hosts|credentials?|secrets?)(?:[\\/.]|$)|\.(?:pem|ppk|p12|pfx|key)(?:$|[?#])/i
const sensitiveIdentityPattern = /(?:password|passphrase|private[ _-]?key|token|api[ _-]?key|credential|secret)/i
const hostnameLabelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const environmentVariableKeyPattern = /^[A-Z_][A-Z0-9_]*$/
const environmentVariableAssignmentPattern = /(?:^|\s)(?:export\s+)?[A-Z_][A-Z0-9_]*\s*=/
const credentialUriPattern = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+@/i
const dynamicSensitiveMapKeyPattern = /^(?:password|passphrase|private[ _-]?key|token|api[ _-]?key|credential|secret|raw[ _-]?(?:terminal|output)|(?:terminal|command)[ _-]?(?:output|history)|stdout|stderr)$/i
const bareCredentialValuePatterns = [
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}\b/i,
  /\bgh[pousr]_[A-Za-z0-9]{36}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{82}\b/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bglpat-[A-Za-z0-9_-]{20}\b/i,
  /\bnpm_[A-Za-z0-9]{36}\b/,
  /\bxoxb-[0-9]{8,}-[0-9]{8,}-[A-Za-z0-9-]{8,}\b/,
  /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/,
  /\bdckr_pat_[A-Za-z0-9_-]{36}\b/i,
  /\baws[-_ ]?secret[-_ ]?access[-_ ]?key\s*[:=]\s*[A-Za-z0-9/+=]{40}\b/i,
  /\b[A-Za-z0-9/+=]{40}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{4,}){0,2}\b/,
  /\bBearer[ \t]+[A-Za-z0-9._~+/=-]{8,}\b/i,
]
const dynamicHostFactMapFields = new Set(['software', 'installLocations', 'services', 'configurationHashes'])

export function containsSensitiveHostMemoryData(value: unknown): boolean {
  return containsSensitiveValue(value, false)
}

function containsSensitiveValue(value: unknown, dynamicMapKeys: boolean): boolean {
  if (typeof value === 'string') return sensitiveValuePattern.test(value)
    || credentialUriPattern.test(value)
    || environmentVariableAssignmentPattern.test(value)
    || bareCredentialValuePatterns.some(pattern => pattern.test(value))
    || temporaryPathPattern.test(value)
    || keyMaterialPathPattern.test(value)
    || value.includes('-----BEGIN') && value.includes('PRIVATE KEY')
  if (Array.isArray(value)) return value.some(item => containsSensitiveValue(item, false))
  if (!value || typeof value !== 'object') return false
  return Object.entries(value).some(([key, child]) => environmentVariableKeyPattern.test(key)
    || (dynamicMapKeys ? dynamicSensitiveMapKeyPattern.test(key) : sensitiveKeyPattern.test(key))
    || containsSensitiveValue(child, dynamicHostFactMapFields.has(key)))
}

export function normalizeSafeHostMemoryIdentity(value: string): string {
  if (value !== value.trim() || /\s/.test(value) || hasControlCharacters(value)) throw new Error('Host memory identity cannot contain whitespace or control characters')
  if (sensitiveIdentityPattern.test(value) || containsSensitiveHostMemoryData(value) || temporaryPathPattern.test(value) || keyMaterialPathPattern.test(value) || value.includes('-----BEGIN')) throw new Error('Host memory identity cannot contain sensitive data')
  const hostname = value.replace(/\.$/, '').toLowerCase()
  if (isIpLiteral(hostname)) throw new Error('Host facts require a hostname, not an IP address')
  if (!hostname || hostname.length > 253 || hostname.split('.').some(label => !hostnameLabelPattern.test(label))) throw new Error('Host memory identity must be a valid hostname')
  return hostname
}

export function normalizeSafeHostMemoryHostnameOutput(value: string): string {
  const hostname = value.endsWith('\r\n') ? value.slice(0, -2) : value.endsWith('\n') ? value.slice(0, -1) : value
  return normalizeSafeHostMemoryIdentity(hostname)
}

export function normalizeSafeHostMemoryConnectionLabel(value: string): string {
  if (value !== value.trim() || /\s/.test(value) || hasControlCharacters(value)) throw new Error('Host memory connection label cannot contain whitespace or control characters')
  if (sensitiveIdentityPattern.test(value) || containsSensitiveHostMemoryData(value) || temporaryPathPattern.test(value) || keyMaterialPathPattern.test(value) || value.includes('-----BEGIN')) throw new Error('Host memory connection label cannot contain sensitive data')
  if (isIpLiteral(value)) return value.toLowerCase()
  return normalizeSafeHostMemoryIdentity(value)
}

export function normalizeSafeHostMemoryConnectionIp(value: string): string {
  if (value !== value.trim() || hasControlCharacters(value) || !isIpLiteral(value)) throw new Error('Host memory connection IP must be a valid IP address')
  return value.toLowerCase()
}

function isIpLiteral(value: string): boolean {
  return isIpv4Literal(value) || isIpv6Literal(value)
}

function isIpv4Literal(value: string): boolean {
  const parts = value.split('.')
  return parts.length === 4 && parts.every(part => /^(?:0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255)
}

function isIpv6Literal(value: string): boolean {
  if (!value.includes(':') || /[^0-9a-f:.]/i.test(value)) return false
  const halves = value.split('::')
  if (halves.length > 2) return false
  const parseHalf = (half: string): number | null => {
    if (!half) return 0
    const parts = half.split(':')
    let groups = 0
    for (const [index, part] of parts.entries()) {
      if (/^[0-9a-f]{1,4}$/i.test(part)) { groups += 1; continue }
      if (index === parts.length - 1 && isIpv4Literal(part)) { groups += 2; continue }
      return null
    }
    return groups
  }
  const left = parseHalf(halves[0]!)
  const right = parseHalf(halves[1] ?? '')
  if (left === null || right === null) return false
  return halves.length === 2 ? left + right < 8 : left + right === 8
}

function hasControlCharacters(value: string): boolean { return [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) }
