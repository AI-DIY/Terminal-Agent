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
    dispose(): void {
      if (frameId !== undefined) cancel(frameId)
      frameId = undefined
      queued = []
    },
  }
}
