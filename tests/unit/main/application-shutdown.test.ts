import { describe, expect, it, vi } from 'vitest'
import { registerGracefulApplicationShutdown } from '../../../src/main/application-shutdown'

describe('graceful application shutdown', () => {
  it('closes sessions once and waits for Shell history persistence before quitting', async () => {
    let beforeQuit: ((event: { preventDefault(): void }) => void) | undefined
    const app = {
      on: vi.fn((event: string, listener: (event: { preventDefault(): void }) => void) => {
        if (event === 'before-quit') beforeQuit = listener
      }),
      removeListener: vi.fn(),
      quit: vi.fn(),
    }
    const persistence = deferred<void>()
    const closeSessions = vi.fn()
    const drainHistory = vi.fn(() => persistence.promise)
    registerGracefulApplicationShutdown(app, closeSessions, drainHistory)
    const firstEvent = { preventDefault: vi.fn() }

    beforeQuit?.(firstEvent)
    beforeQuit?.({ preventDefault: vi.fn() })
    await Promise.resolve()

    expect(firstEvent.preventDefault).toHaveBeenCalledOnce()
    expect(closeSessions).toHaveBeenCalledOnce()
    expect(drainHistory).toHaveBeenCalledOnce()
    expect(app.quit).not.toHaveBeenCalled()

    persistence.resolve()
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce())

    const finalEvent = { preventDefault: vi.fn() }
    beforeQuit?.(finalEvent)
    expect(finalEvent.preventDefault).not.toHaveBeenCalled()
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}
