import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerSessionModeHandlers } from '../../../src/main/agent/register-session-mode-handlers'

const { handle, removeHandler } = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn() }))

vi.mock('electron', () => ({ ipcMain: { handle, removeHandler } }))

describe('registerSessionModeHandlers', () => {
  beforeEach(() => {
    handle.mockReset()
    removeHandler.mockReset()
  })

  it('accepts an explicit upgrade only from the trusted renderer', () => {
    const controller = { upgradeFromUserAction: vi.fn(() => 'autonomous') }
    const sender = { send: vi.fn() }
    const dispose = registerSessionModeHandlers(controller, sender as never)
    const upgrade = handle.mock.calls.find(([channel]) => channel === 'session-modes:upgrade')?.[1] as (event: { sender: unknown }, sessionId: unknown) => unknown

    expect(upgrade({ sender }, 'session-a')).toEqual({ sessionId: 'session-a', mode: 'autonomous' })
    expect(controller.upgradeFromUserAction).toHaveBeenCalledWith('session-a')
    expect(() => upgrade({ sender: {} }, 'session-a')).toThrow('Untrusted renderer')

    dispose()
    expect(removeHandler).toHaveBeenCalledWith('session-modes:upgrade')
  })
})
