import type { SessionMode } from '../../shared/contracts'
import type { SessionService } from '../ssh/session-service'
import { SessionModeService } from './session-mode-service'

type ModeSessionSource = Pick<SessionService, 'onOpened' | 'onClosed' | 'setMode'>

export class SessionModeController {
  constructor(
    private readonly modes: SessionModeService,
    private readonly sessions: ModeSessionSource,
  ) {}

  listen(): () => void {
    const unregisterOpened = this.sessions.onOpened(session => {
      this.modes.create(session.id)
    })
    const unregisterClosed = this.sessions.onClosed(event => {
      this.modes.close(event.sessionId)
    })
    return () => {
      unregisterOpened()
      unregisterClosed()
    }
  }

  get(sessionId: string): SessionMode {
    return this.modes.get(sessionId)
  }

  upgradeFromUserAction(sessionId: string): SessionMode {
    const mode = this.modes.upgradeFromUserAction(sessionId)
    this.sessions.setMode(sessionId, mode)
    return mode
  }
}
