import { describe, expect, it, vi } from 'vitest'
import { runReleaseLauncherCleanup } from '../../helpers/release-launcher-cleanup'

describe('runReleaseLauncherCleanup', () => {
  it('continues to registry restoration after process-query and stop failures without replacing the primary launch error', async () => {
    const originalFailure = new Error('fixture SSH authentication failed')
    const query = vi.fn().mockRejectedValue(new Error('spawn UNKNOWN'))
    const stop = vi.fn().mockRejectedValue(new Error('taskkill failed'))
    const restoreRegistry = vi.fn().mockResolvedValue(undefined)
    const removeFiles = vi.fn().mockResolvedValue(undefined)

    await expect(runReleaseLauncherCleanup(originalFailure, [query, stop, restoreRegistry, removeFiles])).resolves.toBeUndefined()

    expect(query).toHaveBeenCalledOnce()
    expect(stop).toHaveBeenCalledOnce()
    expect(restoreRegistry).toHaveBeenCalledOnce()
    expect(removeFiles).toHaveBeenCalledOnce()
  })

  it('reports cleanup failures when there is no primary test failure', async () => {
    await expect(runReleaseLauncherCleanup(undefined, [
      vi.fn().mockRejectedValue(new Error('spawn UNKNOWN')),
    ])).rejects.toThrow('Release launcher cleanup failed')
  })
})
