import { describe, expect, it } from 'vitest'
import { createAutonomousUpgradeStore } from '../../../src/renderer/src/stores/autonomous-upgrade'

describe('autonomous upgrade confirmation', () => {
  it('holds an active session upgrade until the user explicitly confirms it', () => {
    const upgrade = createAutonomousUpgradeStore()

    upgrade.request('session-a')

    expect(upgrade.state).toEqual({ sessionId: 'session-a', visible: true })
    expect(upgrade.confirm()).toBe('session-a')
    expect(upgrade.state).toEqual({ sessionId: null, visible: false })
  })

  it('cancels an upgrade without yielding a session id for IPC', () => {
    const upgrade = createAutonomousUpgradeStore()

    upgrade.request('session-a')
    upgrade.cancel()

    expect(upgrade.confirm()).toBeNull()
    expect(upgrade.state).toEqual({ sessionId: null, visible: false })
  })
})
