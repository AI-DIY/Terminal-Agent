import { randomUUID } from 'node:crypto'
import type { ChatMessage, ChatCompletionResponseFormat } from '../model/chat-completions-client'
import type { ProviderModelSettings } from '../model/model-provider-router'
import type { ChatMessageContent } from '../../shared/chat-content'
import type { AssistantPlanOutput } from '../../shared/chat-plan'
import type { StructuredChatRequest } from './structured-chat-agent'
import type { ChatProgressStage } from '../../shared/contracts'
import { estimateChatMessages } from './token-estimator'
/* eslint-disable @typescript-eslint/no-explicit-any */

export type ChatRuntimeRequest = { chatId: string; runId: string; content: ChatMessageContent; retry?: boolean }
export type ChatRuntimeEvent =
  | { kind: 'chat:progress'; chatId: string; runId: string; stage: ChatProgressStage }
  | { kind: 'chat:delta'; chatId: string; runId: string; messageId: string; content: string }
  | { kind: 'chat:completed'; chatId: string; runId: string; messageId: string; content: string; executionPlan?: import('../../shared/chat-plan').ChatExecutionPlan }
  | { kind: 'chat:error'; chatId: string; runId: string; messageId: string; error: string; retryable: boolean }

type RuntimeDeps = {
  appendMessage(request: any): Promise<{ messageId?: string } | unknown>
  updateMessage?(request: any): Promise<unknown>
  getRetryMessageId?(chatId: string, content: any): Promise<string | undefined>
  getContext(chatId: string): Promise<ChatMessage[] | { messages: ChatMessage[]; hasImages: boolean; availableHostnames: string[] }>
  resolveModel(input?: { hasImages: boolean }): Promise<ProviderModelSettings>
  runStructured?(settings: ProviderModelSettings, input: StructuredChatRequest, signal: AbortSignal, onStage?: (stage: ChatProgressStage) => void): Promise<AssistantPlanOutput>
  materializePlan?(plan: NonNullable<AssistantPlanOutput['plan']>): import('../../shared/chat-plan').ChatExecutionPlan
  stream(settings: ProviderModelSettings, messages: ChatMessage[], onDelta: (content: string) => void, responseFormat?: ChatCompletionResponseFormat, signal?: AbortSignal): Promise<void>
  timeoutMs?: number
}

export class ChatRuntime {
  private readonly active = new Map<string, ActiveChatRun>()
  private readonly generations = new Map<string, number>()
  constructor(private readonly deps: RuntimeDeps) {}

  async send(request: ChatRuntimeRequest, publish: (event: ChatRuntimeEvent) => void): Promise<void> {
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
      if ((!request.retry || !retryMessageId) && isOwner()) {
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
      const contextResult = await this.deps.getContext(request.chatId)
      const structuredContext = Array.isArray(contextResult) ? null : contextResult
      const context = Array.isArray(contextResult) ? contextResult : contextResult.messages
      const settings = await this.deps.resolveModel({ hasImages: structuredContext?.hasImages ?? false })
      if (!isLiveOwner()) {
        await finalizeCancellationIfNeeded()
        return
      }
      if (estimateChatMessages(context) > settings.contextLimit) throw new Error('聊天上下文超出当前模型限制，请先压缩历史消息。')
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
        const providerStream = this.deps.runStructured && settings.provider !== 'ollama'
          ? (publishProgress('thinking'), this.deps.runStructured(settings, {
            messages: context,
            availableHostnames: structuredContext?.availableHostnames ?? [],
          }, controller.signal, publishProgress)).then(result => { publishProgress('observing'); materializedPlan = result.plan && this.deps.materializePlan ? this.deps.materializePlan(result.plan) : undefined; output = JSON.stringify(result) }).catch(async error => {
            if (controller.signal.aborted) throw error
            await this.deps.stream(settings, context, delta => {
              if (!isLiveOwner()) return
              output += delta
              publish({ kind: 'chat:delta', chatId: request.chatId, runId: request.runId, messageId, content: delta })
            }, undefined, controller.signal)
          })
          : Promise.resolve().then(() => this.deps.stream(settings, context, delta => {
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
