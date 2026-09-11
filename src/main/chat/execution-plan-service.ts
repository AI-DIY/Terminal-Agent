import type { AssistantPlanOutput, ChatExecutionPlan, ChatPlanEditStepRequest, ChatPlanRemoveStepRequest, ChatPlanCancelRequest, ChatPlanExecuteRequest } from '../../shared/chat-plan'
import type { ChatMessageContent } from '../../shared/chat-content'
import { resolvedHostnames } from '../../shared/shell-display-label'
import { resolveModelShellTargets, sameModelShellTarget, selectStableModelTargetIndex } from '../../shared/model-shell-target'
import type { PlanResultOutputWatch, PlanResultOutputWatcher } from './plan-result-auto-continue'
import type { SessionCommandCompletion } from '../ssh/session-service'

type FenceMatcher = { match(command: string): { id: string; name: string } | null }
type Sessions = {
  snapshot(): Array<{ id: string; hostname: string; observedHostname?: string; title?: string }>
  write(sessionId: string, data: string): void | Promise<void>
  /** Newer SessionService transports can acknowledge completion of a command. */
  writeAndWaitForCompletion?: (sessionId: string, data: string) => Promise<SessionCommandCompletion>
  /** Raw TCP sessions must not receive shell completion syntax. */
  supportsCommandCompletion?: (sessionId: string) => boolean
}
type Chats = { get(chatId: string): Promise<{ chat: { messages: Array<{ id: string; role: string; state: string; content: ChatMessageContent; executionPlan?: ChatExecutionPlan }>; shells: Array<{ sessionId?: string; hostname: string; observedHostname?: string; title?: string; status: string }> } }>; updateMessage(request: { requestId: string; chatId: string; messageId: string; content: ChatMessageContent; state: 'complete'; executionPlan?: ChatExecutionPlan }): Promise<unknown>; appendMessage?: (request: { requestId: string; chatId: string; role: 'user'; state: 'complete'; content: string; messageType: 'execution_audit' }) => Promise<unknown> }

type ActiveExecution = {
  plan: ChatExecutionPlan
  cancelled: boolean
  cancellationSignal: Promise<void>
  resolveCancellation: () => void
  /** Serializes only durable plan state writes, never long Shell waits. */
  stateTail: Promise<void>
  resultOutput?: PlanResultOutputWatch
  resultOutputCancelled: boolean
  cancellation?: Promise<unknown>
}

type ExecutionStart = {
  plan: ChatExecutionPlan
  execution: ActiveExecution
}

export class ExecutionPlanService {
  private readonly active = new Map<string, ActiveExecution>()
  private resultOutputWatcher?: PlanResultOutputWatcher
  // Every plan mutation and execution reads a fresh message snapshot. Keep
  // those reads and writes in one per-message queue so an older snapshot can
  // never overwrite a newer edit/removal.
  private readonly operationTails = new Map<string, Promise<void>>()
  constructor(private readonly chats: Chats, private readonly sessions: Sessions, private readonly fence: FenceMatcher, private readonly createId = () => crypto.randomUUID()) {}

  materialize(plan: NonNullable<AssistantPlanOutput['plan']>): ChatExecutionPlan {
    return { id: `EP-${this.createId()}`, title: plan.title, status: 'pending_review', steps: plan.steps.map(step => {
      const matched = this.fence.match(step.command)
      return { id: this.createId(), target: step.target, explanation: step.explanation, originalCommand: step.command, sendState: 'pending', ...(matched ? { fence: { ruleId: matched.id, ruleName: matched.name } } : {}) }
    }) }
  }

  async editStep(request: ChatPlanEditStepRequest): Promise<unknown> {
    return this.enqueue(request.messageId, () => {
      if (this.active.has(request.messageId)) throw new Error('计划不可编辑')
      return this.mutate(request, plan => {
        const step = plan.steps.find(item => item.id === request.stepId)
        if (!step || plan.status !== 'pending_review') throw new Error('计划不可编辑')
        step.finalCommand = request.command
        return plan
      })
    })
  }

  /** Attach the process-wide Shell-output observer after ChatRuntime is ready. */
  setResultOutputWatcher(watcher: PlanResultOutputWatcher | undefined): void {
    this.resultOutputWatcher = watcher
  }
  async removeStep(request: ChatPlanRemoveStepRequest): Promise<unknown> {
    return this.enqueue(request.messageId, () => {
      if (this.active.has(request.messageId)) throw new Error('计划不可删除')
      return this.mutate(request, plan => {
        if (plan.status !== 'pending_review') throw new Error('计划不可删除')
        const index = plan.steps.findIndex(item => item.id === request.stepId)
        if (index < 0) throw new Error('计划不可删除')
        if (plan.steps.length === 1) {
          // Keep a cancelled plan record for the conversation audit trail, but
          // remove its command payload so the deleted host can never be shown or
          // executed again.
          plan.steps = []
          plan.status = 'cancelled'
          return plan
        }
        plan.steps.splice(index, 1)
        return plan
      })
    })
  }
  async cancel(request: ChatPlanCancelRequest): Promise<unknown> {
    const active = this.active.get(request.messageId)
    if (active) return this.cancelActiveExecution(request, active)
    return this.enqueue(request.messageId, () => {
      const queuedActive = this.active.get(request.messageId)
      if (queuedActive) return this.cancelActiveExecution(request, queuedActive)
      return this.mutate(request, plan => {
        if (plan.status !== 'pending_review') throw new Error('计划不可取消')
        plan.status = 'cancelled'
        return plan
      })
    })
  }

  async execute(request: ChatPlanExecuteRequest): Promise<unknown> {
    const start = await this.enqueue(request.messageId, async (): Promise<ExecutionStart> => {
      if (this.active.has(request.messageId)) throw new Error('计划正在执行')
      const current = await this.requirePlan(request)
      if (current.status !== 'pending_review' || current.steps.length === 0) throw new Error('计划不可执行')
      const workspace = await this.chats.get(request.chatId)
      const online = this.sessions.snapshot()
      current.steps = current.steps.map(step => ({
        ...step,
        sessionId: findSessionForTarget(step.target, workspace.chat.shells, online),
      }))
      current.status = 'executing'

      let resolveCancellation!: () => void
      const execution: ActiveExecution = {
        plan: current,
        cancelled: false,
        cancellationSignal: new Promise<void>(resolve => { resolveCancellation = resolve }),
        resolveCancellation: () => resolveCancellation(),
        stateTail: Promise.resolve(),
        resultOutputCancelled: false,
      }
      this.active.set(request.messageId, execution)
      try {
        const initialSave = this.save(request, current, 'executing')
        execution.stateTail = initialSave.then(() => undefined, () => undefined)
        await initialSave
      } catch (error) {
        if (this.active.get(request.messageId) === execution) this.active.delete(request.messageId)
        throw error
      }
      return { plan: current, execution }
    })

    try {
      return await this.runExecution(request, start.plan, start.execution)
    } finally {
      if (this.active.get(request.messageId) === start.execution) this.active.delete(request.messageId)
    }
  }

  private async runExecution(
    request: ChatPlanExecuteRequest,
    current: ChatExecutionPlan,
    execution: ActiveExecution,
  ): Promise<unknown> {
    try {
      if (execution.cancelled) return this.cancelledResult(execution)
      // A user may change the context checkboxes between plan generation and
      // confirmation. Keep every resolved execution target in the follow-up
      // context so the command output cannot be accidentally excluded.
      const continuationSessionIds = request.sshContextSessionIds === undefined
        ? undefined
        : [...new Set([
          ...request.sshContextSessionIds,
          ...current.steps.flatMap(step => step.sessionId ? [step.sessionId] : []),
        ])]
      // Register before SessionService.write(). Some Shell adapters can
      // synchronously publish an echo/result while write() is returning;
      // delaying this registration would lose that result and leave the AI
      // waiting for a later unrelated terminal event.
      execution.resultOutput = this.resultOutputWatcher?.watch({
        chatId: request.chatId,
        messageId: request.messageId,
        ...(request.sshContextLines === undefined ? {} : { sshContextLines: request.sshContextLines }),
        ...(continuationSessionIds === undefined ? {} : { sshContextSessionIds: continuationSessionIds }),
        ...(request.skillIds === undefined ? {} : { skillIds: [...request.skillIds] }),
        ...(request.selectedSkillIds === undefined ? {} : { selectedSkillIds: [...request.selectedSkillIds] }),
      })
      const resultOutput = execution.resultOutput
      if (execution.cancelled) {
        this.cancelResultOutput(execution)
        return this.cancelledResult(execution)
      }

      const blockedSessions = new Set<string>()
      const sessionTails = new Map<string, Promise<void>>()
      const dispatches: Promise<void>[] = []
      const completionAwareByStep = new Map<string, boolean>()

      // Arm every expected output/completion before any transport write can
      // synchronously publish data. This matters when several independent
      // sessions are dispatched in the same turn: the first shell must not
      // race ahead of registration for a later sibling.
      for (const step of current.steps) {
        if (execution.cancelled) break
        if (!step.sessionId) continue
        const completionAware = typeof this.sessions.writeAndWaitForCompletion === 'function'
          && (typeof this.sessions.supportsCommandCompletion !== 'function' || this.sessions.supportsCommandCompletion(step.sessionId))
        completionAwareByStep.set(step.id, completionAware)
        if (completionAware) resultOutput?.expect(step.sessionId, { waitForCompletion: true })
        else resultOutput?.expect(step.sessionId)
      }

      // Commands targeting different sessions can be in flight together,
      // but a single interactive shell must never receive its next command
      // before the previous write/completion has settled. Build one promise
      // chain per session while retaining the reviewed plan's step order.
      const dispatchStep = async (step: typeof current.steps[number]): Promise<void> => {
        const sessionId = step.sessionId
        if (execution.cancelled) {
          if (step.sendState === 'pending') step.sendState = 'not_sent'
          if (sessionId) resultOutput?.forget(sessionId)
          return
        }
        if (!sessionId) {
          step.sendState = 'failed'
          step.failure = '目标 Shell 已断开或不可用'
          return
        }
        if (blockedSessions.has(sessionId)) {
          step.sendState = 'not_sent'
          resultOutput?.forget(sessionId)
          return
        }

        try {
          const command = `${step.finalCommand ?? step.originalCommand}\n`
          const completionAware = completionAwareByStep.get(step.id) ?? false

          if (completionAware) {
            // Record the command as sent as soon as its transport call is
            // issued. A later cancellation must preserve that audit fact.
            const completionResult = this.sessions.writeAndWaitForCompletion!(sessionId, command)
            step.sendState = 'sent'
            const completion = await completionResult
            if (execution.cancelled) return
            if (!completion.completed) {
              resultOutput?.forget(sessionId)
              step.sendState = 'failed'
              step.failure = completion.timedOut ? '命令执行等待超时' : '命令未能确认执行完成'
              blockedSessions.add(sessionId)
              return
            }
            resultOutput?.settle?.(sessionId)
          } else {
            const write = this.sessions.write(sessionId, command)
            step.sendState = 'sent'
            await write
            if (execution.cancelled) return
          }
        } catch {
          if (execution.cancelled) return
          resultOutput?.forget(sessionId)
          step.sendState = 'failed'
          step.failure = '命令未能写入目标 Shell'
          blockedSessions.add(sessionId)
        }
      }

      for (const step of current.steps) {
        if (execution.cancelled) break
        if (!step.sessionId) {
          // There is no session key with which to order an unresolved step;
          // record the failure immediately while allowing other sessions to
          // proceed.
          await dispatchStep(step)
          continue
        }
        const previous = sessionTails.get(step.sessionId) ?? Promise.resolve()
        const dispatch = previous.then(() => dispatchStep(step))
        // Keep every chain awaitable even if an adapter violates its Promise
        // contract and throws outside the guarded write path.
        const settled = dispatch.catch(() => {
          if (!execution.cancelled && step.sendState === 'pending') {
            step.sendState = 'failed'
            step.failure = '命令未能写入目标 Shell'
            blockedSessions.add(step.sessionId!)
          }
        })
        sessionTails.set(step.sessionId, settled)
        dispatches.push(settled)
      }

      // A cancellation must not wait for a command-completion probe that a
      // bastion may have swallowed. The per-shell chains continue harmlessly
      // in the background and observe `execution.cancelled` before writing a
      // later step or terminal plan state.
      const dispatchOutcome = await Promise.race([
        Promise.all(dispatches).then(() => 'settled' as const),
        execution.cancellationSignal.then(() => 'cancelled' as const),
      ])
      if (dispatchOutcome === 'cancelled' || execution.cancelled) return this.cancelledResult(execution)

      const failed = current.steps.some(step => step.sendState === 'failed')
      const sent = current.steps.filter(step => step.sendState === 'sent').length
      current.steps = current.steps.map(step => step.sendState === 'pending' ? { ...step, sendState: 'not_sent' } : step)
      current.status = failed ? (sent > 0 ? 'partially_executed' : 'execution_failed') : 'executed'
      // Keep output observations buffered until the durable result state is
      // written. This avoids launching an analysis turn against an execution
      // record that failed to persist, while still retaining synchronous Shell
      // output captured during the writes above.
      const saved = await this.enqueueExecutionState(execution, async () => {
        if (execution.cancelled) return undefined
        return this.save(request, current, 'result')
      })
      if (execution.cancelled) return this.cancelledResult(execution)
      // A failed sibling still belongs to this approved plan. Once every
      // per-session chain has settled, let successful siblings trigger the
      // normal follow-up analysis instead of cancelling the watcher just
      // because one completion probe timed out.
      if (sent === 0) this.cancelResultOutput(execution)
      else resultOutput?.complete()
      return saved
    } catch (error) {
      if (execution.cancelled) return this.cancelledResult(execution)
      this.cancelResultOutput(execution)
      await this.persistUnexpectedFailure(request, execution)
      throw error
    }
  }

  private cancelActiveExecution(request: ChatPlanCancelRequest, execution: ActiveExecution): Promise<unknown> {
    if (execution.cancellation) return execution.cancellation
    execution.cancelled = true
    execution.resolveCancellation()
    this.cancelResultOutput(execution)
    markPlanCancelled(execution.plan)
    const cancellation = this.persistCancellation(request, execution)
    execution.cancellation = cancellation
    return cancellation
  }

  /**
   * A failed cancellation write must not leave the durable plan in `executing`.
   * Preserve that original error for the caller, but make one ordered, best-
   * effort terminal-state write before releasing the active execution.
   */
  private async persistCancellation(request: ChatPlanCancelRequest, execution: ActiveExecution): Promise<unknown> {
    try {
      return await this.enqueueExecutionState(execution, () => this.save(request, execution.plan))
    } catch (error) {
      markPlanExecutionFailed(execution.plan)
      try {
        await this.enqueueExecutionState(execution, () => this.save(request, execution.plan, 'failed'))
      } catch {
        // The cancellation error remains the actionable result. The fallback
        // is only an attempt to make the durable card recoverable.
      }
      throw error
    }
  }

  private async cancelledResult(execution: ActiveExecution): Promise<unknown> {
    return execution.cancellation
  }

  private cancelResultOutput(execution: ActiveExecution): void {
    if (execution.resultOutputCancelled) return
    execution.resultOutputCancelled = true
    execution.resultOutput?.cancel()
  }

  private async persistUnexpectedFailure(request: ChatPlanExecuteRequest, execution: ActiveExecution): Promise<void> {
    markPlanExecutionFailed(execution.plan)
    try {
      await this.enqueueExecutionState(execution, async () => {
        if (execution.cancelled) return undefined
        return this.save(request, execution.plan, 'failed')
      })
    } catch {
      // Preserve the original execution error. If this best-effort write also
      // fails, the caller still receives the condition that caused the plan
      // to abort, and the active execution is released in `execute`.
    }
  }

  private enqueueExecutionState<T>(execution: ActiveExecution, operation: () => Promise<T>): Promise<T> {
    const result = execution.stateTail.catch(() => undefined).then(operation)
    execution.stateTail = result.then(() => undefined, () => undefined)
    return result
  }

  private async mutate(
    request: { chatId: string; messageId: string; requestId: string },
    change: (plan: ChatExecutionPlan) => ChatExecutionPlan,
  ): Promise<unknown> {
    const plan = await this.requirePlan(request)
    return this.save(request, change(structuredClone(plan)))
  }

  private async requirePlan(request: { chatId: string; messageId: string }): Promise<ChatExecutionPlan> {
    const workspace = await this.chats.get(request.chatId)
    const message = workspace.chat.messages.find(item => item.id === request.messageId)
    if (!message?.executionPlan || message.role !== 'assistant' || message.state !== 'complete') throw new Error('未知执行计划')
    return structuredClone(message.executionPlan)
  }

  private async save(
    request: { chatId: string; messageId: string; requestId: string },
    plan: ChatExecutionPlan,
    phase?: 'executing' | 'result' | 'failed',
  ): Promise<unknown> {
    const workspace = await this.chats.get(request.chatId)
    const message = workspace.chat.messages.find(item => item.id === request.messageId)
    if (!message) throw new Error('未知执行计划')
    const requestId = phase ? phaseRequestId(request.requestId, phase) : request.requestId
    return this.chats.updateMessage({
      requestId,
      chatId: request.chatId,
      messageId: request.messageId,
      content: message.content,
      state: 'complete',
      executionPlan: plan,
    })
  }

  private enqueue<T>(messageId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTails.get(messageId) ?? Promise.resolve()
    const result = previous.catch(() => undefined).then(operation)
    const tail = result.then(() => undefined, () => undefined)
    this.operationTails.set(messageId, tail)
    void tail.then(() => {
      if (this.operationTails.get(messageId) === tail) this.operationTails.delete(messageId)
    })
    return result
  }
}

function findSessionForTarget(
  target: string,
  shells: readonly { sessionId?: string; hostname: string; observedHostname?: string; title?: string; status: string }[],
  online: readonly { id: string; hostname: string; observedHostname?: string; title?: string }[],
): string | undefined {
  const candidates = shells.flatMap(shell => {
    if (shell.status !== 'open' || !shell.sessionId) return []
    const session = online.find(item => item.id === shell.sessionId)
    if (!session) return []
    return [{ shell, session }]
  })
  const resolved = resolvedHostnames(candidates.map(({ shell, session }) => ({
    hostname: session.hostname,
    observedHostname: session.observedHostname ?? shell.observedHostname,
    displayName: session.title ?? shell.title,
  })))
  // Keep this identity derivation in lockstep with the model-facing context.
  // In particular, IP-only/Raw sessions receive an opaque alias such as
  // `online-shell-*`; that alias must resolve to the same candidate
  // here when the user approves a generated plan.
  const modelTargets = resolveModelShellTargets(candidates.map(({ shell, session }) => ({
    stableKey: session.id,
    hostname: session.hostname,
    fallbackHostname: shell.hostname,
    observedHostname: session.observedHostname,
    fallbackObservedHostname: shell.observedHostname,
    displayName: session.title ?? shell.title,
    fallbackDisplayName: shell.title,
  })))
  // The model deliberately receives one target per host.  When that host has
  // multiple connections, use the same stable session-id #1 that its prompt
  // context presents, rather than whichever association happens to be stored
  // first.  This keeps the reviewed plan label, model context, and write
  // destination aligned after a tab/card reorder.
  const stableModelIndex = selectStableModelTargetIndex(
    target,
    modelTargets,
    candidates.map(({ session }) => session.id),
  )
  if (stableModelIndex !== undefined) return candidates[stableModelIndex]?.session.id
  return candidates.find(({ shell, session }, index) => {
    const identities = [
      modelTargets[index],
      resolved[index],
      session.observedHostname,
      shell.observedHostname,
      session.title,
      shell.title,
      session.hostname,
      shell.hostname,
    ]
    return identities.some(identity => sameModelShellTarget(identity, target))
  })?.session.id
}

function markPlanCancelled(plan: ChatExecutionPlan): void {
  plan.status = 'cancelled'
  for (const step of plan.steps) {
    if (step.sendState === 'pending') step.sendState = 'not_sent'
  }
}

function markPlanExecutionFailed(plan: ChatExecutionPlan): void {
  plan.status = 'execution_failed'
  for (const step of plan.steps) {
    if (step.sendState !== 'pending' && step.sendState !== 'not_sent') continue
    step.sendState = 'not_sent'
    if (!step.failure) step.failure = '计划执行过程中发生未预期错误'
  }
}

function phaseRequestId(requestId: string, phase: 'executing' | 'result' | 'failed'): string {
  const suffix = `:${phase}`
  return `${requestId.slice(0, 128 - suffix.length)}${suffix}`
}
