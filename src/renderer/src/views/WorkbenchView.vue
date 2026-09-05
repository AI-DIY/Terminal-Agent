<script setup lang="ts">
import { Bug, Code2, Settings } from '@lucide/vue'
import { Sparkles } from '@lucide/vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { BastionCatalogSnapshot, BastionHostSummary, BastionLaunchRequest, ChatConversationSessionSummary, ChatWorkspace, SavedDirectSessionInput, ShellHistorySummary, TerminalDataEvent } from '../../../shared/contracts'
import type { ConnectionDialogRequest } from '../components/ConnectionDialog.vue'
import SavedSessionsDialog from '../components/SavedSessionsDialog.vue'
import type { DirectSessionSummary } from '../../../main/ssh/direct-session-repository'
import GlobalChatPanel from '../components/chat/GlobalChatPanel.vue'
import SshConnectionLauncher from '../components/connections/SshConnectionLauncher.vue'
import type { PrivateKeySelection } from '../components/connections/DirectSshForm.vue'
import { activeCmdbHostIds, shouldApplyBastionHostResponse } from '../components/connections/bastion-cmdb-state'
import WorkbenchShell from '../components/workbench/WorkbenchShell.vue'
import WorkbenchSessionSidebar from '../components/workbench/WorkbenchSessionSidebar.vue'
import ShellCanvas from '../components/workbench/ShellCanvas.vue'
import ShellHistoryDialog from '../components/workbench/ShellHistoryDialog.vue'
import HostMemoryConsentDialog from '../components/workbench/HostMemoryConsentDialog.vue'
import UpgradeDialog from '../components/UpgradeDialog.vue'
import { closeSession } from '../stores/close-session'
import { createFrameBatcher } from '../stores/data-batcher'
import { createSessionsStore, uniqueSessionHostCount, type SessionView } from '../stores/sessions'
import { getLayoutPreferencesStore } from '../stores/layout-preferences'
import { createShellHistoryStore } from '../stores/shell-history'
import { createHostMemoryDisclosureQueue } from '../stores/host-memory-disclosure-queue'
import { createChatWorkspacesStore, createWorkbenchOperationGate, createWorkbenchOpenedSessionHandler, createWorkbenchSessionOwnershipTracker, ensureWorkbenchShellView, focusOwnedWorkbenchSession, initializeWorkbenchTask, isInteractiveWorkbenchWorkspace, restoreWorkbenchSessionOwnership, runWorkbenchSessionOpen, runWorkbenchSessionReconnect, workbenchReconnectAttachmentTarget, workbenchSessionAttachmentTarget } from '../stores/chat-workspaces'
import { getUserPreferencesStore } from '../stores/user-preferences'
import { getSsoStore } from '../stores/sso'
import { consumeWorkbenchNavigationHandoff } from '../stores/workbench-navigation-handoff'

const emit = defineEmits<{ showSettings: [selectedChatId: string | null]; showSkills: [selectedChatId: string | null] }>()
const store = createSessionsStore()
const sessions = ref<SessionView[]>([])
const activeSessionId = ref<string | null>(null)
const visibleSessionIds = ref<string[]>([])
const showConnection = ref(false)
const showSavedSessions = ref(false)
const editingProfile = ref<DirectSessionSummary | null>(null)
const connectionError = ref('')
const diagnosticError = ref('')
const appVersion = ref('')
const showUpgrade = ref(false)
const bastionCatalog = ref<BastionCatalogSnapshot | null>(null)
const bastionHosts = ref<BastionHostSummary[]>([])
const selectedBastionSystemId = ref('')
const bastionLoading = ref(false)
const bastionError = ref('')
const openedCmdbHostIds = ref<Set<string>>(new Set())
const cmdbSessionHostIds = new Map<string, string>()
const savedProfiles = ref<Awaited<ReturnType<typeof window.terminalAgent.sessions.listProfiles>>>([])
const chatStore = createChatWorkspacesStore(window.terminalAgent.chats)
const shellHistory = createShellHistoryStore(window.terminalAgent.shellHistory)
const layoutPreferences = getLayoutPreferencesStore()
const userPreferences = getUserPreferencesStore()
const sso = getSsoStore()
const navigationHandoff = consumeWorkbenchNavigationHandoff()
const welcomeName = computed(() => {
  const identity = sso.identity.value
  return identity ? identity.name + '（' + identity.employeeId + '）' : userPreferences.state.displayName || '朋友'
})
const skillsAvailable = computed(() => sso.skillsAvailable.value)
const workbenchReady = ref(false)
const conversationSessionBusy = ref(false)
const conversationSessions = ref<ChatConversationSessionSummary[]>([])

function openSkills(): void {
  if (skillsAvailable.value) emit('showSkills', chatStore.state.selectedId)
}
// Internal AI conversations retain the task id (and therefore SSH ownership).
// Use the mutation result to update the task-keyed panel directly rather than
// waiting for an independently delivered task-change event.
const globalChatPanel = ref<{
  hydrateConversation(messages: ChatWorkspace['messages']): void
} | null>(null)
type ShellViewSnapshot = { visibleSessionIds: string[]; activeSessionId: string | null }
const shellViews = new Map<string, ShellViewSnapshot>()
const bindingSessions = new Map<string, Promise<ChatWorkspace>>()
const isLiveChat = computed(() => isInteractiveWorkbenchWorkspace(
  chatStore.state.selected,
  chatStore.state.liveChatId,
))
const activeWorkbenchChatId = computed(() => (
  workbenchSessionAttachmentTarget(chatStore.state.selectedId, chatStore.state.liveChatId)
))
// Keep the selected task's live associations available to the AI context
// picker even when the task itself is historical.  The shell canvas still
// uses `currentLiveSessions` below, so a historical task never accidentally
// mounts a terminal pane that is not part of the live workspace.
const currentChatSessionIds = computed(() => new Set(
  (chatStore.state.selected?.shells ?? [])
    .filter(shell => shell.status === 'open' && shell.sessionId)
    .map(shell => shell.sessionId!),
))
const currentChatSessions = computed(() => orderSessions(
  sessions.value.filter(session => currentChatSessionIds.value.has(session.id)),
  visibleSessionIds.value,
))
const currentLiveSessions = computed(() => isLiveChat.value ? currentChatSessions.value : [])
const currentChatUniqueHostCount = computed(() => uniqueSessionHostCount(currentLiveSessions.value))
const onlineChatIds = computed(() => new Set(
  chatStore.state.chats
    .filter(chat => chatStore.hasOnlineShells(chat.id))
    .map(chat => chat.id),
))
const HISTORY_ORDER_STORAGE_KEY = 'terminal-agent.history-shell-order'

type HistoryDisplayRecord = ShellHistorySummary & {
  /** Connection time remains available inside the detailed history dialog. */
  connectionTimeLabel: string
}

/** One compact history-strip entry per hostname.  Individual connections stay in the dialog. */
type HistoryHost = {
  id: string
  hostname: string
  recordCount: number
  representativeHistoryId: string
  reconnectable: boolean
}

function formatHistoryConnectionTime(startedAt: string): string {
  const started = new Date(startedAt)
  if (Number.isNaN(started.getTime())) return `连接于 ${startedAt}`
  return `连接于 ${new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(started)}`
}

function decorateHistoryRecords(records: readonly ShellHistorySummary[]): HistoryDisplayRecord[] {
  return records.map(record => ({
    ...record,
    connectionTimeLabel: formatHistoryConnectionTime(record.startedAt),
  }))
}

function orderHistoryRecords(records: readonly ShellHistorySummary[], chatId: string | null): HistoryDisplayRecord[] {
  const decorated = decorateHistoryRecords(records)
  if (!chatId) return decorated
  const preferred = historyOrderByChat.value[chatId] ?? []
  if (!preferred.length) return decorated
  const byId = new Map(decorated.map(record => [record.id, record]))
  const ordered = preferred.flatMap(id => {
    const record = byId.get(id)
    return record ? [record] : []
  })
  const seen = new Set(ordered.map(record => record.id))
  return [...ordered, ...decorated.filter(record => !seen.has(record.id))]
}

function historyHostId(hostname: string): string {
  return `host:${hostname}`
}

function groupHistoryRecords(records: readonly ShellHistorySummary[]): HistoryHost[] {
  const hosts = new Map<string, HistoryHost>()
  for (const record of records) {
    const existing = hosts.get(record.hostname)
    if (existing) {
      existing.recordCount += 1
      continue
    }
    // Keep one representative record for the existing reconnect action.  The
    // complete per-connection list, including timestamps, remains available
    // after opening this hostname in the existing history dialog.
    hosts.set(record.hostname, {
      id: historyHostId(record.hostname),
      hostname: record.hostname,
      recordCount: 1,
      representativeHistoryId: record.id,
      reconnectable: record.reconnectable,
    })
  }
  return [...hosts.values()]
}

function orderHistoryHosts(
  hosts: readonly HistoryHost[],
  records: readonly ShellHistorySummary[],
  chatId: string | null,
): HistoryHost[] {
  if (!chatId) return [...hosts]
  const preferred = historyOrderByChat.value[chatId] ?? []
  if (!preferred.length) return [...hosts]
  const byId = new Map(hosts.map(host => [host.id, host]))
  // Earlier versions stored individual history-record ids.  Translate them
  // to their hostname group on read so a release upgrade does not discard a
  // user's manually arranged history strip.
  const hostIdByLegacyRecordId = new Map(records.map(record => [record.id, historyHostId(record.hostname)]))
  const ordered: HistoryHost[] = []
  const seen = new Set<string>()
  for (const preferredId of preferred) {
    const hostId = byId.has(preferredId) ? preferredId : hostIdByLegacyRecordId.get(preferredId)
    const host = hostId ? byId.get(hostId) : undefined
    if (host && !seen.has(host.id)) {
      ordered.push(host)
      seen.add(host.id)
    }
  }
  return [...ordered, ...hosts.filter(host => !seen.has(host.id))]
}

// Keep historical host-tab order per task in renderer state.  The audit
// records stay immutable, so a presentation-only drag does not require a
// persistence write.
const historyOrderByChat = ref<Record<string, string[]>>(loadHistoryOrder())
const historyHosts = computed(() => {
  return orderHistoryHosts(groupHistoryRecords(shellHistory.state.records), shellHistory.state.records, chatStore.state.selectedId)
})
const historyDialogRecords = computed(() => orderHistoryRecords(shellHistory.state.records, chatStore.state.selectedId))
const showHistoryDialog = ref(false)
const hostMemoryDisclosureQueue = createHostMemoryDisclosureQueue()
const pendingHostMemoryDisclosure = hostMemoryDisclosureQueue.current
const hostMemorySubmitting = ref(false)
const historyDialogHost = ref<string | null>(null)
const historyDialogHistoryId = ref<string | null>(null)
let historyDialogFocusOrigin: HTMLElement | null = null
// A list request cannot be cancelled across IPC.  This token makes a slow
// response harmless if the user dismisses the dialog or opens another host
// before the first list has arrived.
let historyDialogRequestGeneration = 0
let conversationSessionListGeneration = 0
let unsubscribe: (() => void) | undefined
let unsubscribeClosed: (() => void) | undefined
let unsubscribeOpened: (() => void) | undefined
let unsubscribeUpdated: (() => void) | undefined
let unsubscribeAccessClientError: (() => void) | undefined
let unsubscribeShellHistory: (() => void) | undefined
let unsubscribeHostMemoryDisclosure: (() => void) | undefined
let unsubscribeHostMemoryInvalidation: (() => void) | undefined
let unsubscribeDiagnosticsError: (() => void) | undefined
let stopShellHistoryEligibilityRefresh: (() => void) | undefined
let bastionHostRequestId = 0
const workbenchOperations = createWorkbenchOperationGate()
let connectionFocusOrigin: HTMLElement | null = null
const sessionOwnership = createWorkbenchSessionOwnershipTracker<{ id: string }>()
let handleOpenedSession: (session: { id: string; chatId?: string }) => Promise<boolean>
const connectionModal = ref<HTMLElement | null>(null)
const shellCanvas = ref<{ openHistoryMenu(historyId: string): void } | null>(null)

function reorderHistory(historyHostIds: string[]): void {
  const chatId = chatStore.state.selectedId
  if (!chatId) return
  const available = new Set(historyHosts.value.map(record => record.id))
  const normalized = [...new Set(historyHostIds)].filter(id => available.has(id))
  for (const id of available) if (!normalized.includes(id)) normalized.push(id)
  historyOrderByChat.value = { ...historyOrderByChat.value, [chatId]: normalized }
  saveHistoryOrder(historyOrderByChat.value)
}

function loadHistoryOrder(): Record<string, string[]> {
  try {
    const raw = globalThis.localStorage?.getItem(HISTORY_ORDER_STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const result: Record<string, string[]> = {}
    for (const [chatId, value] of Object.entries(parsed)) {
      if (!Array.isArray(value)) continue
      const ids = value.filter((id): id is string => typeof id === 'string' && id.trim().length > 0).slice(0, 128)
      if (ids.length > 0) result[chatId] = [...new Set(ids)]
    }
    return result
  } catch {
    return {}
  }
}

function saveHistoryOrder(value: Record<string, string[]>): void {
  try {
    globalThis.localStorage?.setItem(HISTORY_ORDER_STORAGE_KEY, JSON.stringify(value))
  } catch {
    // Local storage is optional in a restricted/private renderer.
  }
}

async function acknowledgeHostMemory(): Promise<void> {
  const disclosure = pendingHostMemoryDisclosure.value
  if (!disclosure || hostMemorySubmitting.value) return
  hostMemorySubmitting.value = true
  try {
    await window.terminalAgent.settings.acknowledgeHostMemory(disclosure.token)
    if (pendingHostMemoryDisclosure.value?.token === disclosure.token) hostMemoryDisclosureQueue.remove(disclosure.token)
  } catch { connectionError.value = '无法确认主机记忆告知。' }
  finally { hostMemorySubmitting.value = false }
}

function dismissHostMemory(): void {
  const disclosure = pendingHostMemoryDisclosure.value
  if (!disclosure || hostMemorySubmitting.value) return
  hostMemoryDisclosureQueue.remove(disclosure.token)
  void window.terminalAgent.settings.dismissHostMemory(disclosure.token).catch(() => undefined)
}

/**
 * Keep the user's tab order as a single source of truth for both the title
 * strip and the terminal canvas.  Stale IDs are discarded and newly opened
 * sessions are appended in connection order, so restoring an older task view
 * can never hide a live connection.
 */
function orderSessions(candidates: readonly SessionView[], preferredIds: readonly string[]): SessionView[] {
  const byId = new Map(candidates.map(session => [session.id, session]))
  const ordered: SessionView[] = []
  for (const sessionId of preferredIds) {
    const session = byId.get(sessionId)
    if (session) ordered.push(session)
  }
  for (const session of candidates) {
    if (!ordered.some(item => item.id === session.id)) ordered.push(session)
  }
  return ordered
}

function normalizeSessionOrder(preferredIds: readonly string[], availableIds: readonly string[]): string[] {
  const available = new Set(availableIds)
  const ordered = [...new Set(preferredIds)].filter(sessionId => available.has(sessionId))
  for (const sessionId of availableIds) {
    if (!ordered.includes(sessionId)) ordered.push(sessionId)
  }
  return ordered
}

function sync(): void { sessions.value = store.all() }
const dataBatcher = createFrameBatcher<TerminalDataEvent>(
  events => {
    for (const event of events) store.appendData(event.sessionId, event.data)
    sync()
  },
  callback => window.requestAnimationFrame(callback),
  frameId => window.cancelAnimationFrame(frameId),
)

function select(sessionId: string): boolean {
  if (!currentChatSessionIds.value.has(sessionId) || !store.byId(sessionId)) return false
  visibleSessionIds.value = normalizeSessionOrder(
    [...visibleSessionIds.value, sessionId],
    sessions.value.filter(session => currentChatSessionIds.value.has(session.id)).map(session => session.id),
  )
  activeSessionId.value = sessionId
  saveLiveShellView()
  return true
}

function reorderSessions(sessionIds: string[]): void {
  if (!isLiveChat.value) return
  const availableIds = sessions.value
    .filter(session => currentChatSessionIds.value.has(session.id))
    .map(session => session.id)
  visibleSessionIds.value = normalizeSessionOrder(sessionIds, availableIds)
  saveLiveShellView()
}

function addSession(session: Omit<SessionView, 'buffer'>, activate = true): void {
  const isNew = !store.byId(session.id)
  store.add(session)
  if (isNew && activate) select(session.id)
  sync()
}

function removeSession(sessionId: string): void {
  cmdbSessionHostIds.delete(sessionId)
  openedCmdbHostIds.value = activeCmdbHostIds(cmdbSessionHostIds)
  const wasActive = activeSessionId.value === sessionId
  store.remove(sessionId)
  visibleSessionIds.value = visibleSessionIds.value.filter(id => id !== sessionId)
  const remainingIds = sessions.value
    .filter(session => session.id !== sessionId && currentChatSessionIds.value.has(session.id))
    .map(session => session.id)
  visibleSessionIds.value = normalizeSessionOrder(visibleSessionIds.value, remainingIds)
  if (wasActive) activeSessionId.value = visibleSessionIds.value[0] ?? null
  sync()
  saveLiveShellView()
}

function saveLiveShellView(): void {
  const chatId = isLiveChat.value ? chatStore.state.selectedId : null
  if (!chatId) return
  shellViews.set(chatId, { visibleSessionIds: [...visibleSessionIds.value], activeSessionId: activeSessionId.value })
}

function restoreLiveShellView(): void {
  const chatId = isLiveChat.value ? chatStore.state.selectedId : null
  if (!chatId) return
  const snapshot = shellViews.get(chatId)
  const availableIds = sessions.value
    .filter(session => currentChatSessionIds.value.has(session.id))
    .map(session => session.id)
  const available = new Set(availableIds)
  visibleSessionIds.value = normalizeSessionOrder(snapshot?.visibleSessionIds ?? [], availableIds)
  activeSessionId.value = snapshot?.activeSessionId && available.has(snapshot.activeSessionId)
    ? snapshot.activeSessionId
    : visibleSessionIds.value[0] ?? null
}

async function createChat(invalidateOperation = true): Promise<void> {
  if (invalidateOperation) workbenchOperations.invalidate()
  saveLiveShellView()
  if (!await chatStore.create()) return
  const chatId = chatStore.state.liveChatId
  if (chatId) shellViews.set(chatId, { visibleSessionIds: [], activeSessionId: null })
  visibleSessionIds.value = []
  activeSessionId.value = null
}

async function refreshConversationSessions(chatId = chatStore.state.selectedId): Promise<void> {
  const generation = ++conversationSessionListGeneration
  // The picker is task-scoped.  Clear the previous task's archived sessions
  // before the next list request resolves so a quick task switch cannot send
  // an archive id from task A to task B.
  conversationSessions.value = []
  if (!chatId) {
    return
  }
  try {
    const snapshot = await window.terminalAgent.chats.listConversationSessions(chatId)
    if (generation !== conversationSessionListGeneration || chatStore.state.selectedId !== chatId) return
    conversationSessions.value = snapshot.sessions
  } catch (error) {
    if (generation !== conversationSessionListGeneration || chatStore.state.selectedId !== chatId) return
    conversationSessions.value = []
    connectionError.value = error instanceof Error ? error.message : '无法读取 AI 会话。'
  }
}

/** Create a task-internal AI conversation without moving its SSH ownership. */
async function createConversationSession(): Promise<void> {
  const source = chatStore.state.selected
  // The panel has the authoritative, live transcript for its enabled state.
  // `chatStore` receives persistence events asynchronously, so checking its
  // cached messages here could turn an enabled New Session click into a
  // silent no-op.  The durable IPC operation independently rejects an empty
  // conversation.
  if (!source || conversationSessionBusy.value) return
  conversationSessionBusy.value = true
  try {
    const snapshot = await window.terminalAgent.chats.createConversationSession({
      requestId: crypto.randomUUID(),
      chatId: source.id,
    })
    if (chatStore.state.selectedId !== source.id) return
    chatStore.merge(snapshot)
    await nextTick()
    globalChatPanel.value?.hydrateConversation(snapshot.chat.messages)
    await refreshConversationSessions(source.id)
  } catch (error) {
    connectionError.value = error instanceof Error ? error.message : '无法新建会话。'
  } finally {
    conversationSessionBusy.value = false
  }
}

/** Restore an archived AI conversation while keeping the task and SSH intact. */
async function switchConversationSession(targetSessionId: string): Promise<void> {
  const source = chatStore.state.selected
  if (
    !source
    || conversationSessionBusy.value
    || !conversationSessions.value.some(session => session.id === targetSessionId)
  ) return
  conversationSessionBusy.value = true
  try {
    const snapshot = await window.terminalAgent.chats.switchConversationSession({
      requestId: crypto.randomUUID(),
      chatId: source.id,
      targetSessionId,
    })
    if (chatStore.state.selectedId !== source.id) return
    chatStore.merge(snapshot)
    await nextTick()
    globalChatPanel.value?.hydrateConversation(snapshot.chat.messages)
    await refreshConversationSessions(source.id)
  } catch (error) {
    connectionError.value = error instanceof Error ? error.message : '无法切换会话。'
  } finally {
    conversationSessionBusy.value = false
  }
}

async function renameTask(chatId: string, title: string): Promise<boolean> {
  return chatStore.updateTitle(chatId, title)
}

async function pinTask(chatId: string): Promise<boolean> {
  return chatStore.pin(chatId)
}

async function unpinTask(chatId: string): Promise<boolean> {
  return chatStore.unpin(chatId)
}

async function selectChat(chatId: string, invalidateOperation = true, isCurrent: () => boolean = () => true): Promise<void> {
  if (invalidateOperation) workbenchOperations.invalidate()
  if (!isCurrent()) return
  saveLiveShellView()
  await chatStore.select(chatId, isCurrent)
  if (!isCurrent()) return
  if (isLiveChat.value) restoreLiveShellView()
}

async function removeChat(chatId: string): Promise<void> {
  const operationGeneration = workbenchOperations.begin()
  const isCurrent = () => workbenchOperations.isCurrent(operationGeneration)
  connectionError.value = ''
  try {
    let source = chatStore.workspace(chatId)
    if (!source && chatStore.state.chats.some(chat => chat.id === chatId && chat.live)) {
      const snapshot = await window.terminalAgent.chats.get(chatId)
      if (!isCurrent()) return
      chatStore.merge(snapshot)
      source = chatStore.workspace(chatId)
    }
    const sessionIds = (source?.shells ?? [])
      .filter(shell => shell.status === 'open' && shell.sessionId)
      .map(shell => shell.sessionId!)
    if (sessionIds.length > 0) {
      const target = chatStore.state.chats.find(chat => chat.id !== chatId && chat.live)
      if (target) await selectChat(target.id, false, isCurrent)
      if (!isCurrent()) return
      if (target && chatStore.state.selectedId !== target.id) {
        throw new Error('无法为运行中的终端会话创建回退聊天。')
      }
      const snapshot = await window.terminalAgent.chats.transferSessions({
        requestId: crypto.randomUUID(),
        sourceChatId: chatId,
        ...(target ? { targetChatId: target.id } : {}),
        sessionIds,
      })
      if (!isCurrent()) return
      chatStore.merge(snapshot)
      if (!target && isCurrent()) await selectChat(snapshot.chat.id, false, isCurrent)
      if (!isCurrent()) return
      const targetWorkspace = chatStore.workspace(snapshot.chat.id)
      if (targetWorkspace && isCurrent()) restoreAssociatedShellView(targetWorkspace)
    }
    if (!isCurrent()) return
    await chatStore.remove(chatId, isCurrent)
    if (!isCurrent()) return
    restoreSelectedShellView()
  } catch (error) {
    if (!isCurrent()) return
    if (chatStore.state.chats.some(chat => chat.id === chatId)) await selectChat(chatId, false, isCurrent)
    if (!isCurrent()) return
    restoreSelectedShellView()
    connectionError.value = error instanceof Error ? error.message : '无法删除任务。'
  }
}

async function attachSession(
  session: Omit<SessionView, 'buffer'>,
  activate = true,
  isCurrent: () => boolean = () => true,
  targetChatId?: string,
): Promise<void> {
  addSession(session, false)
  let binding = bindingSessions.get(session.id)
  if (!binding) {
    binding = (async () => {
      await chatStore.waitForPendingCreate()
      const chatId = activeWorkbenchChatId.value ?? crypto.randomUUID()
      const boundChatId = targetChatId ?? chatId
      const snapshot = await window.terminalAgent.chats.bindSession({ requestId: crypto.randomUUID(), chatId: boundChatId, sessionId: session.id })
      chatStore.merge(snapshot)
      const workspace = chatStore.workspace(snapshot.chat.id)
      if (!workspace) throw new Error('无法关联终端会话。')
      restoreAssociatedShellView(workspace)
      return workspace
    })()
    bindingSessions.set(session.id, binding)
  }
  try {
    const workspace = await binding
    if ((activate || !chatStore.state.selectedId) && isCurrent()) {
      await selectChat(workspace.id, false, isCurrent)
      if (isCurrent() && store.byId(session.id)) select(session.id)
    }
    if (isCurrent() && chatStore.state.selectedId === workspace.id && store.byId(session.id)) {
      if (!visibleSessionIds.value.includes(session.id)) visibleSessionIds.value = [...visibleSessionIds.value, session.id]
      saveLiveShellView()
    }
  } finally {
    if (bindingSessions.get(session.id) === binding) bindingSessions.delete(session.id)
  }
}

async function openShellHistory(hostname?: string, historyId?: string): Promise<void> {
  const chatId = chatStore.state.selectedId
  if (!chatId) return
  const focusOrigin = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const requestGeneration = ++historyDialogRequestGeneration
  historyDialogFocusOrigin = focusOrigin
  historyDialogHost.value = hostname ?? null
  historyDialogHistoryId.value = historyId ?? null
  // Give the click immediate visual feedback.  `open` only waits for the
  // lightweight list; its selected terminal snapshot and host prefetches are
  // already asynchronous in the store.
  showHistoryDialog.value = true
  await shellHistory.open({ chatId, ...(hostname ? { hostname } : {}) })
  if (
    requestGeneration !== historyDialogRequestGeneration
    || !showHistoryDialog.value
    || chatStore.state.selectedId !== chatId
  ) return
  // A grouped history tab supplies one concrete representative connection.
  // The list may contain several records for the same hostname, so explicitly
  // select that record instead of relying on the newest-first default.
  if (historyId && shellHistory.state.records.some(record => record.id === historyId)) {
    void shellHistory.select(historyId)
  }
}

function closeShellHistory(): void {
  const closeGeneration = ++historyDialogRequestGeneration
  const chatId = chatStore.state.selectedId
  const hadHostFilter = historyDialogHost.value !== null
  const historyId = historyDialogHistoryId.value ?? shellHistory.state.selectedId
  const historyHostIdForFocus = historyDialogHost.value ? historyHostId(historyDialogHost.value) : historyId
  showHistoryDialog.value = false
  historyDialogHost.value = null
  historyDialogHistoryId.value = null
  const focusOrigin = historyDialogFocusOrigin
  historyDialogFocusOrigin = null
  const restoreFocus = () => {
    void nextTick(() => {
      if (
        showHistoryDialog.value
        || closeGeneration !== historyDialogRequestGeneration
        || chatStore.state.selectedId !== chatId
      ) return
      if (focusOrigin?.isConnected) {
        focusOrigin.focus()
        return
      }
      // Closing a hostname-filtered dialog refreshes the history strip.  That
      // replaces the opening button, so locate its durable host entry instead
      // of leaving keyboard focus on the document body.
      if (!historyHostIdForFocus) return
      const replacement = [...document.querySelectorAll<HTMLButtonElement>('.history-shell-tab')]
        .find(button => button.dataset.historyId === historyHostIdForFocus)
      replacement?.focus()
    })
  }
  if (hadHostFilter) void refreshHistoryPlayback().finally(restoreFocus)
  else restoreFocus()
}

async function reconnectShell(historyId: string): Promise<void> {
  const targetChatId = chatStore.state.selectedId
  if (!targetChatId) return
  const isTargetCurrent = () => chatStore.state.selectedId === targetChatId
  connectionError.value = ''
  try {
    await runWorkbenchSessionReconnect({
      targetChatId,
      reconnect: () => shellHistory.reconnect(historyId),
      attach: (session, chatId, isCurrent) => attachSession(session, true, isCurrent, workbenchReconnectAttachmentTarget(session.chatId, chatId)),
      isCurrent: isTargetCurrent,
    })
    if (isTargetCurrent()) closeShellHistory()
  } catch (error) {
    if (!isTargetCurrent()) return
    connectionError.value = error instanceof Error ? error.message : '无法重新连接 SSH。'
    void shellHistory.refresh()
  }
}

async function refreshHistoryPlayback(): Promise<void> {
  const chatId = chatStore.state.selectedId
  if (!chatId) {
    shellHistory.clear()
    return
  }
  await shellHistory.open({ chatId })
}

async function openHistoricalShellMenu(historyHostId: string): Promise<void> {
  const chatId = chatStore.state.selectedId
  if (!chatId) return
  await shellHistory.open({ chatId })
  if (chatStore.state.selectedId !== chatId) return
  shellCanvas.value?.openHistoryMenu(historyHostId)
}

async function close(sessionId: string): Promise<void> {
  connectionError.value = ''
  await closeSession(
    sessionId,
    id => window.terminalAgent.sessions.close(id),
    removeSession,
    message => { connectionError.value = message },
  )
}

async function refreshSavedProfiles(): Promise<void> {
  savedProfiles.value = await window.terminalAgent.sessions.listProfiles()
}

async function refreshBastionCatalog(): Promise<void> {
  bastionError.value = ''
  try {
    bastionCatalog.value = await window.terminalAgent.accessClient.catalog()
  } catch (error) {
    bastionCatalog.value = { available: false, systems: [], message: '未配置堡垒机目录来源。' }
    bastionError.value = error instanceof Error ? error.message : '无法读取堡垒机目录。'
  }
}

async function loadBastionHosts(systemId: string): Promise<void> {
  const requestId = ++bastionHostRequestId
  selectedBastionSystemId.value = systemId
  bastionHosts.value = []
  bastionError.value = ''
  if (!systemId || !bastionCatalog.value?.available) return
  try {
    const hosts = await window.terminalAgent.accessClient.hosts(systemId)
    if (!shouldApplyBastionHostResponse({
      requestId,
      latestRequestId: bastionHostRequestId,
      requestedSystemId: systemId,
      selectedSystemId: selectedBastionSystemId.value,
    })) return
    bastionHosts.value = hosts
  } catch (error) {
    if (requestId !== bastionHostRequestId || systemId !== selectedBastionSystemId.value) return
    bastionError.value = error instanceof Error ? error.message : '无法读取堡垒机主机目录。'
  }
}

async function launchBastion(request: BastionLaunchRequest): Promise<void> {
  const operationGeneration = workbenchOperations.begin()
  const targetChatId = activeWorkbenchChatId.value
  const ownershipOperation = sessionOwnership.begin(targetChatId ?? '')
  connectionError.value = ''
  bastionError.value = ''
  bastionLoading.value = true
  try {
    const result = await window.terminalAgent.accessClient.launch(request)
    if (!workbenchOperations.isCurrent(operationGeneration)) return
    if (request.kind === 'cmdb') {
      cmdbSessionHostIds.set(result.sessionId, request.hostId)
      openedCmdbHostIds.value = activeCmdbHostIds(cmdbSessionHostIds)
    }
    if (result.kind === 'opened') {
      const session = (await window.terminalAgent.sessions.list()).find(item => item.id === result.sessionId)
      if (!workbenchOperations.isCurrent(operationGeneration)) return
      if (!session) throw new Error('无法读取新建终端会话。')
      sessionOwnership.resolve(ownershipOperation, session)
      await attachSession(session, true, () => workbenchOperations.isCurrent(operationGeneration), (session as SessionView & { chatId?: string }).chatId ?? targetChatId ?? undefined)
    } else {
      const focused = await focusOwnedWorkbenchSession({
        sessionId: result.sessionId,
        resolve: (sessionId, isCurrent) => chatStore.resolveSession(sessionId, isCurrent),
        selectChat: (workspace, isCurrent) => selectChat(workspace.id, false, isCurrent),
        selectSession: select,
        isCurrent: () => workbenchOperations.isCurrent(operationGeneration),
      })
      if (!focused) {
        if (!workbenchOperations.isCurrent(operationGeneration)) return
        throw new Error('无法确定已有终端会话的聊天归属。')
      }
    }
    if (!workbenchOperations.isCurrent(operationGeneration)) return
    closeConnectionDialog()
  } catch (error) {
    if (!workbenchOperations.isCurrent(operationGeneration)) return
    const message = error instanceof Error ? error.message : '无法唤起堡垒机终端。'
    bastionError.value = message
    connectionError.value = message
  } finally {
    sessionOwnership.complete(ownershipOperation)
    if (workbenchOperations.isCurrent(operationGeneration)) bastionLoading.value = false
  }
}

function selectPrivateKey(accept: (selection: PrivateKeySelection | null) => void): void {
  void window.terminalAgent.sessions.selectPrivateKey()
    .then(accept)
    .catch(error => {
      connectionError.value = error instanceof Error ? error.message : '无法选择私钥文件。'
      accept(null)
    })
}

async function connect(request: ConnectionDialogRequest): Promise<void> {
  bastionLoading.value = false
  connectionError.value = ''
  const targetChatId = activeWorkbenchChatId.value
  const ownershipOperation = sessionOwnership.begin(targetChatId ?? '')
  await runWorkbenchSessionOpen({
    gate: workbenchOperations,
    targetChatId,
    open: async () => {
      if (request.profile) {
        await window.terminalAgent.sessions.saveProfile(request.profile)
        await refreshSavedProfiles()
      }
      return window.terminalAgent.sessions.connect(request.connection)
    },
    attach: (session, current, capturedTargetChatId) => { sessionOwnership.resolve(ownershipOperation, session); return attachSession(session, true, current, (session as SessionView & { chatId?: string }).chatId ?? capturedTargetChatId ?? undefined) },
    complete: () => { sessionOwnership.complete(ownershipOperation); closeConnectionDialog() },
    fail: error => { connectionError.value = error instanceof Error ? error.message : '无法建立 SSH 会话。' },
  })
}

function createConnection(): void {
  workbenchOperations.invalidate()
  bastionLoading.value = false
  connectionFocusOrigin = document.activeElement instanceof HTMLElement ? document.activeElement : null
  editingProfile.value = null
  bastionError.value = ''
  showConnection.value = true
  if (!bastionCatalog.value) void refreshBastionCatalog()
  void nextTick(focusConnectionDialog)
}

function editSavedProfile(profile: DirectSessionSummary): void {
  connectionFocusOrigin = document.activeElement instanceof HTMLElement ? document.activeElement : null
  editingProfile.value = profile
  closeSavedSessionsDialog()
  showConnection.value = true
  void nextTick(focusConnectionDialog)
}

async function saveEditedProfile(profile: SavedDirectSessionInput): Promise<void> {
  connectionError.value = ''
  try {
    await window.terminalAgent.sessions.saveProfile(profile)
    await refreshSavedProfiles()
    closeConnectionDialog()
  } catch (error) {
    connectionError.value = error instanceof Error ? error.message : '无法更新已保存的 SSH 会话。'
  }
}

function closeConnectionDialog(): void {
  workbenchOperations.invalidate()
  bastionLoading.value = false
  showConnection.value = false
  editingProfile.value = null
  bastionError.value = ''
  const focusOrigin = connectionFocusOrigin
  connectionFocusOrigin = null
  void nextTick(() => { if (focusOrigin?.isConnected) focusOrigin.focus() })
}

function closeSavedSessionsDialog(): void {
  workbenchOperations.invalidate()
  showSavedSessions.value = false
}

function openSavedSessionsDialog(): void {
  workbenchOperations.invalidate()
  showSavedSessions.value = true
}

function focusConnectionDialog(): void {
  connectionModal.value?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus()
}

function trapConnectionFocus(event: KeyboardEvent): void {
  if (event.key !== 'Tab') return
  const focusable = [...(connectionModal.value?.querySelectorAll<HTMLElement>(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  ) ?? [])].filter(element => element.offsetParent !== null)
  if (!focusable.length) return
  const first = focusable[0]
  const last = focusable.at(-1)!
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

async function openSavedProfile(id: string): Promise<void> {
  connectionError.value = ''
  const targetChatId = activeWorkbenchChatId.value
  const ownershipOperation = sessionOwnership.begin(targetChatId ?? '')
  await runWorkbenchSessionOpen({
    gate: workbenchOperations,
    targetChatId,
    open: () => window.terminalAgent.sessions.openProfile(id),
    attach: (session, current, capturedTargetChatId) => { sessionOwnership.resolve(ownershipOperation, session); return attachSession(session, true, current, (session as SessionView & { chatId?: string }).chatId ?? capturedTargetChatId ?? undefined) },
    complete: closeSavedSessionsDialog,
    fail: error => { sessionOwnership.complete(ownershipOperation); connectionError.value = error instanceof Error ? error.message : '无法打开已保存的 SSH 会话。' },
  })
}

async function deleteSavedProfile(id: string): Promise<void> {
  connectionError.value = ''
  try {
    await window.terminalAgent.sessions.deleteProfile(id)
    await refreshSavedProfiles()
  } catch (error) {
    connectionError.value = error instanceof Error ? error.message : '无法删除已保存的 SSH 会话。'
  }
}

function onWindowKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  if (showConnection.value) closeConnectionDialog()
  else if (showSavedSessions.value) closeSavedSessionsDialog()
  else if (showHistoryDialog.value) closeShellHistory()
  else if (showUpgrade.value) showUpgrade.value = false
}

async function openUpgrade(): Promise<void> {
  showUpgrade.value = true
  try {
    const updater = window.terminalAgent?.updater
    if (!updater) return
    const updaterState = await updater.getState()
    appVersion.value = updaterState.currentVersion
  } catch { /* The dialog reports updater errors when the check starts. */ }
}

async function openRendererDevTools(): Promise<void> {
  diagnosticError.value = ''
  try {
    await window.terminalAgent.diagnostics.openRendererDevTools()
  } catch (error) {
    diagnosticError.value = error instanceof Error ? error.message : '无法打开 DevTools。'
  }
}

async function openNodeInspector(): Promise<void> {
  diagnosticError.value = ''
  try {
    await window.terminalAgent.diagnostics.openNodeInspector()
  } catch (error) {
    diagnosticError.value = error instanceof Error ? error.message : '无法打开 Node Inspector。'
  }
}

async function initializeWorkbench(): Promise<void> {
  try {
    const failures = await initializeWorkbenchTask({
      load: async () => {
        await chatStore.load()
        const selectedChatId = navigationHandoff?.selectedChatId
        if (selectedChatId && chatStore.state.chats.some(chat => chat.id === selectedChatId)) {
          await selectChat(selectedChatId, false)
        }
      },
      shouldCreate: () => {
        const selectedChatId = navigationHandoff?.selectedChatId
        return !selectedChatId || !chatStore.state.chats.some(chat => chat.id === selectedChatId)
      },
      restore: async () => {
        const selected = chatStore.state.selected
        if (selected) restoreAssociatedShellView(selected)
        const existingSessions = await window.terminalAgent.sessions.list()
        return restoreWorkbenchSessionOwnership({
          sessions: existingSessions,
          add: session => addSession(session, false),
          resolve: session => chatStore.resolveSession(session.id),
          restore: restoreAssociatedShellView,
          bind: (session, activate) => attachSession(session, activate),
        })
      },
      create: () => createChat(false),
    })
    restoreSelectedShellView()
    await refreshHistoryPlayback()
    if (failures.length > 0) connectionError.value = `有 ${failures.length} 个终端会话无法恢复聊天归属。`
  } finally {
    workbenchReady.value = true
  }
}

function restoreAssociatedShellView(workspace: ChatWorkspace): void {
  ensureWorkbenchShellView(shellViews, workspace)
  if (workspace.id === chatStore.state.selectedId) restoreLiveShellView()
}

function restoreSelectedShellView(): void {
  const selected = chatStore.state.selected
  if (selected) restoreAssociatedShellView(selected)
  else if (isLiveChat.value) {
    visibleSessionIds.value = []
    activeSessionId.value = null
  }
}

watch(
  [() => chatStore.state.selectedId, () => isLiveChat.value],
  () => {
    restoreSelectedShellView()
    void refreshHistoryPlayback()
    void refreshConversationSessions()
  },
)
watch(
  () => currentChatSessionIds.value,
  () => {
    if (!isLiveChat.value) return
    const availableSessionIds = sessions.value
      .filter(session => currentChatSessionIds.value.has(session.id))
      .map(session => session.id)
    if (!activeSessionId.value || !availableSessionIds.includes(activeSessionId.value)) {
      activeSessionId.value = availableSessionIds[0] ?? null
    }
    visibleSessionIds.value = normalizeSessionOrder(visibleSessionIds.value, availableSessionIds)
    saveLiveShellView()
  },
  { deep: true },
)

onMounted(() => {
  handleOpenedSession = createWorkbenchOpenedSessionHandler({ tracker: sessionOwnership, currentChatId: () => isLiveChat.value ? chatStore.state.selectedId : null, attach: (session, target) => attachSession(session as Omit<SessionView, 'buffer'>, true, () => true, target ?? undefined) })
  stopShellHistoryEligibilityRefresh = shellHistory.startEligibilityRefresh({
    setInterval: (callback, delay) => window.setInterval(callback, delay),
    clearInterval: handle => window.clearInterval(handle),
  })
  unsubscribe = window.terminalAgent.sessions.onData(event => dataBatcher.enqueue(event))
  unsubscribeClosed = window.terminalAgent.sessions.onClosed(event => removeSession(event.sessionId))
  unsubscribeOpened = window.terminalAgent.sessions.onOpened(session => {
    const targetChatId = session.chatId
    if (targetChatId) {
      const reconnectIsCurrent = () => chatStore.state.selectedId === targetChatId
      void attachSession(session, true, reconnectIsCurrent, targetChatId).catch(error => {
        if (reconnectIsCurrent()) connectionError.value = error instanceof Error ? error.message : '无法关联终端会话。'
      })
      return
    }
    const visibleLiveChatId = isLiveChat.value ? chatStore.state.selectedId : null
    const capturedTargetChatId = visibleLiveChatId
    const shouldPromoteFallback = visibleLiveChatId === null && chatStore.state.liveChatId === null
    const isCurrent = () => capturedTargetChatId !== null
      ? chatStore.state.selectedId === capturedTargetChatId
      : chatStore.state.liveChatId === null
    void handleOpenedSession(session).catch(error => {
      if (isCurrent()) connectionError.value = error instanceof Error ? error.message : '无法关联终端会话。'
    })
  })
  unsubscribeUpdated = window.terminalAgent.sessions.onUpdated(session => addSession(session, false))
  unsubscribeAccessClientError = window.terminalAgent.accessClient.onError(message => { connectionError.value = message })
  unsubscribeDiagnosticsError = window.terminalAgent.diagnostics.onError(message => { diagnosticError.value = message })
  unsubscribeHostMemoryDisclosure = window.terminalAgent.settings.onHostMemoryDisclosure(hostMemoryDisclosureQueue.enqueue)
  unsubscribeHostMemoryInvalidation = window.terminalAgent.settings.onHostMemoryInvalidation(event => hostMemoryDisclosureQueue.remove(event.token))
  void window.terminalAgent.settings.pendingHostMemoryDisclosures().then(items => items.forEach(hostMemoryDisclosureQueue.enqueue)).catch(() => undefined)
  unsubscribeShellHistory = window.terminalAgent.shellHistory.onChanged(event => {
    if (event.kind === 'saved' && event.record.chatId === chatStore.state.selectedId) {
      void refreshHistoryPlayback()
    }
  })
  void initializeWorkbench()
    .catch(() => { connectionError.value = '无法同步已有终端会话。' })
  void window.terminalAgent.accessClient.errors()
    .then(errors => { connectionError.value = errors.at(-1) ?? connectionError.value })
    .catch(() => { connectionError.value = '无法读取 AccessClient 启动状态。' })
  void refreshSavedProfiles().catch(() => { connectionError.value = '无法读取已保存会话。' })
  const updater = window.terminalAgent?.updater
  if (updater) void updater.getState().then(state => { appVersion.value = state.currentVersion }).catch(() => undefined)
  void refreshBastionCatalog()
  window.addEventListener('keydown', onWindowKeydown)
})
onBeforeUnmount(() => {
  stopShellHistoryEligibilityRefresh?.()
  chatStore.dispose()
  unsubscribe?.()
  unsubscribeClosed?.()
  unsubscribeOpened?.()
  unsubscribeUpdated?.()
  unsubscribeAccessClientError?.()
  unsubscribeDiagnosticsError?.()
  unsubscribeShellHistory?.()
  unsubscribeHostMemoryDisclosure?.()
  unsubscribeHostMemoryInvalidation?.()
  for (const disclosure of hostMemoryDisclosureQueue.disclosures.value) void window.terminalAgent.settings.dismissHostMemory(disclosure.token).catch(() => undefined)
  dataBatcher.dispose()
  window.removeEventListener('keydown', onWindowKeydown)
})
</script>

<template>
  <WorkbenchShell
    :data-workbench-ready="workbenchReady ? 'true' : 'false'"
    :modal-open="showConnection || showSavedSessions || showHistoryDialog || showUpgrade || pendingHostMemoryDisclosure !== null"
    :current-version="appVersion"
    :current-chat-title="chatStore.state.selected?.title ?? '未选择任务'"
    :current-chat-shell-count="isLiveChat ? currentChatUniqueHostCount : 0"
    :welcome-name="welcomeName"
  >
    <template #app-actions>
      <p v-if="connectionError" class="connection-error" role="alert">{{ connectionError }}</p>
      <p v-if="diagnosticError" class="diagnostic-error" role="alert">{{ diagnosticError }}</p>
      <button type="button" class="header-button" :aria-label="skillsAvailable ? '技能' : '技能（未登录状态不能使用技能）'" :title="skillsAvailable ? '技能' : '未登录状态不能使用技能'" :disabled="!skillsAvailable" @click="openSkills"><Sparkles :size="14" aria-hidden="true" /><span>技能</span></button>
      <button type="button" class="header-button" aria-label="设置" title="设置" @click="emit('showSettings', chatStore.state.selectedId)"><Settings :size="14" aria-hidden="true" /><span>设置</span></button>
      <button type="button" class="header-button" aria-label="DevTools" title="DevTools" @click="openRendererDevTools"><Code2 :size="14" aria-hidden="true" /><span>DevTools</span></button>
      <button type="button" class="header-button" aria-label="Node Inspector" title="Node Inspector" @click="openNodeInspector"><Bug :size="14" aria-hidden="true" /><span>Node Inspector</span></button>
      <button type="button" class="header-button upgrade-button" aria-label="升级" title="检查并安装升级" @click="openUpgrade"><span>升级</span></button>
    </template>

    <template #sidebar="{ collapse }">
      <WorkbenchSessionSidebar
        :groups="chatStore.state.groups"
        :current-chat-id="chatStore.state.selectedId"
        :online-chat-ids="onlineChatIds"
        :loading="chatStore.state.loading"
        :error="chatStore.state.error"
        :rename-task="renameTask"
        :pin-task="pinTask"
        :unpin-task="unpinTask"
        @select="selectChat"
        @remove="removeChat"
        @create="createChat"
        @collapse="collapse"
      />
    </template>

    <template #shell>
      <ShellCanvas
        ref="shellCanvas"
        :sessions="sessions"
        :current-sessions="currentLiveSessions"
        :visible-session-ids="visibleSessionIds"
        :active-session-id="activeSessionId"
        :shell-count="isLiveChat ? currentChatUniqueHostCount : 0"
        :is-live="isLiveChat"
        :live-chat-available="Boolean(chatStore.state.liveChatId)"
        :history-hosts="historyHosts"
        @select="select"
        @close="close"
        @connect="createConnection"
        @restore-live="chatStore.state.liveChatId ? selectChat(chatStore.state.liveChatId) : undefined"
        @history="openShellHistory"
        @history-menu="openHistoricalShellMenu"
        @reconnect="reconnectShell"
        @reorder="reorderSessions"
        @reorder-history="reorderHistory"
      >
        <template #empty>
          <section class="empty-state">
            <SshConnectionLauncher
              appearance="embedded"
              :catalog="bastionCatalog"
              :hosts="bastionHosts"
              :open-host-ids="openedCmdbHostIds"
              :loading="bastionLoading"
              :error="bastionError"
              @direct-connect="connect"
              @save-profile="saveEditedProfile"
              @select-private-key="selectPrivateKey"
            />
          </section>
        </template>
      </ShellCanvas>
    </template>

    <template #agent="{ collapse }">
      <GlobalChatPanel
        ref="globalChatPanel"
        :chat="chatStore.state.selected"
        :context-sessions="currentChatSessions"
        :conversation-sessions="conversationSessions"
        :session-busy="conversationSessionBusy"
         :skills-available="skillsAvailable"
         @collapse="collapse"
         @new-connection="createConnection"
         @new-session="createConversationSession"
        @switch-session="switchConversationSession"
      />
    </template>

    <template #overlays>
      <div v-if="showConnection" ref="connectionModal" class="connection-modal" role="dialog" aria-modal="true" aria-label="新建 SSH 连接" @keydown.capture="trapConnectionFocus" @pointerdown.self="closeConnectionDialog">
        <SshConnectionLauncher
          appearance="dialog"
          :catalog="bastionCatalog"
          :hosts="bastionHosts"
          :open-host-ids="openedCmdbHostIds"
          :loading="bastionLoading"
          :error="bastionError"
          :editing-profile="editingProfile"
          @direct-connect="connect"
          @save-profile="saveEditedProfile"
          @select-private-key="selectPrivateKey"
          @close="closeConnectionDialog"
        />
      </div>
      <div v-if="showSavedSessions" class="connection-modal" role="dialog" aria-modal="true" aria-label="已保存会话" @pointerdown.self="closeSavedSessionsDialog">
        <SavedSessionsDialog
          :profiles="savedProfiles"
          @close="closeSavedSessionsDialog"
          @create="closeSavedSessionsDialog(); createConnection()"
          @connect="openSavedProfile"
          @edit="editSavedProfile"
          @remove="deleteSavedProfile"
        />
      </div>
      <ShellHistoryDialog
        :open="showHistoryDialog"
        :records="historyDialogRecords"
        :selected-id="shellHistory.state.selectedId"
        :selected="shellHistory.state.selected"
        :loading="shellHistory.state.loading"
        :error="shellHistory.state.error"
        :font-size="layoutPreferences.state.fontSize"
        @close="closeShellHistory"
        @select="shellHistory.select"
        @reconnect="reconnectShell"
      />
      <UpgradeDialog :open="showUpgrade" :current-version="appVersion || '—'" @close="showUpgrade = false" />
      <HostMemoryConsentDialog v-if="pendingHostMemoryDisclosure" :host-identity="pendingHostMemoryDisclosure.hostIdentity" :submitting="hostMemorySubmitting" @close="dismissHostMemory" @acknowledge="acknowledgeHostMemory" />
    </template>
  </WorkbenchShell>
</template>

<style scoped>
.header-button { display: inline-flex; align-items: center; gap: 6px; min-height: 30px; padding: 0 10px; border: 1px solid var(--line); border-radius: 5px; background: var(--surface); color: var(--text); font-size: 11px; font-weight: 600; }.header-button:hover { border-color: var(--focus); background: var(--hover); color: var(--text-strong); }
.empty-state { display: grid; min-width: 0; min-height: 0; overflow: auto; background: var(--surface); }
.agent-empty { display: grid; gap: 7px; padding: 16px; }
.read-only { background: var(--surface-soft); }
.agent-empty strong { color: var(--text-strong); font-size: 12px; }
.agent-empty p { margin: 0; color: var(--muted); font-size: 11px; line-height: 1.5; }
.connection-error { max-width: min(42vw, 480px); margin: 0; overflow: hidden; color: var(--red); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.diagnostic-error { max-width: min(30vw, 320px); min-width: 0; margin: 0; overflow: hidden; color: var(--red); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.connection-modal { position: fixed; z-index: 10; inset: 57px 9px 9px; display: grid; align-content: safe center; justify-content: center; padding: 16px; overflow: auto; border-radius: 0 0 7px 7px; background: rgb(20 24 29 / 52%); backdrop-filter: blur(1px); }
</style>
