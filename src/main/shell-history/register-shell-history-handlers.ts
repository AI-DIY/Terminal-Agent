import { ipcMain, type WebContents } from 'electron'
import {
  shellHistoryChangedEventSchema,
  shellHistoryConnectedSessionSchema,
  shellHistoryDuplicateRequestSchema,
  shellHistoryDetailSchema,
  type ShellHistoryFileTransferLog,
  shellHistoryIdSchema,
  shellHistoryListRequestSchema,
  shellHistorySummarySchema,
  terminalSessionIdSchema,
  type ShellHistoryChangedEvent,
  type ShellHistoryDetail,
  type ShellHistoryListRequest,
  type ShellHistorySummary,
} from '../../shared/contracts'
import type { ConnectedSession } from '../ssh/session-service'
import {
  REDACTED_SHELL_HISTORY_CONTENT,
  sanitizeShellHistoryDisplay,
  sanitizeShellHistoryText,
  stripShellHistoryTerminalControlSequences,
} from './shell-history-contracts'

const channels = ['shell-history:list', 'shell-history:get', 'shell-history:duplicate', 'shell-history:reconnect'] as const

type ShellHistorySource = {
  list(request: ShellHistoryListRequest): Promise<ShellHistorySummary[]>
  get(historyId: string): Promise<ShellHistoryDetail>
  duplicate(sessionId: string, chatId?: string): Promise<ConnectedSession>
  reconnect(historyId: string): Promise<ConnectedSession>
  onChanged(listener: (event: ShellHistoryChangedEvent) => void): () => void
}

export function registerShellHistoryHandlers(service: ShellHistorySource, trustedSender: WebContents): () => void {
  ipcMain.handle('shell-history:list', (event, request: unknown) => {
    assertTrustedSender(event, trustedSender)
    const parsedRequest = shellHistoryListRequestSchema.parse(request)
    return service.list(parsedRequest).then(result => {
      const parsed = shellHistorySummarySchema.array().parse(result)
      return shellHistorySummarySchema.array().parse(parsed.map(sanitizeSummary))
    })
  })
  ipcMain.handle('shell-history:get', (event, historyId: unknown) => {
    assertTrustedSender(event, trustedSender)
    const parsedId = shellHistoryIdSchema.parse(historyId)
    return service.get(parsedId).then(result => {
      const parsed = shellHistoryDetailSchema.parse(result)
      return sanitizeDetail(parsed)
    })
  })
  ipcMain.handle('shell-history:duplicate', (event, sessionId: unknown) => {
    assertTrustedSender(event, trustedSender)
    const parsedRequest = typeof sessionId === 'string'
      ? { sessionId: terminalSessionIdSchema.parse(sessionId), chatId: undefined }
      : shellHistoryDuplicateRequestSchema.parse(sessionId)
    return (parsedRequest.chatId === undefined
      ? service.duplicate(parsedRequest.sessionId)
      : service.duplicate(parsedRequest.sessionId, parsedRequest.chatId)
    ).then(sanitizeConnectedSession)
  })
  ipcMain.handle('shell-history:reconnect', (event, historyId: unknown) => {
    assertTrustedSender(event, trustedSender)
    const parsedHistoryId = shellHistoryIdSchema.parse(historyId)
    return service.reconnect(parsedHistoryId).then(sanitizeConnectedSession)
  })
  const unsubscribe = service.onChanged(event => {
    const parsed = shellHistoryChangedEventSchema.parse(event)
    trustedSender.send('shell-history:changed', parsed.kind === 'saved'
      ? shellHistoryChangedEventSchema.parse({ kind: 'saved', record: sanitizeSummary(parsed.record) })
      : parsed)
  })
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    unsubscribe()
    for (const channel of channels) ipcMain.removeHandler(channel)
  }
}

function sanitizeSummary(summary: ShellHistorySummary): ShellHistorySummary {
  return {
    ...summary,
    hostname: sanitizeShellHistoryDisplay(summary.hostname),
    title: sanitizeShellHistoryDisplay(summary.title),
    preview: sanitizeOutboundText(summary.preview, 512),
  }
}

/**
 * The service and repository already sanitize history defensively.  Repeat
 * the boundary check for every detail-only field because this IPC adapter is
 * also exercised with alternate service implementations in tests and future
 * integrations.  File-transfer metadata deliberately has no local path, but
 * remote paths and error text can still contain terminal controls or secrets.
 */
function sanitizeDetail(detail: ShellHistoryDetail): ShellHistoryDetail {
  return shellHistoryDetailSchema.parse({
    ...sanitizeSummary(detail),
    output: sanitizeOutboundText(detail.output, 256 * 1024),
    commandAudit: { input: sanitizeOutboundText(detail.commandAudit.input, 256 * 1024) },
    fileTransferLogs: detail.fileTransferLogs.map(sanitizeFileTransferLog),
  })
}

function sanitizeFileTransferLog(log: ShellHistoryFileTransferLog): ShellHistoryFileTransferLog {
  return {
    ...log,
    fileName: sanitizeShellHistoryDisplay(log.fileName),
    remotePath: sanitizeShellHistoryDisplay(log.remotePath),
    ...(log.message === undefined ? {} : { message: sanitizeOutboundText(log.message, 4_000) }),
  }
}

function sanitizeOutboundText(value: string, maximumBytes: number): string {
  return stripShellHistoryTerminalControlSequences(value) === value
    ? sanitizeShellHistoryText(value, maximumBytes)
    : REDACTED_SHELL_HISTORY_CONTENT
}

function sanitizeConnectedSession(session: ConnectedSession) {
  const candidate = session as Record<string, unknown>
  return shellHistoryConnectedSessionSchema.parse({
    id: candidate.id,
    hostname: typeof candidate.hostname === 'string' ? sanitizeShellHistoryDisplay(candidate.hostname) : candidate.hostname,
    ...(typeof candidate.title === 'string' ? { title: sanitizeShellHistoryDisplay(candidate.title) } : {}),
    mode: candidate.mode,
    ...(typeof candidate.chatId === 'string' ? { chatId: candidate.chatId } : {}),
  })
}

function assertTrustedSender(event: { sender: WebContents }, trustedSender: WebContents): void {
  if (event.sender !== trustedSender) throw new Error('Untrusted renderer')
}
