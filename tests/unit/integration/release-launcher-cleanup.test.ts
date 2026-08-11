import { describe, expect, it, vi } from 'vitest'
import { runReleaseLauncherCleanup } from '../../helpers/release-launcher-cleanup'

describe('runReleaseLauncherCleanup', () => {
  it('continues to registry restoration and reports cleanup failures together with the primary launch error', async () => {
    const originalFailure = new Error('fixture SSH authentication failed')
    const queryFailure = new Error('spawn UNKNOWN')
    const stopFailure = new Error('taskkill failed')
    const query = vi.fn().mockRejectedValue(queryFailure)
    const stop = vi.fn().mockRejectedValue(stopFailure)
    const restoreRegistry = vi.fn().mockResolvedValue(undefined)
    const removeFiles = vi.fn().mockResolvedValue(undefined)

    const failure = await runReleaseLauncherCleanup(originalFailure, [query, stop, restoreRegistry, removeFiles])
      .catch(error => error as AggregateError)

    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([originalFailure, queryFailure, stopFailure])
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
