const REDACTED = '[REDACTED SENSITIVE CONTENT]'

const sensitiveMarker = /authorization|bearer|password|passphrase|passwd|api[ _-]?key|token|secret|密码|口令|令牌|私钥|-----begin [^-]*private key-----|ghp_|akia|sk-|eyj/i

export function containsSensitiveMaterial(value: string): boolean {
  return sensitiveMarker.test(value)
    || /\bghp_[a-z0-9_]{16,}\b/i.test(value)
    || /\bAKIA[0-9A-Z]{16}\b/.test(value)
    || /\beyJ[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+){2}\b/.test(value)
}

export function redactSensitiveText(value: string): string {
  return containsSensitiveMaterial(value) ? REDACTED : value
}

export class SensitiveTextStreamRedactor {
  private pending = ''

  push(content: string): string {
    this.pending += content
    return ''
  }

  finish(): string {
    if (!this.pending) return ''
    const source = this.pending
    this.pending = ''
    return containsSensitiveMaterial(source) ? REDACTED : source
  }
}
