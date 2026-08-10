import type { SessionMode } from '../../shared/contracts'

export class SessionModeService {
  private readonly modes = new Map<string, SessionMode>()

  create(sessionId: string): SessionMode {
    this.modes.set(sessionId, 'copilot')
    return 'copilot'
  }

  get(sessionId: string): SessionMode {
    const mode = this.modes.get(sessionId)
    if (!mode) throw new Error('Unknown agent session')
    return mode
  }

  upgradeFromUserAction(sessionId: string): 'autonomous' {
    this.get(sessionId)
    this.modes.set(sessionId, 'autonomous')
    return 'autonomous'
  }

  close(sessionId: string): void {
    this.modes.delete(sessionId)
  }
}
