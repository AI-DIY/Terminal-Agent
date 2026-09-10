export type FrameScheduler = (callback: () => void) => number
export type FrameCanceller = (frameId: number) => void

export function createFrameBatcher<T>(
  flush: (items: T[]) => void,
  schedule: FrameScheduler,
  cancel: FrameCanceller,
) {
  let queued: T[] = []
  let frameId: number | undefined

  return {
    enqueue(item: T): void {
      queued.push(item)
      if (frameId !== undefined) return
      frameId = schedule(() => {
        frameId = undefined
        const pending = queued
        queued = []
        flush(pending)
      })
    },
    /**
     * Flush the current queue synchronously.
     *
     * Most callers can let the next animation frame deliver the batch.  Input
     * producers also need a deterministic teardown path, though: dropping a
     * queued character when a terminal pane is unmounted is observable and
     * can leave the remote shell in a different state from xterm.  Keep this
     * separate from `dispose()`, which intentionally discards pending data
     * for event listeners that are being torn down.
     */
    flush(): void {
      if (frameId !== undefined) cancel(frameId)
      frameId = undefined
      const pending = queued
      queued = []
      if (pending.length > 0) flush(pending)
    },
    dispose(): void {
      if (frameId !== undefined) cancel(frameId)
      frameId = undefined
      queued = []
    },
  }
}
