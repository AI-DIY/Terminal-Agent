import type { BuiltInSkillId } from '../../shared/built-in-skills'
import type { ChatPlanResultContinuationRequest, ChatRuntimeEvent } from './chat-runtime'

export type PlanResultOutputWatchRequest = ChatPlanResultContinuationRequest & {
  messageId: string
}

export type PlanResultOutputWatch = {
  /** Register a Shell immediately before its approved command is written. */
  expect(sessionId: string, options?: { waitForCompletion?: boolean }): void
  /**
   * Mark one command as completed by the transport. This remains optional on
   * the adapter type so older/lightweight adapters can use output fallback.
   */
  settle?(sessionId: string): void
  /** Remove a Shell whose write failed before a command could be sent. */
  forget(sessionId: string): void
  /** Declare that all plan writes have either succeeded or failed. */
  complete(): void
  /** Stop waiting when this plan did not send any command. */
  cancel(): void
}

export type PlanResultOutputWatcher = {
  watch(request: PlanResultOutputWatchRequest): PlanResultOutputWatch
}

type SessionDataSource = {
  onData(listener: (event: { sessionId: string; data: string }) => void): () => void
}

type ContinuationRuntime = {
  continueAfterPlanResult(
    request: {
      chatId: string
      sshContextLines?: number
      sshContextSessionIds?: string[]
      skillIds?: BuiltInSkillId[]
    },
    publish: (event: ChatRuntimeEvent) => void,
  ): Promise<boolean>
}

type PendingPlanResult = {
  request: PlanResultOutputWatchRequest
  /**
   * A plan can contain more than one command for the same Shell. Keep a
   * registration count so a failed later write does not remove an earlier
   * successfully sent command from the output watch.
   */
  expectedSessionCounts: Map<string, number>
  /** Registrations that must receive an explicit transport completion signal. */
  completionExpectedCounts: Map<string, number>
  /** Explicit completion signals received for completion-aware registrations. */
  settledSessionCounts: Map<string, number>
  observedSessionIds: Set<string>
  writesComplete: boolean
  settleTimer?: ReturnType<typeof setTimeout>
  partialResultTimer?: ReturnType<typeof setTimeout>
  expiryTimer?: ReturnType<typeof setTimeout>
}

type PlanResultAutoContinueOptions = {
  /** Wait briefly for adjacent terminal chunks before asking the model once. */
  settleMs?: number
  /** Maximum wait for another approved target after the first one responds. */
  partialResultWaitMs?: number
  /** Do not retain a watcher forever when a long-running command is silent. */
  timeoutMs?: number
}

const DEFAULT_SETTLE_MS = 350
const DEFAULT_PARTIAL_RESULT_WAIT_MS = 1_500
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1_000

/**
 * Bridges a reviewed plan's command writes to the next model turn. Terminal
 * protocols expose byte streams rather than portable command-complete events,
 * so a short quiet-period coalesces the first returned output without trying
 * to infer prompts, exit codes, or command success.
 */
export class PlanResultAutoContinue implements PlanResultOutputWatcher {
  private readonly pending = new Map<string, PendingPlanResult>()
  private readonly settleMs: number
  private readonly partialResultWaitMs: number
  private readonly timeoutMs: number
  private readonly unsubscribe: () => void
  private disposed = false

  constructor(
    sessions: SessionDataSource,
    private readonly runtime: ContinuationRuntime,
    private readonly publish: (event: ChatRuntimeEvent) => void,
    options: PlanResultAutoContinueOptions = {},
  ) {
    this.settleMs = Math.max(0, Math.floor(options.settleMs ?? DEFAULT_SETTLE_MS))
    this.partialResultWaitMs = Math.max(this.settleMs, Math.floor(options.partialResultWaitMs ?? DEFAULT_PARTIAL_RESULT_WAIT_MS))
    this.timeoutMs = Math.max(this.partialResultWaitMs, Math.floor(options.timeoutMs ?? DEFAULT_TIMEOUT_MS))
    this.unsubscribe = sessions.onData(event => this.onData(event))
  }

  watch(request: PlanResultOutputWatchRequest): PlanResultOutputWatch {
    // A plan IPC request can already be in flight while Electron begins
    // shutdown. Do not retain a new watch after the SessionService listener
    // has been removed.
    if (this.disposed) return inertWatch
    const key = pendingKey(request)
    this.clear(key)
    const pending: PendingPlanResult = {
      request: cloneRequest(request),
      expectedSessionCounts: new Map(),
      completionExpectedCounts: new Map(),
      settledSessionCounts: new Map(),
      observedSessionIds: new Set(),
      writesComplete: false,
    }
    pending.expiryTimer = setTimeout(() => this.clearIfCurrent(key, pending), this.timeoutMs)
    this.pending.set(key, pending)
    return {
      expect: (sessionId, options = {}) => {
        if (this.pending.get(key) !== pending) return
        pending.expectedSessionCounts.set(sessionId, (pending.expectedSessionCounts.get(sessionId) ?? 0) + 1)
        if (options.waitForCompletion) {
          pending.completionExpectedCounts.set(sessionId, (pending.completionExpectedCounts.get(sessionId) ?? 0) + 1)
        }
      },
      settle: sessionId => {
        if (this.pending.get(key) !== pending) return
        const registered = pending.expectedSessionCounts.get(sessionId) ?? 0
        if (registered === 0) return
        // A caller using the small legacy `expect(sessionId)` API may still
        // provide an explicit settle signal. Promote those registrations to
        // completion-aware ones so the signal remains useful and cannot be
        // preceded by an output-driven continuation.
        let expected = pending.completionExpectedCounts.get(sessionId) ?? 0
        if (expected === 0) {
          expected = registered
          pending.completionExpectedCounts.set(sessionId, expected)
          if (pending.partialResultTimer) {
            clearTimeout(pending.partialResultTimer)
            pending.partialResultTimer = undefined
          }
        }
        const settled = pending.settledSessionCounts.get(sessionId) ?? 0
        if (settled < expected) pending.settledSessionCounts.set(sessionId, settled + 1)
        this.scheduleIfReady(key, pending)
      },
      forget: sessionId => {
        if (this.pending.get(key) !== pending) return
        const expectedWrites = pending.expectedSessionCounts.get(sessionId) ?? 0
        if (expectedWrites <= 1) {
          pending.expectedSessionCounts.delete(sessionId)
          pending.completionExpectedCounts.delete(sessionId)
          pending.settledSessionCounts.delete(sessionId)
          pending.observedSessionIds.delete(sessionId)
        } else {
          pending.expectedSessionCounts.set(sessionId, expectedWrites - 1)
          const expectedCompletions = pending.completionExpectedCounts.get(sessionId) ?? 0
          if (expectedCompletions > 0) {
            // A failed write is registered before it is attempted. Remove one
            // completion obligation while retaining earlier signals.
            if (expectedCompletions <= 1) pending.completionExpectedCounts.delete(sessionId)
            else pending.completionExpectedCounts.set(sessionId, expectedCompletions - 1)
            const settled = pending.settledSessionCounts.get(sessionId) ?? 0
            const remainingCompletions = Math.max(0, expectedCompletions - 1)
            if (settled > remainingCompletions) pending.settledSessionCounts.set(sessionId, remainingCompletions)
          }
        }
        this.scheduleIfReady(key, pending)
      },
      complete: () => {
        if (this.pending.get(key) !== pending) return
        pending.writesComplete = true
        this.scheduleIfReady(key, pending)
      },
      cancel: () => this.clearIfCurrent(key, pending),
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe()
    for (const key of [...this.pending.keys()]) this.clear(key)
  }

  private onData(event: { sessionId: string; data: string }): void {
    if (!event.data) return
    for (const [key, pending] of this.pending) {
      // Output observed before a plan has reached SessionService.write() is
      // ordinary terminal activity, not a result of this approved plan.
      if (!pending.expectedSessionCounts.has(event.sessionId)) continue
      pending.observedSessionIds.add(event.sessionId)
      this.scheduleIfReady(key, pending)
    }
  }

  private flush(key: string, pending: PendingPlanResult): void {
    if (this.pending.get(key) !== pending) return
    const request = pending.request
    this.clear(key)
    void Promise.resolve().then(() => {
      if (this.disposed) return false
      return this.runtime.continueAfterPlanResult({
        chatId: request.chatId,
        ...(request.sshContextLines === undefined ? {} : { sshContextLines: request.sshContextLines }),
        ...(request.sshContextSessionIds === undefined ? {} : { sshContextSessionIds: [...request.sshContextSessionIds] }),
        ...(request.skillIds === undefined ? {} : { skillIds: [...request.skillIds] }),
      }, this.publish)
    }).catch(() => undefined)
  }

  private scheduleIfReady(key: string, pending: PendingPlanResult): void {
    if (this.pending.get(key) !== pending || !pending.writesComplete || pending.expectedSessionCounts.size === 0) return

    // Completion-aware registrations are authoritative. In particular, do
    // not let an early output chunk start the partial-result timer while a
    // command is still running; a command may stream output for a long time.
    const completionPending = [...pending.completionExpectedCounts.keys()].some(sessionId => (
      (pending.settledSessionCounts.get(sessionId) ?? 0)
      < (pending.completionExpectedCounts.get(sessionId) ?? 0)
    ))
    if (completionPending) return

    const allExpectedSessionsReturned = [...pending.expectedSessionCounts.keys()].every(sessionId => {
      const expectedCompletions = pending.completionExpectedCounts.get(sessionId) ?? 0
      const settledCompletions = pending.settledSessionCounts.get(sessionId) ?? 0
      const completionReady = expectedCompletions === 0 || settledCompletions >= expectedCompletions
      const outputReady = expectedCompletions >= (pending.expectedSessionCounts.get(sessionId) ?? 0)
        || pending.observedSessionIds.has(sessionId)
      return completionReady && outputReady
    })
    if (allExpectedSessionsReturned) {
      if (pending.partialResultTimer) {
        clearTimeout(pending.partialResultTimer)
        pending.partialResultTimer = undefined
      }
      if (pending.settleTimer) clearTimeout(pending.settleTimer)
      pending.settleTimer = setTimeout(() => this.flush(key, pending), this.settleMs)
      return
    }
    // A Shell command can legitimately remain silent or run for much longer
    // than a sibling command. Continue with the returned data after a bounded
    // window rather than retaining a plan watcher until its global expiry.
    if (pending.observedSessionIds.size > 0 && !pending.partialResultTimer) {
      pending.partialResultTimer = setTimeout(() => this.flush(key, pending), this.partialResultWaitMs)
    }
  }

  private clearIfCurrent(key: string, pending: PendingPlanResult): void {
    if (this.pending.get(key) === pending) this.clear(key)
  }

  private clear(key: string): void {
    const pending = this.pending.get(key)
    if (!pending) return
    this.pending.delete(key)
    if (pending.expiryTimer) clearTimeout(pending.expiryTimer)
    if (pending.settleTimer) clearTimeout(pending.settleTimer)
    if (pending.partialResultTimer) clearTimeout(pending.partialResultTimer)
  }
}

const inertWatch: PlanResultOutputWatch = {
  expect: () => undefined,
  settle: () => undefined,
  forget: () => undefined,
  complete: () => undefined,
  cancel: () => undefined,
}

function pendingKey(request: PlanResultOutputWatchRequest): string {
  return `${request.chatId}:${request.messageId}`
}

function cloneRequest(request: PlanResultOutputWatchRequest): PlanResultOutputWatchRequest {
  return {
    chatId: request.chatId,
    messageId: request.messageId,
    ...(request.sshContextLines === undefined ? {} : { sshContextLines: request.sshContextLines }),
    ...(request.sshContextSessionIds === undefined ? {} : { sshContextSessionIds: [...request.sshContextSessionIds] }),
    ...(request.skillIds === undefined ? {} : { skillIds: [...request.skillIds] }),
  }
}
