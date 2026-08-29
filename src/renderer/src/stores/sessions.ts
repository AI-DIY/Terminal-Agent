import type { SessionMode } from '../../../shared/contracts'
import { hostnameDisplayLabels } from '../../../shared/shell-display-label'

export const MAX_SESSION_BUFFER_CHARS = 200_000

export type SessionView = {
  id: string
  hostname: string
  title?: string
  mode: SessionMode
  buffer: string
}

export type NewSessionView = Omit<SessionView, 'buffer'>

export function sessionLabel(session: SessionView): string {
  return session.title ?? session.hostname
}

export function sessionDisplayLabel(session: SessionView, orderedSessions: readonly SessionView[]): string {
  const index = orderedSessions.findIndex(item => item.id === session.id)
  if (index < 0) return sessionLabel(session)
  return hostnameDisplayLabels(orderedSessions.map(item => ({ hostname: item.hostname, displayName: item.title })))[index]!.displayLabel
}

export function createSessionsStore() {
  const sessions = new Map<string, SessionView>()

  return {
    add(session: NewSessionView): SessionView {
      const current = sessions.get(session.id)
      const entry = { ...current, ...session, buffer: current?.buffer ?? '' }
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
