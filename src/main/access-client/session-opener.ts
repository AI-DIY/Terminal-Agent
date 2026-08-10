import type { AccessClientSessionOpener } from './access-client-service'
import type { SessionService } from '../ssh/session-service'

type SessionOpenerPort = Pick<SessionService, 'connect' | 'connectAccessSsh' | 'connectRaw'>

export function createAccessClientSessionOpener(sessions: SessionOpenerPort): AccessClientSessionOpener {
  return {
    openSsh: request => sessions.connectAccessSsh({
      host: request.host,
      port: request.port,
      username: request.username,
      ...(request.password !== undefined ? { password: request.password } : {}),
      title: request.title,
      columns: request.columns,
      rows: request.rows,
    }),
    openRaw: request => sessions.connectRaw(request),
  }
}
