import type { SessionMode } from '../../../shared/contracts'
import { sshHostIdentity, sshHostnameDisplayLabels, type HostnameDisplayLabel } from '../../../shared/shell-display-label'

export const MAX_SESSION_BUFFER_CHARS = 200_000

export type SessionView = {
  id: string
  hostname: string
  observedHostname?: string
  title?: string
  mode: SessionMode
  buffer: string
}

export type NewSessionView = Omit<SessionView, 'buffer'>

export function sessionLabel(session: SessionView): string {
  return session.observedHostname ?? session.title ?? session.hostname
}

export function sessionDisplayLabel(session: SessionView, orderedSessions: readonly SessionView[]): string {
  const parts = sessionDisplayParts(session, orderedSessions)
  return parts ? parts.displayLabel : sessionLabel(session)
}

/** Presentation parts for an SSH tab/card.  Keeping the ordinal separate
 * lets the renderer style the small #x badge independently from the host
 * label while retaining the legacy combined string API for chat/a11y. */
export function sessionDisplayParts(session: SessionView, orderedSessions: readonly SessionView[]): HostnameDisplayLabel | null {
  const index = orderedSessions.findIndex(item => item.id === session.id)
  if (index < 0) return null
  return sshHostnameDisplayLabels(orderedSessions.map(item => ({ hostname: item.hostname, observedHostname: item.observedHostname, displayName: item.title })))[index] ?? null
}

export function sessionHasDuplicateHost(session: SessionView, orderedSessions: readonly SessionView[]): boolean {
  const identity = sshHostIdentity({ hostname: session.hostname, observedHostname: session.observedHostname, displayName: session.title })
  return orderedSessions.filter(item => sshHostIdentity({ hostname: item.hostname, observedHostname: item.observedHostname, displayName: item.title }) === identity).length > 1
}

export function createSessionsStore() {
  const sessions = new Map<string, SessionView>()

  return {
    add(session: NewSessionView): SessionView {
      const current = sessions.get(session.id)
      const entry = { ...current, ...session, buffer: current?.buffer ?? '' }
      if (!Object.prototype.hasOwnProperty.call(session, 'observedHostname')) delete entry.observedHostname
      sessions.set(entry.id, entry)
      return entry
    },
    appendData(sessionId: string, data: string): void {
      const session = sessions.get(sessionId)
      if (session) {
        session.buffer = `${session.buffer}${data}`.slice(-MAX_SESSION_BUFFER_CHARS)
      }
    },
    byId(sessionId: string): SessionView | undefined {
      return sessions.get(sessionId)
    },
    all(): SessionView[] {
      return [...sessions.values()]
    },
    remove(sessionId: string): void {
      sessions.delete(sessionId)
    },
  }
}
