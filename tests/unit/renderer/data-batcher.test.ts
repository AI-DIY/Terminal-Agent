import { describe, expect, it, vi } from 'vitest'
import { createFrameBatcher } from '../../../src/renderer/src/stores/data-batcher'

describe('frame data batcher', () => {
  it('coalesces a burst of terminal events into one scheduled flush', () => {
    let scheduled: (() => void) | undefined
    const schedule = vi.fn((callback: () => void) => {
      scheduled = callback
      return 1
    })
    const flush = vi.fn()
    const batcher = createFrameBatcher(flush, schedule, vi.fn())

    for (let index = 0; index < 100; index += 1) batcher.enqueue(`event-${index}`)

    expect(schedule).toHaveBeenCalledOnce()
    expect(flush).not.toHaveBeenCalled()
    scheduled?.()
    expect(flush).toHaveBeenCalledOnce()
    expect(flush).toHaveBeenCalledWith(Array.from({ length: 100 }, (_, index) => `event-${index}`))
  })

  it('cancels an outstanding frame and discards queued events on dispose', () => {
    const cancel = vi.fn()
    const batcher = createFrameBatcher(vi.fn(), () => 42, cancel)

    batcher.enqueue('event')
    batcher.dispose()

    expect(cancel).toHaveBeenCalledWith(42)
  })
})
