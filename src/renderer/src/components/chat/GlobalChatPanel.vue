<script setup lang="ts">
import { Bot, Check, ChevronDown, ChevronUp, CircleAlert, History, MessageSquarePlus, PanelRightClose, Send, Square, Trash2, UserRound, X } from '@lucide/vue'
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import type { ChatConversationSessionSummary, ChatProgressStage, ChatWorkspace } from '../../../../shared/contracts'
import { createGlobalChatStore, hasVisibleAssistantError } from '../../stores/global-chat'
import { chatContentText } from '../../../../shared/chat-content'
import { estimateChatMessages } from '../../../../shared/chat-token-estimator'
import { shouldInsertNewlineOnModifiedEnter, shouldSendOnPlainEnter } from './chat-composer-shortcuts'
import { planTargetLabelForShells } from './plan-target-label'
import { chatContextSessionsAreResolved, normalizeChatContextSessionIds } from '../../../../shared/chat-context-selection'
import { sshHostIdentity, sshHostnameDisplayLabels } from '../../../../shared/shell-display-label'
import { getUserPreferencesStore } from '../../stores/user-preferences'

type ContextSession = {
  id: string
  hostname: string
  observedHostname?: string
  title?: string
}

type ConversationSession = Pick<ChatConversationSessionSummary, 'id' | 'label'>

const props = withDefaults(defineProps<{
  chat: ChatWorkspace | null
  shellCount?: number
  contextSessions?: ContextSession[]
  conversationSessions?: ConversationSession[]
  sessionBusy?: boolean
}>(), {
  shellCount: 0,
  contextSessions: () => [],
  conversationSessions: () => [],
  sessionBusy: false,
})
const emit = defineEmits<{
  collapse: []
  newSession: []
  switchSession: [chatId: string]
}>()
const store = createGlobalChatStore(window.terminalAgent.chat)
const userPreferences = getUserPreferencesStore()
const modelContextLimit = ref(12_000)
const contextDetailsExpanded = ref(true)
const compactError = ref('')
const composerInput = ref<HTMLTextAreaElement | null>(null)
// Keep the transcript container's semantic shape as <div class="messages">.
const messagesElement = ref<HTMLElement | null>(null)
const followMessages = ref(true)
let suppressMessagesScroll = false
const chatId = computed(() => props.chat?.id ?? '')
const assertiveError = ref<{ id: number; content: string } | null>(null)
const assistantResponse = ref<{ id: number; content: string } | null>(null)
const selectedConversationSessionId = ref('')
let assertiveErrorId = 0
let assistantResponseId = 0
function announceAssertiveError(content: string): void {
  assertiveError.value = { id: ++assertiveErrorId, content }
}
function announceAssistantResponse(content: string): void {
  assistantResponse.value = { id: ++assistantResponseId, content }
}
const disposeErrorAnnouncement = store.onErrorAnnouncement(announcement => {
  if (announcement.chatId !== chatId.value) return
  announceAssertiveError(announcement.content)
})
const disposeAssistantAnnouncement = store.onAssistantAnnouncement(announcement => {
  if (announcement.chatId !== chatId.value) return
  announceAssistantResponse(assistantReply(announcement.content))
})
/**
 * Apply the active internal conversation returned by the task-level mutation.
 *
 * Global chat drafts and transcripts are deliberately keyed by task id so an
 * SSH task retains its terminal while its AI conversation changes.  Therefore
 * an internal session boundary cannot rely on a task-id change, nor on a
 * later `chats:changed` projection.  The parent supplies the mutation's
 * authoritative snapshot through this explicit boundary.
 */
function hydrateConversation(messages: ChatWorkspace['messages']): void {
  const id = chatId.value
  if (!id) return
  store.setDraft(id, '')
  store.setPendingImages(id, [])
  compactError.value = ''
  delete actionErrors[id]
  selectedConversationSessionId.value = ''
  followMessages.value = true
  store.hydrate(id, messages, false)
}

defineExpose({ hydrateConversation })

watch(chatId, id => {
  // A task selection is still the normal way to hydrate this panel.  Do not
  // watch every task object replacement: a delayed task-level event can carry
  // an earlier message projection and overwrite an explicitly restored
  // internal conversation with the same task id.
  if (id && props.chat?.id === id && !store.state.runs[id]) {
    store.hydrate(id, props.chat.messages, false)
  }
  assertiveError.value = null
  assistantResponse.value = null
  followMessages.value = true
  scrollMessagesToBottom()
}, { immediate: true })
const messages = computed(() => chatId.value ? store.state.messages[chatId.value] ?? [] : [])
const draft = computed(() => chatId.value ? store.draft(chatId.value) : '')
const running = computed(() => chatId.value ? Boolean(store.state.runs[chatId.value]) : false)
const runUserMessageId = computed(() => chatId.value ? store.state.runUserMessageIds[chatId.value] ?? null : null)
const progress = computed<ChatProgressStage | null>(() => {
  if (!chatId.value) return null
  return store.state.progress[chatId.value] ?? (store.state.runs[chatId.value] ? 'thinking' : null)
})
const standaloneError = computed(() => {
  const error = chatId.value ? store.state.errors[chatId.value] ?? '' : ''
  if (!error || hasVisibleAssistantError(messages.value, error)) return ''
  return error
})
const actionErrors = reactive<Record<string, string>>({})
const actionError = computed(() => chatId.value ? actionErrors[chatId.value] ?? '' : '')
const stepDrafts = reactive<Record<string, string>>({})
const contextUsed = computed(() => estimateChatMessages(messages.value))
const contextPercent = computed(() => Math.min(100, Math.round((contextUsed.value / modelContextLimit.value) * 100)))
const sshContextLines = computed(() => store.state.sshContextLines)
const compacting = computed(() => chatId.value ? Boolean(store.state.compacting[chatId.value]) : false)
const canCreateConversationSession = computed(() => messages.value.length > 0 && !running.value && !compacting.value && !props.sessionBusy)
const canSwitchConversationSession = computed(() => props.conversationSessions.length > 0 && !running.value && !compacting.value && !props.sessionBusy)
type ContextSessionRow = ContextSession & { displayLabel: string; ordinal: number; identity: string }
const associatedContextSessionIds = computed(() => new Set(
  (props.chat?.shells ?? []).filter(shell => shell.status === 'open' && shell.sessionId).map(shell => shell.sessionId!),
))
const contextSessionRows = computed<ContextSessionRow[]>(() => {
  // Session metadata can briefly arrive before chat association metadata is
  // refreshed (or vice versa).  Merge association fields as a fallback so
  // relay connections are grouped by the same observed host identity on both
  // sides of the IPC boundary.
  const associatedShells = new Map(
    (props.chat?.shells ?? [])
      .filter(shell => shell.status === 'open' && shell.sessionId)
      .map(shell => [shell.sessionId!, shell]),
  )
  const sessions = (props.contextSessions ?? [])
    .filter(session => associatedContextSessionIds.value.has(session.id))
    .map(session => {
      const shell = associatedShells.get(session.id)
      if (!shell) return session
      return {
        ...session,
        ...(session.observedHostname ? {} : shell.observedHostname ? { observedHostname: shell.observedHostname } : {}),
        ...(session.title ? {} : shell.title ? { title: shell.title } : {}),
      }
    })
  const labels = sshHostnameDisplayLabels(sessions.map(session => ({
    hostname: session.hostname,
    observedHostname: session.observedHostname,
    displayName: session.title,
    stableKey: session.id,
  })))
  return sessions.map((session, index) => ({
    ...session,
    displayLabel: labels[index]?.displayLabel ?? session.title ?? session.hostname,
    ordinal: labels[index]?.ordinal ?? 1,
    identity: sshHostIdentity({ hostname: session.hostname, observedHostname: session.observedHostname, displayName: session.title }),
  }))
})
const persistedContextSelections = reactive<Record<string, string[]>>(loadContextSelections())
const contextSelectionReady = computed(() => {
  const id = chatId.value
  if (!id || associatedContextSessionIds.value.size === 0) return true
  // Do not use a partial snapshot to decide which hosts should be included.
  // The default remains an explicit opt-out while the complete list arrives.
  return chatContextSessionsAreResolved(
    associatedContextSessionIds.value.size,
    contextSessionRows.value.length,
  )
})
const selectedContextSessionIds = computed<string[] | undefined>(() => {
  const id = chatId.value
  if (!id || !contextSelectionReady.value) return []
  const requested = persistedContextSelections[id]
  return normalizeChatContextSessionIds(contextSessionRows.value, requested ?? [])
})
const selectedContextCount = computed(() => selectedContextSessionIds.value?.length ?? 0)
const enabledSkillIds = computed(() => userPreferences.enabledSkillIds())

watch([chatId, associatedContextSessionIds, contextSessionRows], () => {
  const id = chatId.value
  if (!id) return
  const current = persistedContextSelections[id]
  // A task can hydrate before its live session snapshot does. Wait until every
  // associated Shell has a row before normalizing or persisting anything: a
  // partial snapshot would otherwise drop an existing selection or make a
  // partial default look intentional.
  if (!chatContextSessionsAreResolved(
    associatedContextSessionIds.value.size,
    contextSessionRows.value.length,
  )) return
  // Do not manufacture and persist a setting for a new task with no SSH.
  // When a connection arrives, its context checkbox starts unchecked.
  if (current === undefined && associatedContextSessionIds.value.size === 0) return
  const next = normalizeChatContextSessionIds(contextSessionRows.value, current ?? [])
  if (current === undefined) {
    // First visit to a task: every SSH context checkbox starts unchecked.
    persistedContextSelections[id] = []
    store.setSshContextSessionIds(id, persistedContextSelections[id])
    saveContextSelections(persistedContextSelections)
    return
  }
  if (!sameStringArray(current, next)) {
    persistedContextSelections[id] = next
    store.setSshContextSessionIds(id, next)
    saveContextSelections(persistedContextSelections)
  } else {
    store.setSshContextSessionIds(id, next)
  }
}, { immediate: true, deep: true })

function toggleContextSession(sessionId: string): void {
  const id = chatId.value
  if (!id) return
  const selected = new Set(selectedContextSessionIds.value ?? [])
  if (selected.has(sessionId)) selected.delete(sessionId)
  else selected.add(sessionId)
  persistedContextSelections[id] = normalizeChatContextSessionIds(contextSessionRows.value, [...selected])
  store.setSshContextSessionIds(id, persistedContextSelections[id])
  saveContextSelections(persistedContextSelections)
}

function requestNewConversationSession(): void {
  if (!canCreateConversationSession.value) return
  emit('newSession')
}

function requestConversationSessionSwitch(): void {
  const targetChatId = selectedConversationSessionId.value
  selectedConversationSessionId.value = ''
  if (!targetChatId || !canSwitchConversationSession.value) return
  emit('switchSession', targetChatId)
}

function contextSessionLabel(row: ContextSessionRow): string {
  // A unique host and the primary duplicate intentionally have no ordinal
  // badge.  Alternate connections retain #2/#3 so the user can distinguish
  // them while choosing additional context.
  return row.ordinal > 1 ? row.displayLabel : row.displayLabel.replace(/\s+#1$/, '')
}

function loadContextSelections(): Record<string, string[]> {
  try {
    // Previous versions wrote automatic defaults to the old key.  A new key
    // prevents those values from appearing as a user opt-in after this update.
    const raw = globalThis.localStorage?.getItem('terminal-agent.ai-context-session-ids.v2')
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).flatMap(([key, value]) => {
      if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) return []
      return [[key, [...new Set(value)] as string[]]]
    }))
  } catch {
    return {}
  }
}

function saveContextSelections(value: Record<string, string[]>): void {
  try { globalThis.localStorage?.setItem('terminal-agent.ai-context-session-ids.v2', JSON.stringify(value)) } catch { /* optional storage */ }
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}
function updateDraft(event: Event): void { if (chatId.value) store.setDraft(chatId.value, (event.target as HTMLTextAreaElement).value) }
function send(): void {
  if (chatId.value && !compacting.value && !props.sessionBusy) {
    const content = store.composeUserContent(chatId.value)
    if (content) {
      // A new user message always starts a fresh view at the end of the transcript.
      followMessages.value = true
      void store.send(chatId.value, content, selectedContextSessionIds.value, enabledSkillIds.value)
      scrollMessagesToBottom()
    }
  }
}
function cancel(): void { if (chatId.value) void store.cancel(chatId.value).catch(() => undefined) }
function onKeydown(event: KeyboardEvent): void {
  if (shouldInsertNewlineOnModifiedEnter(event)) {
    event.preventDefault()
    insertNewline()
    return
  }
  if (shouldSendOnPlainEnter(event)) {
    event.preventDefault()
    if (compacting.value) return
    send()
  }
}
function toggleContextDetails(): void { contextDetailsExpanded.value = !contextDetailsExpanded.value }
function updateSshContextLines(event: Event): void {
  store.setSshContextLines(Number((event.target as HTMLInputElement).value))
}
function isMessagesAtBottom(element: HTMLElement, threshold = 24): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= threshold
}
function scrollMessagesToBottom(): void {
  void nextTick(() => {
    const element = messagesElement.value
    if (!element || !followMessages.value) return
    suppressMessagesScroll = true
    element.scrollTop = element.scrollHeight
    suppressMessagesScroll = false
  })
}
function onMessagesScroll(): void {
  if (suppressMessagesScroll) return
  const element = messagesElement.value
  if (element) followMessages.value = isMessagesAtBottom(element)
}
watch(messages, () => {
  if (followMessages.value) scrollMessagesToBottom()
}, { deep: true, flush: 'post' })
watch(chatId, () => { selectedConversationSessionId.value = '' })
async function compactContext(): Promise<void> {
  if (!chatId.value || compacting.value || props.sessionBusy) return
  compactError.value = ''
  try {
    await store.compact(chatId.value, selectedContextSessionIds.value, enabledSkillIds.value)
  } catch (error) {
    compactError.value = error instanceof Error ? error.message : '上下文压缩失败，请稍后再试。'
  }
}
function insertNewline(): void {
  const input = composerInput.value
  if (!input || !chatId.value) return
  const start = input.selectionStart
  const end = input.selectionEnd
  const next = `${draft.value.slice(0, start)}\n${draft.value.slice(end)}`
  store.setDraft(chatId.value, next)
  void nextTick(() => {
    input.selectionStart = input.selectionEnd = start + 1
    input.focus()
  })
}
function formatTokens(value: number): string { return new Intl.NumberFormat('zh-CN').format(value) }
function progressLabel(stage: ChatProgressStage | null): string {
  return stage === 'thinking' ? '正在思考' : stage === 'executing' ? '正在执行' : stage === 'observing' ? '正在整理观察结果' : stage === 'repairing' ? '正在修正计划' : ''
}
function assistantReply(content: unknown): string {
  if (typeof content !== 'string') return chatContentText(content as any)
  try {
    const parsed = JSON.parse(content) as { version?: number; reply?: unknown }
    if (parsed && parsed.version === 1 && typeof parsed.reply === 'string') return parsed.reply
  } catch { /* legacy plain text */ }
  return content
}
function planStatusLabel(status: string): string {
  return status === 'pending_review' ? '待确认' : status === 'executing' ? '执行中' : status === 'executed' ? '已执行' : status === 'partially_executed' ? '部分执行' : status === 'execution_failed' ? '执行失败' : '已取消'
}
function stepCommand(step: { finalCommand?: string; originalCommand: string }): string { return step.finalCommand ?? step.originalCommand }
function planTargetLabel(target: string): string {
  const allShells = props.chat?.shells ?? []
  const liveShells = allShells.filter(shell => shell.status === 'open')
  const shells = liveShells.length > 0 ? liveShells : allShells
  return planTargetLabelForShells(target, shells)
}
function stepDraftKey(messageId: string, stepId: string): string { return `${messageId}:${stepId}` }
function setStepDraft(messageId: string, stepId: string, event: Event): void { stepDrafts[stepDraftKey(messageId, stepId)] = (event.target as HTMLInputElement).value }
function stepDraftValue(messageId: string, stepId: string, step: { finalCommand?: string; originalCommand: string }): string {
  return stepDrafts[stepDraftKey(messageId, stepId)] ?? stepCommand(step)
}
function reportActionError(actionChatId: string, error: unknown, fallback: string): void {
  actionErrors[actionChatId] = error instanceof Error ? error.message : fallback
  if (actionChatId !== chatId.value) return
  announceAssertiveError(actionErrors[actionChatId])
}
async function saveStep(messageId: string, stepId: string, fallbackCommand: string): Promise<void> {
  if (props.sessionBusy) return
  const key = stepDraftKey(messageId, stepId)
  const command = (stepDrafts[key] ?? fallbackCommand).trim()
  if (command) stepDrafts[key] = command
  await editStep(messageId, stepId, command)
}
async function editStep(messageId: string, stepId: string, command: string): Promise<void> {
  const actionChatId = chatId.value
  if (!actionChatId || !command.trim() || props.sessionBusy) return
  actionErrors[actionChatId] = ''
  try { await store.editPlanStep(actionChatId, messageId, stepId, command.trim()) } catch (error) { reportActionError(actionChatId, error, '计划更新失败') }
}
async function removeStep(messageId: string, stepId: string): Promise<void> {
  const actionChatId = chatId.value
  if (!actionChatId || props.sessionBusy) return
  actionErrors[actionChatId] = ''
  try { await store.removePlanStep(actionChatId, messageId, stepId) } catch (error) { reportActionError(actionChatId, error, '计划更新失败') }
}
async function cancelPlan(messageId: string): Promise<void> {
  const actionChatId = chatId.value
  if (!actionChatId || props.sessionBusy) return
  actionErrors[actionChatId] = ''
  try { await store.cancelPlan(actionChatId, messageId) } catch (error) { reportActionError(actionChatId, error, '计划取消失败') }
}
async function executePlan(messageId: string): Promise<void> {
  const actionChatId = chatId.value
  if (!actionChatId || props.sessionBusy) return
  actionErrors[actionChatId] = ''
  try { await store.executePlan(actionChatId, messageId) } catch (error) { reportActionError(actionChatId, error, '计划执行失败') }
}
onMounted(() => {
  followMessages.value = true
  scrollMessagesToBottom()
  void window.terminalAgent.settings.getModel()
    .then(model => { if (model?.contextLimit) modelContextLimit.value = model.contextLimit })
    .catch(() => undefined)
})
onBeforeUnmount(() => { disposeErrorAnnouncement(); disposeAssistantAnnouncement(); store.dispose() })
</script>

<template>
  <section class="global-chat-panel" :class="{ 'context-details-expanded': contextDetailsExpanded }" aria-label="AI工作区">
    <header class="ai-head">
      <span class="ai-avatar" aria-hidden="true">AI</span>
      <div class="ai-head-copy"><h3>AI工作区</h3><span>当前任务的全局协作助手</span></div>
      <div class="ai-head-actions">
        <button type="button" class="session-action new-session" :disabled="!canCreateConversationSession" aria-label="新建会话" title="新建会话：备份当前聊天内容后开始新的会话" @click="requestNewConversationSession"><MessageSquarePlus :size="13" aria-hidden="true" /><span>新建会话</span></button>
        <label class="session-switch"><History :size="13" aria-hidden="true" /><span class="visually-hidden-label">切换会话</span><select v-model="selectedConversationSessionId" :disabled="!canSwitchConversationSession" aria-label="切换会话" title="切换会话" @change="requestConversationSessionSwitch"><option value="">切换会话</option><option v-for="session in conversationSessions" :key="session.id" :value="session.id">{{ session.label }}</option></select></label>
        <button type="button" class="collapse-button" aria-label="收起 AI工作区" title="收起 AI工作区" @click="emit('collapse')"><span>收起</span><PanelRightClose :size="14" aria-hidden="true" /></button>
      </div>
      <div class="ai-safety-badge"><Check :size="12" aria-hidden="true" /><span>计划需手动确认</span></div>
      <section class="context-meter" aria-label="AI 上下文用量">
        <div class="context-meter-head"><strong>上下文</strong><span class="context-meter-summary">{{ formatTokens(contextUsed) }} / {{ formatTokens(modelContextLimit) }} tokens</span><b>{{ contextPercent }}%</b><button type="button" class="context-toggle" :aria-expanded="contextDetailsExpanded" aria-controls="chat-context-details" :aria-label="contextDetailsExpanded ? '收起上下文详情' : '展开上下文详情'" :title="contextDetailsExpanded ? '收起上下文详情' : '展开上下文详情'" @click="toggleContextDetails"><ChevronUp v-if="contextDetailsExpanded" :size="14" aria-hidden="true" /><ChevronDown v-else :size="14" aria-hidden="true" /></button></div>
        <div v-if="contextDetailsExpanded" id="chat-context-details" class="context-meter-details">
          <div class="context-progress" role="progressbar" aria-label="上下文使用比例" :aria-valuenow="contextPercent" aria-valuemin="0" aria-valuemax="100"><span :style="{ width: `${contextPercent}%` }" /></div>
          <div class="context-meter-foot"><span>根据当前聊天文本和模型上限估算</span></div>
          <div class="context-settings">
            <button type="button" class="secondary-action" :disabled="compacting || !chatId || sessionBusy" @click="compactContext">{{ compacting ? '正在压缩…' : '立即压缩' }}</button>
            <label class="ssh-context-setting"><span>SSH 上下文追加行数</span><input type="number" min="0" step="1" :value="sshContextLines" aria-label="SSH 上下文追加的上下文行数" @change="updateSshContextLines"></label>
            <section class="context-host-setting" aria-label="选择主机追加上下文">
              <div class="context-host-setting-head"><span>选择主机追加上下文</span><b>{{ selectedContextCount }} / {{ contextSessionRows.length }}</b></div>
              <div v-if="contextSessionRows.length" class="context-host-options">
                <label v-for="row in contextSessionRows" :key="row.id" class="context-host-option">
                  <input type="checkbox" :checked="selectedContextSessionIds?.includes(row.id) ?? false" :aria-label="`选择 ${contextSessionLabel(row)} 追加上下文`" @change="toggleContextSession(row.id)">
                  <span>{{ contextSessionLabel(row) }}</span>
                </label>
              </div>
              <span v-else class="context-host-empty">暂无在线 SSH 连接</span>
            </section>
          </div>
          <p v-if="compactError" class="context-error">{{ compactError }}</p>
        </div>
      </section>
    </header>

    <div ref="messagesElement" class="messages" @scroll="onMessagesScroll">
      <article v-for="message in messages" :key="message.id" :class="['message', message.role, { audit: message.messageType === 'execution_audit' }]">
        <span class="message-avatar" aria-hidden="true"><UserRound v-if="message.role === 'user'" :size="14" /><Bot v-else :size="14" /></span>
        <div class="message-content">
          <div class="message-meta"><strong>{{ message.messageType === 'execution_audit' ? '执行审计' : message.role === 'user' ? '你' : 'Terminal-Agent' }}</strong><span v-if="message.state === 'streaming'">生成中</span><span v-else-if="message.state === 'error'">未完成</span></div>
          <p>{{ message.messageType === 'execution_audit' ? String(message.content) : message.role === 'assistant' ? assistantReply(message.content) : (typeof message.content === 'string' ? message.content : chatContentText(message.content)) }}</p>
          <section v-if="message.role === 'user' && message.id === runUserMessageId && progress" class="progress-item message-progress" role="status" aria-live="polite"><CircleAlert :size="14" aria-hidden="true" /><span>{{ progressLabel(progress) }}</span><span class="progress-dots" aria-hidden="true">...</span></section>
          <section v-if="message.executionPlan" class="execution-plan" :data-status="message.executionPlan.status">
            <header class="plan-head"><div><strong>{{ message.executionPlan.title }}</strong><span>{{ message.executionPlan.steps.length }} 步 · {{ planStatusLabel(message.executionPlan.status) }}</span></div><span class="plan-badge">{{ planStatusLabel(message.executionPlan.status) }}</span></header>
            <div v-for="step in message.executionPlan.steps" :key="step.id" class="plan-step">
               <div class="plan-step-head"><strong>{{ planTargetLabel(step.target) }}</strong><span>{{ step.sendState }}</span></div>
               <p>{{ step.explanation }}</p>
               <div v-if="step.fence" class="plan-risk"><CircleAlert :size="12" aria-hidden="true" /><span>安全围栏：{{ step.fence.ruleName }}（{{ step.fence.ruleId }}）</span></div>
               <label class="plan-command"><span>原始命令</span><code>{{ step.originalCommand }}</code></label>
               <label v-if="step.finalCommand" class="plan-command"><span>确认命令</span><code>{{ step.finalCommand }}</code></label>
                <div v-if="message.executionPlan.status === 'pending_review'" class="plan-step-actions">
                  <input class="plan-edit-input" :disabled="sessionBusy" :value="stepDraftValue(message.id, step.id, step)" :aria-label="`编辑 ${planTargetLabel(step.target)} 命令`" @input="setStepDraft(message.id, step.id, $event)">
                  <button type="button" class="icon-button" :disabled="sessionBusy" :aria-label="`保存 ${planTargetLabel(step.target)} 命令`" title="保存命令" @click="saveStep(message.id, step.id, stepCommand(step))"><Check :size="13" aria-hidden="true" /></button>
                 <button type="button" class="icon-button" :disabled="sessionBusy" :aria-label="`删除 ${planTargetLabel(step.target)} 步骤`" title="删除步骤" @click="removeStep(message.id, step.id)"><Trash2 :size="13" aria-hidden="true" /></button>
              </div>
            </div>
            <footer v-if="message.executionPlan.status === 'pending_review'" class="plan-actions">
               <button type="button" class="secondary-action" :disabled="sessionBusy" @click="cancelPlan(message.id)"><X :size="13" aria-hidden="true" />取消计划</button>
               <button type="button" class="primary-action" :disabled="sessionBusy" @click="executePlan(message.id)"><Send :size="13" aria-hidden="true" />确认并执行 {{ message.executionPlan.steps.length }} 步</button>
            </footer>
          </section>
        </div>
      </article>
      <section v-if="!messages.length" class="empty"><Bot :size="24" aria-hidden="true" /><strong>开始协作</strong><span>输入目标，AI 会结合当前任务中的 SSH 信息回答</span></section>
      <p v-if="standaloneError" class="error">{{ standaloneError }}</p>
      <p v-if="actionError" class="error">{{ actionError }}</p>
    </div>
    <p class="visually-hidden-alert" role="status" aria-live="polite" aria-atomic="true"><span :key="assistantResponse?.id">{{ assistantResponse?.content ?? '' }}</span></p>
    <p class="visually-hidden-alert" role="alert" aria-atomic="true"><span :key="assertiveError?.id">{{ assertiveError?.content ?? '' }}</span></p>

    <footer class="composer">
      <div class="composer-shell">
        <textarea ref="composerInput" :value="draft" :disabled="!chatId || sessionBusy" aria-label="聊天输入" placeholder="告诉 AI 要完成什么；AI 会根据当前任务的 SSH 信息回答。" @input="updateDraft" @keydown="onKeydown" />
        <div class="composer-foot"><span>{{ `${props.shellCount ?? chat?.shellCount ?? 0} 个在线 SSH` }}</span><button v-if="running" type="button" class="cancel-button" @click="cancel"><Square :size="12" fill="currentColor" aria-hidden="true" />取消</button><button type="button" class="line-break-button" :disabled="!chatId || sessionBusy" title="换行（Alt+Enter、Ctrl+Enter、Shift+Enter）" aria-label="插入换行（Alt+Enter、Ctrl+Enter、Shift+Enter）" @click="insertNewline">↵ 换行</button><button type="button" class="send-button" :disabled="!chatId || compacting || sessionBusy || !draft.trim()" @click="send"><Send :size="13" aria-hidden="true" />发送</button></div>
      </div>
    </footer>
  </section>
</template>

<style scoped>
.global-chat-panel { display: grid; grid-template-rows: auto minmax(0, 1fr) auto; width: 100%; min-width: 0; min-height: 0; height: 100%; overflow: hidden; background: var(--panel); color: var(--text); }.global-chat-panel.context-details-expanded { grid-template-rows: minmax(130px, auto) minmax(0, 1fr) auto; }
.ai-head { display: grid; grid-template-columns: 30px minmax(0, 1fr) auto; grid-template-rows: auto auto auto; align-content: start; gap: 5px 8px; min-width: 0; min-height: 0; padding: 8px 10px; overflow: hidden; border-bottom: 1px solid var(--line); background: var(--surface); }
.ai-avatar { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 6px; background: var(--text-strong); color: var(--surface); font-size: 10px; font-weight: 800; }
.ai-head-copy { min-width: 0; }.ai-head-copy h3 { margin: 0; overflow: hidden; color: var(--text-strong); font-size: 15px; font-weight: 720; text-overflow: ellipsis; white-space: nowrap; }.ai-head-copy span { display: block; margin-top: 2px; overflow: hidden; color: var(--muted); font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }
.ai-head-actions { display: flex; align-items: center; justify-content: flex-end; gap: 4px; min-width: 0; }
.session-action,.session-switch { display: inline-flex; align-items: center; justify-content: center; gap: 4px; height: 30px; min-width: 0; padding: 0 7px; border: 1px solid var(--line); border-radius: 5px; background: var(--surface); color: var(--text-strong); font-size: 9px; font-weight: 650; white-space: nowrap; }
.session-action:hover:not(:disabled),.session-switch:hover { border-color: var(--focus); background: var(--hover); }.session-action:disabled,.session-switch:has(select:disabled) { cursor: not-allowed; opacity: .55; }
.session-switch { position: relative; gap: 3px; padding-left: 6px; }.session-switch select { width: 82px; min-width: 0; height: 28px; padding: 0 15px 0 0; border: 0; outline: 0; background: transparent; color: inherit; font: inherit; cursor: pointer; }.session-switch select:disabled { cursor: not-allowed; }.session-switch option { background: var(--surface); color: var(--text); }
.collapse-button { display: inline-flex; align-items: center; justify-content: center; gap: 5px; height: 30px; padding: 0 8px; border: 1px solid var(--line); border-radius: 5px; background: var(--surface); color: var(--text-strong); font-size: 10px; font-weight: 650; white-space: nowrap; }.collapse-button:hover { border-color: var(--focus); background: var(--hover); }
.ai-safety-badge { grid-column: 1 / -1; display: inline-flex; align-items: center; gap: 5px; min-width: 0; color: var(--accent); font-size: 10px; font-weight: 650; }
.context-meter { grid-column: 1 / -1; min-width: 0; padding-top: 4px; border-top: 1px solid var(--line-soft); }.context-meter-head { display: grid; grid-template-columns: auto minmax(0, 1fr) auto 26px; align-items: center; gap: 6px; min-width: 0; }.context-meter-head strong { color: var(--text-strong); font-size: 10px; }.context-meter-summary { min-width: 0; overflow: hidden; color: var(--muted); font-size: 9px; font-variant-numeric: tabular-nums; text-overflow: ellipsis; white-space: nowrap; }.context-meter-head b { color: var(--text-strong); font-size: 9px; }.context-toggle { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; padding: 0; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); color: var(--muted); }.context-toggle:hover { border-color: var(--focus); color: var(--text-strong); }.context-meter-details { min-width: 0; }.context-progress { height: 5px; margin-top: 4px; overflow: hidden; border-radius: 3px; background: var(--line); }.context-progress span { display: block; height: 100%; border-radius: inherit; background: var(--accent); }.context-meter-foot { margin-top: 4px; color: var(--muted); font-size: 8.5px; }.context-settings { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-top: 6px; }.context-settings .secondary-action { min-height: 27px; }.ssh-context-setting { display: inline-flex; align-items: center; gap: 6px; min-width: 0; color: var(--muted); font-size: 9px; }.ssh-context-setting span { white-space: nowrap; }.ssh-context-setting input { width: 62px; height: 27px; padding: 0 6px; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); color: var(--text); font-size: 10px; font-variant-numeric: tabular-nums; }.ssh-context-setting input:focus { border-color: var(--focus); outline: none; box-shadow: 0 0 0 2px var(--accent-soft); }.context-error { margin: 5px 0 0; color: var(--red); font-size: 9px; line-height: 1.4; overflow-wrap: anywhere; }
.context-host-setting { flex: 1 1 100%; min-width: 0; margin-top: 2px; padding-top: 6px; border-top: 1px solid var(--line-soft); }.context-host-setting-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--muted); font-size: 9px; }.context-host-setting-head b { color: var(--text-strong); font-size: 9px; font-variant-numeric: tabular-nums; }.context-host-options { display: flex; flex-wrap: wrap; gap: 4px 8px; margin-top: 5px; }.context-host-option { display: inline-flex; align-items: center; gap: 4px; min-width: 0; padding: 3px 5px; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); color: var(--text); font-size: 9px; cursor: pointer; }.context-host-option:hover { border-color: var(--focus); background: var(--hover); }.context-host-option input { margin: 0; accent-color: var(--accent); }.context-host-option span { min-width: 0; max-width: 190px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.context-host-empty { display: block; margin-top: 5px; color: var(--faint); font-size: 9px; }
.messages { min-width: 0; min-height: 0; overflow-x: hidden; overflow-y: auto; padding: 10px 12px 14px; scrollbar-gutter: stable; scrollbar-color: transparent transparent; scrollbar-width: thin; }
.messages:hover,.messages:focus-within { scrollbar-color: var(--line) transparent; }
.messages::-webkit-scrollbar { width: 7px; }
.messages::-webkit-scrollbar-track { background: transparent; }
.messages::-webkit-scrollbar-thumb { border-radius: 4px; background: transparent; }
.messages:hover::-webkit-scrollbar-thumb,.messages:focus-within::-webkit-scrollbar-thumb { background: var(--line); }
.messages::-webkit-scrollbar-button { display: none; width: 0; height: 0; }
.visually-hidden-alert,.visually-hidden-label { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.progress-item { display: flex; align-items: center; gap: 7px; min-height: 32px; padding: 8px 10px; border-left: 2px solid var(--accent); background: var(--surface-soft); color: var(--muted); font-size: 10px; }.message-progress { margin-top: 9px; }.progress-item svg { color: var(--accent); }.progress-dots { letter-spacing: 2px; color: var(--accent); }
.message { display: grid; grid-template-columns: 29px minmax(0, 1fr); align-items: start; gap: 8px; min-width: 0; padding: 8px 0; }.message-avatar { display: grid; place-items: center; width: 29px; height: 29px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); color: var(--muted); }.message.assistant .message-avatar { border-color: var(--text-strong); background: var(--text-strong); color: var(--surface); }.message-content { position: relative; min-width: 0; max-width: 100%; padding: 10px 11px 11px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); overflow-wrap: anywhere; }.message.assistant .message-content::before { position: absolute; top: 10px; bottom: 10px; left: -1px; width: 2px; border-radius: 0 2px 2px 0; background: var(--accent); content: ""; }.message.user { grid-template-columns: minmax(0, 1fr) 29px; padding-left: 38px; }.message.user .message-avatar { grid-column: 2; grid-row: 1; background: var(--panel); color: var(--text-strong); }.message.user .message-content { grid-column: 1; grid-row: 1; background: var(--surface-soft); }.message-meta { display: flex; align-items: center; gap: 7px; margin-bottom: 6px; color: var(--faint); font-size: 9px; }.message-meta strong { color: var(--text-strong); font-size: 10px; }.message.assistant .message-meta strong { color: var(--accent); }.message-meta span { margin-left: auto; }.message p { margin: 0; color: var(--text); font-size: 11px; line-height: 1.65; white-space: pre-wrap; overflow-wrap: anywhere; }.message.audit .message-content { border-color: var(--amber-line); background: var(--amber-soft); }.message.audit .message-avatar { color: var(--amber); }
.execution-plan { display: grid; gap: 8px; margin-top: 11px; padding: 10px; border: 1px solid var(--line); border-radius: 5px; background: var(--panel); }.plan-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; min-width: 0; padding-bottom: 7px; border-bottom: 1px solid var(--line-soft); }.plan-head > div { display: grid; gap: 3px; min-width: 0; }.plan-head strong { color: var(--text-strong); font-size: 11px; overflow-wrap: anywhere; }.plan-head span { color: var(--muted); font-size: 9px; }.plan-badge { flex: 0 0 auto; padding: 3px 6px; border: 1px solid var(--accent); border-radius: 4px; color: var(--accent) !important; font-weight: 650; }.plan-step { display: grid; gap: 5px; min-width: 0; padding: 8px 0; border-bottom: 1px solid var(--line-soft); }.plan-step:last-of-type { border-bottom: 0; }.plan-step-head { display: flex; align-items: center; justify-content: space-between; gap: 7px; }.plan-step-head strong { color: var(--text-strong); font-size: 10px; }.plan-step-head span { color: var(--muted); font-size: 9px; }.plan-step p { color: var(--muted); font-size: 9px; line-height: 1.45; }.plan-risk { display: flex; align-items: flex-start; gap: 5px; color: var(--amber); font-size: 9px; line-height: 1.45; }.plan-risk svg { flex: 0 0 auto; margin-top: 1px; }.plan-command { display: grid; gap: 3px; min-width: 0; }.plan-command span { color: var(--faint); font-size: 8px; }.plan-command code { display: block; min-width: 0; overflow: auto; padding: 5px 6px; border: 1px solid var(--line-soft); background: var(--surface-soft); color: var(--text); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 9px; white-space: pre-wrap; overflow-wrap: anywhere; }.plan-step-actions,.plan-actions { display: flex; align-items: center; gap: 6px; min-width: 0; }.plan-step-actions { margin-top: 2px; }.plan-edit-input { min-width: 0; flex: 1; height: 27px; padding: 0 7px; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); color: var(--text); font-size: 9px; }.icon-button,.secondary-action,.primary-action { display: inline-flex; align-items: center; justify-content: center; gap: 4px; min-height: 27px; padding: 0 7px; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); color: var(--text); font-size: 9px; white-space: nowrap; }.icon-button { width: 27px; padding: 0; }.icon-button:hover,.secondary-action:hover { border-color: var(--focus); color: var(--text-strong); }.primary-action { border-color: var(--accent); background: var(--accent); color: #fff; }.plan-actions { justify-content: flex-end; padding-top: 2px; }.plan-edit-input:disabled,.icon-button:disabled,.plan-actions button:disabled { cursor: not-allowed; opacity: .55; }
.empty { display: grid; justify-items: center; gap: 6px; padding: 34px 18px; color: var(--muted); text-align: center; }.empty strong { color: var(--text-strong); font-size: 12px; }.empty span { max-width: 270px; font-size: 10px; line-height: 1.55; }
.error { display: flex; align-items: flex-start; gap: 8px; margin: 8px 0 0 37px; padding: 9px 10px; border-left: 2px solid var(--red); background: var(--surface); color: var(--red); font-size: 10px; line-height: 1.5; }.error span { min-width: 0; flex: 1; overflow-wrap: anywhere; }.error button { display: inline-flex; align-items: center; gap: 4px; min-height: 26px; padding: 0 8px; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); color: var(--text); }
.composer { min-width: 0; padding: 10px; border-top: 1px solid var(--line); background: var(--surface); }.composer-shell { overflow: hidden; border: 1px solid var(--line); border-radius: 6px; background: var(--surface-soft); }.composer:focus-within .composer-shell { border-color: var(--focus); box-shadow: 0 0 0 2px var(--accent-soft); }.composer textarea { display: block; width: 100%; height: 64px; resize: none; padding: 10px 11px 7px; border: 0; background: transparent; color: var(--text-strong); font-size: 11px; line-height: 1.5; }.composer textarea::placeholder { color: var(--faint); }.composer-foot { display: flex; align-items: center; justify-content: flex-end; gap: 7px; min-height: 39px; padding: 6px 7px 7px 10px; border-top: 1px solid var(--line-soft); }.composer-foot > span { min-width: 0; margin-right: auto; overflow: hidden; color: var(--muted); font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }.composer-foot button { display: inline-flex; align-items: center; justify-content: center; gap: 5px; height: 29px; padding: 0 11px; border: 1px solid var(--line); border-radius: 5px; background: var(--surface); color: var(--text); font-size: 10px; font-weight: 650; }.composer-foot button:disabled { cursor: not-allowed; opacity: .55; }.composer-foot .send-button { border-color: var(--accent); background: var(--accent); color: #fff; }.composer-foot .line-break-button:hover { border-color: var(--focus); color: var(--text-strong); }.composer-foot .cancel-button:hover { border-color: var(--red); color: var(--red); }
@media (max-width: 1180px) { .collapse-button span { display: none; }.collapse-button { width: 30px; padding: 0; }.ai-head-copy span { display: none; } }
</style>
