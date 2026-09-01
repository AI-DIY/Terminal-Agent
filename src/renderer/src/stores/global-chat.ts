import { reactive } from 'vue'
import type { ChatRuntimeEvent, ChatProgressStage, ChatWorkspaceSnapshot } from '../../../shared/contracts'
import type { ChatMessageContent, ChatImageUrlPart } from '../../../shared/chat-content'
import type { ChatExecutionPlan, ChatPlanEditStepRequest, ChatPlanRemoveStepRequest, ChatPlanCancelRequest, ChatPlanExecuteRequest } from '../../../shared/chat-plan'
/* eslint-disable @typescript-eslint/no-explicit-any */

type Api = {
  send(request: { chatId: string; runId: string; content: any; retry?: boolean }): Promise<void>
  cancel(chatId: string): Promise<void>
  onEvent(listener: (event: ChatRuntimeEvent) => void): () => void
  plans?: {
    editStep(request: ChatPlanEditStepRequest): Promise<ChatWorkspaceSnapshot>
    removeStep(request: ChatPlanRemoveStepRequest): Promise<ChatWorkspaceSnapshot>
    cancel(request: ChatPlanCancelRequest): Promise<ChatWorkspaceSnapshot>
    execute(request: ChatPlanExecuteRequest): Promise<ChatWorkspaceSnapshot>
  }
}
type Message = {
  id: string
  role: 'user' | 'assistant'
  content: any
  state: 'streaming' | 'complete' | 'error'
  retryable?: boolean
  messageType?: 'execution_audit'
  executionPlan?: ChatExecutionPlan
}
type ErrorAnnouncement = { chatId: string; content: string }
type AssistantAnnouncement = { chatId: string; content: string }

const terminalCancellationContent = '已取消。'

export function hasVisibleAssistantError(messages: readonly Pick<Message, 'role' | 'state' | 'content'>[], error: string): boolean {
  if (!error) return false
  return messages.some(message => message.role === 'assistant' && message.state === 'error' && message.content === error)
}

export function createGlobalChatStore(api: Api) {
  const state = reactive({
    drafts: {} as Record<string, string>,
    messages: {} as Record<string, Message[]>,
    runs: {} as Record<string, string | null>,
    errors: {} as Record<string, string>,
    retryableErrors: {} as Record<string, boolean>,
    readOnly: {} as Record<string, boolean>,
    activeMessageIds: {} as Record<string, string | null>,
    runUserMessageIds: {} as Record<string, string | null>,
    pendingImages: {} as Record<string, ChatImageUrlPart[]>,
    progress: {} as Record<string, ChatProgressStage | null>,
  })
  const lastUserMessage = new Map<string, { id: string; content: string }>()
  const cancelledRuns = new Map<string, string>()
  const errorAnnouncementListeners = new Set<(announcement: ErrorAnnouncement) => void>()
  const assistantAnnouncementListeners = new Set<(announcement: AssistantAnnouncement) => void>()

  function announceError(chatId: string, content: string): void {
    for (const listener of errorAnnouncementListeners) listener({ chatId, content })
  }

  function announceAssistant(chatId: string, content: string): void {
    for (const listener of assistantAnnouncementListeners) listener({ chatId, content })
  }

  function apply(event: ChatRuntimeEvent): void {
    const acceptsCancelledRun = event.kind === 'chat:error'
      && !event.retryable
      && cancelledRuns.get(event.chatId) === event.runId
    if (state.runs[event.chatId] !== event.runId && !acceptsCancelledRun) return
    if (event.kind === 'chat:progress') {
      state.progress[event.chatId] = event.stage
      return
    }
    const list = state.messages[event.chatId] ?? (state.messages[event.chatId] = [])
    const activeMessageId = state.activeMessageIds[event.chatId]
    if (activeMessageId && event.messageId !== activeMessageId) return

    if (event.kind === 'chat:delta') {
      state.runs[event.chatId] = event.runId
      state.activeMessageIds[event.chatId] = event.messageId
      const message = list.find(item => item.id === event.messageId)
      if (message) message.content += event.content
      else list.push({ id: event.messageId, role: 'assistant', content: event.content, state: 'streaming' })
      return
    }

    if (event.kind === 'chat:completed') {
      state.runs[event.chatId] = null
      state.progress[event.chatId] = null
      state.errors[event.chatId] = ''
      state.retryableErrors[event.chatId] = false
      state.activeMessageIds[event.chatId] = null
      state.runUserMessageIds[event.chatId] = null
      const message = list.find(item => item.id === event.messageId)
      if (message) {
        message.content = event.content
        message.state = 'complete'
        if (event.executionPlan) message.executionPlan = structuredClone(event.executionPlan)
      } else {
        list.push({ id: event.messageId, role: 'assistant', content: event.content, state: 'complete', ...(event.executionPlan ? { executionPlan: structuredClone(event.executionPlan) } : {}) })
      }
      announceAssistant(event.chatId, event.content)
      return
    }

    state.runs[event.chatId] = null
    state.progress[event.chatId] = null
    state.errors[event.chatId] = event.error
    state.retryableErrors[event.chatId] = event.retryable
    state.activeMessageIds[event.chatId] = event.messageId
    state.runUserMessageIds[event.chatId] = null
    const message = list.find(item => item.id === event.messageId)
    if (message) {
      message.content = event.error
      message.state = 'error'
      message.retryable = event.retryable
    } else {
      list.push({ id: event.messageId, role: 'assistant', content: event.error, state: 'error', retryable: event.retryable })
    }
    cancelledRuns.delete(event.chatId)
    announceError(event.chatId, event.error)
  }

  const unsubscribe = api.onEvent(apply)
  return {
    state,
    apply,
    beginRun(chatId: string, runId: string): void {
      cancelledRuns.delete(chatId)
      state.runs[chatId] = runId
      state.progress[chatId] = null
      state.activeMessageIds[chatId] = null
      state.runUserMessageIds[chatId] = latestUserMessageId(state.messages[chatId])
    },
    setDraft(chatId: string, value: string): void {
      state.drafts[chatId] = value
    },
    draft(chatId: string): string {
      return state.drafts[chatId] ?? ''
    },
    setPendingImages(chatId: string, images: ChatImageUrlPart[]): void { state.pendingImages[chatId] = structuredClone(images) },
    removePendingImage(chatId: string, index: number): void { state.pendingImages[chatId] = (state.pendingImages[chatId] ?? []).filter((_, i) => i !== index) },
    composeUserContent(chatId: string): ChatMessageContent | null {
      const text = (state.drafts[chatId] ?? '').trim()
      return text || null
    },
    hydrate(chatId: string, messages: readonly {
      id: string
      role: 'user' | 'assistant' | 'system'
      content: any
      state: 'complete' | 'streaming' | 'error'
      retryable?: boolean
      messageType?: 'execution_audit'
      executionPlan?: ChatExecutionPlan
    }[], readOnly = false): void {
      cancelledRuns.delete(chatId)
      state.runs[chatId] = null
      const visible = messages.filter(message => message.role !== 'system').map(message => ({ ...message }))
      state.messages[chatId] = visible.map(message => ({
        id: message.id,
        role: message.role as 'user' | 'assistant',
        content: message.content,
        state: message.state,
        ...(message.retryable === undefined ? {} : { retryable: message.retryable }),
        ...(message.messageType ? { messageType: message.messageType } : {}),
        ...(message.executionPlan ? { executionPlan: structuredClone(message.executionPlan) } : {}),
      }))
      state.progress[chatId] = null
      const retryTarget = retryableHydratedError(visible)
      if (retryTarget && typeof retryTarget.user.content === 'string') {
        lastUserMessage.set(chatId, { id: retryTarget.user.id, content: retryTarget.user.content })
        state.errors[chatId] = retryTarget.assistant.content
        state.retryableErrors[chatId] = true
      } else {
        lastUserMessage.delete(chatId)
        const terminalError = terminalHydratedError(visible)
        state.errors[chatId] = terminalError?.content ?? ''
        state.retryableErrors[chatId] = false
      }
      state.activeMessageIds[chatId] = null
      state.runUserMessageIds[chatId] = null
      state.readOnly[chatId] = readOnly
    },
    async send(chatId: string, content: any): Promise<void> {
      if (typeof content !== 'string') return
      const value = content.trim()
      if (!value || state.readOnly[chatId]) return
      const runId = crypto.randomUUID()
      cancelledRuns.delete(chatId)
      state.drafts[chatId] = ''
      state.pendingImages[chatId] = []
      state.runs[chatId] = runId
      state.progress[chatId] = null
      state.activeMessageIds[chatId] = null
      const userId = `user:${runId}`
      ;(state.messages[chatId] ?? (state.messages[chatId] = [])).push({ id: userId, role: 'user', content: value, state: 'complete' })
      lastUserMessage.set(chatId, { id: userId, content: value })
      state.runUserMessageIds[chatId] = userId
      await api.send({ chatId, runId, content: value })
    },
    async retry(chatId: string): Promise<void> {
      if (state.readOnly[chatId]) return
      const previous = lastUserMessage.get(chatId)
      if (!previous || !previous.content || !state.errors[chatId] || !state.retryableErrors[chatId]) return
      const runId = crypto.randomUUID()
      cancelledRuns.delete(chatId)
      state.runs[chatId] = runId
      state.progress[chatId] = null
      state.errors[chatId] = ''
      state.retryableErrors[chatId] = false
      state.activeMessageIds[chatId] = null
      state.runUserMessageIds[chatId] = previous.id
      await api.send({ chatId, runId, content: previous.content, retry: true })
    },
    canRetry(chatId: string): boolean {
      return !state.readOnly[chatId] && Boolean(state.errors[chatId]) && state.retryableErrors[chatId]
    },
    onErrorAnnouncement(listener: (announcement: ErrorAnnouncement) => void): () => void {
      errorAnnouncementListeners.add(listener)
      return () => errorAnnouncementListeners.delete(listener)
    },
    onAssistantAnnouncement(listener: (announcement: AssistantAnnouncement) => void): () => void {
      assistantAnnouncementListeners.add(listener)
      return () => assistantAnnouncementListeners.delete(listener)
    },
    async cancel(chatId: string): Promise<void> {
      const runId = state.runs[chatId]
      if (!runId) return
      const activeMessageId = state.activeMessageIds[chatId]
      cancelledRuns.set(chatId, runId)
      try {
        await api.cancel(chatId)
      } catch {
        if (cancelledRuns.get(chatId) === runId) cancelledRuns.delete(chatId)
        if (state.runs[chatId] === runId) {
          state.runs[chatId] = null
          state.progress[chatId] = null
          state.activeMessageIds[chatId] = null
          state.runUserMessageIds[chatId] = null
        }
        lastUserMessage.delete(chatId)
        state.errors[chatId] = '取消状态未能保存，请重新加载后确认。'
        state.retryableErrors[chatId] = false
        announceError(chatId, state.errors[chatId])
        return
      }
      if (state.runs[chatId] === runId) {
        state.runs[chatId] = null
        state.progress[chatId] = null
        state.activeMessageIds[chatId] = null
        state.runUserMessageIds[chatId] = null
        state.errors[chatId] = ''
      }
      if (activeMessageId) {
        const message = state.messages[chatId]?.find(item => item.id === activeMessageId)
        if (message?.state === 'streaming') {
          message.content = terminalCancellationContent
          message.state = 'error'
        }
      }
    },
    async editPlanStep(chatId: string, messageId: string, stepId: string, command: string): Promise<ChatWorkspaceSnapshot> {
      if (!api.plans) throw new Error('计划操作不可用')
      const snapshot = await api.plans.editStep({ requestId: crypto.randomUUID(), chatId, messageId, stepId, command })
      this.hydrate(chatId, snapshot.chat.messages, Boolean(state.readOnly[chatId]))
      return snapshot
    },
    async removePlanStep(chatId: string, messageId: string, stepId: string): Promise<ChatWorkspaceSnapshot> {
      if (!api.plans) throw new Error('计划操作不可用')
      const snapshot = await api.plans.removeStep({ requestId: crypto.randomUUID(), chatId, messageId, stepId })
      this.hydrate(chatId, snapshot.chat.messages, Boolean(state.readOnly[chatId]))
      return snapshot
    },
    async cancelPlan(chatId: string, messageId: string): Promise<ChatWorkspaceSnapshot> {
      if (!api.plans) throw new Error('计划操作不可用')
      const snapshot = await api.plans.cancel({ requestId: crypto.randomUUID(), chatId, messageId })
      this.hydrate(chatId, snapshot.chat.messages, Boolean(state.readOnly[chatId]))
      return snapshot
    },
    async executePlan(chatId: string, messageId: string): Promise<ChatWorkspaceSnapshot> {
      if (!api.plans) throw new Error('计划操作不可用')
      const snapshot = await api.plans.execute({ requestId: crypto.randomUUID(), chatId, messageId })
      this.hydrate(chatId, snapshot.chat.messages, Boolean(state.readOnly[chatId]))
      return snapshot
    },
    dispose(): void {
      unsubscribe()
      errorAnnouncementListeners.clear()
      assistantAnnouncementListeners.clear()
    },
  }
}

function retryableHydratedError(messages: readonly {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: any
  state: 'streaming' | 'complete' | 'error'
  retryable?: boolean
}[]): { user: { id: string; content: any }; assistant: { content: any } } | undefined {
  const assistant = messages.at(-1)
  const user = messages.at(-2)
  if (assistant?.role !== 'assistant' || assistant.state !== 'error' || assistant.retryable === false || assistant.content === terminalCancellationContent || user?.role !== 'user') return undefined
  return { user, assistant }
}

function latestUserMessageId(messages: readonly Message[] | undefined): string | null {
  for (let index = (messages?.length ?? 0) - 1; index >= 0; index -= 1) {
    const message = messages?.[index]
    if (message?.role === 'user' && message.messageType !== 'execution_audit') return message.id
  }
  return null
}

function terminalHydratedError(messages: readonly {
  role: 'user' | 'assistant' | 'system'
  content: any
  state: 'streaming' | 'complete' | 'error'
  retryable?: boolean
}[]): { content: string } | undefined {
  const assistant = messages.at(-1)
  if (assistant?.role !== 'assistant' || assistant.state !== 'error') return undefined
  if (assistant.retryable === false || assistant.content === terminalCancellationContent) return assistant
  return undefined
}
