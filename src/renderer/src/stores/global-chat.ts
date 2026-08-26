import { reactive } from 'vue'
import type { ChatRuntimeEvent } from '../../../shared/contracts'

type Api = {
  send(request: { chatId: string; runId: string; content: any; retry?: boolean }): Promise<void>
  cancel(chatId: string): Promise<void>
  onEvent(listener: (event: ChatRuntimeEvent) => void): () => void
}
type Message = {
  id: string
  role: 'user' | 'assistant'
  content: any
  state: 'streaming' | 'complete' | 'error'
  retryable?: boolean
}

const terminalCancellationContent = '已取消。'

export function createGlobalChatStore(api: Api) {
  const state = reactive({
    drafts: {} as Record<string, string>,
    messages: {} as Record<string, Message[]>,
    runs: {} as Record<string, string | null>,
    errors: {} as Record<string, string>,
    retryableErrors: {} as Record<string, boolean>,
    readOnly: {} as Record<string, boolean>,
    activeMessageIds: {} as Record<string, string | null>,
  })
  const lastUserMessage = new Map<string, any>()
  const cancelledRuns = new Map<string, string>()

  function apply(event: ChatRuntimeEvent): void {
    const acceptsCancelledRun = event.kind === 'chat:error'
      && !event.retryable
      && cancelledRuns.get(event.chatId) === event.runId
    if (state.runs[event.chatId] !== event.runId && !acceptsCancelledRun) return
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
      state.errors[event.chatId] = ''
      state.retryableErrors[event.chatId] = false
      state.activeMessageIds[event.chatId] = null
      const message = list.find(item => item.id === event.messageId)
      if (message) {
        message.content = event.content
        message.state = 'complete'
      } else {
        list.push({ id: event.messageId, role: 'assistant', content: event.content, state: 'complete' })
      }
      return
    }

    state.runs[event.chatId] = null
    state.errors[event.chatId] = event.error
    state.retryableErrors[event.chatId] = event.retryable
    state.activeMessageIds[event.chatId] = event.messageId
    cancelledRuns.delete(event.chatId)
  }

  const unsubscribe = api.onEvent(apply)
  return {
    state,
    apply,
    beginRun(chatId: string, runId: string): void {
      cancelledRuns.delete(chatId)
      state.runs[chatId] = runId
      state.activeMessageIds[chatId] = null
    },
    setDraft(chatId: string, value: string): void {
      state.drafts[chatId] = value
    },
    draft(chatId: string): string {
      return state.drafts[chatId] ?? ''
    },
    hydrate(chatId: string, messages: readonly {
      id: string
      role: 'user' | 'assistant' | 'system'
      content: any
      state: 'complete' | 'streaming' | 'error'
      retryable?: boolean
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
      }))
      const retryTarget = retryableHydratedError(visible)
      if (retryTarget) {
        lastUserMessage.set(chatId, retryTarget.user.content)
        state.errors[chatId] = retryTarget.assistant.content
        state.retryableErrors[chatId] = true
      } else {
        lastUserMessage.delete(chatId)
        const terminalError = terminalHydratedError(visible)
        state.errors[chatId] = terminalError?.content ?? ''
        state.retryableErrors[chatId] = false
      }
      state.activeMessageIds[chatId] = null
      state.readOnly[chatId] = readOnly
    },
    async send(chatId: string, content: any): Promise<void> {
      const value = typeof content === 'string' ? content.trim() : content
      if (!value || state.readOnly[chatId]) return
      const runId = crypto.randomUUID()
      cancelledRuns.delete(chatId)
      state.drafts[chatId] = ''
      state.runs[chatId] = runId
      state.activeMessageIds[chatId] = null
      lastUserMessage.set(chatId, value)
      const userId = `user:${runId}`
      ;(state.messages[chatId] ?? (state.messages[chatId] = [])).push({ id: userId, role: 'user', content: value, state: 'complete' })
      await api.send({ chatId, runId, content: value })
    },
    async retry(chatId: string): Promise<void> {
      if (state.readOnly[chatId]) return
      const value = lastUserMessage.get(chatId)
      if (!value || !state.errors[chatId] || !state.retryableErrors[chatId]) return
      const runId = crypto.randomUUID()
      cancelledRuns.delete(chatId)
      state.runs[chatId] = runId
      state.errors[chatId] = ''
      state.retryableErrors[chatId] = false
      state.activeMessageIds[chatId] = null
      await api.send({ chatId, runId, content: value, retry: true })
    },
    canRetry(chatId: string): boolean {
      return !state.readOnly[chatId] && Boolean(state.errors[chatId]) && state.retryableErrors[chatId]
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
          state.activeMessageIds[chatId] = null
        }
        lastUserMessage.delete(chatId)
        state.errors[chatId] = '取消状态未能保存，请重新加载后确认。'
        state.retryableErrors[chatId] = false
        return
      }
      if (state.runs[chatId] === runId) {
        state.runs[chatId] = null
        state.activeMessageIds[chatId] = null
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
    dispose(): void {
      unsubscribe()
    },
  }
}

function retryableHydratedError(messages: readonly {
  role: 'user' | 'assistant' | 'system'
  content: any
  state: 'streaming' | 'complete' | 'error'
  retryable?: boolean
}[]): { user: { content: any }; assistant: { content: any } } | undefined {
  const assistant = messages.at(-1)
  const user = messages.at(-2)
  if (assistant?.role !== 'assistant' || assistant.state !== 'error' || assistant.retryable === false || assistant.content === terminalCancellationContent || user?.role !== 'user') return undefined
  return { user, assistant }
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
