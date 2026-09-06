import { describe, expect, it, vi } from 'vitest'
import { PlanResultAutoContinue } from '../../../src/main/chat/plan-result-auto-continue'

describe('PlanResultAutoContinue', () => {
  it('coalesces returned SSH output into one continuation with the confirmed context selection', async () => {
    vi.useFakeTimers()
    try {
      let onData!: (event: { sessionId: string; data: string }) => void
      const unsubscribe = vi.fn()
      const sessions = {
        onData: vi.fn((listener: (event: { sessionId: string; data: string }) => void) => {
          onData = listener
          return unsubscribe
        }),
      }
      const runtime = { continueAfterPlanResult: vi.fn(async () => true) }
      const publish = vi.fn()
      const continuation = new PlanResultAutoContinue(sessions, runtime, publish, { settleMs: 20, timeoutMs: 1_000 })
      const watch = continuation.watch({
        chatId: 'chat-1',
        messageId: 'message-1',
        sshContextLines: 125,
        sshContextSessionIds: ['primary', 'alternate'],
        skillIds: ['security-review'],
      })

      // Ordinary terminal traffic before SessionService.write() is ignored.
      onData({ sessionId: 'primary', data: 'old prompt\n' })
      watch.expect('primary')
      watch.complete()
      onData({ sessionId: 'other', data: 'unrelated\n' })
      onData({ sessionId: 'primary', data: 'command echo\n' })
      await vi.advanceTimersByTimeAsync(10)
      onData({ sessionId: 'primary', data: 'command result\n' })
      await vi.advanceTimersByTimeAsync(20)

      expect(runtime.continueAfterPlanResult).toHaveBeenCalledTimes(1)
      expect(runtime.continueAfterPlanResult).toHaveBeenCalledWith({
        chatId: 'chat-1',
        sshContextLines: 125,
        sshContextSessionIds: ['primary', 'alternate'],
        skillIds: ['security-review'],
      }, publish)

      onData({ sessionId: 'primary', data: 'later output\n' })
      await vi.advanceTimersByTimeAsync(20)
      expect(runtime.continueAfterPlanResult).toHaveBeenCalledTimes(1)

      continuation.dispose()
      expect(unsubscribe).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not continue when the plan sends no command', async () => {
    vi.useFakeTimers()
    try {
      let onData!: (event: { sessionId: string; data: string }) => void
      const sessions = { onData: vi.fn((listener: (event: { sessionId: string; data: string }) => void) => { onData = listener; return () => undefined }) }
      const runtime = { continueAfterPlanResult: vi.fn(async () => true) }
      const continuation = new PlanResultAutoContinue(sessions, runtime, vi.fn(), { settleMs: 0, timeoutMs: 1_000 })
      const watch = continuation.watch({ chatId: 'chat-1', messageId: 'message-1', sshContextSessionIds: ['primary'] })

      watch.expect('primary')
      watch.cancel()
      onData({ sessionId: 'primary', data: 'not a plan result\n' })
      await vi.advanceTimersByTimeAsync(1)

      expect(runtime.continueAfterPlanResult).not.toHaveBeenCalled()
      continuation.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits for every successfully written Shell before continuing a multi-session plan', async () => {
    vi.useFakeTimers()
    try {
      let onData!: (event: { sessionId: string; data: string }) => void
      const sessions = { onData: vi.fn((listener: (event: { sessionId: string; data: string }) => void) => { onData = listener; return () => undefined }) }
      const runtime = { continueAfterPlanResult: vi.fn(async () => true) }
      const continuation = new PlanResultAutoContinue(sessions, runtime, vi.fn(), {
        settleMs: 20,
        partialResultWaitMs: 100,
        timeoutMs: 1_000,
      })
      const watch = continuation.watch({ chatId: 'chat-1', messageId: 'message-1' })

      watch.expect('web-01')
      watch.expect('db-01')
      watch.complete()
      onData({ sessionId: 'web-01', data: 'web result\n' })
      await vi.advanceTimersByTimeAsync(25)
      expect(runtime.continueAfterPlanResult).not.toHaveBeenCalled()

      onData({ sessionId: 'db-01', data: 'db result\n' })
      await vi.advanceTimersByTimeAsync(20)
      expect(runtime.continueAfterPlanResult).toHaveBeenCalledOnce()

      continuation.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses a bounded partial-result window when another written Shell stays silent', async () => {
    vi.useFakeTimers()
    try {
      let onData!: (event: { sessionId: string; data: string }) => void
      const sessions = { onData: vi.fn((listener: (event: { sessionId: string; data: string }) => void) => { onData = listener; return () => undefined }) }
      const runtime = { continueAfterPlanResult: vi.fn(async () => true) }
      const continuation = new PlanResultAutoContinue(sessions, runtime, vi.fn(), {
        settleMs: 20,
        partialResultWaitMs: 100,
        timeoutMs: 1_000,
      })
      const watch = continuation.watch({ chatId: 'chat-1', messageId: 'message-1' })

      watch.expect('web-01')
      watch.expect('db-01')
      watch.complete()
      onData({ sessionId: 'web-01', data: 'web result\n' })
      await vi.advanceTimersByTimeAsync(99)
      expect(runtime.continueAfterPlanResult).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(runtime.continueAfterPlanResult).toHaveBeenCalledOnce()

      continuation.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('retains an earlier successful write when a later same-Shell write fails', async () => {
    vi.useFakeTimers()
    try {
      let onData!: (event: { sessionId: string; data: string }) => void
      const sessions = { onData: vi.fn((listener: (event: { sessionId: string; data: string }) => void) => { onData = listener; return () => undefined }) }
      const runtime = { continueAfterPlanResult: vi.fn(async () => true) }
      const continuation = new PlanResultAutoContinue(sessions, runtime, vi.fn(), { settleMs: 20, timeoutMs: 1_000 })
      const watch = continuation.watch({ chatId: 'chat-1', messageId: 'message-1' })

      watch.expect('web-01')
      watch.expect('web-01')
      watch.forget('web-01')
      watch.complete()
      onData({ sessionId: 'web-01', data: 'first command result\n' })
      await vi.advanceTimersByTimeAsync(20)

      expect(runtime.continueAfterPlanResult).toHaveBeenCalledOnce()
      continuation.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cleans timers and the session listener once during disposal', async () => {
    vi.useFakeTimers()
    try {
      let onData!: (event: { sessionId: string; data: string }) => void
      const unsubscribe = vi.fn()
      const sessions = {
        onData: vi.fn((listener: (event: { sessionId: string; data: string }) => void) => {
          onData = listener
          return unsubscribe
        }),
      }
      const runtime = { continueAfterPlanResult: vi.fn(async () => true) }
      const continuation = new PlanResultAutoContinue(sessions, runtime, vi.fn(), { settleMs: 20, timeoutMs: 1_000 })
      const watch = continuation.watch({ chatId: 'chat-1', messageId: 'message-1' })
      watch.expect('web-01')
      watch.complete()
      onData({ sessionId: 'web-01', data: 'result\n' })

      continuation.dispose()
      continuation.dispose()
      await vi.advanceTimersByTimeAsync(1_000)

      expect(unsubscribe).toHaveBeenCalledOnce()
      expect(runtime.continueAfterPlanResult).not.toHaveBeenCalled()

      const afterDispose = continuation.watch({ chatId: 'chat-2', messageId: 'message-2' })
      afterDispose.expect('web-01')
      afterDispose.complete()
      onData({ sessionId: 'web-01', data: 'late result\n' })
      await vi.advanceTimersByTimeAsync(1_000)
      expect(runtime.continueAfterPlanResult).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('swallows a synchronous continuation adapter failure from the timer callback', async () => {
    vi.useFakeTimers()
    try {
      let onData!: (event: { sessionId: string; data: string }) => void
      const sessions = { onData: vi.fn((listener: (event: { sessionId: string; data: string }) => void) => { onData = listener; return () => undefined }) }
      const runtime = { continueAfterPlanResult: vi.fn(() => { throw new Error('runtime unavailable') }) }
      const continuation = new PlanResultAutoContinue(sessions, runtime, vi.fn(), { settleMs: 0, timeoutMs: 1_000 })
      const watch = continuation.watch({ chatId: 'chat-1', messageId: 'message-1' })
      watch.expect('web-01')
      watch.complete()
      onData({ sessionId: 'web-01', data: 'result\n' })

      await vi.advanceTimersByTimeAsync(0)
      // Flush the Promise.resolve() hop used to normalize sync throws.
      await Promise.resolve()
      expect(runtime.continueAfterPlanResult).toHaveBeenCalledOnce()
      continuation.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not start a queued continuation if disposal wins after the settle timer', async () => {
    vi.useFakeTimers()
    try {
      let onData!: (event: { sessionId: string; data: string }) => void
      const sessions = { onData: vi.fn((listener: (event: { sessionId: string; data: string }) => void) => { onData = listener; return () => undefined }) }
      const runtime = { continueAfterPlanResult: vi.fn(async () => true) }
      const continuation = new PlanResultAutoContinue(sessions, runtime, vi.fn(), { settleMs: 20, timeoutMs: 1_000 })
      const watch = continuation.watch({ chatId: 'chat-1', messageId: 'message-1' })
      watch.expect('web-01')
      watch.complete()
      onData({ sessionId: 'web-01', data: 'result\n' })

      // Run the timer callback synchronously, then dispose before its queued
      // Promise microtask gets a chance to call the runtime.
      vi.advanceTimersByTime(20)
      continuation.dispose()
      await Promise.resolve()
      expect(runtime.continueAfterPlanResult).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
