const REDACTED = '[REDACTED SENSITIVE CONTENT]'

const sensitiveMarker = /authorization|bearer|password|passphrase|passwd|api[ _-]?key|token|secret|密码|口令|令牌|私钥|-----begin [^-]*private key-----|gh[pousr]_|github_pat_|glpat-|npm_|xoxb-|dckr_pat_|sk-proj-|(?:sk|rk)_live_|(?:akia|asia)|aws[-_ ]?secret[-_ ]?access[-_ ]?key|eyj/i
const temporaryReferencePattern = /(?:^|[^a-z0-9_])tmp:(?=[^\r\n]*\S)/i
const temporaryFilesystemPathPattern = /(?:[a-z]:)?[\\/](?:[^\\/\r\n]+[\\/])*(?:temp|tmp)(?:[\\/]|$)/i
const privateKeyFilesystemPathPattern = /(?:^|[\s"'=([{,:;])((?:[^\r\n]*[\\/])?\.ssh[\\/]id_[^\\/\s"'`),:;\]}]+|[^\r\n]*\.(?:pem|ppk|key))(?=$|[\s"'`),:;\]}])/i

const sensitiveValuePatterns = [
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/i,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/i,
  /\bglpat-[A-Za-z0-9_-]{12,}\b/i,
  /\bnpm_[A-Za-z0-9]{20,}\b/i,
  /\bxoxb-[0-9]{4,}-[0-9]{4,}-[A-Za-z0-9-]{6,}\b/i,
  /\bsk-proj-[A-Za-z0-9_-]{12,}\b/i,
  /sk-[A-Za-z0-9]{32,}(?![A-Za-z0-9])/i,
  /\b(?:sk|rk)_live_[A-Za-z0-9_-]{12,}\b/i,
  /\bdckr_pat_[A-Za-z0-9_-]{20,}\b/i,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\baws[-_ ]?secret[-_ ]?access[-_ ]?key\s*[:=]\s*[A-Za-z0-9/+=]{20,}\b/i,
  /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+=]{40,}(?![A-Za-z0-9/+=])/,
  /\bBearer[ \t]+[^\s,;]+/i,
  /\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{4,}){1,2}\b/,
  /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/i,
]

export function containsSensitiveMaterial(value: string): boolean {
  return hasSensitiveFilesystemPath(value)
    || sensitiveMarker.test(value)
    || sensitiveValuePatterns.some(pattern => pattern.test(value))
}

export function redactSensitiveText(value: string): string {
  if (hasSensitiveFilesystemPath(value)) return REDACTED
  if (!containsSensitiveMaterial(value)) return value
  let output = value
  output = output.replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/gi, REDACTED)
  output = output.replace(/\bBearer[ \t]+[^\s,;]+/gi, 'Bearer [REDACTED]')
  for (const pattern of sensitiveValuePatterns) {
    if (pattern.source.includes('PRIVATE KEY') || pattern.source.includes('Bearer')) continue
    output = output.replace(new RegExp(pattern.source, `${pattern.flags}g`), REDACTED)
  }
  if (/authorization|password|passphrase|passwd|api[ _-]?key|token|secret|密码|口令|令牌|私钥/i.test(output)) return REDACTED
  return output
}

export class SensitiveTextStreamRedactor {
  private pending = ''

  push(content: string): string {
    this.pending += content
    const candidate = findCredentialCandidate(this.pending)
    if (candidate === -1) {
      const partial = findPartialCredentialSuffix(this.pending)
      if (partial === -1) {
        const complete = this.pending
        this.pending = ''
        return redactSensitiveText(complete)
      }
      const prefix = this.pending.slice(0, partial)
      this.pending = this.pending.slice(partial)
      return redactSensitiveText(prefix)
    }
    const prefix = this.pending.slice(0, candidate)
    const candidateValue = this.pending.slice(candidate)
    const releaseLength = terminatedSensitiveCandidateLength(candidateValue)
    if (releaseLength !== -1) {
      this.pending = candidateValue.slice(releaseLength)
      return redactSensitiveText(`${prefix}${candidateValue.slice(0, releaseLength)}`)
    }
    this.pending = candidateValue
    return redactSensitiveText(prefix)
  }

  finish(): string {
    if (!this.pending) return ''
    const source = this.pending
    this.pending = ''
    return redactSensitiveText(source)
  }
}

const credentialStartPattern = /(?:Bearer\s+|glpat-|npm_|xoxb-|sk-proj-|(?:sk|rk)_live_|dckr_pat_|(?:AKIA|ASIA)|aws[-_ ]?secret[-_ ]?access[-_ ]?key\s*[:=]|-----BEGIN|(?:password|passphrase|api[ _-]?key|token|secret)\s*[:=])/i
const credentialPrefixes = ['bearer', 'glpat-', 'npm_', 'xoxb-', 'sk-', 'rk-', 'sk-proj-', 'sk_live_', 'rk_live_', 'dckr_pat_', 'akia', 'asia', 'aws-secret-access-key', 'aws_secret_access_key', 'password=', 'password:', 'token=', 'token:', 'secret=', 'secret:']

function findCredentialCandidate(value: string): number {
  const credential = credentialStartPattern.exec(value)?.index ?? -1
  const sensitivePath = findSensitiveFilesystemPathCandidate(value)
  return lowestCandidate(credential, sensitivePath)
}

function findPartialCredentialSuffix(value: string): number {
  const source = value.toLowerCase()
  let boundary = -1
  for (const prefix of credentialPrefixes) {
    let from = 0
    while (from < source.length) {
      const index = source.indexOf(prefix, from)
      if (index === -1) break
      const suffix = source.slice(index)
      if (/^[a-z0-9_\-+/=]+$/i.test(suffix) || suffix === prefix) boundary = boundary === -1 ? index : Math.min(boundary, index)
      from = index + 1
    }
  }
  if (boundary !== -1) return boundary

  // A provider may split a credential immediately after JSON, Markdown, or quote
  // delimiters. Keep every unfinished token-like suffix until a safe delimiter
  // arrives so a short prefix cannot be combined with a later emitted fragment.
  const suffix = /[a-z0-9_.:+\-/=]+$/i.exec(value)
  return suffix?.[0] ? suffix.index : -1
}

function terminatedSensitiveCandidateLength(value: string): number {
  if (/^-----BEGIN /i.test(value)) return -1
  if (/[\\/]/.test(value) || /^tmp:/i.test(value)) {
    const delimiter = /[\s"'`),;\]}]+$/.exec(value)
    return delimiter && hasSensitiveFilesystemPath(value) ? value.length - delimiter[0].length : -1
  }
  if (/^Bearer[ \t]+/i.test(value)) {
    const bearer = /^Bearer[ \t]+[^\s,;]+/i.exec(value)
    return bearer && bearer[0].length < value.length ? bearer[0].length : -1
  }
  if (/^(?:password|passphrase|api[ _-]?key|token|secret)\s*[:=]\s*/i.test(value)) return -1
  const token = /^[a-z0-9_.:+\-/=]+/i.exec(value)
  return token && token[0].length < value.length ? token[0].length : -1
}

function hasSensitiveFilesystemPath(value: string): boolean {
  return temporaryReferencePattern.test(value)
    || temporaryFilesystemPathPattern.test(value)
    || privateKeyFilesystemPathPattern.test(value)
}

function findSensitiveFilesystemPathCandidate(value: string): number {
  const temporaryReference = /(?:^|[^a-z0-9_])(tmp:)/i.exec(value)
  const temporaryPath = temporaryFilesystemPathPattern.exec(value)
  const privateKeyPath = privateKeyFilesystemPathPattern.exec(value)
  const partialPath = findPartialFilesystemPathSuffix(value)
  return lowestCandidate(
    temporaryReference ? temporaryReference.index + temporaryReference[0].lastIndexOf(temporaryReference[1]) : -1,
    temporaryPath?.index ?? -1,
    privateKeyPath ? privateKeyPath.index + privateKeyPath[0].lastIndexOf(privateKeyPath[1]) : -1,
    partialPath,
  )
}

function findPartialFilesystemPathSuffix(value: string): number {
  const relativeSshPath = /(?:^|[\s"'=([{,:;])(\.ssh(?:[\\/][^\s"'`),:;\]}]*)?)$/i.exec(value)
  if (relativeSshPath) return relativeSshPath.index + relativeSshPath[0].lastIndexOf(relativeSshPath[1])

  const paths = /(?:[a-z]:)?[\\/][^\s"'`),:;\]}]*/ig
  let match: RegExpExecArray | null
  while ((match = paths.exec(value))) {
    if (match.index + match[0].length === value.length) return match.index
  }
  return -1
}

function lowestCandidate(...candidates: number[]): number {
  const matches = candidates.filter(candidate => candidate >= 0)
  return matches.length ? Math.min(...matches) : -1
}
