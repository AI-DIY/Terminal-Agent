<script setup lang="ts">
import { Expand, Files, History, LayoutGrid, Plus, Upload, X } from '@lucide/vue'
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { broadcastCommandPayload } from './broadcast-command'
import SessionTabs from '../SessionTabs.vue'
import TerminalPane from '../TerminalPane.vue'
import FileTransferPanel from './FileTransferPanel.vue'
import { sessionDisplayLabel, sessionDisplayParts, sessionHasDuplicateHost, sessionLabel, type SessionView } from '../../stores/sessions'
import {
  getLayoutPreferencesStore,
  SHELL_FONT_SIZE_OPTIONS,
  SHELL_ROW_HEIGHT_OPTIONS,
  shellGridStyle,
} from '../../stores/layout-preferences'

type HistoryHost = {
  /** Stable renderer id for one hostname in the compact history strip. */
  id: string
  hostname: string
  recordCount: number
  representativeHistoryId: string
}

const props = defineProps<{
  sessions: SessionView[]
  currentSessions: SessionView[]
  visibleSessionIds: string[]
  activeSessionId: string | null
  shellCount: number
  isLive: boolean
  historyHosts: HistoryHost[]
}>()
const emit = defineEmits<{
  select: [sessionId: string]
  close: [sessionId: string]
  connect: []
  history: [hostname: string, historyId?: string]
  historyMenu: [historyHostId: string]
  reorder: [sessionIds: string[]]
  reorderHistory: [historyIds: string[]]
}>()

const layout = getLayoutPreferencesStore()
const layoutMenuOpen = ref(false)
const menuHistoryId = ref<string | null>(null)
const draggingSessionId = ref<string | null>(null)
const dragOverSessionId = ref<string | null>(null)
const draggingHistoryId = ref<string | null>(null)
const dragOverHistoryId = ref<string | null>(null)
const activeHistoryId = ref<string | null>(null)
const fileTransferPanelSessionIds = ref<string[]>([])
const fileTransferVisibleSessionIds = ref(new Set<string>())
const fileTransferBusySessionIds = ref(new Set<string>())
const fileTransferPanelHeights = ref<Record<string, number>>({})
const fileTransferResizeState = ref<{ sessionId: string; startY: number; startHeight: number; minHeight: number; maxHeight: number } | null>(null)
const broadcastEnabled = ref(false)
const broadcastInput = ref('')
const broadcastSending = ref(false)
const broadcastStatus = ref('')
const globalUploadBusy = ref(false)
const globalUploadStatus = ref('')
const broadcastEditorOpen = ref(false)
const broadcastEditor = ref<HTMLTextAreaElement | null>(null)
type BroadcastRequest = {
  data: string
  targets: string[]
  clearInputValue?: string
}
const broadcastQueue: BroadcastRequest[] = []
let broadcastQueueRunning = false
const orderedCurrentSessions = computed(() => {
  const sessionsById = new Map(props.currentSessions.map(session => [session.id, session]))
  const ordered: SessionView[] = []
  for (const sessionId of props.visibleSessionIds) {
    const session = sessionsById.get(sessionId)
    if (session) ordered.push(session)
  }
  for (const session of props.currentSessions) {
    if (!ordered.some(item => item.id === session.id)) ordered.push(session)
  }
  return ordered
})
const displayedSessionIds = computed(() => orderedCurrentSessions.value.map(session => session.id))
const gridColumns = computed(() => Math.max(1, Math.min(layout.state.columns, orderedCurrentSessions.value.length || 1)))
const gridStyle = computed(() => shellGridStyle(gridColumns.value, layout.state.rowHeightPercent))
const hasOnlineSessions = computed(() => props.currentSessions.length > 0)
/**
 * File uploads intentionally target every live session known by the
 * workbench, not only the sessions currently attached to this task's canvas.
 * Keep the list de-duplicated because the IPC contract rejects duplicate ids.
 */
const globalUploadSessionIds = computed(() => [...new Set(
  props.sessions.map(session => session.id).filter(sessionId => Boolean(sessionId)),
)])
const broadcastDisplayStatus = computed(() => globalUploadStatus.value || broadcastStatus.value)
const layoutItemCount = computed(() => hasOnlineSessions.value
  ? orderedCurrentSessions.value.length
  : props.historyHosts.length)
const historyHostCount = computed(() => props.historyHosts.length)
const historyRecordCount = computed(() => props.historyHosts.reduce((count, host) => count + host.recordCount, 0))
const layoutSummary = computed(() => {
  const count = layoutItemCount.value
  const columns = Math.max(1, Math.min(layout.state.columns, count || 1))
  return count === 0 ? '尚未接入 SSH' : `${count} 个 SSH · ${Math.ceil(count / columns)} 行`
})
const canUseWorkspaceControls = computed(() => props.isLive && orderedCurrentSessions.value.length > 0)

function selectSession(sessionId: string): void {
  emit('select', sessionId)
}

function updateLayout(field: 'columns' | 'rowHeightPercent' | 'fontSize', event: Event): void {
  const value = Number((event.target as HTMLSelectElement).value)
  const patch = { [field]: value }
  layout.previewLayout(patch)
  void layout.saveLayout(patch).catch(() => undefined)
}

function closeSession(sessionId: string): void {
  emit('close', sessionId)
}

function mountFileTransferSession(sessionId: string): void {
  if (!fileTransferPanelSessionIds.value.includes(sessionId)) {
    fileTransferPanelSessionIds.value = [...fileTransferPanelSessionIds.value, sessionId]
  }
}

function isFileTransferVisible(sessionId: string): boolean {
  return fileTransferVisibleSessionIds.value.has(sessionId)
}

function toggleFileTransfer(sessionId: string): void {
  if (!props.currentSessions.some(session => session.id === sessionId)) return
  const visible = new Set(fileTransferVisibleSessionIds.value)
  if (visible.has(sessionId)) {
    visible.delete(sessionId)
  } else {
    mountFileTransferSession(sessionId)
    visible.add(sessionId)
  }
  fileTransferVisibleSessionIds.value = visible
  layoutMenuOpen.value = false
  menuHistoryId.value = null
}

function hideFileTransfer(sessionId: string): void {
  const visible = new Set(fileTransferVisibleSessionIds.value)
  visible.delete(sessionId)
  fileTransferVisibleSessionIds.value = visible
}

function fileTransferPanelHeight(sessionId: string): number | undefined {
  return fileTransferPanelHeights.value[sessionId]
}

function updateFileTransferHeight(sessionId: string, height: number): void {
  fileTransferPanelHeights.value = { ...fileTransferPanelHeights.value, [sessionId]: Math.round(height) }
}

function finishFileTransferResize(): void {
  fileTransferResizeState.value = null
  document.body.classList.remove('resizing-file-transfer')
  window.removeEventListener('pointermove', onFileTransferResizeMove)
  window.removeEventListener('pointerup', finishFileTransferResize)
  window.removeEventListener('pointercancel', finishFileTransferResize)
}

function onFileTransferResizeMove(event: PointerEvent): void {
  const state = fileTransferResizeState.value
  if (!state) return
  const height = Math.min(state.maxHeight, Math.max(state.minHeight, state.startHeight - (event.clientY - state.startY)))
  updateFileTransferHeight(state.sessionId, height)
}

function beginFileTransferResize(sessionId: string, event: PointerEvent): void {
  if (event.button !== 0) return
  const handle = event.currentTarget as HTMLElement | null
  const frame = handle?.closest('.terminal-frame') as HTMLElement | null
  const panel = handle?.nextElementSibling as HTMLElement | null
  const frameHeight = frame?.getBoundingClientRect().height ?? 640
  const currentHeight = panel?.getBoundingClientRect().height ?? fileTransferPanelHeight(sessionId) ?? 260
  const minHeight = 190
  const maxHeight = Math.max(minHeight, frameHeight - 36 - 104)
  fileTransferResizeState.value = { sessionId, startY: event.clientY, startHeight: currentHeight, minHeight, maxHeight }
  document.body.classList.add('resizing-file-transfer')
  window.addEventListener('pointermove', onFileTransferResizeMove)
  window.addEventListener('pointerup', finishFileTransferResize)
  window.addEventListener('pointercancel', finishFileTransferResize)
  event.preventDefault()
}

function nudgeFileTransferResize(sessionId: string, delta: number): void {
  const handle = document.querySelector<HTMLElement>(`[data-file-transfer-resize="${CSS.escape(sessionId)}"]`)
  const frame = handle?.closest('.terminal-frame') as HTMLElement | null
  const panel = handle?.nextElementSibling as HTMLElement | null
  const frameHeight = frame?.getBoundingClientRect().height ?? 640
  const currentHeight = panel?.getBoundingClientRect().height ?? fileTransferPanelHeight(sessionId) ?? 260
  const maxHeight = Math.max(190, frameHeight - 36 - 104)
  updateFileTransferHeight(sessionId, Math.min(maxHeight, Math.max(190, currentHeight + delta)))
}

function setFileTransferBusy(sessionId: string, busy: boolean): void {
  const next = new Set(fileTransferBusySessionIds.value)
  if (busy) next.add(sessionId)
  else next.delete(sessionId)
  fileTransferBusySessionIds.value = next
}

async function drainBroadcastQueue(): Promise<void> {
  if (broadcastQueueRunning) return
  broadcastQueueRunning = true
  broadcastSending.value = true
  try {
    while (broadcastQueue.length > 0) {
      const request = broadcastQueue.shift()!
      const data = request.data
      broadcastStatus.value = `正在发送到 ${request.targets.length} 个 SSH…`
      const results = await Promise.allSettled(request.targets.map(sessionId => (
        Promise.resolve().then(() => window.terminalAgent.sessions.write(sessionId, data))
      )))
      const failed = results.filter(result => result.status === 'rejected').length
      const succeeded = results.length - failed
      broadcastStatus.value = failed
        ? `已发送到 ${succeeded} 个 SSH，${failed} 个会话发送失败。`
        : `已发送到 ${succeeded} 个 SSH。`
      // Do not erase text that the user entered while an earlier write was
      // waiting on IPC.  Control-key requests intentionally leave the draft
      // untouched, so they can be used to interrupt or navigate a command.
      if (!failed && request.clearInputValue !== undefined && broadcastInput.value === request.clearInputValue) {
        broadcastInput.value = ''
      }
    }
  } catch {
    // Promise.allSettled normally keeps this path unreachable, but preserve a
    // usable status if an unexpected bridge failure escapes the per-target
    // promise wrapper.
    broadcastStatus.value = '发送失败，请检查 SSH 连接。'
  } finally {
    broadcastQueueRunning = false
    broadcastSending.value = broadcastQueue.length > 0
    if (broadcastQueue.length > 0) void drainBroadcastQueue()
  }
}

function sendBroadcastData(data: string, clearInputValue?: string): void {
  if (!broadcastEnabled.value || !canUseWorkspaceControls.value || !data) return
  const targets = orderedCurrentSessions.value.map(session => session.id)
  if (!targets.length) return
  broadcastQueue.push({ data, targets, ...(clearInputValue === undefined ? {} : { clearInputValue }) })
  void drainBroadcastQueue()
}

function sendBroadcast(): void {
  const value = broadcastInput.value
  const data = broadcastCommandPayload(value)
  if (!data) return
  sendBroadcastData(data, value)
}

/** Select one local file and fan it out to every connected SSH session. */
async function uploadFileToAllConnectedSessions(): Promise<void> {
  if (globalUploadBusy.value) return
  const sessionIds = [...globalUploadSessionIds.value]
  if (!sessionIds.length) {
    globalUploadStatus.value = '当前没有可用的 SSH 会话。'
    return
  }

  const uploadAll = window.terminalAgent.fileTransfer?.uploadAll
  if (typeof uploadAll !== 'function') {
    globalUploadStatus.value = '当前版本不支持上传文件到所有会话。'
    return
  }

  globalUploadBusy.value = true
  globalUploadStatus.value = `正在选择文件并上传到 ${sessionIds.length} 个会话…`
  try {
    const result = await uploadAll({ sessionIds, remotePath: './' })
    const completed = result.results.filter(item => item.status === 'completed').length
    const failed = result.results.length - completed
    globalUploadStatus.value = result.status === 'canceled'
      ? '已取消上传。'
      : failed
        ? `已上传到 ${completed} 个会话，${failed} 个会话失败。`
        : `已上传到 ${completed} 个会话。`
  } catch (cause) {
    globalUploadStatus.value = cause instanceof Error
      ? cause.message
      : '上传文件到所有会话失败。'
  } finally {
    globalUploadBusy.value = false
  }
}

function isBroadcastInputSendable(value: string): boolean {
  return broadcastCommandPayload(value) !== null
}

function controlCharacterForKey(event: KeyboardEvent): string | null {
  if (!event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return null
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key
  if (key >= 'a' && key <= 'z') return String.fromCharCode(key.charCodeAt(0) - 96)
  return ({
    ' ': '\u0000',
    '@': '\u0000',
    '[': '\u001b',
    '\\': '\u001c',
    ']': '\u001d',
    '^': '\u001e',
    '_': '\u001f',
    '?': '\u007f',
  } as Record<string, string>)[key] ?? null
}

function sendBroadcastControl(data: string): void {
  sendBroadcastData(data)
}

function handleBroadcastKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.isComposing) {
    event.preventDefault()
    sendBroadcast()
    return
  }
  const control = controlCharacterForKey(event)
  if (!control) return
  // Prevent browser editing shortcuts (notably Ctrl+C copy) from swallowing
  // the signal before it can be delivered to every connected shell.
  event.preventDefault()
  sendBroadcastControl(control)
}

function openBroadcastEditor(): void {
  if (!broadcastEnabled.value || !canUseWorkspaceControls.value) return
  broadcastEditorOpen.value = true
  void nextTick(() => broadcastEditor.value?.focus())
}

function closeBroadcastEditor(): void {
  broadcastEditorOpen.value = false
}

function sendBroadcastFromEditor(): void {
  const value = broadcastInput.value
  const data = broadcastCommandPayload(value, true)
  if (data) sendBroadcastData(data, value)
  closeBroadcastEditor()
}

function handleBroadcastEditorKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    closeBroadcastEditor()
    return
  }
  // Shift+Enter remains available for composing a multi-line shell input;
  // unmodified Enter preserves the compact input's immediate-send behavior.
  if (event.key === 'Enter' && event.shiftKey) return
  handleBroadcastKeydown(event)
}

function beginSessionDrag(sessionId: string, event: DragEvent): void {
  draggingSessionId.value = sessionId
  dragOverSessionId.value = sessionId
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', sessionId)
  }
}

function trackSessionDragOver(sessionId: string, event: DragEvent): void {
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  dragOverSessionId.value = sessionId
}

function finishSessionDrag(): void {
  draggingSessionId.value = null
  dragOverSessionId.value = null
}

function dropSession(sessionId: string, event: DragEvent): void {
  event.preventDefault()
  const sourceId = draggingSessionId.value ?? event.dataTransfer?.getData('text/plain') ?? null
  if (!sourceId || sourceId === sessionId) {
    finishSessionDrag()
    return
  }
  const ids = orderedCurrentSessions.value.map(session => session.id)
  const sourceIndex = ids.indexOf(sourceId)
  if (sourceIndex < 0 || !ids.includes(sessionId)) {
    finishSessionDrag()
    return
  }
  ids.splice(sourceIndex, 1)
  const targetIndex = ids.indexOf(sessionId)
  if (targetIndex < 0) {
    finishSessionDrag()
    return
  }
  const targetElement = event.currentTarget as HTMLElement
  const bounds = targetElement.getBoundingClientRect()
  const afterTarget = Number.isFinite(event.clientX)
    && bounds.width > 0
    && event.clientX > bounds.left + bounds.width / 2
  ids.splice(targetIndex + (afterTarget ? 1 : 0), 0, sourceId)
  emit('reorder', ids)
  finishSessionDrag()
}

function openHistoryMenu(historyId: string): void {
  layoutMenuOpen.value = false
  menuHistoryId.value = menuHistoryId.value === historyId ? null : historyId
}

defineExpose({ openHistoryMenu })

function openSessionHistory(session: SessionView): void {
  menuHistoryId.value = null
  emit('history', sessionLabel(session))
}

function openHistoricalSessionHistory(hostname: string, historyId?: string, historyHostId = historyId): void {
  menuHistoryId.value = null
  if (!hasOnlineSessions.value && historyHostId) activeHistoryId.value = historyHostId
  emit('history', hostname, historyId)
}

function beginHistoryDrag(historyId: string, event: DragEvent): void {
  draggingHistoryId.value = historyId
  dragOverHistoryId.value = historyId
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', historyId)
  }
}

function trackHistoryDragOver(historyId: string, event: DragEvent): void {
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  dragOverHistoryId.value = historyId
}

function finishHistoryDrag(): void {
  draggingHistoryId.value = null
  dragOverHistoryId.value = null
}

function dropHistory(historyId: string, event: DragEvent): void {
  event.preventDefault()
  const sourceId = draggingHistoryId.value ?? event.dataTransfer?.getData('text/plain') ?? null
  if (!sourceId || sourceId === historyId) {
    finishHistoryDrag()
    return
  }
  const ids = props.historyHosts.map(host => host.id)
  const sourceIndex = ids.indexOf(sourceId)
  const targetIndex = ids.indexOf(historyId)
  if (sourceIndex < 0 || targetIndex < 0) {
    finishHistoryDrag()
    return
  }
  ids.splice(sourceIndex, 1)
  const targetElement = event.currentTarget as HTMLElement
  const bounds = targetElement.getBoundingClientRect()
  const afterTarget = Number.isFinite(event.clientX)
    && bounds.width > 0
    && event.clientX > bounds.left + bounds.width / 2
  const adjustedTargetIndex = ids.indexOf(historyId)
  ids.splice(Math.max(0, adjustedTargetIndex + (afterTarget ? 1 : 0)), 0, sourceId)
  emit('reorderHistory', ids)
  finishHistoryDrag()
}

function historyTabActive(historyId: string): boolean {
  return !hasOnlineSessions.value && activeHistoryId.value === historyId
}

function displayBaseLabel(session: SessionView): string {
  return sessionDisplayParts(session, orderedCurrentSessions.value)?.displayLabel.replace(/\s+#\d+$/, '') ?? sessionDisplayLabel(session, orderedCurrentSessions.value)
}

function displayOrdinal(session: SessionView): number | null {
  return sessionHasDuplicateHost(session, orderedCurrentSessions.value)
    ? sessionDisplayParts(session, orderedCurrentSessions.value)?.ordinal ?? null
    : null
}

/** Historical tabs always open the shared read-only history dialog. */
function handleHistoryHostClick(host: HistoryHost): void {
  openHistoricalSessionHistory(host.hostname, host.representativeHistoryId, host.id)
}

function historyHostLabel(host: HistoryHost): string {
  return host.hostname
}

function historyHostActionLabel(host: HistoryHost): string {
  return `打开 SSH 历史 ${historyHostLabel(host)}`
}

watch(
  () => props.currentSessions.map(session => session.id),
  sessionIds => {
    layoutMenuOpen.value = false
    const available = new Set(sessionIds)
    fileTransferPanelSessionIds.value = fileTransferPanelSessionIds.value.filter(sessionId => available.has(sessionId))
    fileTransferVisibleSessionIds.value = new Set([...fileTransferVisibleSessionIds.value].filter(sessionId => available.has(sessionId)))
    fileTransferBusySessionIds.value = new Set([...fileTransferBusySessionIds.value].filter(sessionId => available.has(sessionId)))
    const heights = { ...fileTransferPanelHeights.value }
    for (const sessionId of Object.keys(heights)) if (!available.has(sessionId)) delete heights[sessionId]
    fileTransferPanelHeights.value = heights
    if (!sessionIds.length) {
      broadcastStatus.value = ''
    }
  },
)

onBeforeUnmount(() => finishFileTransferResize())
watch(
  [() => props.isLive, () => props.currentSessions.length, () => props.historyHosts.map(host => host.id).join('\u0000')],
  ([isLive, currentSessionCount, historyIds]) => {
    if (!isLive && currentSessionCount === 0 && !historyIds) layoutMenuOpen.value = false
    if (isLive || currentSessionCount === 0) menuHistoryId.value = null
    if (currentSessionCount > 0) activeHistoryId.value = null
    if (activeHistoryId.value && !props.historyHosts.some(host => host.id === activeHistoryId.value)) activeHistoryId.value = null
  },
)
</script>

<template>
  <section class="shell-canvas" :class="{ empty: isLive && currentSessions.length === 0 && historyHosts.length === 0 }">
    <header v-show="currentSessions.length > 0 || !isLive || historyHosts.length > 0" class="shell-toolbar-content">
      <div class="workspace-toolbar-title"><strong>SSH工作区</strong></div>
      <SessionTabs
        v-if="isLive && currentSessions.length"
        :sessions="orderedCurrentSessions"
        :active-session-id="activeSessionId"
        @select="selectSession"
        @close="closeSession"
        @reorder="emit('reorder', $event)"
      />
      <div class="hostbar-tools">
        <div v-if="isLive" class="shell-title">
          <strong>SSH</strong>
          <span>{{ shellCount }} 个主机 · {{ displayedSessionIds.length }} 个连接</span>
        </div>
        <span v-else class="history-readonly-note">当前任务没有在线 SSH</span>
        <button v-if="isLive" type="button" class="connect-button" @click="emit('connect')"><Plus :size="13" aria-hidden="true" /><span>新建 SSH 连接</span></button>
        <button
          v-if="isLive && currentSessions.length"
          type="button"
          class="layout-button"
          aria-label="SSH 窗口布局"
          aria-haspopup="true"
          :aria-expanded="layoutMenuOpen"
          @click="layoutMenuOpen = !layoutMenuOpen"
        ><LayoutGrid :size="13" aria-hidden="true" /><span>SSH 窗口布局</span></button>
      </div>
    </header>
    <section v-if="layoutMenuOpen && isLive && currentSessions.length" class="layout-menu" aria-label="SSH 窗口布局设置">
      <strong>SSH 窗口布局</strong>
      <label>每行数量
        <select :value="layout.state.columns" @change="updateLayout('columns', $event)">
          <option v-for="value in 4" :key="value" :value="value">{{ value }}</option>
        </select>
      </label>
      <label>SSH 字体大小
        <select :value="layout.state.fontSize" @change="updateLayout('fontSize', $event)">
           <option v-for="preset in SHELL_FONT_SIZE_OPTIONS" :key="preset.value" :value="preset.value">{{ preset.label }} · {{ preset.value }}px</option>
        </select>
      </label>
      <label>单行高度（占工作区）
        <select :value="layout.state.rowHeightPercent" @change="updateLayout('rowHeightPercent', $event)">
           <option v-for="preset in SHELL_ROW_HEIGHT_OPTIONS" :key="preset.value" :value="preset.value">{{ preset.label }} · {{ preset.value }}%</option>
        </select>
      </label>
      <span>{{ layoutSummary }}</span>
    </section>
    <section v-if="historyHosts.length" class="history-shell-toolbar" aria-label="历史 SSH 连接">
      <div class="history-shell-heading"><strong>历史 SSH 连接</strong><span>{{ historyHostCount }} 台主机 · {{ historyRecordCount }} 条记录</span></div>
      <nav class="history-session-tabs" aria-label="历史 SSH 会话">
        <div
          v-for="host in historyHosts"
          :key="host.id"
          class="history-session-tab"
          :class="{ active: historyTabActive(host.id), dragging: host.id === draggingHistoryId, 'drag-over': host.id === dragOverHistoryId && host.id !== draggingHistoryId }"
          draggable="true"
            :title="`拖动排序：${historyHostLabel(host)}`"
          @dragstart="beginHistoryDrag(host.id, $event)"
          @dragover="trackHistoryDragOver(host.id, $event)"
          @drop="dropHistory(host.id, $event)"
          @dragend="finishHistoryDrag"
        >
          <button
            type="button"
            class="history-shell-tab"
            :data-history-id="host.id"
            :aria-label="historyHostActionLabel(host)"
            :aria-current="historyTabActive(host.id) ? 'page' : undefined"
            @click="handleHistoryHostClick(host)"
            @contextmenu.prevent="emit('historyMenu', host.id)"
          ><span class="host-status" aria-hidden="true" /><strong>{{ historyHostLabel(host) }}</strong></button>
          <section v-if="menuHistoryId === host.id" class="history-context-menu" role="menu" :aria-label="`历史 SSH 操作 ${historyHostLabel(host)}`">
            <button type="button" role="menuitem" @click="openHistoricalSessionHistory(host.hostname, host.representativeHistoryId, host.id)">查看 SSH 历史</button>
          </section>
        </div>
      </nav>
    </section>

    <div class="canvas-content">
      <section
        v-show="currentSessions.length > 0"
        v-memo="[orderedCurrentSessions, activeSessionId, gridColumns, gridStyle, layout.state.rowHeightPercent, layout.state.fontSize, fileTransferPanelSessionIds, fileTransferVisibleSessionIds, fileTransferBusySessionIds, fileTransferPanelHeights, draggingSessionId, dragOverSessionId]"
        class="terminal-grid"
        aria-label="可见终端面板"
        :data-columns="gridColumns"
        :data-row-height-percent="layout.state.rowHeightPercent"
        :style="gridStyle"
      >
        <article
          v-for="session in orderedCurrentSessions"
          :key="session.id"
          class="terminal-frame"
          :class="{ selected: session.id === activeSessionId, dragging: session.id === draggingSessionId, 'drag-over': session.id === dragOverSessionId && session.id !== draggingSessionId }"
        >
          <header
            draggable="true"
            :title="`拖动排序：${sessionDisplayLabel(session, orderedCurrentSessions)}`"
            @dragstart="beginSessionDrag(session.id, $event)"
            @dragover="trackSessionDragOver(session.id, $event)"
            @drop="dropSession(session.id, $event)"
            @dragend="finishSessionDrag"
          >
            <strong :title="sessionDisplayLabel(session, orderedCurrentSessions)">{{ displayBaseLabel(session) }}</strong>
            <span v-if="displayOrdinal(session) !== null" class="host-ordinal">#{{ displayOrdinal(session) }}</span>
            <span>已连接</span>
            <div class="terminal-actions">
              <button
                type="button"
                class="file-transfer-button"
                :class="{ busy: fileTransferBusySessionIds.has(session.id) }"
                :aria-label="`${isFileTransferVisible(session.id) ? '隐藏' : '显示'} ${sessionDisplayLabel(session, orderedCurrentSessions)} 的文件传输`"
                :aria-expanded="isFileTransferVisible(session.id)"
                :title="fileTransferBusySessionIds.has(session.id) ? '文件传输中' : (isFileTransferVisible(session.id) ? '隐藏文件传输' : '显示文件传输')"
                @click.stop="toggleFileTransfer(session.id)"
              ><span v-if="fileTransferBusySessionIds.has(session.id)">文件传输中</span><Files :size="14" aria-hidden="true" /></button>
              <button type="button" :aria-label="`查看 SSH 历史 ${sessionDisplayLabel(session, orderedCurrentSessions)}`" title="历史会话" @click.stop="openSessionHistory(session)"><History :size="14" aria-hidden="true" /></button>
              <button type="button" :aria-label="`关闭画布终端会话 ${sessionDisplayLabel(session, orderedCurrentSessions)}`" title="关闭 SSH" class="close-terminal" @click.stop="closeSession(session.id)"><X :size="15" aria-hidden="true" /></button>
            </div>
          </header>
          <TerminalPane :session="session" :active="session.id === activeSessionId" :font-size="layout.state.fontSize" @activate="selectSession(session.id)" />
          <!-- Keep an opened transfer surface mounted while it is hidden so
               ongoing SFTP work remains attached to this SSH session. -->
          <section
            v-if="fileTransferPanelSessionIds.includes(session.id)"
            v-show="isFileTransferVisible(session.id)"
            class="file-transfer-session-panel"
            :style="fileTransferPanelHeight(session.id) ? { '--file-transfer-height': `${fileTransferPanelHeight(session.id)}px` } : undefined"
            :aria-label="`${sessionDisplayLabel(session, orderedCurrentSessions)} 的文件传输`"
          >
            <button
              type="button"
              class="file-transfer-resize-handle"
              :data-file-transfer-resize="session.id"
              aria-label="调整文件传输面板高度"
              title="拖动调整文件传输面板高度"
              @pointerdown="beginFileTransferResize(session.id, $event)"
              @keydown.arrowup.prevent="nudgeFileTransferResize(session.id, 24)"
              @keydown.arrowdown.prevent="nudgeFileTransferResize(session.id, -24)"
            ><span aria-hidden="true" /></button>
            <FileTransferPanel
              :session-id="session.id"
              :hostname="sessionDisplayLabel(session, orderedCurrentSessions)"
              @hide="hideFileTransfer(session.id)"
              @close="hideFileTransfer(session.id)"
              @busy-change="setFileTransferBusy(session.id, $event)"
            />
          </section>
        </article>
      </section>

      <section v-if="currentSessions.length === 0" class="empty-slot"><slot name="empty" /></section>
    </div>

    <section v-if="isLive && currentSessions.length" class="broadcast-bar" aria-label="发送命令到所有会话">
      <label class="broadcast-toggle">
        <span class="broadcast-toggle-label">发送命令到所有会话</span>
        <input
          v-model="broadcastEnabled"
          class="broadcast-switch-input"
          type="checkbox"
          role="switch"
          aria-label="启用发送命令到所有会话"
          :aria-checked="broadcastEnabled"
        />
        <span class="broadcast-switch-control" :class="{ enabled: broadcastEnabled }" aria-hidden="true"><i /></span>
      </label>
      <div class="broadcast-input-group">
        <input
          v-model="broadcastInput"
          class="broadcast-input"
          type="text"
          autocomplete="off"
          aria-label="发送命令到所有会话"
          placeholder="输入要发送到所有在线 SSH 的命令。注意：组合键操作跳过发送按键直接发送"
          :disabled="!broadcastEnabled"
          @keydown="handleBroadcastKeydown"
        />
        <button
          type="button"
          class="broadcast-expand-button"
          aria-label="放大编辑广播命令"
          title="放大编辑"
          :disabled="!broadcastEnabled"
          @click="openBroadcastEditor"
        ><Expand :size="14" aria-hidden="true" /></button>
      </div>
      <button
        type="button"
        class="broadcast-send-button"
        :disabled="!broadcastEnabled || !isBroadcastInputSendable(broadcastInput) || broadcastSending || !currentSessions.length"
        @click="sendBroadcast"
      >{{ broadcastSending ? '发送中…' : '发送所有会话执行' }}</button>
      <button
        type="button"
        class="broadcast-upload-all-button"
        :disabled="globalUploadBusy || !globalUploadSessionIds.length"
        aria-label="上传文件到所有会话"
        title="选择一个本地文件，上传到所有已连接会话的用户目录"
        @click="uploadFileToAllConnectedSessions"
      ><Upload :size="13" aria-hidden="true" /><span>{{ globalUploadBusy ? '上传中…' : '上传到所有会话' }}</span></button>
      <span class="broadcast-status" role="status" aria-live="polite">{{ broadcastDisplayStatus }}</span>
    </section>

    <div v-if="broadcastEditorOpen" class="broadcast-editor-backdrop" role="presentation" @pointerdown.self="closeBroadcastEditor">
      <section class="broadcast-editor-dialog" role="dialog" aria-modal="true" aria-labelledby="broadcast-editor-title" @keydown="handleBroadcastEditorKeydown">
        <header>
          <strong id="broadcast-editor-title">发送命令到所有会话</strong>
          <button type="button" aria-label="关闭放大编辑" title="关闭" @click="closeBroadcastEditor"><X :size="15" aria-hidden="true" /></button>
        </header>
        <textarea
          ref="broadcastEditor"
          v-model="broadcastInput"
          aria-label="放大编辑发送命令到所有会话"
          placeholder="输入要发送到所有在线 SSH 的命令。注意：组合键操作跳过发送按键直接发送"
          :disabled="!broadcastEnabled"
        />
        <footer>
          <span>{{ broadcastDisplayStatus }}</span>
          <button
            type="button"
            class="broadcast-editor-send-button"
            :disabled="!broadcastEnabled || !isBroadcastInputSendable(broadcastInput) || broadcastSending || !currentSessions.length"
            @click="sendBroadcastFromEditor"
          >{{ broadcastSending ? '发送中…' : '发送所有会话执行' }}</button>
        </footer>
      </section>
    </div>

  </section>
</template>

<style scoped>
.shell-canvas { position: relative; display: grid; grid-template-rows: 42px auto minmax(0, 1fr) auto auto; width: 100%; height: 100%; min-width: 0; min-height: 0; overflow: hidden; background: var(--surface); }
.shell-canvas.empty { grid-template-rows: minmax(0, 1fr); }
.shell-canvas.empty .canvas-content { grid-row: 1; }
.shell-toolbar-content { position: relative; display: flex; align-items: stretch; min-width: 0; height: 42px; overflow: hidden; border-bottom: 1px solid var(--line); background: var(--panel); }
.workspace-toolbar-title { display: flex; flex: 0 0 auto; align-items: center; min-width: 92px; padding: 0 11px; border-right: 1px solid var(--line-soft); }.workspace-toolbar-title strong { color: var(--text-strong); font-size: 14px; white-space: nowrap; }
.hostbar-tools { position: sticky; z-index: 3; right: 0; display: flex; flex: 0 0 auto; align-items: center; gap: 6px; min-width: max-content; margin-left: auto; padding: 0 8px; border-left: 1px solid var(--line-soft); background: var(--panel); box-shadow: -8px 0 12px var(--panel); }
.shell-title { display: flex; align-items: baseline; gap: 6px; min-width: 0; overflow: hidden; }
.shell-title strong { color: var(--text-strong); font-size: 10px; white-space: nowrap; }
.shell-title span { max-width: 170px; overflow: hidden; color: var(--muted); font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }
.history-readonly-note { max-width: 220px; overflow: hidden; color: var(--muted); font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }
.hostbar-tools button { display: inline-flex; align-items: center; justify-content: center; gap: 5px; height: 29px; padding: 0 9px; border: 1px solid var(--line); border-radius: 5px; background: var(--surface); color: var(--text-strong); font-size: 10px; font-weight: 650; white-space: nowrap; }
.hostbar-tools button:hover { border-color: var(--focus); background: var(--hover); }
.hostbar-tools .connect-button { border-color: var(--accent); background: var(--accent); color: #fff; }
.layout-menu { position: absolute; z-index: 8; top: 46px; right: 8px; display: grid; grid-template-columns: minmax(120px, 1fr) 86px; gap: 9px 12px; width: 264px; padding: 13px; border: 1px solid var(--line); border-radius: 7px; background: var(--surface); box-shadow: 0 14px 36px rgb(24 31 40 / 22%); }
.layout-menu > strong,.layout-menu > span { grid-column: 1 / -1; color: var(--text-strong); font-size: 11px; }
.layout-menu > span { color: var(--muted); }
.layout-menu label { display: contents; color: var(--text); font-size: 11px; }
.layout-menu select { width: 86px; height: 28px; padding: 0 6px; border: 1px solid var(--line); border-radius: 4px; background: var(--surface-soft); color: var(--text); }
.canvas-content { position: relative; display: grid; grid-template-rows: minmax(0, 1fr) auto; grid-row: 3; min-width: 0; min-height: 0; overflow: hidden; }
.terminal-grid { display: grid; align-content: start; width: 100%; height: auto; min-width: 0; min-height: 0; gap: 10px; padding: 10px; overflow-x: auto; overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable both-edges; scrollbar-color: transparent transparent; background: var(--surface); }
.terminal-grid:hover,.terminal-grid:focus-within { scrollbar-color: color-mix(in srgb, var(--muted) 58%, transparent) transparent; }
.terminal-grid::-webkit-scrollbar { width: 8px; height: 8px; }
.terminal-grid::-webkit-scrollbar-track { background: transparent; }
.terminal-grid::-webkit-scrollbar-thumb { border: 2px solid transparent; border-radius: 999px; background: transparent; background-clip: padding-box; }
.terminal-grid:hover::-webkit-scrollbar-thumb,.terminal-grid:focus-within::-webkit-scrollbar-thumb { background-color: color-mix(in srgb, var(--muted) 58%, transparent); }
.terminal-grid:hover::-webkit-scrollbar-thumb:hover,.terminal-grid:focus-within::-webkit-scrollbar-thumb:hover { background-color: var(--muted); }
.terminal-frame { position: relative; display: grid; grid-template-rows: 36px minmax(104px, 1fr) auto; min-width: 0; min-height: 0; overflow: hidden; border: 1px solid var(--line); border-radius: 6px; background: var(--terminal); container-type: inline-size; }
.terminal-frame.dragging { opacity: .58; }
.terminal-frame.drag-over { box-shadow: inset 0 0 0 2px var(--focus); }
.terminal-frame.selected { border-color: var(--red); background: var(--amber-soft); box-shadow: inset 0 2px 0 var(--red); }
.terminal-frame > header { display: flex; align-items: center; gap: 7px; min-width: 0; padding: 0 7px 0 10px; border-bottom: 1px solid var(--line); background: var(--panel); color: var(--text); cursor: grab; }
.terminal-frame.selected > header { background: var(--amber-soft); }
.terminal-frame > header:active { cursor: grabbing; }
.terminal-frame > header strong { min-width: 36px; max-width: min(30cqw, 180px); overflow: hidden; color: var(--text-strong); font-size: 10px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.terminal-frame > header > span:not(.host-ordinal) { min-width: 0; flex: 1 1 auto; overflow: hidden; color: var(--faint); font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }
.terminal-frame > header > .host-ordinal { align-self: flex-start; flex: 0 0 auto; margin-top: 5px; padding: 1px 4px; border: 1px solid var(--amber-line); border-radius: 3px; background: var(--amber-soft); color: var(--amber); font-size: 8px; font-weight: 750; line-height: 1.1; }
.terminal-actions { display: flex; flex: 0 0 auto; gap: 3px; margin-left: auto; }
.terminal-actions button { display: grid; place-items: center; width: 26px; height: 26px; padding: 0; border: 0; border-radius: 4px; background: transparent; color: var(--muted); }
.terminal-actions button:hover,.terminal-actions button:focus-visible { background: var(--hover); color: var(--text-strong); }.terminal-actions .close-terminal:hover { color: var(--red); }
.terminal-actions .file-transfer-button { display: inline-flex; width: auto; min-width: 26px; gap: 4px; padding-inline: 6px; }
.terminal-actions .file-transfer-button.busy { color: var(--amber); background: var(--amber-soft); }
.terminal-actions .file-transfer-button span { font-size: 8px; font-weight: 700; white-space: nowrap; }
.terminal-frame :deep(.terminal-pane) { height: 100%; min-height: 0; border: 0; }
.file-transfer-session-panel { position: relative; display: grid; grid-template-rows: 8px minmax(0, var(--file-transfer-height, 260px)); min-width: 0; max-height: min(62vh, 520px); overflow: hidden; border-top: 1px solid var(--line); background: var(--panel); }
.file-transfer-resize-handle { display: grid; place-items: center; width: 100%; min-height: 8px; padding: 0; border: 0; background: transparent; cursor: ns-resize; }
.file-transfer-resize-handle span { width: 42px; height: 3px; border-radius: 999px; background: var(--line); }
.file-transfer-resize-handle:hover span,.file-transfer-resize-handle:focus-visible span { background: var(--focus); }
:global(body.resizing-file-transfer),:global(body.resizing-file-transfer *) { cursor: ns-resize !important; user-select: none !important; }
.history-context-menu { position: absolute; z-index: 9; top: 25px; right: auto; left: 0; display: grid; min-width: 154px; padding: 4px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); box-shadow: 0 14px 36px rgb(24 31 40 / 22%); }
.history-context-menu button { min-height: 29px; padding: 0 8px; border: 0; border-radius: 3px; background: transparent; color: var(--text); font-size: 11px; text-align: left; }.history-context-menu button:hover,.history-context-menu button:focus-visible { background: var(--surface-soft); outline: 1px solid var(--accent); }.history-context-menu button:disabled { color: var(--muted); cursor: not-allowed; }
.empty-slot { width: 100%; height: 100%; min-width: 0; min-height: 0; overflow: hidden; }
.history-shell-toolbar { position: relative; display: grid; grid-row: 2; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 8px; min-height: 32px; padding: 3px 8px; border-bottom: 1px solid var(--line); background: color-mix(in srgb, var(--panel) 86%, var(--surface)); }
.history-shell-heading { display: flex; align-items: center; gap: 5px; white-space: nowrap; }.history-shell-heading strong { color: var(--text-strong); font-size: 9px; }.history-shell-heading span { color: var(--muted); font-size: 8px; }
.history-session-tabs { display: flex; min-width: 0; min-height: 0; height: 25px; align-items: stretch; overflow-x: auto; overflow-y: hidden; scrollbar-gutter: stable; scrollbar-width: thin; scrollbar-color: transparent transparent; }
.history-session-tabs:hover,.history-session-tabs:focus-within { scrollbar-color: color-mix(in srgb, var(--muted) 58%, transparent) transparent; }
.history-session-tabs::-webkit-scrollbar { width: 0; height: 5px; }.history-session-tabs::-webkit-scrollbar-track { background: transparent; }.history-session-tabs::-webkit-scrollbar-thumb { border: 1px solid transparent; border-radius: 999px; background: transparent; background-clip: padding-box; }.history-session-tabs:hover::-webkit-scrollbar-thumb,.history-session-tabs:focus-within::-webkit-scrollbar-thumb { background-color: color-mix(in srgb, var(--muted) 58%, transparent); }
.history-session-tab { position: relative; display: flex; box-sizing: border-box; height: 100%; min-height: 0; flex: 0 0 auto; align-items: center; max-width: 228px; border: 1px solid transparent; border-bottom-width: 2px; background: transparent; color: var(--muted); white-space: nowrap; cursor: grab; }
.history-session-tab:hover { background: var(--hover); }.history-session-tab:active { cursor: grabbing; }.history-session-tab.active { border-color: var(--red); background: var(--amber-soft); color: var(--text-strong); }.history-session-tab.dragging { opacity: .48; }.history-session-tab.drag-over { box-shadow: inset 2px 0 0 var(--focus); }
.history-session-tab > .history-shell-tab { display: flex; min-width: 0; align-items: center; gap: 5px; height: 100%; padding: 0 6px 0 8px; border: 0; background: transparent; color: inherit; font-size: 9px; text-align: left; white-space: nowrap; }
.history-session-tab > .history-shell-tab:hover,.history-session-tab > .history-shell-tab:focus-visible { outline: 0; }.history-session-tab > .history-shell-tab strong { max-width: 112px; overflow: hidden; color: var(--text-strong); font-size: 10px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.host-status { width: 6px; height: 6px; flex: 0 0 auto; border-radius: 50%; background: var(--muted); }.history-session-tab.active .host-status { background: var(--accent); }
.broadcast-bar { display: grid; grid-row: 4; grid-template-columns: auto minmax(180px, 1fr) auto auto minmax(0, 220px); align-items: center; gap: 6px; min-width: 0; min-height: 36px; padding: 4px 8px; border-top: 1px solid var(--line); background: var(--panel); }
.broadcast-bar > * { align-self: center; }
.broadcast-toggle { position: relative; display: inline-flex; align-items: center; gap: 7px; min-height: 27px; color: var(--text-strong); font-size: 10px; font-weight: 650; line-height: 1; white-space: nowrap; cursor: pointer; }
.broadcast-toggle-label { display: inline-flex; align-items: center; min-height: 27px; }
.broadcast-switch-input { position: absolute; z-index: 2; top: 50%; right: 0; width: 36px; height: 20px; margin: 0; border: 0; opacity: 0; cursor: pointer; transform: translateY(-50%); }
.broadcast-switch-control { box-sizing: border-box; display: inline-flex; width: 36px; height: 20px; flex: 0 0 auto; align-items: center; padding: 2px; border: 1px solid var(--line); border-radius: 999px; background: var(--line); pointer-events: none; transition: background .15s,border-color .15s; }
.broadcast-switch-control i { display: block; width: 14px; height: 14px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgb(19 27 36 / 22%); transition: transform .15s; }
.broadcast-switch-control.enabled { border-color: var(--accent); background: var(--accent); }.broadcast-switch-control.enabled i { transform: translateX(15px); }.broadcast-switch-input:focus-visible + .broadcast-switch-control { box-shadow: 0 0 0 3px var(--accent-soft); }
.broadcast-input-group { display: grid; grid-template-columns: minmax(0, 1fr) 27px; min-width: 0; gap: 4px; }.broadcast-input { box-sizing: border-box; display: block; width: 100%; min-width: 0; height: 27px; margin: 0; padding: 0 8px; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); color: var(--text-strong); font: inherit; font-size: 10px; line-height: 25px; }.broadcast-input:focus { border-color: var(--focus); outline: 2px solid color-mix(in srgb, var(--focus) 22%, transparent); }.broadcast-input:disabled { cursor: not-allowed; background: var(--surface-soft); color: var(--faint); }
.broadcast-expand-button { display: grid; place-items: center; width: 27px; height: 27px; padding: 0; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); color: var(--muted); }.broadcast-expand-button:hover:not(:disabled) { border-color: var(--focus); background: var(--hover); color: var(--text-strong); }.broadcast-expand-button:disabled { cursor: not-allowed; background: var(--surface-soft); color: var(--faint); }
.broadcast-send-button { display: inline-flex; align-items: center; justify-content: center; height: 27px; margin: 0; padding: 0 9px; border: 1px solid var(--accent); border-radius: 4px; background: var(--accent); color: #fff; font-size: 9px; font-weight: 680; line-height: 1; white-space: nowrap; }.broadcast-send-button:disabled { cursor: not-allowed; border-color: var(--line); background: var(--surface-soft); color: var(--faint); }
.broadcast-upload-all-button { display: inline-flex; align-items: center; justify-content: center; gap: 4px; height: 27px; margin: 0; padding: 0 8px; border: 1px solid color-mix(in srgb, var(--accent) 48%, var(--line)); border-radius: 4px; background: var(--accent-soft); color: var(--accent); font-size: 9px; font-weight: 680; line-height: 1; white-space: nowrap; }.broadcast-upload-all-button:hover:not(:disabled) { border-color: var(--accent); background: var(--accent); color: #fff; }.broadcast-upload-all-button:disabled { cursor: not-allowed; border-color: var(--line); background: var(--surface-soft); color: var(--faint); opacity: .72; }
.broadcast-status { min-width: 0; overflow: hidden; color: var(--muted); font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }
.broadcast-editor-backdrop { position: absolute; z-index: 15; inset: 0; display: grid; place-items: center; padding: 16px; background: rgb(20 24 29 / 48%); backdrop-filter: blur(1px); }.broadcast-editor-dialog { display: grid; grid-template-rows: auto minmax(180px, 1fr) auto; width: min(760px, 100%); height: min(520px, 100%); min-width: 0; min-height: 0; overflow: hidden; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); box-shadow: 0 20px 48px rgb(20 24 29 / 28%); }.broadcast-editor-dialog header,.broadcast-editor-dialog footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; padding: 9px 10px; border-bottom: 1px solid var(--line); background: var(--panel); }.broadcast-editor-dialog header strong { color: var(--text-strong); font-size: 12px; }.broadcast-editor-dialog header button { display: grid; place-items: center; width: 27px; height: 27px; padding: 0; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); color: var(--muted); }.broadcast-editor-dialog header button:hover { border-color: var(--focus); background: var(--hover); color: var(--text-strong); }.broadcast-editor-dialog textarea { box-sizing: border-box; width: 100%; min-width: 0; min-height: 0; padding: 12px; resize: none; border: 0; background: var(--surface); color: var(--text-strong); font: inherit; font-size: 12px; line-height: 1.55; outline: 0; }.broadcast-editor-dialog textarea:focus { box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--focus) 32%, transparent); }.broadcast-editor-dialog textarea:disabled { cursor: not-allowed; background: var(--surface-soft); color: var(--faint); }.broadcast-editor-dialog footer { min-height: 46px; border-top: 1px solid var(--line); border-bottom: 0; }.broadcast-editor-dialog footer span { min-width: 0; overflow: hidden; color: var(--muted); font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }.broadcast-editor-send-button { flex: 0 0 auto; min-height: 28px; padding: 0 10px; border: 1px solid var(--accent); border-radius: 4px; background: var(--accent); color: #fff; font-size: 10px; font-weight: 680; }.broadcast-editor-send-button:disabled { cursor: not-allowed; border-color: var(--line); background: var(--surface-soft); color: var(--faint); }
@media (max-width: 1180px) {
  .shell-title { display: none; }
  .history-shell-heading span { display: none; }
  .hostbar-tools button { padding-inline: 7px; }
}
@media (max-width: 980px) {
  .hostbar-tools button span { display: none; }
  .hostbar-tools button { width: 29px; padding: 0; }
  .broadcast-bar { grid-template-columns: auto minmax(120px, 1fr) auto auto; }
  .broadcast-status { grid-column: 2 / -1; }
}
@media (max-width: 680px) {
  .broadcast-bar { grid-template-columns: minmax(0, 1fr) auto auto; }
  .broadcast-toggle { grid-column: 1 / -1; }
  .broadcast-status { grid-column: 1 / -1; }
}
</style>
