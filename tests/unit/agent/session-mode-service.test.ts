import { describe, expect, it } from 'vitest'
import { SessionModeService } from '../../../src/main/agent/session-mode-service'

describe('SessionModeService', () => {
  it('starts in Copilot and upgrades only when the user-facing request is explicit', () => {
    const modes = new SessionModeService()
    modes.create('session-a')

    expect(modes.get('session-a')).toBe('copilot')
    expect(modes.upgradeFromUserAction('session-a')).toBe('autonomous')
    expect(modes.get('session-a')).toBe('autonomous')
  })

  it('removes a closed session instead of retaining its mode', () => {
    const modes = new SessionModeService()
    modes.create('session-a')
    modes.close('session-a')

    expect(() => modes.get('session-a')).toThrow('Unknown agent session')
  })
})
