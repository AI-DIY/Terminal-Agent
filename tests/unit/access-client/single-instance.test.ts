import { describe, expect, it, vi } from 'vitest'
import { configureAccessClientSingleInstance } from '../../../src/main/access-client/single-instance'

describe('configureAccessClientSingleInstance', () => {
  it('opens each valid second-instance AccessClient launch as another terminal session', async () => {
    const app = createApp(true)
    const openFromArgv = vi.fn().mockResolvedValue(true)

    const isPrimary = configureAccessClientSingleInstance(app, { tryOpenFromArgv: openFromArgv })
    const listener = app.on.mock.calls.find(([event]) => event === 'second-instance')?.[1] as (_event: unknown, argv: string[]) => void
    listener({}, ['Terminal-Agent.exe', '-raw', '-P', '22022'])
    await vi.waitFor(() => expect(openFromArgv).toHaveBeenCalledWith(['Terminal-Agent.exe', '-raw', '-P', '22022']))

    expect(isPrimary).toBe(true)
    expect(app.quit).not.toHaveBeenCalled()
  })

  it('quits a non-primary process before registering Electron handlers', () => {
    const app = createApp(false)

    expect(configureAccessClientSingleInstance(app, { tryOpenFromArgv: vi.fn() })).toBe(false)

    expect(app.quit).toHaveBeenCalledOnce()
    expect(app.on).not.toHaveBeenCalled()
  })
})

function createApp(lock: boolean) {
  return {
    requestSingleInstanceLock: vi.fn(() => lock),
    quit: vi.fn(),
    on: vi.fn(),
  }
}
