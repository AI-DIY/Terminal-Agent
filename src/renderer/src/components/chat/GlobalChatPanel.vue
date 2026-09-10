<script setup lang="ts">
import { Bot, Check, ChevronDown, ChevronUp, CircleAlert, History, MessageSquarePlus, PanelRightClose, Send, Square, Trash2, UserRound, X } from '@lucide/vue'
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import SafeMarkdown from './SafeMarkdown.vue'
import type { ChatConversationSessionSummary, ChatProgressStage, ChatWorkspace } from '../../../../shared/contracts'
import { createGlobalChatStore, hasVisibleAssistantError } from '../../stores/global-chat'
import { chatContentText } from '../../../../shared/chat-content'
import { estimateChatMessages } from '../../../../shared/chat-token-estimator'
import { shouldInsertNewlineOnModifiedEnter, shouldSendOnPlainEnter } from './chat-composer-shortcuts'
import { planTargetLabelForShells } from './plan-target-label'
import { chatContextSessionsAreResolved, normalizeChatContextSessionIds } from '../../../../shared/chat-context-selection'
import { sshHostIdentity, sshHostnameDisplayLabels } from '../../../../shared/shell-display-label'
import { getUserPreferencesStore } from '../../stores/user-preferences'
import { runChatActionWithSkillGate } from '../../stores/skill-capability'
import { getSkillsStore } from '../../stores/skills'
import type { SkillId } from '../../../../shared/skill-contracts'

type ContextSession = {
  id: string
  hostname: string
  observedHostname?: string
  title?: string
}

type ConversationSession = Pick<ChatConversationSessionSummary, 'id' | 'label'>

const props = withDefaults(defineProps<{
  chat: ChatWorkspace | null
  contextSessions?: ContextSession[]
  conversationSessions?: ConversationSession[]
  sessionBusy?: boolean
  skillsAvailable?: boolean
}>(), {
  contextSessions: () => [],
  conversationSessions: () => [],
  sessionBusy: false,
  skillsAvailable: false,
})
const emit = defineEmits<{
  collapse: []
  newSession: []
  switchSession: [chatId: string]
}>()
const store = createGlobalChatStore(window.terminalAgent.chat)
const userPreferences = getUserPreferencesStore()
const dynamicSkills = getSkillsStore()
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
const selectedSkillIds = ref<SkillId[]>([])
// Skill chips are draft-scoped. Keep an in-memory projection per task so
// switching the left-hand task list cannot leak a pending `$` selection into
// another conversation (and returning to the task restores its selection).
const selectedSkillIdsByChat = new Map<string, SkillId[]>()
const skillPickerOpen = ref(false)
const skillQuery = ref('')
const skillPickerActiveIndex = ref(0)
let assertiveErrorId = 0
let assistantResponseId = 0
let scrollFrame: number | undefined
let scrollPending = false
let scrollDisposed = false
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

watch(chatId, (id, previousId) => {
  if (previousId) selectedSkillIdsByChat.set(previousId, [...selectedSkillIds.value])
  selectedSkillIds.value = id ? [...(selectedSkillIdsByChat.get(id) ?? [])] : []
  closeSkillPicker()
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
const progress = computed<ChatProgressStage | null>(() => {
  const id = chatId.value
  if (!id) return null
  // A running Skill has its own transient card. Hide the generic thinking
  // card while that card is present so the two progress indicators do not
  // compete for the same phase of the turn.
  if ((store.state.skillEvents[id]?.length ?? 0) > 0) return null
  // `null` is an explicit suppression after the first assistant delta. Only
  // fall back to the initial thinking state when no progress value exists yet.
  if (Object.prototype.hasOwnProperty.call(store.state.progress, id)) return store.state.progress[id]
  return store.state.runs[id] ? 'thinking' : null
})
const skillEvents = computed(() => chatId.value ? store.state.skillEvents[chatId.value] ?? [] : [])
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
const skillPickerItems = computed(() => {
  const query = skillQuery.value.trim().toLowerCase()
  return dynamicSkills.state.catalog.skills
    .filter(skill => skill.enabled && !selectedSkillIds.value.includes(skill.id))
    .filter(skill => !query || skill.id.toLowerCase().includes(query) || skill.name.toLowerCase().includes(query))
})
const selectedSkills = computed(() => selectedSkillIds.value.flatMap(id => dynamicSkills.state.catalog.skills.filter(skill => skill.id === id)))
const activeSkillPickerId = computed(() => {
  const skill = skillPickerItems.value[skillPickerActiveIndex.value]
  return skill ? skillPickerOptionId(skill.id) : undefined
})

watch(selectedSkillIds, value => {
  const id = chatId.value
  if (id) selectedSkillIdsByChat.set(id, [...value])
}, { deep: true })

watch(() => dynamicSkills.state.catalog.skills, skills => {
  // A refresh can remove or disable a skill while its chip is still in the
  // draft. Drop those stale chips before the next send so the main-process
  // gate never receives a skill that is no longer available.
  const enabled = new Set(skills.filter(skill => skill.enabled).map(skill => skill.id))
  const next = selectedSkillIds.value.filter(id => enabled.has(id))
  if (!sameStringArray(next, selectedSkillIds.value)) selectedSkillIds.value = next
}, { deep: true })

watch(skillPickerItems, items => {
  // Keep the highlighted row valid when filtering removes the previously
  // highlighted skill (or when a live catalogue update disables it).
  skillPickerActiveIndex.value = items.length
    ? Math.min(skillPickerActiveIndex.value, items.length - 1)
    : 0
})

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
function onDraftInput(event: Event): void {
  updateDraft(event)
  const value = (event.target as HTMLTextAreaElement).value
  const match = value.match(/\$([A-Za-z0-9._-]*)$/)
  const wasOpen = skillPickerOpen.value
  skillPickerOpen.value = Boolean(match)
  skillQuery.value = match?.[1] ?? ''
  if (!wasOpen || !match) skillPickerActiveIndex.value = 0
}
function chooseSkill(id: SkillId): void {
  if (!selectedSkillIds.value.includes(id)) selectedSkillIds.value = [...selectedSkillIds.value, id]
  const idValue = chatId.value
  if (idValue) {
    const current = store.draft(idValue)
    store.setDraft(idValue, current.replace(/\$[A-Za-z0-9._-]*$/, '').trimEnd())
  }
  skillPickerOpen.value = false
  skillQuery.value = ''
  skillPickerActiveIndex.value = 0
  void nextTick(() => composerInput.value?.focus())
}
function removeSelectedSkill(id: SkillId): void { selectedSkillIds.value = selectedSkillIds.value.filter(item => item !== id) }
function closeSkillPicker(): void {
  skillPickerOpen.value = false
  skillQuery.value = ''
  skillPickerActiveIndex.value = 0
}
function skillPickerOptionId(id: SkillId): string {
  // Skill IDs are validated to [A-Za-z0-9._-], but escaping here keeps the
  // ARIA relationship safe if that contract is ever broadened.
  return `skill-picker-option-${encodeURIComponent(id)}`
}
function onSkillPickerKeydown(event: KeyboardEvent): boolean {
  if (!skillPickerOpen.value) return false
  const items = skillPickerItems.value
  if (event.key === 'Escape') {
    event.preventDefault()
    closeSkillPicker()
    return true
  }
  if (event.key === 'Backspace' && !skillQuery.value && selectedSkillIds.value.length) {
    event.preventDefault()
    removeSelectedSkill(selectedSkillIds.value[selectedSkillIds.value.length - 1]!)
    return true
  }
  if (!items.length) return false
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    skillPickerActiveIndex.value = (skillPickerActiveIndex.value + 1) % items.length
    return true
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault()
    skillPickerActiveIndex.value = (skillPickerActiveIndex.value - 1 + items.length) % items.length
    return true
  }
  if (event.key === 'Enter' && !event.isComposing) {
    event.preventDefault()
    const selected = items[skillPickerActiveIndex.value]
    if (selected) chooseSkill(selected.id)
    return true
  }
  return false
}
function send(): void {
  if (chatId.value && !compacting.value && !props.sessionBusy) {
    const content = store.composeUserContent(chatId.value)
    if (content) {
      // A new user message always starts a fresh view at the end of the transcript.
      followMessages.value = true
      void runChatActionWithSkillGate(props.skillsAvailable, enabledSkillIds.value, skillIds => (
        store.send(chatId.value, content, selectedContextSessionIds.value, skillIds, selectedSkillIds.value)
      ))
      selectedSkillIds.value = []
      selectedSkillIdsByChat.set(chatId.value, [])
      skillPickerOpen.value = false
      skillQuery.value = ''
      skillPickerActiveIndex.value = 0
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
  if (onSkillPickerKeydown(event)) return
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
  if (!followMessages.value || scrollPending || scrollDisposed) return
  scrollPending = true
  void nextTick(() => {
    if (scrollDisposed) {
      scrollPending = false
      return
    }
    const update = (): void => {
      scrollFrame = undefined
      scrollPending = false
      const element = messagesElement.value
      if (!element || !followMessages.value) return
      suppressMessagesScroll = true
      element.scrollTop = element.scrollHeight
      suppressMessagesScroll = false
    }
    // Streaming replies can update a message many times in one visual frame.
    // Coalescing the layout read/write keeps the composer responsive.
    if (typeof window.requestAnimationFrame === 'function') {
      scrollFrame = window.requestAnimationFrame(update)
    } else {
      update()
    }
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
    await runChatActionWithSkillGate(props.skillsAvailable, enabledSkillIds.value, skillIds => (
      // Context compression never loads or executes a Skill. The compact
      // request intentionally carries only ordinary product guidance.
      store.compact(chatId.value, selectedContextSessionIds.value, skillIds)
    ))
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
  return stage === 'thinking' ? '正在思考' : stage === 'executing' ? '正在执行计划' : stage === 'observing' ? '正在整理结果' : stage === 'repairing' ? '正在完善方案' : ''
}
function skillStageLabel(stage: string): string {
  return stage === 'loading' ? '加载中' : stage === 'reading' ? '读取中' : stage === 'executing' ? '执行中' : stage === 'organizing' ? '整理结果' : stage
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
function setStepDraft(messageId: string, stepId: string, event: Event): void { stepDrafts[stepDraftKey(messageId, stepId)] = (event.target as HTMLTextAreaElement).value }
function stepDraftValue(messageId: string, stepId: string, step: { finalCommand?: string; originalCommand: string }): string {
  return stepDrafts[stepDraftKey(messageId, stepId)] ?? stepCommand(step)
}
function reportActionError(actionChatId: string, error: unknown, fallback: string): void {
  actionErrors[actionChatId] = error instanceof Error ? error.message : fallback
  if (actionChatId !== chatId.value) return
  announceAssertiveError(actionErrors[actionChatId])
}
async function editStep(messageId: string, stepId: string, command: string): Promise<void> {
  const actionChatId = chatId.value
  if (!actionChatId || !command.trim() || props.sessionBusy) return
  actionErrors[actionChatId] = ''
  try {
    await store.editPlanStep(actionChatId, messageId, stepId, command.trim())
  } catch (error) {
    reportActionError(actionChatId, error, '计划更新失败')
    throw error
  }
}
async function removeStep(messageId: string, stepId: string): Promise<void> {
  const actionChatId = chatId.value
  if (!actionChatId || props.sessionBusy) return
  actionErrors[actionChatId] = ''
  try {
    await store.removePlanStep(actionChatId, messageId, stepId)
    delete stepDrafts[stepDraftKey(messageId, stepId)]
  } catch (error) {
    reportActionError(actionChatId, error, '计划更新失败')
  }
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
  try {
    // Persist the current textarea values immediately before the single plan
    // confirmation so the command sent by the main process is the command the
    // user can see and edit in the review card.
    const message = messages.value.find(item => item.id === messageId)
    const plan = message?.executionPlan
    if (plan?.status === 'pending_review') {
      for (const step of plan.steps) {
        const key = stepDraftKey(messageId, step.id)
        const command = (stepDrafts[key] ?? stepCommand(step)).trim()
        if (!command) throw new Error('执行命令不能为空')
        if (command !== stepCommand(step)) await editStep(messageId, step.id, command)
      }
    }
    // Legacy assertion/documentation: store.executePlan(actionChatId, messageId, selectedContextSessionIds.value, skillIds)
    await runChatActionWithSkillGate(props.skillsAvailable, enabledSkillIds.value, skillIds => (
      store.executePlan(actionChatId, messageId, selectedContextSessionIds.value, skillIds, selectedSkillIds.value)
    ))
  } catch (error) {
    reportActionError(actionChatId, error, '计划执行失败')
  }
}
onMounted(() => {
  scrollDisposed = false
  followMessages.value = true
  scrollMessagesToBottom()
  void window.terminalAgent.settings.getModel()
    .then(model => { if (model?.contextLimit) modelContextLimit.value = model.contextLimit })
    .catch(() => undefined)
  void dynamicSkills.hydrate().catch(() => undefined)
})
onBeforeUnmount(() => {
  scrollDisposed = true
  if (scrollFrame !== undefined) window.cancelAnimationFrame(scrollFrame)
  scrollFrame = undefined
  scrollPending = false
  disposeErrorAnnouncement()
  disposeAssistantAnnouncement()
  store.dispose()
  dynamicSkills.dispose()
})
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
      <article v-for="message in messages" :key="message.id" :class="['message', message.role, { audit: message.messageType === 'execution_audit', 'execution-card': message.messageType === 'execution_audit' }]">
        <span class="message-avatar" aria-hidden="true"><UserRound v-if="message.role === 'user'" :size="14" /><Bot v-else :size="14" /></span>
        <div class="message-content message-bubble">
          <div class="message-meta"><strong>{{ message.messageType === 'execution_audit' ? '执行审计' : message.role === 'user' ? '你' : 'Terminal-Agent' }}</strong><span v-if="message.state === 'streaming'">生成中</span><span v-else-if="message.state === 'error'">未完成</span></div>
          <SafeMarkdown v-if="message.role === 'assistant' && message.messageType !== 'execution_audit'" :content="assistantReply(message.content)" />
          <p v-else>{{ message.messageType === 'execution_audit' ? String(message.content) : (typeof message.content === 'string' ? message.content : chatContentText(message.content)) }}</p>
          <section v-if="message.executionPlan" class="execution-plan plan-card" :data-status="message.executionPlan.status" :aria-label="message.executionPlan.status === 'pending_review' ? '待确认的命令计划' : '已执行的命令结果'">
            <header class="plan-head plan-heading"><div><strong>{{ message.executionPlan.title }}</strong><span>{{ message.executionPlan.steps.length }} 步 · {{ planStatusLabel(message.executionPlan.status) }}</span></div><span :class="['plan-badge', 'status-chip', message.executionPlan.status]">{{ planStatusLabel(message.executionPlan.status) }}</span></header>
            <p v-if="message.executionPlan.steps.length === 0" class="plan-empty">计划已取消，未执行任何命令。</p>
             <div v-for="step in message.executionPlan.steps" :key="step.id" class="plan-step" :data-plan-step="step.id">
               <div class="plan-step-head"><strong>{{ planTargetLabel(step.target) }}</strong><span>{{ step.sendState }}</span></div>
               <p>{{ step.explanation }}</p>
               <div v-if="step.fence" class="plan-risk"><CircleAlert :size="12" aria-hidden="true" /><span>安全围栏：{{ step.fence.ruleName }}（{{ step.fence.ruleId }}）</span></div>
               <label class="plan-command"><span>原始命令</span><code>{{ step.originalCommand }}</code></label>
               <div v-if="message.executionPlan.status === 'pending_review'" class="plan-command-editor">
                 <label class="plan-command"><span>修改后命令（可编辑）</span><textarea class="plan-edit-input" rows="2" :disabled="sessionBusy" :value="stepDraftValue(message.id, step.id, step)" :aria-label="`编辑 ${planTargetLabel(step.target)} 命令`" @input="setStepDraft(message.id, step.id, $event)" /></label>
                 <div class="plan-step-actions">
                   <button type="button" class="icon-button delete-plan-step" :disabled="sessionBusy" aria-label="删除命令" :title="message.executionPlan.steps.length <= 1 ? '删除后将取消计划' : `删除 ${planTargetLabel(step.target)} 步骤`" @click="removeStep(message.id, step.id)"><Trash2 :size="13" aria-hidden="true" /></button>
                 </div>
               </div>
               <label v-else class="plan-command"><span>修改后命令</span><code>{{ stepCommand(step) }}</code></label>
            </div>
            <footer v-if="message.executionPlan.status === 'pending_review' && message.executionPlan.steps.length > 0" class="plan-actions">
               <button type="button" class="secondary-action" :disabled="sessionBusy" @click="cancelPlan(message.id)"><X :size="13" aria-hidden="true" />取消计划</button>
               <button type="button" class="primary-action" :disabled="sessionBusy" @click="executePlan(message.id)"><Send :size="13" aria-hidden="true" />确认并执行 {{ message.executionPlan.steps.length }} 步</button>
            </footer>
          </section>
        </div>
      </article>
      <article v-if="progress" class="message assistant progress-message">
        <span class="message-avatar" aria-hidden="true"><Bot :size="14" /></span>
        <div class="message-content message-bubble progress-content">
          <div class="message-meta"><strong>Terminal-Agent</strong><span>处理中</span></div>
          <section class="progress-item" role="status" aria-live="polite" aria-atomic="true" data-visual="thinking-card">
            <span class="thinking-animation" aria-hidden="true"><span class="thinking-bars"><i /><i /><i /><i /></span></span>
            <span class="thinking-copy"><strong>{{ progressLabel(progress) }}</strong><em>分析中</em></span>
          </section>
        </div>
      </article>
      <article v-for="event in skillEvents" :key="event.invocationId" class="message assistant progress-message skill-progress-message">
        <span class="message-avatar" aria-hidden="true"><Bot :size="14" /></span>
        <div class="message-content message-bubble progress-content"><section class="progress-item" role="status" aria-live="polite"><span class="thinking-animation skill-animation" aria-hidden="true"><span class="thinking-bars"><i /><i /><i /><i /></span></span><span class="thinking-copy"><strong>{{ event.skillId }}</strong><em>{{ skillStageLabel(event.stage) }}</em></span></section></div>
      </article>
      <section v-if="!messages.length && !progress" class="empty"><Bot :size="24" aria-hidden="true" /><strong>开始协作</strong><span>输入目标，AI 会结合当前任务中的 SSH 信息回答</span></section>
      <p v-if="standaloneError" class="error">{{ standaloneError }}</p>
      <p v-if="actionError" class="error">{{ actionError }}</p>
    </div>
    <p class="visually-hidden-alert" role="status" aria-live="polite" aria-atomic="true"><span :key="assistantResponse?.id">{{ assistantResponse?.content ?? '' }}</span></p>
    <p class="visually-hidden-alert" role="alert" aria-atomic="true"><span :key="assertiveError?.id">{{ assertiveError?.content ?? '' }}</span></p>

    <footer class="composer">
      <div class="composer-shell">
        <div v-if="selectedSkills.length" class="selected-skill-chips" aria-label="已选择技能">
          <span v-for="skill in selectedSkills" :key="skill.id" class="selected-skill-chip">${{ skill.name }}<button type="button" :aria-label="`移除技能 ${skill.name}`" @click="removeSelectedSkill(skill.id)"><X :size="10" aria-hidden="true" /></button></span>
        </div>
        <div v-if="skillPickerOpen" class="skill-picker" role="listbox" aria-label="选择技能">
          <button v-for="(skill, index) in skillPickerItems" :id="skillPickerOptionId(skill.id)" :key="skill.id" type="button" role="option" class="skill-picker-option" :class="{ active: index === skillPickerActiveIndex }" :aria-selected="index === skillPickerActiveIndex" @mouseenter="skillPickerActiveIndex = index" @click="chooseSkill(skill.id)"><strong>${{ skill.id }}</strong><span>{{ skill.description }}</span></button>
          <span v-if="!skillPickerItems.length" class="skill-picker-empty">没有匹配的已启用技能</span>
        </div>
        <textarea ref="composerInput" :value="draft" :disabled="!chatId || sessionBusy" aria-label="聊天输入" :aria-expanded="skillPickerOpen" aria-haspopup="listbox" :aria-activedescendant="skillPickerOpen ? activeSkillPickerId : undefined" placeholder="告诉 AI 要完成什么；输入 $ 可选择技能。" @input="onDraftInput" @keydown="onKeydown" />
        <div class="composer-foot"><button v-if="running" type="button" class="cancel-button" @click="cancel"><Square :size="12" fill="currentColor" aria-hidden="true" />取消</button><button type="button" class="line-break-button" :disabled="!chatId || sessionBusy" title="换行（Alt+Enter、Ctrl+Enter、Shift+Enter）" aria-label="插入换行（Alt+Enter、Ctrl+Enter、Shift+Enter）" @click="insertNewline">↵ 换行</button><button type="button" class="send-button" :disabled="!chatId || compacting || sessionBusy || !draft.trim()" @click="send"><Send :size="13" aria-hidden="true" />发送</button></div>
      </div>
    </footer>
  </section>
</template>

<style scoped>
.global-chat-panel { display: grid; grid-template-rows: auto minmax(0, 1fr) auto; width: 100%; min-width: 0; min-height: 0; height: 100%; overflow: hidden; background: var(--surface); color: var(--text); container-type: inline-size; }.global-chat-panel.context-details-expanded { grid-template-rows: minmax(148px, auto) minmax(0, 1fr) auto; }
.ai-head { display: grid; grid-template-columns: 34px minmax(0, 1fr) auto; grid-template-rows: auto auto auto; align-content: start; gap: 8px 9px; min-width: 0; min-height: 0; padding: 12px 13px 11px; overflow: hidden; border-bottom: 1px solid var(--line); background: color-mix(in srgb, var(--surface) 88%, var(--panel)); }
.ai-avatar { display: grid; place-items: center; width: 34px; height: 34px; border: 1px solid color-mix(in srgb, var(--accent) 42%, var(--line)); border-radius: 8px; background: color-mix(in srgb, var(--accent-soft) 74%, var(--surface)); color: var(--accent); font-size: 10px; font-weight: 800; letter-spacing: .04em; }
.ai-head-copy { min-width: 0; }.ai-head-copy h3 { margin: 0; overflow: hidden; color: var(--text-strong); font-size: 14px; font-weight: 740; text-overflow: ellipsis; white-space: nowrap; }.ai-head-copy span { display: block; margin-top: 2px; overflow: hidden; color: var(--muted); font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }
.ai-head-actions { display: flex; align-items: center; justify-content: flex-end; gap: 5px; min-width: 0; }
.session-action,.session-switch { display: inline-flex; align-items: center; justify-content: center; gap: 4px; height: 30px; min-width: 0; padding: 0 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); color: var(--text-strong); font-size: 9px; font-weight: 650; white-space: nowrap; box-shadow: 0 1px 0 color-mix(in srgb, var(--text-strong) 5%, transparent); }
.session-action:hover:not(:disabled),.session-switch:hover { border-color: var(--focus); background: var(--hover); }.session-action:disabled,.session-switch:has(select:disabled) { cursor: not-allowed; opacity: .55; }
.session-switch { position: relative; gap: 3px; padding-left: 7px; }.session-switch select { width: 82px; min-width: 0; height: 28px; padding: 0 15px 0 0; border: 0; outline: 0; background: transparent; color: inherit; font: inherit; cursor: pointer; }.session-switch select:disabled { cursor: not-allowed; }.session-switch option { background: var(--surface); color: var(--text); }
.collapse-button { display: inline-flex; align-items: center; justify-content: center; gap: 5px; height: 30px; padding: 0 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); color: var(--text-strong); font-size: 10px; font-weight: 650; white-space: nowrap; }.collapse-button:hover { border-color: var(--focus); background: var(--hover); }
.ai-safety-badge { grid-column: 1 / -1; display: inline-flex; align-items: center; gap: 5px; justify-self: start; min-width: 0; min-height: 24px; padding: 0 8px; border: 1px solid color-mix(in srgb, var(--green) 45%, var(--line)); border-radius: 999px; background: var(--green-soft); color: var(--green); font-size: 9px; font-weight: 700; }
.context-meter { grid-column: 1 / -1; min-width: 0; padding: 9px 9px 8px; border: 1px solid var(--line-soft); border-radius: 7px; background: var(--surface-soft); }.context-meter-head { display: grid; grid-template-columns: auto minmax(0, 1fr) auto 26px; align-items: center; gap: 6px; min-width: 0; }.context-meter-head strong { color: var(--text-strong); font-size: 10px; }.context-meter-summary { min-width: 0; overflow: hidden; color: var(--muted); font-size: 9px; font-variant-numeric: tabular-nums; text-overflow: ellipsis; white-space: nowrap; }.context-meter-head b { color: var(--accent); font-size: 9px; }.context-toggle { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; padding: 0; border: 1px solid var(--line); border-radius: 5px; background: var(--surface); color: var(--muted); }.context-toggle:hover { border-color: var(--focus); color: var(--text-strong); }.context-meter-details { min-width: 0; }.context-progress { height: 5px; margin-top: 7px; overflow: hidden; border-radius: 999px; background: var(--line); }.context-progress span { display: block; height: 100%; border-radius: inherit; background: var(--accent); }.context-meter-foot { margin-top: 5px; color: var(--muted); font-size: 8.5px; }.context-settings { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; margin-top: 8px; }.context-settings .secondary-action { min-height: 27px; }.ssh-context-setting { display: inline-flex; align-items: center; gap: 6px; min-width: 0; color: var(--muted); font-size: 9px; }.ssh-context-setting span { white-space: nowrap; }.ssh-context-setting input { width: 62px; height: 27px; padding: 0 6px; border: 1px solid var(--line); border-radius: 5px; background: var(--surface); color: var(--text); font-size: 10px; font-variant-numeric: tabular-nums; }.ssh-context-setting input:focus { border-color: var(--focus); outline: none; box-shadow: 0 0 0 2px var(--accent-soft); }.context-error { margin: 5px 0 0; color: var(--red); font-size: 9px; line-height: 1.4; overflow-wrap: anywhere; }
.context-host-setting { flex: 1 1 100%; min-width: 0; margin-top: 1px; padding-top: 7px; border-top: 1px solid var(--line-soft); }.context-host-setting-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--muted); font-size: 9px; }.context-host-setting-head b { color: var(--text-strong); font-size: 9px; font-variant-numeric: tabular-nums; }.context-host-options { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; }.context-host-option { display: inline-flex; align-items: center; gap: 4px; min-width: 0; padding: 4px 6px; border: 1px solid var(--line); border-radius: 999px; background: var(--surface); color: var(--text); font-size: 9px; cursor: pointer; }.context-host-option:hover,.context-host-option:has(input:checked) { border-color: color-mix(in srgb, var(--accent) 55%, var(--line)); background: var(--accent-soft); color: var(--text-strong); }.context-host-option input { margin: 0; accent-color: var(--accent); }.context-host-option span { min-width: 0; max-width: 190px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.context-host-empty { display: block; margin-top: 5px; color: var(--faint); font-size: 9px; }
.messages { min-width: 0; min-height: 0; overflow-x: hidden; overflow-y: auto; padding: 14px 13px 18px; scrollbar-gutter: stable; scrollbar-color: transparent transparent; scrollbar-width: thin; background: color-mix(in srgb, var(--surface) 94%, var(--panel)); }
.messages:hover,.messages:focus-within { scrollbar-color: var(--line) transparent; }
.messages::-webkit-scrollbar { width: 7px; }
.messages::-webkit-scrollbar-track { background: transparent; }
.messages::-webkit-scrollbar-thumb { border-radius: 4px; background: transparent; }
.messages:hover::-webkit-scrollbar-thumb,.messages:focus-within::-webkit-scrollbar-thumb { background: var(--line); }
.messages::-webkit-scrollbar-button { display: none; width: 0; height: 0; }
.visually-hidden-alert,.visually-hidden-label { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.progress-message { padding-top: 3px; }.progress-content { padding-top: 8px; padding-bottom: 8px; }.progress-item { display: flex; align-items: center; gap: 9px; min-height: 34px; padding: 8px 10px; border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--line)); border-left: 3px solid var(--accent); border-radius: 5px; background: var(--accent-soft); color: var(--muted); font-size: 10px; }.progress-item svg { color: var(--accent); }.progress-dots { display: inline-flex; flex: 0 0 auto; align-items: center; gap: 3px; min-width: 19px; color: var(--accent); }.progress-dots i { display: block; width: 4px; height: 4px; border-radius: 50%; background: currentColor; opacity: .3; animation: chat-progress-dot 1.15s ease-in-out infinite; }.progress-dots i:nth-child(2) { animation-delay: .14s; }.progress-dots i:nth-child(3) { animation-delay: .28s; }
.message { display: grid; grid-template-columns: 31px minmax(0, 1fr); align-items: start; gap: 9px; min-width: 0; padding: 9px 0; }.message-avatar { display: grid; place-items: center; width: 31px; height: 31px; border: 1px solid var(--line); border-radius: 7px; background: var(--surface); color: var(--muted); }.message.assistant .message-avatar { border-color: color-mix(in srgb, var(--accent) 42%, var(--line)); background: var(--accent-soft); color: var(--accent); }.message-content { position: relative; min-width: 0; max-width: 100%; padding: 11px 12px 12px; border: 1px solid var(--line); border-radius: 7px; background: var(--surface); box-shadow: 0 2px 8px color-mix(in srgb, var(--text-strong) 4%, transparent); overflow-wrap: anywhere; }.message.assistant .message-content::before { position: absolute; top: 11px; bottom: 11px; left: -1px; width: 3px; border-radius: 0 3px 3px 0; background: var(--accent); content: ""; }.message.user { grid-template-columns: minmax(0, 1fr) 31px; padding-left: 40px; }.message.user .message-avatar { grid-column: 2; grid-row: 1; background: var(--panel); color: var(--text-strong); }.message.user .message-content { grid-column: 1; grid-row: 1; background: var(--surface-soft); }.message-meta { display: flex; align-items: center; gap: 7px; margin-bottom: 6px; color: var(--faint); font-size: 9px; }.message-meta strong { color: var(--text-strong); font-size: 10px; }.message.assistant .message-meta strong { color: var(--accent); }.message-meta span { margin-left: auto; }.message p { margin: 0; color: var(--text); font-size: 11px; line-height: 1.65; white-space: pre-wrap; overflow-wrap: anywhere; }.message.audit .message-content { border-color: var(--amber-line); background: var(--amber-soft); }.message.audit .message-avatar { color: var(--amber); }
.execution-plan { display: grid; gap: 8px; margin-top: 11px; padding: 10px; border: 1px solid var(--line); border-radius: 5px; background: var(--panel); }.plan-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; min-width: 0; padding-bottom: 7px; border-bottom: 1px solid var(--line-soft); }.plan-head > div { display: grid; gap: 3px; min-width: 0; }.plan-head strong { color: var(--text-strong); font-size: 11px; overflow-wrap: anywhere; }.plan-head span { color: var(--muted); font-size: 9px; }.plan-badge { flex: 0 0 auto; padding: 3px 6px; border: 1px solid var(--accent); border-radius: 4px; color: var(--accent) !important; font-weight: 650; }.plan-empty { margin: 2px 0; color: var(--muted); font-size: 9px; line-height: 1.45; }.plan-step { display: grid; gap: 5px; min-width: 0; padding: 8px 0; border-bottom: 1px solid var(--line-soft); }.plan-step:last-of-type { border-bottom: 0; }.plan-step-head { display: flex; align-items: center; justify-content: space-between; gap: 7px; }.plan-step-head strong { color: var(--text-strong); font-size: 10px; }.plan-step-head span { color: var(--muted); font-size: 9px; }.plan-step p { color: var(--muted); font-size: 9px; line-height: 1.45; }.plan-risk { display: flex; align-items: flex-start; gap: 5px; color: var(--amber); font-size: 9px; line-height: 1.45; }.plan-risk svg { flex: 0 0 auto; margin-top: 1px; }.plan-command { display: grid; gap: 3px; min-width: 0; }.plan-command span { color: var(--faint); font-size: 8px; }.plan-command code { display: block; min-width: 0; overflow: auto; padding: 5px 6px; border: 1px solid var(--line-soft); background: var(--surface-soft); color: var(--text); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 9px; white-space: pre-wrap; overflow-wrap: anywhere; }.plan-step-actions,.plan-actions { display: flex; align-items: center; gap: 6px; min-width: 0; }.plan-edit-input { min-width: 0; flex: 1; height: 27px; padding: 0 7px; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); color: var(--text); font-size: 9px; }.icon-button,.secondary-action,.primary-action { display: inline-flex; align-items: center; justify-content: center; gap: 4px; min-height: 27px; padding: 0 7px; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); color: var(--text); font-size: 9px; white-space: nowrap; }.icon-button { width: 27px; padding: 0; }.icon-button:hover,.secondary-action:hover { border-color: var(--focus); color: var(--text-strong); }.delete-plan-step { border-color: var(--amber-line); background: var(--amber-soft); color: var(--amber); }.delete-plan-step:hover:not(:disabled) { border-color: var(--amber); background: var(--amber-soft); color: var(--amber); }.primary-action { border-color: var(--accent); background: var(--accent); color: #fff; }.plan-actions { justify-content: flex-end; padding-top: 2px; }.plan-edit-input:disabled,.icon-button:disabled,.plan-actions button:disabled { cursor: not-allowed; opacity: .55; }
.empty { display: grid; justify-items: center; gap: 7px; margin: auto 0; padding: 42px 18px; border: 1px dashed var(--line); border-radius: 8px; color: var(--muted); text-align: center; }.empty svg { color: var(--accent); }.empty strong { color: var(--text-strong); font-size: 12px; }.empty span { max-width: 270px; font-size: 10px; line-height: 1.55; }
.plan-command-editor { display: grid; grid-template-columns: minmax(0, 1fr) 27px; align-items: center; gap: 6px; min-width: 0; }.plan-command-editor .plan-edit-input { display: block; width: 100%; min-width: 0; min-height: 44px; height: auto; padding: 7px; resize: vertical; font: 9px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }.plan-command-editor .plan-step-actions { align-self: center; justify-self: end; }
.error { display: flex; align-items: flex-start; gap: 8px; margin: 8px 0 0 37px; padding: 9px 10px; border-left: 2px solid var(--red); background: var(--surface); color: var(--red); font-size: 10px; line-height: 1.5; }.error span { min-width: 0; flex: 1; overflow-wrap: anywhere; }.error button { display: inline-flex; align-items: center; gap: 4px; min-height: 26px; padding: 0 8px; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); color: var(--text); }
.composer { min-width: 0; padding: 12px; border-top: 1px solid var(--line); background: var(--panel); }.composer-shell { position: relative; overflow: visible; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); box-shadow: 0 2px 8px color-mix(in srgb, var(--text-strong) 4%, transparent); }.composer:focus-within .composer-shell { border-color: var(--focus); box-shadow: 0 0 0 2px var(--accent-soft); }.composer textarea { display: block; width: 100%; height: 72px; resize: none; padding: 11px 12px 8px; border: 0; background: transparent; color: var(--text-strong); font-size: 11px; line-height: 1.5; }.composer textarea::placeholder { color: var(--faint); }.composer-foot { display: flex; align-items: center; justify-content: flex-end; gap: 7px; min-height: 40px; padding: 6px 8px 7px 11px; border-top: 1px solid var(--line-soft); background: var(--surface-soft); }.composer-foot button { display: inline-flex; align-items: center; justify-content: center; gap: 5px; height: 29px; padding: 0 11px; border: 1px solid var(--line); border-radius: 5px; background: var(--surface); color: var(--text); font-size: 10px; font-weight: 650; }.composer-foot button:disabled { cursor: not-allowed; opacity: .55; }.composer-foot .send-button { border-color: var(--accent); background: var(--accent); color: #fff; }.composer-foot .line-break-button:hover { border-color: var(--focus); color: var(--text-strong); }.composer-foot .cancel-button:hover { border-color: var(--red); color: var(--red); }
.selected-skill-chips { display: flex; flex-wrap: wrap; gap: 4px; padding: 6px 8px 0; }.selected-skill-chip { display: inline-flex; align-items: center; gap: 4px; padding: 3px 5px 3px 7px; border-radius: 999px; background: var(--accent-soft); color: var(--accent); font-size: 9px; }.selected-skill-chip button { display: inline-flex; align-items: center; justify-content: center; width: 15px; height: 15px; padding: 0; border: 0; border-radius: 50%; background: transparent; color: inherit; }.selected-skill-chip button:hover { background: color-mix(in srgb, var(--accent) 18%, transparent); }.skill-picker { position: absolute; right: 8px; bottom: calc(100% + 7px); left: 8px; z-index: 3; display: grid; gap: 3px; max-height: 190px; overflow-y: auto; padding: 5px; border: 1px solid var(--line); border-radius: 7px; background: var(--surface); box-shadow: 0 8px 22px rgb(0 0 0 / 16%); }.skill-picker-option { display: grid; gap: 2px; min-width: 0; padding: 6px 8px; border: 0; border-radius: 5px; background: transparent; color: var(--text); text-align: left; }.skill-picker-option:hover,.skill-picker-option:focus-visible,.skill-picker-option.active { background: var(--accent-soft); outline: none; }.skill-picker-option strong { color: var(--accent); font: 10px ui-monospace, SFMono-Regular, Consolas, monospace; }.skill-picker-option span { overflow: hidden; color: var(--muted); font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }.skill-picker-empty { padding: 9px; color: var(--muted); font-size: 9px; }
@keyframes chat-progress-dot { 0%, 60%, 100% { opacity: .25; transform: translateY(0); } 30% { opacity: 1; transform: translateY(-3px); } }
@media (prefers-reduced-motion: reduce) { .progress-dots i { animation-duration: .01ms; animation-iteration-count: 1; } }
@media (max-width: 1180px) { .collapse-button span { display: none; }.collapse-button { width: 30px; padding: 0; }.ai-head-copy span { display: none; } }

/* Prototype-aligned AI transcript surfaces.  Keep the visual treatment while
   staying compact enough for the transcript to remain useful beside a shell. */
.ai-head { gap: 6px 8px; padding: 8px 10px 8px; }
.ai-avatar { width: 29px; height: 29px; border-radius: 7px; }
.ai-head-copy h3 { font-size: 13px; }
.session-action,.session-switch { height: 27px; padding: 0 7px; }
.session-switch select { height: 25px; }
.collapse-button { height: 27px; padding: 0 7px; font-size: 9px; }
.ai-safety-badge { min-height: 21px; padding: 0 7px; font-size: 8.5px; }
.context-meter { padding: 7px 8px 6px; }
.context-meter-head { grid-template-columns: auto minmax(0, 1fr) auto 23px; gap: 5px; }
.context-toggle { width: 23px; height: 23px; }
.context-progress { margin-top: 6px; }
.context-settings { gap: 6px; margin-top: 6px; }
.context-settings .secondary-action { min-height: 25px; }
.context-host-setting { margin-top: 0; padding-top: 6px; }
.context-host-options { gap: 4px; margin-top: 5px; }
.context-host-option { padding: 3px 5px; }
.global-chat-panel.context-details-expanded { grid-template-rows: minmax(126px, auto) minmax(0, 1fr) auto; }
.messages { padding: 9px 10px 12px; background: color-mix(in srgb, var(--surface) 94%, var(--panel)); }
.message + .message { margin-top: 5px; }
.message { grid-template-columns: 28px minmax(0, 1fr); gap: 6px; padding: 0; }
.message.user { grid-template-columns: minmax(0, 1fr) 28px; padding-left: clamp(12px, 5%, 32px); }
.message-avatar { width: 28px; height: 28px; border-radius: 7px; border-color: var(--line); background: var(--surface); color: var(--accent); }
.message.user .message-avatar { border-color: color-mix(in srgb, var(--accent) 62%, var(--line)); background: var(--accent); color: #fff; }
.message-content.message-bubble { box-sizing: border-box; width: fit-content; max-width: 88%; padding: 7px 9px; border-radius: 7px; background: var(--surface); }
.message.assistant .message-content.message-bubble { width: min(100%, 540px); max-width: none; border-left: 3px solid var(--accent); }
.message.user .message-content.message-bubble { justify-self: end; max-width: min(78%, 360px); border-color: color-mix(in srgb, var(--accent) 48%, var(--line)); background: var(--accent-soft); box-shadow: 0 1px 1px color-mix(in srgb, var(--accent) 14%, transparent); }
.message-meta { margin-bottom: 4px; }
.message-meta strong { font-size: 10px; }
.message.assistant .message-meta strong { color: var(--accent); }
.message.user .message-meta strong { color: var(--accent); }
.message p { font-size: 10px; line-height: 1.5; }
.message.audit { grid-template-columns: minmax(0, 1fr); padding-left: clamp(12px, 5%, 32px); }
.message.audit .message-avatar { display: none; }
.message.audit .message-content.message-bubble { justify-self: start; width: min(100%, 540px); max-width: none; border: 1px solid color-mix(in srgb, var(--green) 48%, var(--line)); border-left: 3px solid var(--green); background: var(--green-soft); }
.execution-plan { margin-top: 7px; padding: 0; gap: 0; overflow: hidden; border: 1px solid var(--amber-line); border-left: 3px solid var(--amber); border-radius: 7px; background: var(--surface); }
.plan-head.plan-heading { display: flex; justify-content: space-between; gap: 8px; padding: 8px 9px; border-bottom: 1px solid color-mix(in srgb, var(--amber-line) 65%, var(--line)); background: color-mix(in srgb, var(--amber-soft) 78%, var(--surface)); }
.plan-head.plan-heading strong { font-size: 11px; }
.plan-head.plan-heading span:not(.plan-badge) { display: block; margin-top: 2px; font-size: 9px; }
.plan-badge.status-chip { min-height: 22px; padding: 0 6px; border: 0; border-radius: 4px; background: var(--amber-soft); color: var(--amber) !important; font-size: 9px; }
.plan-badge.status-chip.executed { background: var(--green-soft); color: var(--green) !important; }
.plan-badge.status-chip.partially_executed { background: var(--amber-soft); color: var(--amber) !important; }
.plan-badge.status-chip.executing { background: var(--accent-soft); color: var(--accent) !important; }
.plan-badge.status-chip.execution_failed { background: color-mix(in srgb, var(--red) 15%, var(--surface)); color: var(--red) !important; }
.plan-badge.status-chip.cancelled { background: var(--surface-soft); color: var(--muted) !important; }
.execution-plan[data-status="executed"] { border-color: color-mix(in srgb, var(--green) 48%, var(--line)); border-left-color: var(--green); }
.execution-plan[data-status="executed"] .plan-heading { border-bottom-color: color-mix(in srgb, var(--green) 28%, var(--line)); background: color-mix(in srgb, var(--green-soft) 74%, var(--surface)); }
.execution-plan[data-status="partially_executed"] { border-color: color-mix(in srgb, var(--amber) 58%, var(--line)); border-left-color: var(--amber); }
.execution-plan[data-status="partially_executed"] .plan-heading { border-bottom-color: color-mix(in srgb, var(--amber) 32%, var(--line)); background: color-mix(in srgb, var(--amber-soft) 84%, var(--surface)); }
.execution-plan[data-status="executing"] { border-color: color-mix(in srgb, var(--accent) 52%, var(--line)); border-left-color: var(--accent); }
.execution-plan[data-status="executing"] .plan-heading { border-bottom-color: color-mix(in srgb, var(--accent) 28%, var(--line)); background: color-mix(in srgb, var(--accent-soft) 78%, var(--surface)); }
.execution-plan[data-status="execution_failed"] { border-color: color-mix(in srgb, var(--red) 48%, var(--line)); border-left-color: var(--red); }
.execution-plan[data-status="execution_failed"] .plan-heading { border-bottom-color: color-mix(in srgb, var(--red) 28%, var(--line)); background: color-mix(in srgb, var(--red) 10%, var(--surface)); }
.execution-plan[data-status="cancelled"] { border-color: color-mix(in srgb, var(--muted) 52%, var(--line)); border-left-color: var(--muted); }
.execution-plan[data-status="cancelled"] .plan-heading { border-bottom-color: color-mix(in srgb, var(--muted) 26%, var(--line)); background: color-mix(in srgb, var(--surface-soft) 78%, var(--surface)); }
.plan-step { padding: 8px 9px; border-bottom: 1px solid var(--line); }
.plan-step-head strong { font-size: 10px; }
.plan-step p { margin: 5px 0 6px; font-size: 9px; line-height: 1.45; }
.plan-risk { margin-bottom: 6px; padding: 6px 7px; border-radius: 4px; background: var(--amber-soft); font-size: 9px; }
.plan-command span { font-size: 9px; font-weight: 700; }
.plan-command code { padding: 6px 7px; border-color: var(--line); border-radius: 5px; background: var(--terminal); color: var(--terminal-text); font-size: 9px; line-height: 1.4; }
.plan-command-editor { grid-template-columns: minmax(0, 1fr) 28px; gap: 6px; margin-top: 6px; padding: 6px; border-color: color-mix(in srgb, var(--accent) 48%, var(--line)); border-radius: 5px; background: color-mix(in srgb, var(--accent-soft) 72%, var(--surface)); }
.plan-command-editor .plan-edit-input { min-height: 40px; padding: 6px 7px; border-color: color-mix(in srgb, var(--accent) 56%, var(--line)); border-radius: 4px; background: var(--surface); color: var(--text-strong); font-size: 9px; }
.delete-plan-step { width: 28px; height: 28px; border-radius: 4px; background: var(--amber-soft); }
.plan-actions { justify-content: space-between; padding: 8px 9px; border-top: 1px solid color-mix(in srgb, var(--amber-line) 65%, var(--line)); background: color-mix(in srgb, var(--amber-soft) 78%, var(--surface)); }
.plan-actions::before { color: var(--amber); font-size: 9px; font-weight: 700; content: '确认后将按顺序发送命令'; }
.progress-message { grid-template-columns: minmax(0, 1fr); padding-left: clamp(12px, 5%, 32px); }
.progress-message .message-avatar { display: none; }
.progress-message .message-content.message-bubble { width: min(100%, 540px); max-width: none; padding: 0; border: 1px solid color-mix(in srgb, var(--accent) 42%, var(--line)); border-left: 3px solid var(--accent); background: var(--accent-soft); }
.progress-content .message-meta { display: none; }
.progress-item { min-height: 52px; padding: 8px 9px; border: 0; background: transparent; font-size: 10px; }
.thinking-animation { position: relative; display: grid; width: 34px; height: 34px; flex: 0 0 auto; place-items: center; border: 1px solid color-mix(in srgb, var(--accent) 64%, var(--line)); border-radius: 50%; color: var(--accent); }
.thinking-animation::before { position: absolute; inset: 4px; border: 1.5px solid transparent; border-top-color: var(--accent); border-right-color: var(--accent); border-radius: 50%; content: ''; animation: chat-thinking-orbit 1.35s linear infinite; }
.thinking-bars { display: flex; align-items: center; gap: 2px; height: 14px; }
.thinking-bars i { display: block; width: 2px; height: 6px; border-radius: 2px; background: var(--accent); animation: chat-thinking-bar 1s ease-in-out infinite; }
.thinking-bars i:nth-child(2) { animation-delay: .12s; }.thinking-bars i:nth-child(3) { animation-delay: .24s; }.thinking-bars i:nth-child(4) { animation-delay: .36s; }
.thinking-copy { display: inline-flex; align-items: center; justify-content: space-between; gap: 7px; min-width: 0; flex: 1; color: var(--text); }
.thinking-copy strong { color: var(--accent); font-size: 11px; font-weight: 760; }.thinking-copy em { color: var(--muted); font-size: 9px; font-style: normal; font-weight: 700; white-space: nowrap; }
/* Context details intentionally keep their own legible 8.5–10px scale. */
.context-meter-details .context-meter-foot { font-size: 8.5px; }
.context-meter-details .ssh-context-setting { font-size: 9px; }
.context-meter-details .context-host-setting-head,.context-meter-details .context-host-option,.context-meter-details .context-host-empty,.context-meter-details .context-error { font-size: 9px; }
@keyframes chat-thinking-orbit { to { transform: rotate(360deg); } }
@keyframes chat-thinking-bar { 0%, 100% { height: 7px; opacity: .45; } 50% { height: 17px; opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .thinking-animation::before,.thinking-bars i { animation-duration: .01ms; animation-iteration-count: 1; } }
@container (max-width: 520px) { .message.user .message-content.message-bubble { max-width: 82%; }.message.assistant .message-content.message-bubble,.progress-message .message-content.message-bubble { width: 100%; }.plan-actions { align-items: flex-start; flex-wrap: wrap; }.plan-actions::before { flex: 1 1 100%; order: 2; } }
</style>
