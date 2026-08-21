<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { BastionCatalogSnapshot, BastionHostSummary, BastionLaunchRequest, ChatWorkspace, SavedDirectSessionInput, TerminalDataEvent } from '../../../shared/contracts'
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
import { closeSession } from '../stores/close-session'
import { createFrameBatcher } from '../stores/data-batcher'
import { createSessionsStore, type SessionView } from '../stores/sessions'
import { reconcileVisiblePanes, selectVisiblePane } from '../stores/visible-panes'
import { getLayoutPreferencesStore } from '../stores/layout-preferences'
import { createAutonomousUpgradeStore } from '../stores/autonomous-upgrade'
import { createShellHistoryStore, latestHistoryByHost, readOnlyHistoryTerminal } from '../stores/shell-history'
import { createHostMemoryDisclosureQueue } from '../stores/host-memory-disclosure-queue'
import { createChatWorkspacesStore, createWorkbenchOperationGate, ensureWorkbenchShellView, focusOwnedWorkbenchSession, isInteractiveWorkbenchWorkspace, restoreWorkbenchSessionOwnership, runWorkbenchSessionDuplicate, runWorkbenchSessionOpen, runWorkbenchSessionReconnect } from '../stores/chat-workspaces'

const emit = defineEmits<{ showSettings: [] }>()
const store = createSessionsStore()
const sessions = ref<SessionView[]>([])
const activeSessionId = ref<string | null>(null)
const visibleSessionIds = ref<string[]>([])
const showConnection = ref(false)
const showSavedSessions = ref(false)
const editingProfile = ref<DirectSessionSummary | null>(null)
const connectionError = ref('')
const bastionCatalog = ref<BastionCatalogSnapshot | null>(null)
const bastionHosts = ref<BastionHostSummary[]>([])
const selectedBastionSystemId = ref('')
const bastionLoading = ref(false)
const bastionError = ref('')
const openedCmdbHostIds = ref<Set<string>>(new Set())
const cmdbSessionHostIds = new Map<string, string>()
const savedProfiles = ref<Awaited<ReturnType<typeof window.terminalAgent.sessions.listProfiles>>>([])
const autonomousUpgrade = createAutonomousUpgradeStore()
const chatStore = createChatWorkspacesStore(window.terminalAgent.chats)
const shellHistory = createShellHistoryStore(window.terminalAgent.shellHistory)
const layoutPreferences = getLayoutPreferencesStore()
type ShellViewSnapshot = { visibleSessionIds: string[]; activeSessionId: string | null }
const shellViews = new Map<string, ShellViewSnapshot>()
const bindingSessions = new Map<string, Promise<ChatWorkspace>>()
const isLiveChat = computed(() => isInteractiveWorkbenchWorkspace(
  chatStore.state.selected,
  chatStore.state.liveChatId,
))
const activeWorkbenchChatId = computed(() => (
  isLiveChat.value ? chatStore.state.selectedId : chatStore.state.liveChatId
))
const currentChatSessionIds = computed(() => new Set(
  isLiveChat.value
    ? (chatStore.state.selected?.shells ?? []).filter(shell => shell.status === 'open' && shell.sessionId).map(shell => shell.sessionId!)
    : [],
))
const currentChatSessions = computed(() => sessions.value.filter(session => currentChatSessionIds.value.has(session.id)))
const activeSession = computed(() => isLiveChat.value && activeSessionId.value ? currentChatSessions.value.find(session => session.id === activeSessionId.value) ?? null : null)
const historyShells = computed(() => (chatStore.state.selected?.shells ?? []).filter(shell => shell.status === 'closed'))
const historyPlayback = computed(() => latestHistoryByHost(shellHistory.state.records).map(record => ({
  record,
  terminal: readOnlyHistoryTerminal(shellHistory.state.details[record.id] ?? null),
})))
const showHistoryDialog = ref(false)
const hostMemoryDisclosureQueue = createHostMemoryDisclosureQueue()
const pendingHostMemoryDisclosure = hostMemoryDisclosureQueue.current
const hostMemorySubmitting = ref(false)
const historyDialogHost = ref<string | null>(null)
let historyDialogFocusOrigin: HTMLElement | null = null
let unsubscribe: (() => void) | undefined
let unsubscribeClosed: (() => void) | undefined
let unsubscribeOpened: (() => void) | undefined
let unsubscribeUpdated: (() => void) | undefined
let unsubscribeAccessClientError: (() => void) | undefined
let unsubscribeShellHistory: (() => void) | undefined
let unsubscribeHostMemoryDisclosure: (() => void) | undefined
let unsubscribeHostMemoryInvalidation: (() => void) | undefined
let stopShellHistoryEligibilityRefresh: (() => void) | undefined
let bastionHostRequestId = 0
const workbenchOperations = createWorkbenchOperationGate()
let connectionFocusOrigin: HTMLElement | null = null
const connectionModal = ref<HTMLElement | null>(null)
const shellCanvas = ref<{ openHistoryMenu(historyId: string): void } | null>(null)

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
  visibleSessionIds.value = selectVisiblePane(
    visibleSessionIds.value,
    sessionId,
    activeSessionId.value,
    layoutPreferences.state.visibleCount,
  )
  activeSessionId.value = sessionId
  saveLiveShellView()
  return true
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

  const replacement = store.all().find(session => currentChatSessionIds.value.has(session.id) && !visibleSessionIds.value.includes(session.id))
  if (replacement) visibleSessionIds.value = selectVisiblePane(
    visibleSessionIds.value,
    replacement.id,
    null,
    layoutPreferences.state.visibleCount,
  )
  if (wasActive) activeSessionId.value = visibleSessionIds.value[0] ?? replacement?.id ?? null
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
  const available = new Set(currentChatSessions.value.map(session => session.id))
  activeSessionId.value = snapshot?.activeSessionId && available.has(snapshot.activeSessionId)
    ? snapshot.activeSessionId
    : snapshot?.visibleSessionIds.find(id => available.has(id)) ?? currentChatSessions.value[0]?.id ?? null
  visibleSessionIds.value = reconcileVisiblePanes(
    snapshot?.visibleSessionIds ?? [],
    currentChatSessions.value.map(session => session.id),
    activeSessionId.value,
    layoutPreferences.state.visibleCount,
  )
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
    connectionError.value = error instanceof Error ? error.message : '无法删除聊天。'
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
      if (!activate && visibleSessionIds.value.length < layoutPreferences.state.visibleCount && !visibleSessionIds.value.includes(session.id)) {
        visibleSessionIds.value = [...visibleSessionIds.value, session.id]
      }
      saveLiveShellView()
    }
  } finally {
    if (bindingSessions.get(session.id) === binding) bindingSessions.delete(session.id)
  }
}

async function openShellHistory(hostname?: string): Promise<void> {
  const chatId = chatStore.state.selectedId
  if (!chatId) return
  const focusOrigin = document.activeElement instanceof HTMLElement ? document.activeElement : null
  await shellHistory.open({ chatId, ...(hostname ? { hostname } : {}) })
  if (chatStore.state.selectedId !== chatId) return
  historyDialogFocusOrigin = focusOrigin
  historyDialogHost.value = hostname ?? null
  showHistoryDialog.value = true
}

function closeShellHistory(): void {
  const hadHostFilter = historyDialogHost.value !== null
  showHistoryDialog.value = false
  historyDialogHost.value = null
  const focusOrigin = historyDialogFocusOrigin
  historyDialogFocusOrigin = null
  void nextTick(() => { if (focusOrigin?.isConnected) focusOrigin.focus() })
  if (hadHostFilter) void refreshHistoryPlayback()
}

async function duplicateShell(sessionId: string): Promise<void> {
  connectionError.value = ''
  const targetChatId = activeWorkbenchChatId.value
  if (!targetChatId) {
    connectionError.value = '无法确定复制 Shell 的目标聊天。'
    return
  }
  const isTargetCurrent = () => chatStore.state.selectedId === targetChatId
  try {
    await runWorkbenchSessionDuplicate({
      sessionId,
      targetChatId,
      duplicate: (sourceSessionId, chatId) => shellHistory.duplicate(sourceSessionId, chatId),
      attach: (session, chatId, isCurrent) => attachSession(session, true, isCurrent, chatId),
      isCurrent: isTargetCurrent,
    })
  } catch (error) {
    if (isTargetCurrent()) connectionError.value = error instanceof Error ? error.message : '无法复制 SSH 通道。'
  }
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
      attach: (session, chatId, isCurrent) => attachSession(session, true, isCurrent, chatId),
      isCurrent: isTargetCurrent,
    })
    if (isTargetCurrent()) closeShellHistory()
  } catch (error) {
    if (!isTargetCurrent()) return
    connectionError.value = error instanceof Error ? error.message : '无法重新连接 Shell。'
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

async function openHistoricalShellMenu(historyId: string): Promise<void> {
  const chatId = chatStore.state.selectedId
  if (!chatId) return
  await shellHistory.open({ chatId })
  if (chatStore.state.selectedId !== chatId) return
  shellCanvas.value?.openHistoryMenu(historyId)
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
      await attachSession(session, true, () => workbenchOperations.isCurrent(operationGeneration))
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
  await runWorkbenchSessionOpen({
    gate: workbenchOperations,
    open: async () => {
      if (request.profile) {
        await window.terminalAgent.sessions.saveProfile(request.profile)
        await refreshSavedProfiles()
      }
      return window.terminalAgent.sessions.connect(request.connection)
    },
    attach: (session, current) => attachSession(session, true, current),
    complete: closeConnectionDialog,
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
  await runWorkbenchSessionOpen({
    gate: workbenchOperations,
    open: () => window.terminalAgent.sessions.openProfile(id),
    attach: (session, current) => attachSession(session, true, current),
    complete: closeSavedSessionsDialog,
    fail: error => { connectionError.value = error instanceof Error ? error.message : '无法打开已保存的 SSH 会话。' },
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

function requestAutonomousUpgrade(): void {
  if (!activeSession.value) return
  autonomousUpgrade.request(activeSession.value.id)
}

async function confirmAutonomousUpgrade(): Promise<void> {
  const sessionId = autonomousUpgrade.confirm()
  if (!sessionId) return
  try {
    const result = await window.terminalAgent.sessionModes.upgrade(sessionId)
    const session = sessions.value.find(item => item.id === sessionId)
    if (session) addSession({ ...session, mode: result.mode }, false)
  } catch (error) {
    connectionError.value = error instanceof Error ? error.message : '无法升级当前会话。'
  }
}

function onWindowKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  if (showConnection.value) closeConnectionDialog()
  else if (showSavedSessions.value) closeSavedSessionsDialog()
  else if (showHistoryDialog.value) closeShellHistory()
  else if (autonomousUpgrade.state.visible) autonomousUpgrade.cancel()
}

async function initializeWorkbench(): Promise<void> {
  await chatStore.load()
  const selected = chatStore.state.selected
  if (selected) restoreAssociatedShellView(selected)
  const existingSessions = await window.terminalAgent.sessions.list()
  const failures = await restoreWorkbenchSessionOwnership({
    sessions: existingSessions,
    add: session => addSession(session, false),
    resolve: session => chatStore.resolveSession(session.id),
    restore: restoreAssociatedShellView,
    bind: (session, activate) => attachSession(session, activate),
  })
  restoreSelectedShellView()
  await refreshHistoryPlayback()
  if (failures.length > 0) connectionError.value = `有 ${failures.length} 个终端会话无法恢复聊天归属。`
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
  },
)
watch(
  [
    () => layoutPreferences.state.visibleCount,
    () => currentChatSessions.value.map(session => session.id).join('\u0000'),
  ],
  () => {
    if (!isLiveChat.value) return
    const availableSessionIds = currentChatSessions.value.map(session => session.id)
    if (!activeSessionId.value || !availableSessionIds.includes(activeSessionId.value)) {
      activeSessionId.value = availableSessionIds[0] ?? null
    }
    visibleSessionIds.value = reconcileVisiblePanes(
      visibleSessionIds.value,
      availableSessionIds,
      activeSessionId.value,
      layoutPreferences.state.visibleCount,
    )
    saveLiveShellView()
  },
)

onMounted(() => {
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
    const shouldPromoteFallback = visibleLiveChatId === null && chatStore.state.liveChatId === null
    const isCurrent = () => visibleLiveChatId !== null
      ? chatStore.state.selectedId === visibleLiveChatId
      : chatStore.state.liveChatId === null
    void attachSession(session, shouldPromoteFallback, isCurrent).catch(error => {
      if (isCurrent()) connectionError.value = error instanceof Error ? error.message : '无法关联终端会话。'
    })
  })
  unsubscribeUpdated = window.terminalAgent.sessions.onUpdated(session => addSession(session, false))
  unsubscribeAccessClientError = window.terminalAgent.accessClient.onError(message => { connectionError.value = message })
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
    :modal-open="showConnection || showSavedSessions || showHistoryDialog || autonomousUpgrade.state.visible || pendingHostMemoryDisclosure !== null"
    :current-chat-title="chatStore.state.selected?.title ?? '未选择聊天'"
    :current-chat-shell-count="chatStore.state.selected?.shellCount ?? 0"
  >
    <template #app-actions>
      <p v-if="connectionError" class="connection-error" role="alert">{{ connectionError }}</p>
      <button type="button" class="header-button" @click="emit('showSettings')">设置</button>
    </template>

    <template #sidebar>
      <WorkbenchSessionSidebar
        :groups="chatStore.state.groups"
        :current-chat-id="chatStore.state.selectedId"
        :loading="chatStore.state.loading"
        :error="chatStore.state.error"
        @select="selectChat"
        @remove="removeChat"
        @create="createChat"
      />
    </template>

    <template #shell>
      <ShellCanvas
        ref="shellCanvas"
        :sessions="sessions"
        :current-sessions="currentChatSessions"
        :visible-session-ids="visibleSessionIds"
        :active-session-id="activeSessionId"
        :shell-count="chatStore.state.selected?.shellCount ?? 0"
        :is-live="isLiveChat"
        :live-chat-available="Boolean(chatStore.state.liveChatId)"
        :history-shells="historyShells"
        :history-records="shellHistory.state.records"
        @select="select"
        @close="close"
        @connect="createConnection"
        @open-saved="openSavedSessionsDialog"
        @upgrade="requestAutonomousUpgrade"
        @restore-live="chatStore.state.liveChatId ? selectChat(chatStore.state.liveChatId) : undefined"
        @duplicate="duplicateShell"
        @history="openShellHistory"
        @history-menu="openHistoricalShellMenu"
        @reconnect="reconnectShell"
      >
        <template #history>
          <section class="history-playback" aria-label="聊天 Shell 历史回放">
            <div v-if="historyPlayback.length" class="history-shell-grid">
              <article v-for="playback in historyPlayback" :key="playback.record.id" class="history-shell-card">
                <header><strong>{{ playback.record.title }}</strong><button type="button" :aria-label="`查看 Shell 历史 ${playback.record.hostname}`" @click="openShellHistory(playback.record.hostname)">历史</button></header>
                <span>{{ playback.record.hostname }}</span><b>已关闭 · 只读历史</b>
                <pre :aria-label="`只读终端历史 ${playback.record.hostname}`" data-read-only="true">{{ playback.terminal.output || playback.record.preview }}</pre>
              </article>
            </div>
            <p v-else-if="shellHistory.state.loading">正在读取关联 Shell 历史...</p>
            <p v-else>此聊天没有关联 Shell。</p>
          </section>
        </template>
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
              @bastion-launch="launchBastion"
              @system-change="loadBastionHosts"
              @save-profile="saveEditedProfile"
              @select-private-key="selectPrivateKey"
            />
          </section>
        </template>
      </ShellCanvas>
    </template>

    <template #agent>
      <GlobalChatPanel :chat="chatStore.state.selected" :read-only="!isLiveChat" />
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
          @bastion-launch="launchBastion"
          @system-change="loadBastionHosts"
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
        :records="shellHistory.state.records"
        :selected-id="shellHistory.state.selectedId"
        :selected="shellHistory.state.selected"
        :loading="shellHistory.state.loading"
        :error="shellHistory.state.error"
        @close="closeShellHistory"
        @select="shellHistory.select"
        @reconnect="reconnectShell"
      />
      <HostMemoryConsentDialog v-if="pendingHostMemoryDisclosure" :host-identity="pendingHostMemoryDisclosure.hostIdentity" :submitting="hostMemorySubmitting" @close="dismissHostMemory" @acknowledge="acknowledgeHostMemory" />
      <div v-if="autonomousUpgrade.state.visible" class="connection-modal" role="dialog" aria-modal="true" aria-labelledby="autonomous-upgrade-title">
        <section class="autonomous-upgrade-dialog">
          <h2 id="autonomous-upgrade-title">确认升级为全自动驾驶</h2>
          <p>全自动驾驶允许 AI 自动发送候选命令到终端。</p>
          <p>仅用于已验证的低风险维护或测试任务；不适用于未经确认的生产变更。</p>
          <p>本次升权只对当前会话生效。</p>
          <div class="autonomous-upgrade-actions">
            <button type="button" class="cancel-button" @click="autonomousUpgrade.cancel">取消</button>
            <button type="button" class="confirm-upgrade-button" @click="confirmAutonomousUpgrade">确认升级</button>
          </div>
        </section>
      </div>
    </template>
  </WorkbenchShell>
</template>

<style scoped>
.header-button { min-height: 30px; padding: 0 10px; border: 1px solid var(--line); border-radius: 5px; background: var(--surface); color: var(--text); font-size: 11px; }
.empty-state { display: grid; min-width: 0; min-height: 0; overflow: auto; background: var(--surface); }
.agent-empty { display: grid; gap: 7px; padding: 16px; }
.history-playback { height: 100%; overflow: auto; padding: 12px; background: var(--surface-soft); }
.history-shell-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 8px; }
.history-shell-card { display: grid; grid-template-rows: auto auto auto minmax(80px, 1fr); gap: 5px; min-width: 0; padding: 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); }
.history-shell-card header { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }.history-shell-card header button { min-height: 25px; padding: 0 8px; border: 1px solid var(--line); border-radius: 4px; background: var(--surface-soft); color: var(--text); font-size: 10px; }
.history-shell-card strong,.history-shell-card span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.history-shell-card pre { min-width: 0; max-height: 180px; margin: 0; padding: 8px; overflow: auto; border: 1px solid #343a42; border-radius: 4px; background: var(--terminal); color: #d8dade; font: 10px/1.45 ui-monospace, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
.history-shell-card span,.history-shell-card b,.history-playback p { color: var(--muted); font-size: 10px; }
.read-only { background: var(--surface-soft); }
.agent-empty strong { color: var(--text-strong); font-size: 12px; }
.agent-empty p { margin: 0; color: var(--muted); font-size: 11px; line-height: 1.5; }
.connection-error { max-width: min(42vw, 480px); margin: 0; overflow: hidden; color: var(--red); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.connection-modal { position: fixed; z-index: 10; inset: 40px 0 0; display: grid; align-content: center; justify-content: center; padding: 16px; overflow: auto; background: rgb(20 24 29 / 42%); }
.autonomous-upgrade-dialog { display: grid; gap: 12px; width: min(460px, calc(100vw - 32px)); padding: 20px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); color: var(--text); box-shadow: 0 18px 48px rgb(16 24 40 / 18%); }
.autonomous-upgrade-dialog h2,.autonomous-upgrade-dialog p { margin: 0; }
.autonomous-upgrade-actions { display: flex; justify-content: flex-end; gap: 8px; }
.cancel-button,.confirm-upgrade-button { min-height: 34px; padding: 0 12px; border: 1px solid var(--line); border-radius: 5px; background: var(--surface); color: var(--text); }
.confirm-upgrade-button { border-color: var(--green); background: var(--green); color: #fff; }
</style>
