import type { SessionMode } from '../../../shared/contracts'

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
