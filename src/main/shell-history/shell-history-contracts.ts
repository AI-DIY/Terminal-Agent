import { z } from 'zod'
import {
  chatIdentifierSchema,
  chatTimestampSchema,
  hostnameSchema,
  shellHistoryIdSchema,
  shellHistoryStatusSchema,
  terminalSessionIdSchema,
} from '../../shared/contracts'
import { redactSensitiveText } from '../agent/sensitive-data'

export const SHELL_HISTORY_MAX_RECORDS_PER_HOST = 50
export const SHELL_HISTORY_MAX_OUTPUT_BYTES = 256 * 1024
export const SHELL_HISTORY_MAX_AUDIT_BYTES = 256 * 1024

export const REDACTED_SHELL_HISTORY_CONTENT = '[REDACTED SENSITIVE CONTENT]'
const ESCAPE = String.fromCharCode(27)
const CONTROL_STRING_INTRODUCERS = new Set(['P', 'X', ']', '^', '_'])

export const shellHistoryConnectionTypeSchema = z.enum(['direct-ssh', 'access-client-ssh', 'access-client-raw'])
export type ShellHistoryConnectionType = z.infer<typeof shellHistoryConnectionTypeSchema>

export const shellHistoryReconnectReferenceSchema = z.string().regex(/^reconnect:[0-9a-f-]{16,128}$/i)

function boundedShellHistoryTextSchema(maximumBytes: number, label: string) {
  return z.string().superRefine((value, context) => {
    if (Buffer.byteLength(value, 'utf8') > maximumBytes) {
      context.addIssue({ code: 'custom', message: `${label} exceeds ${maximumBytes} UTF-8 bytes` })
    }
  })
}

const shellHistoryOutputSchema = boundedShellHistoryTextSchema(SHELL_HISTORY_MAX_OUTPUT_BYTES, 'Shell history output')
const shellHistoryAuditInputSchema = boundedShellHistoryTextSchema(SHELL_HISTORY_MAX_AUDIT_BYTES, 'Shell history command audit')

const shellHistoryCommandAuditSchema = z.object({
  input: shellHistoryAuditInputSchema,
}).strict()

const shellHistoryReconnectAuditSchema = z.object({
  count: z.number().int().min(0).max(1_000_000),
  lastReconnectedAt: chatTimestampSchema.optional(),
}).strict()

export const shellHistoryRecordSchema = z.object({
  id: shellHistoryIdSchema,
  chatId: chatIdentifierSchema,
  sessionId: terminalSessionIdSchema,
  hostname: hostnameSchema,
  title: z.string().trim().min(1).max(255),
  startedAt: chatTimestampSchema,
  endedAt: chatTimestampSchema,
  status: shellHistoryStatusSchema,
  output: shellHistoryOutputSchema,
  commandAudit: shellHistoryCommandAuditSchema.default({ input: '' }),
  reconnectable: z.boolean(),
  reconnectReference: shellHistoryReconnectReferenceSchema.optional(),
  reconnectAudit: shellHistoryReconnectAuditSchema.default({ count: 0 }),
  connectionType: shellHistoryConnectionTypeSchema,
}).strict()
export type ShellHistoryRecord = z.infer<typeof shellHistoryRecordSchema>

export const shellHistoryDocumentSchema = z.object({
  version: z.literal(1),
  records: z.array(shellHistoryRecordSchema),
}).strict().superRefine((document, context) => {
  const seenIds = new Set<string>()
  const recordCountByHost = new Map<string, number>()
  for (const [index, record] of document.records.entries()) {
    if (seenIds.has(record.id)) {
      context.addIssue({ code: 'custom', path: ['records', index, 'id'], message: 'Shell history ids must be unique' })
    }
    seenIds.add(record.id)
    const count = (recordCountByHost.get(record.hostname) ?? 0) + 1
    recordCountByHost.set(record.hostname, count)
    if (count > SHELL_HISTORY_MAX_RECORDS_PER_HOST) {
      context.addIssue({
        code: 'custom', path: ['records', index, 'hostname'],
        message: `Shell history keeps at most ${SHELL_HISTORY_MAX_RECORDS_PER_HOST} records per host`,
      })
    }
  }
})
export type ShellHistoryDocument = z.infer<typeof shellHistoryDocumentSchema>

export const shellHistoryAttachSchema = z.object({
  sessionId: terminalSessionIdSchema,
  chatId: chatIdentifierSchema.optional(),
  historyId: shellHistoryIdSchema.optional(),
  hostname: hostnameSchema,
  title: z.string().trim().min(1).max(255),
  connectionType: shellHistoryConnectionTypeSchema,
  reconnectReference: shellHistoryReconnectReferenceSchema.optional(),
  startedAt: chatTimestampSchema,
}).strict()
export type ShellHistoryAttach = z.infer<typeof shellHistoryAttachSchema>

export const shellHistoryAssociateSchema = z.object({
  sessionId: terminalSessionIdSchema,
  chatId: chatIdentifierSchema,
  historyId: shellHistoryIdSchema,
}).strict()
export type ShellHistoryAssociate = z.infer<typeof shellHistoryAssociateSchema>

export const shellHistoryAppendSchema = z.object({
  sessionId: terminalSessionIdSchema,
  data: z.string(),
}).strict()
export type ShellHistoryAppend = z.infer<typeof shellHistoryAppendSchema>

export const shellHistoryAuditSchema = shellHistoryAppendSchema
export type ShellHistoryAudit = z.infer<typeof shellHistoryAuditSchema>

export const shellHistoryCloseSchema = z.object({
  sessionId: terminalSessionIdSchema,
  hostname: hostnameSchema.optional(),
  endedAt: chatTimestampSchema,
}).strict()
export type ShellHistoryClose = z.infer<typeof shellHistoryCloseSchema>

export function sanitizeShellHistoryText(value: string, maximumBytes = SHELL_HISTORY_MAX_OUTPUT_BYTES): string {
  const terminalControls = new ShellHistoryTerminalControlSanitizer()
  const plainText = terminalControls.append(value)
  if (terminalControls.hasIncompleteSequence()) return REDACTED_SHELL_HISTORY_CONTENT
  if (hasOrphanedPrivateKeyEnd(plainText)) return REDACTED_SHELL_HISTORY_CONTENT
  const withoutPrivateKeyBlocks = redactPrivateKeyBlocks(plainText)
  const redacted = redactSensitiveShellHistoryLines(withoutPrivateKeyBlocks)
  return truncateShellHistoryText(redacted, maximumBytes)
}

export function sanitizeShellHistoryDisplay(value: string): string {
  const terminalControls = new ShellHistoryTerminalControlSanitizer()
  const plainText = terminalControls.append(value)
  if (terminalControls.hasIncompleteSequence()) return REDACTED_SHELL_HISTORY_CONTENT
  if (hasOrphanedPrivateKeyEnd(plainText)) return REDACTED_SHELL_HISTORY_CONTENT
  const withoutPrivateKeyBlocks = redactPrivateKeyBlocks(plainText)
  return hasSensitiveShellHistoryPath(withoutPrivateKeyBlocks) || hasInlineShellHistoryCredential(withoutPrivateKeyBlocks)
    ? REDACTED_SHELL_HISTORY_CONTENT
    : redactSensitiveText(withoutPrivateKeyBlocks)
}

export function truncateShellHistoryText(value: string, maximumBytes = SHELL_HISTORY_MAX_OUTPUT_BYTES): string {
  let output = ''
  let bytes = 0
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8')
    if (bytes + characterBytes > maximumBytes) break
    output += character
    bytes += characterBytes
  }
  return output
}

function hasAccessClientTemporaryPath(value: string): boolean {
  const plainText = stripShellHistoryTerminalControlSequences(value)
  return /(?:^|[^a-z0-9_])tmp:(?=[^\r\n]*\S)/i.test(plainText) || hasTemporaryFilesystemPath(plainText)
}

function hasTemporaryFilesystemPath(value: string): boolean {
  return /(?:[a-z]:)?[\\/](?:[^\\/\r\n]+[\\/])*(?:temp|tmp)(?:[\\/]|$)/i.test(value)
}

function hasSensitiveShellHistoryPath(value: string): boolean {
  return hasAccessClientTemporaryPath(value) || hasPrivateKeyPath(value)
}

function hasInlineShellHistoryCredential(value: string): boolean {
  const plainText = stripShellHistoryTerminalControlSequences(value).replace(/\\\r?\n/g, '')
  return /(?:^|\s)(?:--(?:user|proxy-user)|-u)(?:=|\s*)(?:"[^"\r\n]*:[^"\r\n]*"|'[^'\r\n]*:[^'\r\n]*'|[^\s\r\n]*:[^\s\r\n]*)/i.test(plainText)
    || /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]*:[^\s/@]+@/i.test(plainText)
    || /\bsshpass\b[^\r\n]*(?:\s--password(?:=|\s+)|\s-p(?:=|\s+)?)(?:"[^"\r\n]*"|'[^'\r\n]*'|\S+)/.test(plainText)
    || /\bredis-cli\b[^\r\n]*(?:\s(?:-a|--pass)(?:=|\s*))(?:"[^"\r\n]*"|'[^'\r\n]*'|\S+)/i.test(plainText)
}

function redactSensitiveShellHistoryLines(value: string): string {
  const redacted: string[] = []
  let logicalLine = ''
  for (const segment of value.split(/(?<=\n)/)) {
    logicalLine += segment
    if (/\\\r?\n$/.test(stripShellHistoryTerminalControlSequences(logicalLine))) continue
    redacted.push(redactSensitiveShellHistoryLine(logicalLine))
    logicalLine = ''
  }
  if (logicalLine) redacted.push(redactSensitiveShellHistoryLine(logicalLine))
  return redacted.join('')
}

function redactSensitiveShellHistoryLine(value: string): string {
  return hasInlineShellHistoryCredential(value) || hasSensitiveShellHistoryPath(value)
    ? REDACTED_SHELL_HISTORY_CONTENT
    : redactSensitiveText(value)
}

function hasPrivateKeyPath(value: string): boolean {
  const plainText = stripShellHistoryTerminalControlSequences(value)
  return /(?:^|[\s"'=([{,:;])(?:[^\r\n]*[\\/])?\.ssh[\\/]id_(?:ed25519|rsa|ecdsa|dsa)(?=$|[\s"'`),:;\]}])/i.test(plainText)
    || /(?:^|[\s"'=([{,:;])[^\r\n]*\.(?:pem|ppk|key)(?=$|[\s"'`),:;\]}])/i.test(plainText)
    || /\bssh\b[^\r\n]*?(?:\s-i(?:=|\s+)|\s--identity-file(?:=|\s+))(?:(?:"[^"\r\n]+")|(?:'[^'\r\n]+')|[^\s\r\n]+)/i.test(plainText)
}

function redactPrivateKeyBlocks(value: string): string {
  return value.replace(
    /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/gi,
    REDACTED_SHELL_HISTORY_CONTENT,
  )
}

function hasOrphanedPrivateKeyEnd(value: string): boolean {
  return !/-----BEGIN [^-\r\n]*PRIVATE KEY-----/i.test(value)
    && /-----END [^-\r\n]*PRIVATE KEY-----/i.test(value)
}

export function stripShellHistoryTerminalControlSequences(value: string): string {
  return new ShellHistoryTerminalControlSanitizer().append(value)
}

type TerminalControlState = 'text' | 'escape' | 'csi' | 'control-string' | 'control-string-escape'

export class ShellHistoryTerminalControlSanitizer {
  private state: TerminalControlState = 'text'
  private oscTerminatesWithBel = false

  append(value: string): string {
    let plainText = ''
    for (const character of value) {
      const code = character.charCodeAt(0)
      if (this.state === 'escape') {
        if (character === '[') this.state = 'csi'
        else if (CONTROL_STRING_INTRODUCERS.has(character)) {
          this.state = 'control-string'
          this.oscTerminatesWithBel = character === ']'
        } else this.state = 'text'
        continue
      }
      if (this.state === 'csi') {
        if (code >= 0x40 && code <= 0x7e) this.state = 'text'
        continue
      }
      if (this.state === 'control-string-escape') {
        this.state = character === '\\' ? 'text' : 'control-string'
        continue
      }
      if (this.state === 'control-string') {
        if ((this.oscTerminatesWithBel && code === 0x07) || code === 0x9c) this.state = 'text'
        else if (character === ESCAPE) this.state = 'control-string-escape'
        continue
      }
      if (character === ESCAPE) {
        this.state = 'escape'
        continue
      }
      if (code === 0x9b) {
        this.state = 'csi'
        continue
      }
      if (code === 0x9d || code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
        this.state = 'control-string'
        this.oscTerminatesWithBel = code === 0x9d
        continue
      }
      if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
        if (code === 0x09 || code === 0x0a || code === 0x0d) plainText += character
        continue
      }
      plainText += character
    }
    return plainText
  }

  hasIncompleteSequence(): boolean {
    return this.state !== 'text'
  }
}
