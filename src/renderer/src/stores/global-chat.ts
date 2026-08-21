import { reactive } from 'vue'
import type { ChatRuntimeEvent } from '../../../shared/contracts'

type Api = { send(request: { chatId: string; runId: string; content: string; retry?: boolean }): Promise<void>; cancel(chatId: string): Promise<void>; onEvent(listener: (event: ChatRuntimeEvent) => void): () => void }
type Message = { id: string; role: 'user' | 'assistant'; content: string; state: 'streaming' | 'complete' | 'error'; retryable?: boolean }

const terminalCancellationContent = '已取消。'

export function createGlobalChatStore(api: Api) {
  const state = reactive({ drafts: {} as Record<string, string>, messages: {} as Record<string, Message[]>, runs: {} as Record<string, string | null>, errors: {} as Record<string, string>, retryableErrors: {} as Record<string, boolean>, readOnly: {} as Record<string, boolean>, activeMessageIds: {} as Record<string, string | null> })
  const lastUserMessage = new Map<string, string>()
  const pendingStreams = new Map<string, Map<string, Map<string, RendererSensitiveTextStreamRedactor>>>()
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
      const content = redactPendingStream(event.chatId, event.runId, event.messageId, event.content)
      if (message) message.content += content
      else list.push({ id: event.messageId, role: 'assistant', content, state: 'streaming' })
    } else if (event.kind === 'chat:completed') {
      state.runs[event.chatId] = null
      state.errors[event.chatId] = ''
      state.retryableErrors[event.chatId] = false
      state.activeMessageIds[event.chatId] = null
      discardPendingStream(event.chatId, event.runId)
      const message = list.find(item => item.id === event.messageId)
      const content = sanitizeChatText(event.content)
      if (message) { message.content = content; message.state = 'complete' }
      else list.push({ id: event.messageId, role: 'assistant', content, state: 'complete' })
    } else {
      state.runs[event.chatId] = null
      state.errors[event.chatId] = sanitizeChatText(event.error)
      state.retryableErrors[event.chatId] = event.retryable
      state.activeMessageIds[event.chatId] = event.messageId
      discardPendingStream(event.chatId, event.runId)
      cancelledRuns.delete(event.chatId)
    }
  }
  const unsubscribe = api.onEvent(apply)
  return {
    state,
    apply,
    beginRun(chatId: string, runId: string): void {
      cancelledRuns.delete(chatId)
      discardPendingStream(chatId)
      state.runs[chatId] = runId
      state.activeMessageIds[chatId] = null
    },
    setDraft(chatId: string, value: string): void { state.drafts[chatId] = sanitizeChatText(value) },
    draft(chatId: string): string { return state.drafts[chatId] ?? '' },
    hydrate(chatId: string, messages: readonly { id: string; role: 'user' | 'assistant' | 'system'; content: string; state: 'complete' | 'streaming' | 'error'; retryable?: boolean }[], readOnly = false): void {
      cancelledRuns.delete(chatId)
      discardPendingStream(chatId)
      state.runs[chatId] = null
      const visible = messages.filter(message => message.role !== 'system').map(message => ({ ...message, content: sanitizeChatText(message.content) }))
      state.messages[chatId] = visible.map(message => ({ id: message.id, role: message.role as 'user' | 'assistant', content: message.content, state: message.state, ...(message.retryable === undefined ? {} : { retryable: message.retryable }) }))
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
    async send(chatId: string, content: string): Promise<void> {
      const value = sanitizeChatText(content.trim())
      if (!value || state.readOnly[chatId]) return
      const runId = crypto.randomUUID()
      cancelledRuns.delete(chatId)
      discardPendingStream(chatId)
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
      discardPendingStream(chatId)
      state.runs[chatId] = runId
      state.errors[chatId] = ''
      state.retryableErrors[chatId] = false
      state.activeMessageIds[chatId] = null
      await api.send({ chatId, runId, content: value, retry: true })
    },
    canRetry(chatId: string): boolean { return !state.readOnly[chatId] && Boolean(state.errors[chatId]) && state.retryableErrors[chatId] },
    async cancel(chatId: string): Promise<void> {
      const runId = state.runs[chatId]
      if (!runId) return
      const activeMessageId = state.activeMessageIds[chatId]
      discardPendingStream(chatId, runId)
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
          message.content = '已取消。'
          message.state = 'error'
        }
      }
    },
    dispose(): void { unsubscribe() },
  }

  function redactPendingStream(chatId: string, runId: string, messageId: string, delta: string): string {
    const byRun = pendingStreams.get(chatId) ?? new Map<string, Map<string, RendererSensitiveTextStreamRedactor>>()
    pendingStreams.set(chatId, byRun)
    const byMessage = byRun.get(runId) ?? new Map<string, RendererSensitiveTextStreamRedactor>()
    byRun.set(runId, byMessage)
    const redactor = byMessage.get(messageId) ?? new RendererSensitiveTextStreamRedactor()
    byMessage.set(messageId, redactor)
    return redactor.push(delta)
  }

  function discardPendingStream(chatId: string, runId?: string): void {
    if (runId === undefined) {
      pendingStreams.delete(chatId)
      return
    }
    const byRun = pendingStreams.get(chatId)
    if (!byRun) return
    byRun.delete(runId)
    if (!byRun.size) pendingStreams.delete(chatId)
  }
}

function retryableHydratedError(messages: readonly { role: 'user' | 'assistant' | 'system'; content: string; state: 'streaming' | 'complete' | 'error'; retryable?: boolean }[]): { user: { content: string }; assistant: { content: string } } | undefined {
  const assistant = messages.at(-1)
  const user = messages.at(-2)
  if (assistant?.role !== 'assistant' || assistant.state !== 'error' || assistant.retryable === false || assistant.content === terminalCancellationContent || user?.role !== 'user') return undefined
  return { user, assistant }
}

function terminalHydratedError(messages: readonly { role: 'user' | 'assistant' | 'system'; content: string; state: 'streaming' | 'complete' | 'error'; retryable?: boolean }[]): { content: string } | undefined {
  const assistant = messages.at(-1)
  if (assistant?.role !== 'assistant' || assistant.state !== 'error') return undefined
  if (assistant.retryable === false || assistant.content === terminalCancellationContent) return assistant
  return undefined
}

function sanitizeChatText(value: string): string {
  if (hasSensitiveFilesystemPath(value)) return '[REDACTED SENSITIVE CONTENT]'
  let result = value
  result = result.replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/gi, '[REDACTED SENSITIVE CONTENT]')
  result = result.replace(/\bBearer[ \t]+[^\s,;]+/gi, 'Bearer [REDACTED]')
  result = result.replace(/(?:\b(?:glpat-[A-Za-z0-9_-]{12,}|npm_[A-Za-z0-9]{20,}|xoxb-[0-9]{4,}-[0-9]{4,}-[A-Za-z0-9-]{6,}|sk-proj-[A-Za-z0-9_-]{12,}|(?:sk|rk)_live_[A-Za-z0-9_-]{12,}|dckr_pat_[A-Za-z0-9_-]{20,}|(?:AKIA|ASIA)[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})\b|sk-[A-Za-z0-9]{32,}(?![A-Za-z0-9]))/gi, '[REDACTED SENSITIVE CONTENT]')
  result = result.replace(/\baws[-_ ]?secret[-_ ]?access[-_ ]?key\s*[:=]\s*[^\s,;]+/gi, '[REDACTED SENSITIVE CONTENT]')
  result = result.replace(/(?<![A-Za-z0-9/+=])[A-Za-z0-9/+=]{40,}(?![A-Za-z0-9/+=])/g, '[REDACTED SENSITIVE CONTENT]')
  result = result.replace(/\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{4,}){1,2}\b/g, '[REDACTED SENSITIVE CONTENT]')
  result = result.replace(/\b(?:password|passphrase|api[ _-]?key|token|secret)\s*[:=]\s*[^\s,;]+/gi, '[REDACTED SENSITIVE CONTENT]')
  if (/authorization|password|passphrase|passwd|api[ _-]?key|token|secret|密码|口令|令牌|私钥/i.test(result)) return '[REDACTED SENSITIVE CONTENT]'
  return result
}

function hasSensitiveFilesystemPath(value: string): boolean {
  return /(?:^|[^a-z0-9_])tmp:(?=[^\r\n]*\S)/i.test(value)
    || /(?:[a-z]:)?[\\/](?:[^\\/\r\n]+[\\/])*(?:temp|tmp)(?:[\\/]|$)/i.test(value)
    || /(?:^|[\s"'=([{,:;])((?:[^\r\n]*[\\/])?\.ssh[\\/]id_[^\\/\s"'`),:;\]}]+|[^\r\n]*\.(?:pem|ppk|key))(?=$|[\s"'`),:;\]}])/i.test(value)
}

class RendererSensitiveTextStreamRedactor {
  private pending = ''

  push(content: string): string {
    this.pending += content
    const candidate = findSensitiveCandidate(this.pending)
    if (candidate !== -1) {
      const prefix = this.pending.slice(0, candidate)
      const candidateValue = this.pending.slice(candidate)
      const releaseLength = terminatedSensitiveCandidateLength(candidateValue)
      if (releaseLength !== -1) {
        this.pending = candidateValue.slice(releaseLength)
        return sanitizeChatText(`${prefix}${candidateValue.slice(0, releaseLength)}`)
      }
      this.pending = candidateValue
      return sanitizeChatText(prefix)
    }
    const partial = findPartialCandidateSuffix(this.pending)
    if (partial !== -1) {
      const prefix = this.pending.slice(0, partial)
      this.pending = this.pending.slice(partial)
      return sanitizeChatText(prefix)
    }
    const complete = this.pending
    this.pending = ''
    return sanitizeChatText(complete)
  }
}

const credentialStartPattern = /(?:Bearer\s+|gh[pousr]_|github_pat_|glpat-|npm_|xoxb-|sk-proj-|sk-|(?:sk|rk)_live_|dckr_pat_|(?:AKIA|ASIA)|aws[-_ ]?secret[-_ ]?access[-_ ]?key\s*[:=]|-----BEGIN|(?:password|passphrase|api[ _-]?key|token|secret)\s*[:=]|eyJ)/i
const credentialPrefixes = ['bearer', 'ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_', 'glpat-', 'npm_', 'xoxb-', 'sk-proj-', 'sk-', 'rk-', 'sk_live_', 'rk_live_', 'dckr_pat_', 'akia', 'asia', 'aws-secret-access-key', 'aws_secret_access_key', 'password=', 'password:', 'passphrase=', 'passphrase:', 'api-key=', 'api-key:', 'api_key=', 'api_key:', 'token=', 'token:', 'secret=', 'secret:', 'eyj', 'tmp:', '-----begin']

function findSensitiveCandidate(value: string): number {
  const credential = credentialStartPattern.exec(value)?.index ?? -1
  const temporaryReference = /(?:^|[^a-z0-9_])(tmp:)/i.exec(value)
  const filesystemPath = findUnfinishedFilesystemPath(value)
  const base64 = /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+=]{40,}(?![A-Za-z0-9/+=])/.exec(value)?.index ?? -1
  return lowestCandidate(
    credential,
    temporaryReference ? temporaryReference.index + temporaryReference[0].lastIndexOf(temporaryReference[1]) : -1,
    filesystemPath,
    base64,
  )
}

function findUnfinishedFilesystemPath(value: string): number {
  const relativeSshPath = /(?:^|[\s"'=([{,:;])(\.ssh(?:[\\/][^\s"'`),:;\]}]*)?)$/i.exec(value)
  let candidate = relativeSshPath ? relativeSshPath.index + relativeSshPath[0].lastIndexOf(relativeSshPath[1]) : -1
  const paths = /(?:[a-z]:)?[\\/][^\s"'`),:;\]}]*/ig
  let match: RegExpExecArray | null
  while ((match = paths.exec(value))) {
    if (match.index + match[0].length === value.length) {
      candidate = candidate === -1 ? match.index : Math.min(candidate, match.index)
    }
  }
  return candidate
}

function findPartialCandidateSuffix(value: string): number {
  const boundary = tokenBoundary(value)
  const suffix = value.slice(boundary)
  const normalized = suffix.toLowerCase()
  if (suffix.length > 0 && credentialPrefixes.some(prefix => prefix.startsWith(normalized))) return boundary
  if (/^(?:[a-z]:)?[\\/][^\r\n]*$/i.test(suffix)) return boundary
  const token = /[a-z0-9_.:+\-/=]+$/i.exec(value)
  return token?.[0] ? token.index : -1
}

function terminatedSensitiveCandidateLength(value: string): number {
  if (/^-----BEGIN /i.test(value)) return -1
  if (/[\\/]/.test(value) || /^tmp:/i.test(value)) {
    const delimiter = /[\s"'`),;\]}]+$/.exec(value)
    return delimiter && hasSensitiveFilesystemPath(value) ? value.length - delimiter[0].length : -1
  }
  if (/^Bearer[ \t]+/i.test(value)) {
    const bearer = /^Bearer[ \t]+[^\s,;]+/i.exec(value)
    return bearer && bearer[0].length < value.length ? bearer[0].length : -1
  }
  if (/^(?:password|passphrase|api[ _-]?key|token|secret)\s*[:=]\s*/i.test(value)) return -1
  const token = /^[a-z0-9_.:+\-/=]+/i.exec(value)
  return token && token[0].length < value.length ? token[0].length : -1
}

function tokenBoundary(value: string): number {
  return Math.max(
    value.lastIndexOf(' '),
    value.lastIndexOf('\n'),
    value.lastIndexOf('\t'),
    value.lastIndexOf('\r'),
    value.lastIndexOf('"'),
    value.lastIndexOf("'"),
    value.lastIndexOf('='),
    value.lastIndexOf('('),
    value.lastIndexOf('['),
    value.lastIndexOf('{'),
    value.lastIndexOf(','),
    value.lastIndexOf(':'),
    value.lastIndexOf(';'),
  ) + 1
}

function lowestCandidate(...candidates: number[]): number {
  const matches = candidates.filter(candidate => candidate >= 0)
  return matches.length ? Math.min(...matches) : -1
}
