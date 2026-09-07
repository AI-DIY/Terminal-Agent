import { randomUUID } from 'node:crypto'
import {
  shellHistoryIdSchema,
  shellHistoryChangedEventSchema,
  terminalSessionIdSchema,
  type ShellHistoryChangedEvent,
  type ShellHistoryDetail,
  type ShellHistoryListRequest,
  type ShellHistorySummary,
} from '../../shared/contracts'
import type { ConnectedSession } from '../ssh/session-service'
import {
  REDACTED_SHELL_HISTORY_CONTENT,
  SHELL_HISTORY_MAX_OUTPUT_BYTES,
  SHELL_HISTORY_MAX_AUDIT_BYTES,
  SHELL_HISTORY_MAX_FILE_TRANSFER_LOGS,
  ShellHistoryTerminalControlSanitizer,
  sanitizeShellHistoryDisplay,
  sanitizeShellHistoryFileTransferLog,
  sanitizeShellHistoryText,
  stripShellHistoryTerminalControlSequences,
  shellHistoryAppendSchema,
  shellHistoryAuditSchema,
  shellHistoryAssociateSchema,
  shellHistoryAttachSchema,
  shellHistoryCloseSchema,
  shellHistoryFileTransferRecordSchema,
  truncateShellHistoryText,
  type ShellHistoryAppend,
  type ShellHistoryAudit,
  type ShellHistoryAssociate,
  type ShellHistoryAttach,
  type ShellHistoryClose,
  type ShellHistoryFileTransferRecord,
} from './shell-history-contracts'
import { chatIdentifierSchema } from '../../shared/contracts'
import type { ShellHistoryFileTransferLog } from '../../shared/contracts'
import type { ShellHistoryRecord, ShellHistoryRepositoryPort } from './shell-history-repository'

type Collector = ShellHistoryAttach & {
  output: string
  outputBytes: number
  terminalTail: string
  terminalControls: ShellHistoryTerminalControlSanitizer
  commandInputChunks: string[]
  commandInputBytes: number
  pendingCommandChunks: string[]
  pendingCommandBytes: number
  sensitiveInputPending: boolean
  sensitivePromptMarkerPending: boolean
  sensitiveOutputPending: boolean
  fileTransferLogs: ShellHistoryFileTransferLog[]
}

/**
 * A closed SSH session may still have an in-flight SFTP promise settling
 * after SessionService has emitted its close event.  Keep only a small,
 * bounded reference to the persisted history id so that final transfer
 * results can be appended without retaining the full terminal transcript in
 * memory.
 */
type ClosedSessionReference = {
  historyId: string
  writeTail: Promise<void>
}

const MAX_CLOSED_SESSION_REFERENCES = 256

type ShellHistoryServiceOptions = {
  createId?: () => string
  now?: () => Date
  connectionOpener?: ShellHistoryConnectionOpener
}

export type ShellHistoryConnectionOpener = {
  canReconnect(reconnectReference: string): boolean
  duplicate(sessionId: string, chatId?: string): Promise<ConnectedSession>
  reconnect(reconnectReference: string, chatId: string): Promise<ConnectedSession>
}

export class ShellHistoryService {
  private readonly collectors = new Map<string, Collector>()
  private readonly closedSessions = new Map<string, ClosedSessionReference>()
  private readonly changedListeners = new Set<(event: ShellHistoryChangedEvent) => void>()
  private readonly createId: () => string
  private readonly now: () => Date
  private readonly connectionOpener: ShellHistoryConnectionOpener | undefined

  constructor(private readonly repository: ShellHistoryRepositoryPort, options: ShellHistoryServiceOptions = {}) {
    this.createId = options.createId ?? randomUUID
    this.now = options.now ?? (() => new Date())
    this.connectionOpener = options.connectionOpener
  }

  attach(input: ShellHistoryAttach): void {
    const parsed = shellHistoryAttachSchema.parse(input)
    const existing = this.collectors.get(parsed.sessionId)
    if (existing) return
    // Session ids are normally unique, but dropping a stale closed reference
    // makes a reused id unambiguously refer to the newly opened session.
    this.closedSessions.delete(parsed.sessionId)
    this.collectors.set(parsed.sessionId, {
      ...parsed,
      output: '',
      outputBytes: 0,
      terminalTail: '',
      terminalControls: new ShellHistoryTerminalControlSanitizer(),
      commandInputChunks: [],
      commandInputBytes: 0,
      pendingCommandChunks: [],
      pendingCommandBytes: 0,
      sensitiveInputPending: false,
      sensitivePromptMarkerPending: false,
      sensitiveOutputPending: false,
      fileTransferLogs: [],
    })
  }

  associate(input: ShellHistoryAssociate): void {
    const parsed = shellHistoryAssociateSchema.parse(input)
    const collector = this.collectors.get(parsed.sessionId)
    if (!collector) return
    collector.chatId = parsed.chatId
    collector.historyId = parsed.historyId
  }

  append(input: ShellHistoryAppend): void {
    const parsed = shellHistoryAppendSchema.parse(input)
    const collector = this.collectors.get(parsed.sessionId)
    if (!collector) return
    if (collector.sensitiveOutputPending) {
      const lineEnding = /\r\n|\r|\n/.exec(parsed.data)
      if (lineEnding) {
        collector.sensitiveOutputPending = false
        const remainder = parsed.data.slice(lineEnding.index + lineEnding[0].length)
        if (remainder) this.append({ sessionId: parsed.sessionId, data: remainder })
      }
      return
    }
    const terminalData = collector.terminalControls.append(parsed.data)
    const hadSensitivePrompt = collector.sensitivePromptMarkerPending || collector.sensitiveInputPending
    const containsSensitiveResponse = updateSensitivePromptState(collector, terminalData)
    if (collector.outputBytes >= SHELL_HISTORY_MAX_OUTPUT_BYTES) return
    const output = containsSensitiveResponse
      ? redactSensitivePromptResponse(terminalData, hadSensitivePrompt)
      : terminalData
    const accepted = truncateShellHistoryText(output, SHELL_HISTORY_MAX_OUTPUT_BYTES - collector.outputBytes)
    collector.output += accepted
    collector.outputBytes += Buffer.byteLength(accepted, 'utf8')
  }

  audit(input: ShellHistoryAudit): void {
    const parsed = shellHistoryAuditSchema.parse(input)
    const collector = this.collectors.get(parsed.sessionId)
    if (!collector || collector.terminalControls.hasIncompleteSequence() || collector.commandInputBytes >= SHELL_HISTORY_MAX_AUDIT_BYTES) return
    collectCommandInput(collector, parsed.data)
  }

  /**
   * Record a completed/cancelled/failed SFTP action without allowing transfer
   * persistence to interfere with a live SSH operation.  The main process
   * supplies only display-safe metadata, and the bounded collector is later
   * written together with the corresponding closed Shell history record.
   */
  async recordFileTransfer(input: ShellHistoryFileTransferRecord): Promise<void> {
    const parsed = shellHistoryFileTransferRecordSchema.parse(input)
    const collector = this.collectors.get(parsed.sessionId)
    const log = sanitizeShellHistoryFileTransferLog({
      id: parsed.id,
      direction: parsed.direction,
      fileName: parsed.fileName,
      remotePath: parsed.remotePath,
      status: parsed.status,
      transferredBytes: parsed.transferredBytes,
      ...(parsed.totalBytes === undefined ? {} : { totalBytes: parsed.totalBytes }),
      ...(parsed.message === undefined ? {} : { message: parsed.message }),
      startedAt: parsed.startedAt,
      endedAt: parsed.endedAt,
    })

    if (collector) {
      updateFileTransferLogs(collector.fileTransferLogs, log)
      return
    }

    // Do not silently discard a result merely because the connection closed
    // while SFTP was resolving.  Its ordered tail waits for close()'s initial
    // save, then applies the same idempotent log update to the closed record.
    const closed = this.closedSessions.get(parsed.sessionId)
    if (!closed) return
    await this.enqueueClosedSessionWrite(closed, async () => {
      if (this.repository.appendFileTransferLog) {
        const updated = await this.repository.appendFileTransferLog(closed.historyId, log)
        if (updated) this.publish({ kind: 'saved', record: this.toSummary(updated) })
        return
      }
      // Compatibility fallback for repository adapters predating the atomic
      // append API. Production uses appendFileTransferLog so a concurrent
      // history update cannot overwrite a trailing transfer audit row.
      const record = await this.repository.get(closed.historyId)
      if (!record) return
      const fileTransferLogs = [...(record.fileTransferLogs ?? [])]
      updateFileTransferLogs(fileTransferLogs, log)
      const updated: ShellHistoryRecord = { ...record, fileTransferLogs }
      await this.repository.save(updated)
      this.publish({ kind: 'saved', record: this.toSummary(updated) })
    })
  }

  async close(input: ShellHistoryClose): Promise<void> {
    const parsed = shellHistoryCloseSchema.parse(input)
    const collector = this.collectors.get(parsed.sessionId)
    if (!collector) return
    this.collectors.delete(parsed.sessionId)
    if (!collector.chatId) return

    const record: ShellHistoryRecord = {
      id: collector.historyId ?? this.createId(),
      chatId: collector.chatId,
      sessionId: collector.sessionId,
      hostname: sanitizeShellHistoryDisplay(parsed.hostname ?? collector.hostname),
      title: sanitizeShellHistoryDisplay(collector.title),
      startedAt: collector.startedAt,
      endedAt: parsed.endedAt,
      status: 'closed',
      output: sanitizeShellHistoryText(collector.output),
      commandAudit: { input: sanitizeShellHistoryText(collector.commandInputChunks.join('')) },
      fileTransferLogs: collector.fileTransferLogs.map(sanitizeShellHistoryFileTransferLog),
      reconnectable: Boolean(collector.reconnectReference && this.connectionOpener?.canReconnect(collector.reconnectReference)),
      ...(collector.reconnectReference ? { reconnectReference: collector.reconnectReference } : {}),
      reconnectAudit: { count: 0 },
      connectionType: collector.connectionType,
    }
    const closed = this.rememberClosedSession(parsed.sessionId, record.id)
    try {
      await this.enqueueClosedSessionWrite(closed, () => this.repository.save(record))
      this.publish({ kind: 'saved', record: this.toSummary(record) })
    } catch {
      this.publish({ kind: 'error', message: 'Shell 历史保存失败，实时连接未受影响。' })
    }
  }

  async list(request: ShellHistoryListRequest): Promise<ShellHistorySummary[]> {
    try {
      return (await this.repository.list(request)).map(record => this.toSummary(record))
    } catch {
      throw new Error('Shell 历史暂不可用。')
    }
  }

  async get(historyId: string): Promise<ShellHistoryDetail> {
    let record: ShellHistoryRecord | undefined
    try {
      record = await this.repository.get(historyId)
    } catch {
      throw new Error('Shell 历史暂不可用。')
    }
    if (!record) throw new Error('Shell 历史记录不存在。')
    return {
      ...this.toSummary(record),
      output: sanitizeShellHistoryText(record.output),
      commandAudit: { input: sanitizeShellHistoryText(record.commandAudit?.input ?? '') },
      fileTransferLogs: (record.fileTransferLogs ?? []).map(sanitizeShellHistoryFileTransferLog),
    }
  }

  async duplicate(sessionId: string, chatId?: string): Promise<ConnectedSession> {
    const parsedSessionId = terminalSessionIdSchema.parse(sessionId)
    const parsedChatId = chatId === undefined ? undefined : chatIdentifierSchema.parse(chatId)
    if (!this.connectionOpener) throw new Error('Shell 复制不可用。')
    try {
      return await (parsedChatId === undefined
        ? this.connectionOpener.duplicate(parsedSessionId)
        : this.connectionOpener.duplicate(parsedSessionId, parsedChatId))
    } catch {
      throw new Error('Shell 复制不可用。')
    }
  }

  async reconnect(historyId: string): Promise<ConnectedSession> {
    const parsedHistoryId = shellHistoryIdSchema.parse(historyId)
    let record: ShellHistoryRecord | undefined
    try {
      record = await this.repository.get(parsedHistoryId)
    } catch {
      throw new Error('Shell 历史暂不可用。')
    }
    const reconnectReference = record?.reconnectReference
    if (!record || !reconnectReference || !this.connectionOpener?.canReconnect(reconnectReference)) {
      throw new Error('Shell 历史重连不可用。')
    }
    let session: ConnectedSession
    try {
      session = await this.connectionOpener.reconnect(reconnectReference, record.chatId)
    } catch {
      throw new Error('Shell 历史重连不可用。')
    }
    const reconnectAudit = {
      count: record.reconnectAudit.count + 1,
      lastReconnectedAt: this.now().toISOString(),
    }
    try {
      const updated: ShellHistoryRecord = { ...record, reconnectable: true, reconnectAudit }
      await this.repository.save(updated)
      this.publish({ kind: 'saved', record: this.toSummary(updated) })
    } catch {
      this.reportError()
    }
    return session
  }

  onChanged(listener: (event: ShellHistoryChangedEvent) => void): () => void {
    this.changedListeners.add(listener)
    return () => this.changedListeners.delete(listener)
  }

  reportError(): void {
    this.publish({ kind: 'error', message: 'Shell 历史保存失败，实时连接未受影响。' })
  }

  async contextAudit(chatId: string): Promise<Array<{ kind: string; label: string; at: string }>> {
    void chatId
    // Shell history captures user terminal input for local replay only. It is
    // never an authorization signal and must not be promoted into AI context.
    return []
  }

  /** Wait for any final SFTP audit writes queued after a Shell closes. */
  async drain(): Promise<void> {
    while (true) {
      const tails = [...this.closedSessions.values()].map(reference => reference.writeTail)
      await Promise.all(tails)
      if ([...this.closedSessions.values()].every(reference => tails.includes(reference.writeTail))) return
    }
  }

  private publish(event: ShellHistoryChangedEvent): void {
    const parsed = shellHistoryChangedEventSchema.parse(event)
    for (const listener of this.changedListeners) listener(parsed)
  }

  private toSummary(record: ShellHistoryRecord): ShellHistorySummary {
    return toSummary(record, Boolean(record.reconnectReference && this.connectionOpener?.canReconnect(record.reconnectReference)))
  }

  private rememberClosedSession(sessionId: string, historyId: string): ClosedSessionReference {
    this.closedSessions.delete(sessionId)
    const reference: ClosedSessionReference = { historyId, writeTail: Promise.resolve() }
    this.closedSessions.set(sessionId, reference)
    while (this.closedSessions.size > MAX_CLOSED_SESSION_REFERENCES) {
      const oldestSessionId = this.closedSessions.keys().next().value as string | undefined
      if (!oldestSessionId) break
      this.closedSessions.delete(oldestSessionId)
    }
    return reference
  }

  private enqueueClosedSessionWrite(
    reference: ClosedSessionReference,
    operation: () => Promise<void>,
  ): Promise<void> {
    const queued = reference.writeTail.then(operation)
    // Later transfer logs must still get an opportunity to persist if an
    // earlier best-effort write failed.  The caller receives the original
    // error, while the serial tail deliberately continues.
    reference.writeTail = queued.then(() => undefined, () => undefined)
    return queued
  }
}

function updateFileTransferLogs(logs: ShellHistoryFileTransferLog[], log: ShellHistoryFileTransferLog): void {
  const priorIndex = logs.findIndex(item => item.id === log.id)
  if (priorIndex >= 0) logs.splice(priorIndex, 1, log)
  else {
    logs.push(log)
    if (logs.length > SHELL_HISTORY_MAX_FILE_TRANSFER_LOGS) {
      logs.splice(0, logs.length - SHELL_HISTORY_MAX_FILE_TRANSFER_LOGS)
    }
  }
}

function collectCommandInput(collector: Collector, data: string): void {
  const lineEnding = /\r\n|\r|\n/g
  let start = 0
  let match: RegExpExecArray | null
  while ((match = lineEnding.exec(data)) !== null) {
    collectCommandFragment(collector, data.slice(start, match.index))
    finishCommandInput(collector, match[0])
    start = match.index + match[0].length
  }
  collectCommandFragment(collector, data.slice(start))
}

function collectCommandFragment(collector: Collector, fragment: string): void {
  if (!fragment || collector.sensitiveInputPending) return
  const remainingBytes = SHELL_HISTORY_MAX_AUDIT_BYTES - collector.commandInputBytes - collector.pendingCommandBytes
  if (remainingBytes <= 0) return
  const accepted = truncateShellHistoryText(fragment, remainingBytes)
  if (!accepted) return
  collector.pendingCommandChunks.push(accepted)
  collector.pendingCommandBytes += Buffer.byteLength(accepted, 'utf8')
}

function finishCommandInput(collector: Collector, lineEnding: string): void {
  if (collector.sensitiveInputPending) {
    collector.sensitiveInputPending = false
    collector.sensitivePromptMarkerPending = false
    collector.terminalTail = ''
    collector.pendingCommandChunks = []
    collector.pendingCommandBytes = 0
    collector.sensitiveOutputPending = true
    return
  }
  if (collector.pendingCommandBytes === 0) return
  collector.commandInputChunks.push(...collector.pendingCommandChunks)
  collector.commandInputBytes += collector.pendingCommandBytes
  collector.pendingCommandChunks = []
  collector.pendingCommandBytes = 0
  const acceptedEnding = truncateShellHistoryText(lineEnding, SHELL_HISTORY_MAX_AUDIT_BYTES - collector.commandInputBytes)
  if (!acceptedEnding) return
  collector.commandInputChunks.push(acceptedEnding)
  collector.commandInputBytes += Buffer.byteLength(acceptedEnding, 'utf8')
}

function updateSensitivePromptState(collector: Collector, data: string): boolean {
  const combined = stripShellHistoryTerminalControlSequences(`${collector.terminalTail}${data}`)
  const logicalLines = combined.split(/\r\n|\r|\n/)
  const hadSensitivePrompt = collector.sensitivePromptMarkerPending || collector.sensitiveInputPending
  let sensitivePromptInChunk = false
  let responseAfterSensitivePrompt = false

  for (const [index, line] of logicalLines.entries()) {
    const containsSensitiveMarker = /password|passphrase|pass phrase|pass-phrase|passwd|token|secret|api\s+(?:key|密钥)|密码|口令|令牌|密钥/i.test(line)
    const isSensitivePrompt = containsSensitiveMarker && /[:?：？]/.test(line)
    if (isSensitivePrompt) {
      collector.sensitivePromptMarkerPending = true
      collector.sensitiveInputPending = true
      sensitivePromptInChunk = true
      if (/[:?：？]\s*\S/.test(line)) responseAfterSensitivePrompt = true
      continue
    }
    if (sensitivePromptInChunk && index > 0 && line.trim()) responseAfterSensitivePrompt = true
  }

  const currentLine = logicalLines.at(-1) ?? ''
  if (hadSensitivePrompt && !sensitivePromptInChunk && currentLine.trim()) responseAfterSensitivePrompt = true
  const containsSensitiveMarker = /password|passphrase|pass phrase|pass-phrase|passwd|token|secret|api\s+(?:key|密钥)|密码|口令|令牌|密钥/i.test(currentLine)
  if (logicalLines.length > 1) collector.sensitivePromptMarkerPending = containsSensitiveMarker
  else collector.sensitivePromptMarkerPending ||= containsSensitiveMarker
  collector.sensitiveInputPending ||= collector.sensitivePromptMarkerPending && /[:?：？]\s*$/.test(currentLine)
  collector.terminalTail = responseAfterSensitivePrompt
    ? ''
    : sanitizeShellHistoryText(`${collector.terminalTail}${data}`).slice(-512)
  return responseAfterSensitivePrompt
}

function redactSensitivePromptResponse(data: string, hadSensitivePrompt: boolean): string {
  const lineEnding = /\r\n|\r|\n/g
  const plainData = stripShellHistoryTerminalControlSequences(data)
  let responsePending = hadSensitivePrompt
  let start = 0
  let output = ''
  let match: RegExpExecArray | null

  while ((match = lineEnding.exec(plainData)) !== null) {
    output += redactSensitivePromptResponseLine(plainData.slice(start, match.index), match[0], responsePending)
    const line = plainData.slice(start, match.index)
    responsePending = nextSensitiveResponsePending(line, responsePending)
    start = match.index + match[0].length
  }
  output += redactSensitivePromptResponseLine(plainData.slice(start), '', responsePending)
  return sanitizeShellHistoryText(output)
}

function redactSensitivePromptResponseLine(line: string, lineEnding: string, responsePending: boolean): string {
  if (responsePending && line.trim() && !isSensitivePrompt(line)) {
    return `${REDACTED_SHELL_HISTORY_CONTENT}${lineEnding}`
  }
  return `${line}${lineEnding}`
}

function nextSensitiveResponsePending(line: string, responsePending: boolean): boolean {
  if (isSensitivePrompt(line)) return /[:?：？]\s*$/.test(line)
  return responsePending && !line.trim()
}

function isSensitivePrompt(line: string): boolean {
  return /password|passphrase|pass phrase|pass-phrase|passwd|token|secret|api\s+(?:key|密钥)|密码|口令|令牌|密钥/i.test(line) && /[:?：？]/.test(line)
}

function toSummary(record: ShellHistoryRecord, reconnectable: boolean): ShellHistorySummary {
  return {
    id: record.id,
    chatId: record.chatId,
    hostname: sanitizeShellHistoryDisplay(record.hostname),
    title: sanitizeShellHistoryDisplay(record.title),
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    status: 'closed',
    preview: sanitizeShellHistoryText(record.output).slice(0, 512),
    reconnectable,
  }
}
