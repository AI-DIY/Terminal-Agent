import { describe, expect, it, vi } from 'vitest'
import { closeSession } from '../../../src/renderer/src/stores/close-session'

describe('closeSession', () => {
  it('keeps the terminal tab and pane when the main-process close request rejects', async () => {
    const requestClose = vi.fn().mockRejectedValue(new Error('network lost'))
    const remove = vi.fn()
    const reportError = vi.fn()

    await closeSession('s1', requestClose, remove, reportError)

    expect(remove).not.toHaveBeenCalled()
    expect(reportError).toHaveBeenCalledWith('network lost')
  })

  it('removes the terminal only after the main-process close request succeeds', async () => {
    const requestClose = vi.fn().mockResolvedValue(undefined)
    const remove = vi.fn()

    await closeSession('s1', requestClose, remove, vi.fn())

    expect(remove).toHaveBeenCalledWith('s1')
  })
})
