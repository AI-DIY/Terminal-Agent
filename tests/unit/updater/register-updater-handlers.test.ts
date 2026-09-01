import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerUpdaterHandlers } from '../../../src/main/updater/register-updater-handlers'

const { handle, removeHandler } = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle, removeHandler } }))

function handlerFor(channel: string): (...args: unknown[]) => unknown {
  const handler = handle.mock.calls.find(([name]) => name === channel)?.[1]
  if (!handler) throw new Error(`Missing handler: ${channel}`)
  return handler as (...args: unknown[]) => unknown
}

describe('registerUpdaterHandlers', () => {
  beforeEach(() => { handle.mockReset(); removeHandler.mockReset() })

  it('accepts only trusted zero-argument operations and forwards events', async () => {
    const trusted = { send: vi.fn() }
    const source = {
      check: vi.fn(async () => ({ currentVersion: '2.0.5', updateAvailable: false, release: null })),
      download: vi.fn(async () => { throw new Error('not called') }),
      install: vi.fn(async () => { throw new Error('not called') }),
      restart: vi.fn(),
      getState: vi.fn(() => ({ phase: 'idle', currentVersion: '2.0.5', release: null, downloaded: null, progress: null, error: null })),
      onProgress: vi.fn().mockReturnValue(vi.fn()),
      onStatus: vi.fn().mockReturnValue(vi.fn()),
      onError: vi.fn().mockReturnValue(vi.fn()),
    }
    const dispose = registerUpdaterHandlers(source as never, trusted as never)

    await expect(handlerFor('updater:check')({ sender: trusted })).resolves.toMatchObject({ updateAvailable: false })
    await expect(handlerFor('updater:check')({ sender: trusted }, 'forged')).rejects.toThrow('do not accept arguments')
    await expect(handlerFor('updater:check')({ sender: {} })).rejects.toThrow('Untrusted renderer')
    expect(source.check).toHaveBeenCalledOnce()

    const progress = source.onProgress.mock.calls[0]?.[0] as (event: unknown) => void
    progress({ phase: 'download', percent: 50 })
    expect(trusted.send).toHaveBeenCalledWith('updater:progress', { phase: 'download', percent: 50 })
    dispose()
    dispose()
    expect(removeHandler).toHaveBeenCalledTimes(5)
  })
})
