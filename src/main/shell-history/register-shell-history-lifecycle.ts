import type { ChatChangedEvent } from '../../shared/contracts'
import type { ConnectedSession, HistoryConnectedSession, TerminalClosedEvent, TerminalDataEvent, TerminalWriteEvent } from '../ssh/session-service'
import type { ShellHistoryService } from './shell-history-service'

type SessionLifecycleSource = {
  onHistoryOpened(listener: (session: HistoryConnectedSession) => void): () => void
  onUpdated(listener: (session: ConnectedSession) => void): () => void
  onData(listener: (event: TerminalDataEvent) => void): () => void
  onWrite(listener: (event: TerminalWriteEvent) => void): () => void
  onClosed(listener: (event: TerminalClosedEvent) => void): () => void
}

type ChatLifecycleSource = {
  onChanged(listener: (event: ChatChangedEvent) => void): () => void
  ensureClosedHistoryAssociation?(session: HistoryConnectedSession): Promise<{ chatId: string; historyId: string }>
}

type ShellHistoryLifecycleSink = Pick<ShellHistoryService, 'attach' | 'append' | 'audit' | 'associate' | 'close' | 'reportError'> & {
  /** Optional for compatibility with lightweight history sinks in tests. */
  drain?: () => Promise<void>
}

type ShellHistoryLifecycleOptions = {
  now?: () => Date
}

/**
 * Terminal input usually arrives one character at a time. Keep the expensive
 * history sanitization off the synchronous SSH write path while preserving
 * the exact byte sequence before a session is closed.
 */
export const SHELL_HISTORY_WRITE_AUDIT_DELAY_MS = 48

export type ShellHistoryLifecycleRegistration = (() => void) & {
  drain(): Promise<void>
}

export function registerShellHistoryLifecycle(
  sessions: SessionLifecycleSource,
  chats: ChatLifecycleSource,
  history: ShellHistoryLifecycleSink,
  options: ShellHistoryLifecycleOptions = {},
): ShellHistoryLifecycleRegistration {
  const now = options.now ?? (() => new Date())
  const associations = new Map<string, { chatId: string; historyId: string }>()
  const openedSessions = new Map<string, HistoryConnectedSession>()
  const pendingCloses = new Set<Promise<void>>()
  const pendingWriteAudits = new Map<string, string>()
  let writeAuditTimer: ReturnType<typeof setTimeout> | undefined

  const cancelWriteAuditTimer = (): void => {
    if (writeAuditTimer === undefined) return
    clearTimeout(writeAuditTimer)
    writeAuditTimer = undefined
  }

  const flushWriteAudit = (sessionId: string): void => {
    const data = pendingWriteAudits.get(sessionId)
    if (!data) return
    pendingWriteAudits.delete(sessionId)
    runSafely(() => history.audit({ sessionId, data }))
  }

  const flushWriteAudits = (sessionId?: string): void => {
    if (sessionId !== undefined) {
      flushWriteAudit(sessionId)
      if (pendingWriteAudits.size === 0) cancelWriteAuditTimer()
      return
    }
    cancelWriteAuditTimer()
    for (const id of [...pendingWriteAudits.keys()]) flushWriteAudit(id)
  }

  const scheduleWriteAudit = (): void => {
    if (writeAuditTimer !== undefined) return
    writeAuditTimer = setTimeout(() => {
      writeAuditTimer = undefined
      flushWriteAudits()
    }, SHELL_HISTORY_WRITE_AUDIT_DELAY_MS)
    writeAuditTimer.unref?.()
  }
  const unsubscribeHistoryOpened = sessions.onHistoryOpened(session => {
    runSafely(() => {
      openedSessions.set(session.id, session)
      history.attach({
        sessionId: session.id,
        hostname: historyHostname(session),
        title: session.title ?? session.hostname,
        connectionType: session.connectionType,
        reconnectReference: session.reconnectReference,
        startedAt: now().toISOString(),
      })
      const association = associations.get(session.id)
      if (association) history.associate({ sessionId: session.id, ...association })
    })
  })
  const unsubscribeUpdated = sessions.onUpdated(session => {
    const opened = openedSessions.get(session.id)
    if (!opened) return
    const updated: HistoryConnectedSession = { ...opened, ...session }
    if (!Object.prototype.hasOwnProperty.call(session, 'observedHostname')) delete updated.observedHostname
    openedSessions.set(session.id, updated)
  })
  const unsubscribeData = sessions.onData(event => {
    runSafely(() => history.append(event))
  })
  const unsubscribeWrite = sessions.onWrite(event => {
    // Do not synchronously parse and redact every keystroke from the SSH
    // write call. A per-session buffer preserves ordering, and close() below
    // flushes it before the durable history record is assembled.
    pendingWriteAudits.set(event.sessionId, `${pendingWriteAudits.get(event.sessionId) ?? ''}${event.data}`)
    scheduleWriteAudit()
  })
  const unsubscribeClosed = sessions.onClosed(event => {
    flushWriteAudits(event.sessionId)
    const endedAt = now().toISOString()
    const association = associations.get(event.sessionId)
    const session = openedSessions.get(event.sessionId)
    associations.delete(event.sessionId)
    openedSessions.delete(event.sessionId)
    const closeTask = Promise.resolve().then(async () => {
      if (!association && session && chats.ensureClosedHistoryAssociation) {
        try {
          const fallback = await chats.ensureClosedHistoryAssociation(session)
          history.associate({ sessionId: event.sessionId, ...fallback })
        } catch {
          history.reportError()
        }
      }
      await history.close({
        sessionId: event.sessionId,
        endedAt,
        ...(session ? { hostname: historyHostname(session) } : {}),
      })
    }).catch(() => undefined)
    pendingCloses.add(closeTask)
    void closeTask.finally(() => pendingCloses.delete(closeTask))
  })
  const unsubscribeChanged = chats.onChanged(event => {
    if (event.kind === 'removed') return
    for (const shell of event.chat.shells) {
      if (shell.status !== 'open' || !shell.sessionId) continue
      const association = { chatId: shell.chatId, historyId: shell.historyId }
      associations.set(shell.sessionId, association)
      runSafely(() => history.associate({ sessionId: shell.sessionId!, ...association }))
    }
  })
  let disposed = false
  const dispose = (() => {
    if (disposed) return
    disposed = true
    flushWriteAudits()
    unsubscribeHistoryOpened()
    unsubscribeUpdated()
    unsubscribeData()
    unsubscribeWrite()
    unsubscribeClosed()
    unsubscribeChanged()
  }) as ShellHistoryLifecycleRegistration
  dispose.drain = async () => {
    flushWriteAudits()
    while (pendingCloses.size > 0) await Promise.all([...pendingCloses])
    await history.drain?.()
  }
  return dispose
}

function historyHostname(session: ConnectedSession): string {
  return session.observedHostname?.trim() || session.title?.trim() || session.hostname
}

function runSafely(operation: () => unknown): void {
  try {
    const result = operation()
    if (isPromise(result)) void result.catch(() => undefined)
  } catch {
    // Terminal data and SSH lifecycle callbacks must remain independent from history persistence.
  }
}

function isPromise(value: unknown): value is Promise<unknown> {
  return typeof value === 'object' && value !== null && 'then' in value && typeof value.then === 'function'
}
