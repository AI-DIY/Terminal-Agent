import { randomUUID } from 'node:crypto'
import type { ChatMessage, ChatCompletionResponseFormat } from '../model/chat-completions-client'
import type { ProviderModelSettings } from '../model/model-provider-router'
import type { ChatMessageContent } from '../../shared/chat-content'
import type { AssistantPlanOutput } from '../../shared/chat-plan'
import type { StructuredChatRequest, StructuredChatShell } from './structured-chat-agent'
import type { ChatCompactRequest, ChatProgressStage } from '../../shared/contracts'
import type { BuiltInSkillId } from '../../shared/built-in-skills'
import type { SkillDocument, SkillId, SkillSummary, SkillRuntimeEvent } from '../../shared/skill-contracts'
import type { StructuredSkillRuntime } from './structured-chat-agent'
import { estimateChatMessages } from './token-estimator'
/* eslint-disable @typescript-eslint/no-explicit-any */

export type ChatRuntimeRequest = {
  chatId: string
  runId: string
  content: ChatMessageContent
  retry?: boolean
  sshContextLines?: number
  sshContextSessionIds?: string[]
  skillIds?: BuiltInSkillId[]
  selectedSkillIds?: SkillId[]
  /** Trusted main-process continuation: do not persist a synthetic user turn. */
  skipUserMessage?: true
  /** Trusted prompt appended only to the model request, never to the transcript. */
  transientPrompt?: string
  /** Called after this run becomes the active owner. Not exposed through IPC. */
  onStarted?: () => void
  /** Trusted continuation guard: return without superseding an existing run. */
  onlyIfIdle?: true
  /** Epoch captured before the continuation's scheduling boundary. */
  onlyIfIdleEpoch?: number
}
export type ChatRuntimeEvent =
  | { kind: 'chat:auto-started'; chatId: string; runId: string }
  | { kind: 'chat:progress'; chatId: string; runId: string; stage: ChatProgressStage }
  | { kind: 'chat:delta'; chatId: string; runId: string; messageId: string; content: string }
  | { kind: 'chat:completed'; chatId: string; runId: string; messageId: string; content: string; executionPlan?: import('../../shared/chat-plan').ChatExecutionPlan }
  | { kind: 'chat:error'; chatId: string; runId: string; messageId: string; error: string; retryable: boolean }
  | SkillRuntimeEvent

export type ChatPlanResultContinuationRequest = {
  chatId: string
  sshContextLines?: number
  sshContextSessionIds?: string[]
  skillIds?: BuiltInSkillId[]
  selectedSkillIds?: SkillId[]
}

type RuntimeDeps = {
  appendMessage(request: any): Promise<{ messageId?: string } | unknown>
  updateMessage?(request: any): Promise<unknown>
  getRetryMessageId?(chatId: string, content: any): Promise<string | undefined>
  getContext(chatId: string, options?: {
    sshContextLines?: number
    sshContextSessionIds?: readonly string[]
    skillIds?: readonly BuiltInSkillId[]
    selectedSkillIds?: readonly SkillId[]
    maxMessages?: number
  }): Promise<ChatMessage[] | {
    messages: ChatMessage[]
    hasImages: boolean
    availableHostnames: string[]
    availableShells?: StructuredChatShell[]
    preserveShellConnections?: boolean
    skillIds?: BuiltInSkillId[]
    selectedSkillIds?: SkillId[]
    skillCatalog?: SkillSummary[]
    skillDocuments?: SkillDocument[]
  }>
  resolveModel(input?: { hasImages: boolean }): Promise<ProviderModelSettings>
  runStructured?(settings: ProviderModelSettings, input: StructuredChatRequest, signal: AbortSignal, onStage?: (stage: ChatProgressStage) => void): Promise<AssistantPlanOutput>
  materializePlan?(plan: NonNullable<AssistantPlanOutput['plan']>): import('../../shared/chat-plan').ChatExecutionPlan
  stream(settings: ProviderModelSettings, messages: ChatMessage[], onDelta: (content: string) => void, responseFormat?: ChatCompletionResponseFormat, signal?: AbortSignal): Promise<void>
  skillRuntime?: StructuredSkillRuntime
  timeoutMs?: number
}

export class ChatRuntime {
  private readonly active = new Map<string, ActiveChatRun>()
  private readonly generations = new Map<string, number>()
  /**
   * Counts user-originated send invocations, including ones still waiting on
   * compaction. Automatic result turns use the captured value to avoid
   * overtaking a user request that has already entered the runtime.
   */
  private readonly userRequestEpochs = new Map<string, number>()
  /**
   * A compaction lock is held for the whole compaction transaction.  In
   * particular, the lock is not released until the caller has persisted the
   * generated summary (see compactAndPersist).  This prevents a new turn from
   * taking a transcript snapshot between summary generation and persistence.
   */
  private readonly compactions = new Map<string, Promise<void>>()
  constructor(private readonly deps: RuntimeDeps) {}

  async send(request: ChatRuntimeRequest, publish: (event: ChatRuntimeEvent) => void): Promise<void> {
    const userRequestEpoch = this.userRequestEpochs.get(request.chatId) ?? 0
    if (!request.onlyIfIdle) this.userRequestEpochs.set(request.chatId, userRequestEpoch + 1)
    const expectedUserRequestEpoch = request.onlyIfIdleEpoch ?? userRequestEpoch
    // A compaction may have cancelled the previous run but still be reading
    // and summarising its transcript.  Wait for that transaction to finish so
    // this turn cannot hydrate from the pre-summary snapshot.
    await this.waitForCompaction(request.chatId)
    // Automatic plan-result turns must never win a race against a user turn
    // that became active while compaction was settling. Keep this check
    // immediately adjacent to active-run installation; there is no await
    // between the two operations, so either side wins deterministically.
    if (request.onlyIfIdle && (
      this.active.has(request.chatId)
      || (this.userRequestEpochs.get(request.chatId) ?? 0) !== expectedUserRequestEpoch
    )) return
    const superseded = this.active.get(request.chatId)
    superseded?.controller.abort()
    const controller = new AbortController()
    const generation = (this.generations.get(request.chatId) ?? 0) + 1
    this.generations.set(request.chatId, generation)
    let resolveDone!: () => void
    const done = new Promise<void>(resolve => { resolveDone = resolve })
    let messageId: string = randomUUID()
    let timedOut = false
    const run: ActiveChatRun = {
      chatId: request.chatId,
      controller,
      generation,
      runId: request.runId,
      publish,
      messageId,
      pendingAssistantWrites: new Set(),
      done,
      resolveDone,
    }
    this.active.set(request.chatId, run)
    request.onStarted?.()
    if (superseded) await this.finalizeCancelledRun(superseded)
    const isOwner = () => {
      const current = this.active.get(request.chatId)
      return current?.controller === controller && current.generation === generation
    }
    const isLiveOwner = () => isOwner() && !controller.signal.aborted
    const publishProgress = (stage: ChatProgressStage): void => {
      if (isLiveOwner()) publish({ kind: 'chat:progress', chatId: request.chatId, runId: request.runId, stage })
    }
    const trackAssistantWrite = <T>(operation: Promise<T>): Promise<T> => {
      return this.trackAssistantWrite(run, operation)
    }
    const finalizeCancellationIfNeeded = async (): Promise<void> => {
      if (controller.signal.aborted && !timedOut) await this.finalizeCancelledRun(run)
    }
    let cancelled = false
    const onAbort = () => { if (!timedOut) cancelled = true }
    controller.signal.addEventListener('abort', onAbort, { once: true })
    let output = ''
    let materializedPlan: import('../../shared/chat-plan').ChatExecutionPlan | undefined
    let persistedMessageId: string | undefined
    let retryMessageId: string | undefined
    const pendingUpdates: Promise<unknown>[] = []
    try {
      if (request.retry) retryMessageId = await this.deps.getRetryMessageId?.(request.chatId, request.content)
      if ((!request.retry || !retryMessageId) && !request.skipUserMessage && isOwner()) {
        try {
          await this.deps.appendMessage({ requestId: `${request.runId}:user`, chatId: request.chatId, role: 'user', content: request.content, state: 'complete' })
        } catch {
          throw new ChatPersistenceError()
        }
      }
      if (!isLiveOwner()) {
        await finalizeCancellationIfNeeded()
        return
      }
      const contextResult = await this.deps.getContext(request.chatId, {
        sshContextLines: request.sshContextLines,
        ...(request.sshContextSessionIds === undefined ? {} : { sshContextSessionIds: request.sshContextSessionIds }),
        ...(request.skillIds === undefined ? {} : { skillIds: request.skillIds }),
        ...(request.selectedSkillIds === undefined ? {} : { selectedSkillIds: request.selectedSkillIds }),
      })
      const structuredContext = Array.isArray(contextResult) ? null : contextResult
      const context = Array.isArray(contextResult) ? contextResult : contextResult.messages
      // Plan-result follow-ups are deliberately transient. The persisted
      // transcript already carries the reviewed plan, while this trusted
      // prompt tells the model why it should inspect the freshly selected SSH
      // output without manufacturing a user message in the conversation.
      const modelContext = request.transientPrompt
        ? [...context, { role: 'user' as const, content: request.transientPrompt }]
        : context
      const effectiveSkillIds = structuredContext?.skillIds ?? request.skillIds
      const effectiveSelectedSkillIds = structuredContext?.selectedSkillIds ?? request.selectedSkillIds
      const preserveShellConnections = structuredContext?.preserveShellConnections ?? request.sshContextSessionIds !== undefined
      const settings = await this.deps.resolveModel({ hasImages: structuredContext?.hasImages ?? false })
      if (!isLiveOwner()) {
        await finalizeCancellationIfNeeded()
        return
      }
      if (estimateChatMessages(modelContext) > settings.contextLimit) throw new Error('聊天上下文超出当前模型限制，请先压缩历史消息。')
      if (isLiveOwner()) {
        persistedMessageId = retryMessageId
        if (isLiveOwner()) {
          if (persistedMessageId && this.deps.updateMessage) {
            await trackAssistantWrite(this.deps.updateMessage({ requestId: `${request.runId}:assistant:retrying`, chatId: request.chatId, messageId: persistedMessageId, content: '', state: 'streaming' }))
          } else {
            const persisted = await trackAssistantWrite(this.deps.appendMessage({ requestId: `${request.runId}:assistant:streaming`, chatId: request.chatId, role: 'assistant', content: '', state: 'streaming' }))
            persistedMessageId = persistedMessageIdFrom(persisted)
          }
        }
      }
      if (persistedMessageId) {
        messageId = persistedMessageId
        run.persistedMessageId = persistedMessageId
        run.messageId = persistedMessageId
      }
      if (!isLiveOwner()) {
        await finalizeCancellationIfNeeded()
        return
      }
      const timeout = setTimeout(() => { timedOut = true; controller.abort() }, this.deps.timeoutMs ?? 120_000)
      try {
        const providerStream = this.deps.runStructured
          ? (publishProgress('thinking'), this.deps.runStructured(settings, {
            messages: modelContext,
            availableHostnames: structuredContext?.availableHostnames ?? [],
            ...(structuredContext?.availableShells ? { availableShells: structuredContext.availableShells } : {}),
            ...(preserveShellConnections ? { preserveShellConnections: true } : {}),
            ...(effectiveSkillIds?.length ? { skillIds: effectiveSkillIds } : {}),
            ...(effectiveSelectedSkillIds?.length ? { selectedSkillIds: effectiveSelectedSkillIds } : {}),
            ...(structuredContext?.skillCatalog?.length ? { skillCatalog: structuredContext.skillCatalog } : {}),
            ...(structuredContext?.skillDocuments?.length ? { skillDocuments: structuredContext.skillDocuments } : {}),
            ...(this.deps.skillRuntime ? { skillRuntime: this.scopedSkillRuntime(request, controller, publish, isLiveOwner) } : {}),
            chatId: request.chatId,
            runId: request.runId,
            contextLimit: settings.contextLimit,
          }, controller.signal, publishProgress)).then(result => { publishProgress('observing'); materializedPlan = result.plan && this.deps.materializePlan ? this.deps.materializePlan(result.plan) : undefined; output = JSON.stringify(result) })
          : Promise.resolve().then(() => this.deps.stream(settings, modelContext, delta => {
          if (!isLiveOwner()) return
          output += delta
          if (persistedMessageId && this.deps.updateMessage) {
            const update = { requestId: `${request.runId}:assistant:update:${output.length}`, chatId: request.chatId, messageId: persistedMessageId, content: output, state: 'streaming' as const }
            pendingUpdates.push(trackAssistantWrite(Promise.resolve().then(() => isLiveOwner() ? this.deps.updateMessage!(update) : undefined)))
          }
          publish({ kind: 'chat:delta', chatId: request.chatId, runId: request.runId, messageId, content: delta })
          }, undefined, controller.signal))
        await raceProviderStreamWithAbort(providerStream, controller.signal)
      } finally { clearTimeout(timeout) }
      if (!isOwner()) {
        await finalizeCancellationIfNeeded()
        return
      }
      if (controller.signal.aborted) {
        if (timedOut) {
          const timeoutError = new Error('聊天请求超时。')
          await this.persistTimeout(request, persistedMessageId, timeoutError.message, trackAssistantWrite)
          if (!isOwner()) return
          publish({ kind: 'chat:error', chatId: request.chatId, runId: request.runId, messageId, error: timeoutError.message, retryable: true })
        } else await this.finalizeCancelledRun(run)
        return
      }
      if (!isOwner()) {
        await finalizeCancellationIfNeeded()
        return
      }
      await Promise.all(pendingUpdates)
      if (!isLiveOwner()) {
        await finalizeCancellationIfNeeded()
        return
      }
      if (persistedMessageId && this.deps.updateMessage) await trackAssistantWrite(this.deps.updateMessage({ requestId: `${request.runId}:assistant:complete`, chatId: request.chatId, messageId: persistedMessageId, content: output, state: 'complete', ...(materializedPlan ? { executionPlan: materializedPlan } : {}) }))
      else await trackAssistantWrite(this.deps.appendMessage({ requestId: `${request.runId}:assistant`, chatId: request.chatId, role: 'assistant', content: output, state: 'complete', ...(materializedPlan ? { executionPlan: materializedPlan } : {}) }))
      if (!isLiveOwner()) {
        await finalizeCancellationIfNeeded()
        return
      }
      publish({ kind: 'chat:completed', chatId: request.chatId, runId: request.runId, messageId, content: output, ...(materializedPlan ? { executionPlan: materializedPlan } : {}) })
    } catch (error) {
      if (!isOwner()) return
      if (controller.signal.aborted) {
        if (timedOut) {
          const message = '聊天请求超时。'
          await this.persistTimeout(request, persistedMessageId, message, trackAssistantWrite)
          if (!isOwner()) return
          publish({ kind: 'chat:error', chatId: request.chatId, runId: request.runId, messageId, error: message, retryable: true })
          return
        }
        if (cancelled) {
          await this.finalizeCancelledRun(run)
          return
        }
      }
      const message = publicChatError(error)
      try {
        if (persistedMessageId && this.deps.updateMessage) {
          await trackAssistantWrite(this.deps.updateMessage({ requestId: `${request.runId}:assistant:error`, chatId: request.chatId, messageId: persistedMessageId, content: message, state: 'error', retryable: true }))
        } else {
          await trackAssistantWrite(this.deps.appendMessage({ requestId: `${request.runId}:assistant:error`, chatId: request.chatId, role: 'assistant', content: message, state: 'error', retryable: true }))
        }
      } catch {
        // Persistence failures must not replace the safe renderer-facing error.
      }
      if (!isLiveOwner()) {
        await finalizeCancellationIfNeeded()
        return
      }
      publish({ kind: 'chat:error', chatId: request.chatId, runId: request.runId, messageId, error: message, retryable: true })
    } finally {
      controller.signal.removeEventListener('abort', onAbort)
      if (isOwner()) this.active.delete(request.chatId)
      run.resolveDone()
    }
  }

  /**
   * Start one trusted follow-up after an approved plan's target Shell emits
   * output. The prompt is intentionally not persisted as a user message: the
   * existing task history and explicit SSH selection remain the source of
   * truth, and any next command still materializes as a new reviewable plan.
   */
  async continueAfterPlanResult(
    request: ChatPlanResultContinuationRequest,
    publish: (event: ChatRuntimeEvent) => void,
  ): Promise<boolean> {
    // A result must never interrupt a user turn or a deliberate compaction.
    // Dropping the automatic continuation in that case leaves the terminal
    // output available for the user's next explicit request.
    if (this.active.has(request.chatId) || this.compactions.has(request.chatId)) return false
    const idleEpoch = this.userRequestEpochs.get(request.chatId) ?? 0
    // Give an already-dispatched renderer input a chance to install its
    // explicit run before this timer-driven continuation claims the chat.
    // This microtask-only delay keeps the normal result analysis responsive
    // while making the idle-only policy deterministic at the UI event boundary.
    await Promise.resolve()
    if (this.active.has(request.chatId) || this.compactions.has(request.chatId)) return false
    const runId = randomUUID()
    let started = false
    await this.send({
      ...request,
      runId,
      content: planResultContinuationPrompt,
      skipUserMessage: true,
      transientPrompt: planResultContinuationPrompt,
      onlyIfIdle: true,
      onlyIfIdleEpoch: idleEpoch,
      onStarted: () => {
        started = true
        publish({ kind: 'chat:auto-started', chatId: request.chatId, runId })
      },
    }, publish)
    return started
  }

  /**
   * Generates a compact, model-authored task summary without changing the
   * visible transcript. The caller persists it as a context-summary message,
   * which becomes the durable boundary used by buildChatContext().
   */
  async compact(request: ChatCompactRequest): Promise<string> {
    return this.withCompactionLock(request.chatId, () => this.generateCompactionSummary(request))
  }

  /**
   * Generate and persist a compaction summary while retaining the per-chat
   * lock through the persistence callback.  The IPC handler uses this variant
   * so a send cannot race the summary append between the two operations.
   */
  async compactAndPersist<T>(request: ChatCompactRequest, persist: (summary: string) => Promise<T>): Promise<T> {
    return this.withCompactionLock(request.chatId, async () => {
      const summary = await this.generateCompactionSummary(request)
      return persist(summary)
    })
  }

  private async generateCompactionSummary(request: ChatCompactRequest): Promise<string> {
    await this.cancel(request.chatId)
    const controller = new AbortController()
    let timedOut = false
    const timeout = setTimeout(() => { timedOut = true; controller.abort() }, this.deps.timeoutMs ?? 120_000)
    try {
      // Compaction needs a wider transcript window than a normal turn. The
      // context builder still applies its hard safety cap, while preserving
      // the latest summary boundary when one already exists.
      const contextResult = await this.deps.getContext(request.chatId, {
        sshContextLines: request.sshContextLines,
        ...(request.sshContextSessionIds === undefined ? {} : { sshContextSessionIds: request.sshContextSessionIds }),
        ...(request.skillIds === undefined ? {} : { skillIds: request.skillIds }),
        // Context compression is deliberately non-executing: omit explicit
        // standard Skill selections so the structured model cannot load or
        // run local Skill commands while summarizing history.
        selectedSkillIds: [],
        maxMessages: 100,
      })
      const structuredContext = Array.isArray(contextResult) ? null : contextResult
      const context = Array.isArray(contextResult) ? contextResult : contextResult.messages
      // Older context adapters may not echo request-scoped skills or the
      // explicit connection-selection mode. Preserve those choices when the
      // structured context projection is otherwise valid but incomplete.
      const effectiveSkillIds = structuredContext?.skillIds ?? request.skillIds
      const preserveShellConnections = structuredContext?.preserveShellConnections ?? request.sshContextSessionIds !== undefined
      const settings = await this.deps.resolveModel({ hasImages: structuredContext?.hasImages ?? false })
      if (estimateChatMessages(context) > settings.contextLimit) {
        throw new Error('聊天上下文超出当前模型限制，无法生成摘要。请先减少 SSH 上下文追加行数后重试。')
      }
      const summaryPrompt: ChatMessage = {
        role: 'user',
        content: '请将此前任务对话压缩成面向后续运维协作的简明摘要。保留目标、已确认的事实、已执行或待执行的步骤、风险和待确认事项；不要编造信息，不要执行命令。此请求仅用于上下文压缩：请在 reply 中给出摘要，plan 必须为 null。',
      }
      if (this.deps.runStructured) {
        const result = await this.deps.runStructured(settings, {
          messages: [...context, summaryPrompt],
          availableHostnames: structuredContext?.availableHostnames ?? [],
          ...(structuredContext?.availableShells ? { availableShells: structuredContext.availableShells } : {}),
          ...(preserveShellConnections ? { preserveShellConnections: true } : {}),
          ...(effectiveSkillIds?.length ? { skillIds: effectiveSkillIds } : {}),
          skillCatalog: [],
          contextLimit: settings.contextLimit,
        }, controller.signal)
        const summary = result.reply.trim()
        if (summary) return summary
        throw new Error('AI 未返回可用摘要。')
      }

      let summary = ''
      await this.deps.stream(settings, [...context, summaryPrompt], delta => { summary += delta }, undefined, controller.signal)
      summary = summary.trim()
      if (summary) return summary
      throw new Error('AI 未返回可用摘要。')
    } catch (error) {
      if (timedOut || controller.signal.aborted) throw new Error('上下文压缩超时，请稍后重试。', { cause: error })
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }

  private scopedSkillRuntime(
    request: ChatRuntimeRequest,
    _controller: AbortController,
    publish: (event: ChatRuntimeEvent) => void,
    isLiveOwner: () => boolean,
  ): StructuredSkillRuntime {
    const runtime = this.deps.skillRuntime!
    return {
      loadSkill: (skillId, signal) => runtime.loadSkill(skillId, signal),
      readSkillFile: (skillId, path, signal) => runtime.readSkillFile(skillId, path, signal),
      runSkillCommand: (command, signal) => runtime.runSkillCommand(command, signal),
      onEvent: event => {
        if (!isLiveOwner()) return
        publish({
          kind: 'chat:skill',
          chatId: request.chatId,
          runId: request.runId,
          invocationId: event.invocationId,
          skillId: event.skillId,
          stage: event.stage,
          detail: event.detail,
        })
      },
    }
  }

  /** Wait until all currently queued compaction transactions for a chat finish. */
  private async waitForCompaction(chatId: string): Promise<void> {
    while (true) {
      const pending = this.compactions.get(chatId)
      if (!pending) return
      await pending
      // Another compaction can have been queued immediately after the one we
      // awaited.  Re-check the map before allowing a send to proceed.
      if (this.compactions.get(chatId) === pending) return
    }
  }

  private async withCompactionLock<T>(chatId: string, operation: () => Promise<T>): Promise<T> {
    const release = await this.acquireCompactionLock(chatId)
    try {
      return await operation()
    } finally {
      release()
    }
  }

  private async acquireCompactionLock(chatId: string): Promise<() => void> {
    // Serialise concurrent compaction requests.  The lock is installed
    // synchronously once no predecessor remains, so two callers cannot both
    // observe an empty map and enter the critical section.
    while (true) {
      const predecessor = this.compactions.get(chatId)
      if (!predecessor) break
      await predecessor
    }

    let resolveLock!: () => void
    const lock = new Promise<void>(resolve => { resolveLock = resolve })
    this.compactions.set(chatId, lock)
    let released = false
    return () => {
      if (released) return
      released = true
      if (this.compactions.get(chatId) === lock) {
        this.compactions.delete(chatId)
        resolveLock()
      }
    }
  }

  async cancel(chatId: string): Promise<void> {
    const run = this.active.get(chatId)
    if (!run) return
    run.controller.abort()
    await run.done
    if (run.cancellationError) throw run.cancellationError
  }

  private async finalizeCancelledRun(run: ActiveChatRun): Promise<void> {
    if (run.cancellationFinalization) return run.cancellationFinalization
    const finalization = this.persistCancelledRun(run).catch(() => {
      run.cancellationError = new ChatCancellationPersistenceError()
    })
    run.cancellationFinalization = finalization
    return finalization
  }

  private async persistCancelledRun(run: ActiveChatRun): Promise<void> {
    await Promise.allSettled([...run.pendingAssistantWrites])
    const message = '已取消。'
    let messageId = run.persistedMessageId
    const requestId = `${run.runId}:assistant:${this.isOwner(run) ? 'cancel' : 'superseded'}`
    try {
      if (messageId && this.deps.updateMessage) {
        await this.trackAssistantWrite(run, this.deps.updateMessage({ requestId, chatId: run.chatId, messageId, content: message, state: 'error', retryable: false }))
      } else {
        const persisted = await this.trackAssistantWrite(run, this.deps.appendMessage({ requestId, chatId: run.chatId, role: 'assistant', content: message, state: 'error', retryable: false }))
        const persistedId = persistedMessageIdFrom(persisted)
        if (!persistedId) throw new ChatCancellationPersistenceError()
        messageId = persistedId
        run.persistedMessageId = persistedId
      }
    } catch (error) {
      throw error instanceof ChatCancellationPersistenceError ? error : new ChatCancellationPersistenceError()
    }
    run.messageId = messageId!
    if (!this.isOwner(run)) return
    run.publish({ kind: 'chat:error', chatId: run.chatId, runId: run.runId, messageId: run.messageId, error: message, retryable: false })
  }

  private isOwner(run: ActiveChatRun): boolean {
    const current = this.active.get(run.chatId)
    return current?.controller === run.controller && current.generation === run.generation
  }

  private trackAssistantWrite<T>(run: ActiveChatRun, operation: Promise<T>): Promise<T> {
    run.pendingAssistantWrites.add(operation)
    const remove = () => run.pendingAssistantWrites.delete(operation)
    void operation.then(remove, remove)
    return operation
  }

  private async persistTimeout(
    request: ChatRuntimeRequest,
    messageId: string | undefined,
    message: string,
    trackAssistantWrite: <T>(operation: Promise<T>) => Promise<T>,
  ): Promise<void> {
    try {
      if (messageId && this.deps.updateMessage) {
        await trackAssistantWrite(this.deps.updateMessage({ requestId: `${request.runId}:assistant:timeout`, chatId: request.chatId, messageId, content: message, state: 'error', retryable: true }))
      } else {
        await trackAssistantWrite(this.deps.appendMessage({ requestId: `${request.runId}:assistant:error`, chatId: request.chatId, role: 'assistant', content: message, state: 'error', retryable: true }))
      }
    } catch {
      // Renderer must receive the safe retryable timeout even if disk persistence fails.
    }
  }
}

type ActiveChatRun = {
  chatId: string
  controller: AbortController
  generation: number
  runId: string
  publish: (event: ChatRuntimeEvent) => void
  messageId: string
  persistedMessageId?: string
  cancellationFinalization?: Promise<void>
  cancellationError?: ChatCancellationPersistenceError
  pendingAssistantWrites: Set<Promise<unknown>>
  done: Promise<void>
  resolveDone: () => void
}

const planResultContinuationPrompt = '系统触发：用户已经确认并发送此前执行计划中的命令，相关 SSH 会话产生了新输出。请仅基于当前任务历史和本次明确选择的 SSH 上下文分析执行结果，说明已确认的事实、风险和下一步；如需要执行命令，必须返回新的待人工确认计划。不要重复发送此前计划的命令。'

function persistedMessageIdFrom(value: unknown): string | undefined {
  return typeof value === 'object' && value && 'messageId' in value && typeof value.messageId === 'string' ? value.messageId : undefined
}

function raceProviderStreamWithAbort(providerStream: Promise<void>, signal: AbortSignal): Promise<void> {
  // Providers may ignore AbortSignal. Keep their eventual rejection handled while
  // letting the runtime finalize its own state as soon as the signal aborts.
  void providerStream.catch(() => undefined)
  if (signal.aborted) return Promise.resolve()
  let removeAbortListener: () => void = () => undefined
  const aborted = new Promise<void>(resolve => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    removeAbortListener = () => signal.removeEventListener('abort', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  return Promise.race([providerStream, aborted]).finally(removeAbortListener)
}

function publicChatError(error: unknown): string {
  if (error instanceof ChatPersistenceError) return '聊天暂时无法保存，请稍后重试。'
  const raw = error instanceof Error ? error.message : ''
  if (/技能内容|技能说明|执行结果/.test(raw)) return '所选技能说明或执行结果超出当前模型上下文限制，请减少技能选择或先压缩历史消息。'
  if (/context|上下文|压缩历史/i.test(raw)) return '聊天上下文超出当前模型限制，请先压缩历史消息。'
  if (/超时|timeout/i.test(raw)) return '聊天请求超时。'
  if (/未配置|configuration|model/i.test(raw)) return '未配置可用的 AI 模型，请前往设置完成模型连接后重试。'
  return '聊天运行失败，请检查模型连接后重试。'
}

class ChatPersistenceError extends Error {
  constructor() {
    super('chat persistence failed')
    this.name = 'ChatPersistenceError'
  }
}

class ChatCancellationPersistenceError extends Error {
  constructor() {
    super('聊天暂时无法保存，请稍后重试。')
    this.name = 'ChatCancellationPersistenceError'
  }
}
