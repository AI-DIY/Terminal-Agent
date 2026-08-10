import { describe, expect, it, vi } from 'vitest'
import { SessionModeController } from '../../../src/main/agent/session-mode-controller'
import { SessionModeService } from '../../../src/main/agent/session-mode-service'

describe('SessionModeController', () => {
  it('registers opened sessions as Copilot and upgrades only a user-requested active session', () => {
    let opened: ((session: { id: string }) => void) | undefined
    let closed: ((event: { sessionId: string }) => void) | undefined
    const sessions = {
      onOpened: vi.fn(listener => { opened = listener; return vi.fn() }),
      onClosed: vi.fn(listener => { closed = listener; return vi.fn() }),
      setMode: vi.fn(),
    }
    const controller = new SessionModeController(new SessionModeService(), sessions)
    controller.listen()

    opened?.({ id: 'session-a' })
    expect(controller.get('session-a')).toBe('copilot')

    expect(controller.upgradeFromUserAction('session-a')).toBe('autonomous')
    expect(sessions.setMode).toHaveBeenCalledWith('session-a', 'autonomous')

    closed?.({ sessionId: 'session-a' })
    expect(() => controller.get('session-a')).toThrow('Unknown agent session')
  })
})
