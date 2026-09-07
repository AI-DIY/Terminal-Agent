<script setup lang="ts">
import { Files, History, LayoutGrid, Plus, X } from '@lucide/vue'
import { computed, ref, watch } from 'vue'
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
  liveChatAvailable: boolean
  historyHosts: HistoryHost[]
}>()
const emit = defineEmits<{
  select: [sessionId: string]
  close: [sessionId: string]
  connect: []
  restoreLive: []
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
const fileTransferOpen = ref(false)
const fileTransferSessionId = ref<string | null>(null)
const fileTransferPanelSessionIds = ref<string[]>([])
const fileTransferBusySessionIds = ref(new Set<string>())
const broadcastEnabled = ref(false)
const broadcastInput = ref('')
const broadcastSending = ref(false)
const broadcastStatus = ref('')
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
const fileTransferPanelSessions = computed(() => {
  const mounted = new Set(fileTransferPanelSessionIds.value)
  return orderedCurrentSessions.value.filter(session => mounted.has(session.id))
})
const canUseWorkspaceControls = computed(() => props.isLive && orderedCurrentSessions.value.length > 0)
const fileTransferBusy = computed(() => fileTransferBusySessionIds.value.size > 0)

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
  fileTransferSessionId.value = sessionId
}

function toggleFileTransfer(): void {
  if (!canUseWorkspaceControls.value) return
  const target = orderedCurrentSessions.value.find(session => session.id === props.activeSessionId)
    ?? orderedCurrentSessions.value[0]
  if (!target) return
  if (fileTransferOpen.value && fileTransferSessionId.value === target.id) {
    fileTransferOpen.value = false
    return
  }
  mountFileTransferSession(target.id)
  fileTransferOpen.value = true
  layoutMenuOpen.value = false
  menuHistoryId.value = null
}

function closeFileTransfer(): void {
  fileTransferOpen.value = false
}

function setFileTransferBusy(sessionId: string, busy: boolean): void {
  const next = new Set(fileTransferBusySessionIds.value)
  if (busy) next.add(sessionId)
  else next.delete(sessionId)
  fileTransferBusySessionIds.value = next
}

function sendBroadcast(): void {
  if (!broadcastEnabled.value || broadcastSending.value || !canUseWorkspaceControls.value) return
  const value = broadcastInput.value
  if (!value.trim()) return
  const targets = orderedCurrentSessions.value.map(session => session.id)
  if (!targets.length) return
  broadcastSending.value = true
  broadcastStatus.value = `正在发送到 ${targets.length} 个 SSH…`
  // A one-line field represents a command-like keystroke.  Append Enter so
  // the same input can be executed immediately in every shell; callers may
  // still paste control sequences through the terminal itself when needed.
  const data = `${value}\r`
  void Promise.allSettled(targets.map(sessionId => Promise.resolve().then(() => window.terminalAgent.sessions.write(sessionId, data))))
    .then(results => {
      const failed = results.filter(result => result.status === 'rejected').length
      const succeeded = results.length - failed
      broadcastStatus.value = failed
        ? `已发送到 ${succeeded} 个 SSH，${failed} 个会话发送失败。`
        : `已发送到 ${succeeded} 个 SSH。`
      if (!failed) broadcastInput.value = ''
    })
    .catch(() => { broadcastStatus.value = '发送失败，请检查 SSH 连接。' })
    .finally(() => { broadcastSending.value = false })
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
    fileTransferBusySessionIds.value = new Set([...fileTransferBusySessionIds.value].filter(sessionId => available.has(sessionId)))
    if (!sessionIds.length) {
      fileTransferOpen.value = false
      fileTransferSessionId.value = null
      broadcastStatus.value = ''
    } else if (fileTransferOpen.value) {
      const activeId = props.activeSessionId && available.has(props.activeSessionId) ? props.activeSessionId : sessionIds[0]
      mountFileTransferSession(activeId)
    }
  },
)
watch(
  [() => props.activeSessionId, () => fileTransferOpen.value],
  ([activeId, open]) => {
    if (!open || !activeId || !props.currentSessions.some(session => session.id === activeId)) return
    mountFileTransferSession(activeId)
  },
)
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
        <button v-else-if="liveChatAvailable" type="button" class="connect-button" @click="emit('restoreLive')">返回实时任务</button>
        <button
          v-if="isLive && currentSessions.length"
          type="button"
          class="layout-button"
          aria-label="SSH 窗口布局"
          aria-haspopup="true"
          :aria-expanded="layoutMenuOpen"
          @click="layoutMenuOpen = !layoutMenuOpen"
        ><LayoutGrid :size="13" aria-hidden="true" /><span>SSH 窗口布局</span></button>
        <button
          v-if="isLive && currentSessions.length"
          type="button"
          class="file-transfer-button"
          :class="{ busy: fileTransferBusy }"
          :aria-label="fileTransferOpen ? '隐藏文件传输' : '显示文件传输'"
          :aria-expanded="fileTransferOpen"
          :title="fileTransferBusy ? '文件传输中' : (fileTransferOpen ? '隐藏文件传输' : '显示文件传输')"
          @click="toggleFileTransfer"
        ><Files :size="14" aria-hidden="true" /><span v-if="fileTransferBusy">文件传输中</span><span v-else>文件传输</span></button>
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
              <button type="button" :aria-label="`查看 SSH 历史 ${sessionDisplayLabel(session, orderedCurrentSessions)}`" title="历史会话" @click.stop="openSessionHistory(session)"><History :size="14" aria-hidden="true" /></button>
              <button type="button" :aria-label="`关闭画布终端会话 ${sessionDisplayLabel(session, orderedCurrentSessions)}`" title="关闭 SSH" class="close-terminal" @click.stop="closeSession(session.id)"><X :size="15" aria-hidden="true" /></button>
            </div>
          </header>
          <TerminalPane :session="session" :active="session.id === activeSessionId" :font-size="layout.state.fontSize" @activate="selectSession(session.id)" />
        </article>
      </section>

      <section v-if="currentSessions.length === 0" class="empty-slot"><slot name="empty" /></section>
    </div>

    <section v-if="isLive && currentSessions.length" class="broadcast-bar" aria-label="发送键输入到所有会话">
      <label class="broadcast-toggle">
        <input v-model="broadcastEnabled" type="checkbox" aria-label="启用发送键输入到所有会话" />
        <span>发送键输入到所有会话</span>
      </label>
      <input
        v-model="broadcastInput"
        class="broadcast-input"
        type="text"
        autocomplete="off"
        placeholder="输入要发送到所有在线 SSH 的命令"
        :disabled="!broadcastEnabled"
        @keydown.enter.prevent="sendBroadcast"
      />
      <button
        type="button"
        class="broadcast-send-button"
        :disabled="!broadcastEnabled || !broadcastInput.trim() || broadcastSending || !currentSessions.length"
        @click="sendBroadcast"
      >{{ broadcastSending ? '发送中…' : '发送所有窗口执行' }}</button>
      <span class="broadcast-status" role="status" aria-live="polite">{{ broadcastStatus }}</span>
    </section>

    <!-- v-show deliberately keeps every opened panel alive while hidden.  A
         transfer therefore survives switching terminals or collapsing the
         dock; only closing/removing that SSH session destroys its panel. -->
    <section v-if="isLive && fileTransferPanelSessions.length" v-show="fileTransferOpen" class="file-transfer-dock" aria-label="SSH 文件传输面板">
      <div v-for="session in fileTransferPanelSessions" :key="session.id" v-show="session.id === fileTransferSessionId" class="file-transfer-session-panel">
        <FileTransferPanel
          :session-id="session.id"
          :hostname="sessionDisplayLabel(session, orderedCurrentSessions)"
          @close="closeFileTransfer"
          @busy-change="setFileTransferBusy(session.id, $event)"
        />
      </div>
    </section>
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
.hostbar-tools .file-transfer-button.busy { border-color: var(--amber-line); background: var(--amber-soft); color: var(--amber); }
.layout-menu { position: absolute; z-index: 8; top: 46px; right: 8px; display: grid; grid-template-columns: minmax(120px, 1fr) 86px; gap: 9px 12px; width: 264px; padding: 13px; border: 1px solid var(--line); border-radius: 7px; background: var(--surface); box-shadow: 0 14px 36px rgb(24 31 40 / 22%); }
.layout-menu > strong,.layout-menu > span { grid-column: 1 / -1; color: var(--text-strong); font-size: 11px; }
.layout-menu > span { color: var(--muted); }
.layout-menu label { display: contents; color: var(--text); font-size: 11px; }
.layout-menu select { width: 86px; height: 28px; padding: 0 6px; border: 1px solid var(--line); border-radius: 4px; background: var(--surface-soft); color: var(--text); }
.canvas-content { position: relative; display: grid; grid-template-rows: minmax(0, 1fr) auto; grid-row: 3; min-width: 0; min-height: 0; overflow: hidden; }
.terminal-grid { display: grid; align-content: start; width: 100%; height: auto; min-width: 0; min-height: 0; gap: 10px; padding: 10px; overflow-x: auto; overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable; scrollbar-color: transparent transparent; background: var(--surface); }
.terminal-grid:hover,.terminal-grid:focus-within { scrollbar-color: color-mix(in srgb, var(--muted) 58%, transparent) transparent; }
.terminal-grid::-webkit-scrollbar { width: 8px; height: 8px; }
.terminal-grid::-webkit-scrollbar-track { background: transparent; }
.terminal-grid::-webkit-scrollbar-thumb { border: 2px solid transparent; border-radius: 999px; background: transparent; background-clip: padding-box; }
.terminal-grid:hover::-webkit-scrollbar-thumb,.terminal-grid:focus-within::-webkit-scrollbar-thumb { background-color: color-mix(in srgb, var(--muted) 58%, transparent); }
.terminal-grid:hover::-webkit-scrollbar-thumb:hover,.terminal-grid:focus-within::-webkit-scrollbar-thumb:hover { background-color: var(--muted); }
.terminal-frame { position: relative; display: grid; grid-template-rows: 36px minmax(0, 1fr); min-width: 0; min-height: 0; overflow: hidden; border: 1px solid var(--line); border-radius: 6px; background: var(--terminal); container-type: inline-size; }
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
.terminal-frame :deep(.terminal-pane) { height: 100%; min-height: 0; border: 0; }
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
.broadcast-bar { display: grid; grid-row: 4; grid-template-columns: auto minmax(180px, 1fr) auto minmax(0, 220px); align-items: center; gap: 7px; min-width: 0; min-height: 42px; padding: 6px 10px; border-top: 1px solid var(--line); background: var(--panel); }
.broadcast-toggle { display: inline-flex; align-items: center; gap: 5px; color: var(--text-strong); font-size: 10px; font-weight: 650; white-space: nowrap; cursor: pointer; }.broadcast-toggle input { width: 14px; height: 14px; margin: 0; accent-color: var(--accent); }
.broadcast-input { box-sizing: border-box; width: 100%; min-width: 0; height: 27px; padding: 0 8px; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); color: var(--text-strong); font: inherit; font-size: 10px; }.broadcast-input:focus { border-color: var(--focus); outline: 2px solid color-mix(in srgb, var(--focus) 22%, transparent); }.broadcast-input:disabled { cursor: not-allowed; background: var(--surface-soft); color: var(--faint); }
.broadcast-send-button { height: 27px; padding: 0 9px; border: 1px solid var(--accent); border-radius: 4px; background: var(--accent); color: #fff; font-size: 9px; font-weight: 680; white-space: nowrap; }.broadcast-send-button:disabled { cursor: not-allowed; border-color: var(--line); background: var(--surface-soft); color: var(--faint); }
.broadcast-status { min-width: 0; overflow: hidden; color: var(--muted); font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }
.file-transfer-dock { display: block; grid-row: 5; min-width: 0; max-height: min(300px, 48vh); overflow: hidden; background: var(--panel); }
.file-transfer-session-panel { min-width: 0; min-height: 0; }
@media (max-width: 1180px) {
  .shell-title { display: none; }
  .history-shell-heading span { display: none; }
  .hostbar-tools button { padding-inline: 7px; }
}
@media (max-width: 980px) {
  .hostbar-tools button span { display: none; }
  .hostbar-tools button { width: 29px; padding: 0; }
  .hostbar-tools .file-transfer-button.busy { width: auto; padding-inline: 7px; }
  .hostbar-tools .file-transfer-button.busy span { display: inline; }
  .broadcast-bar { grid-template-columns: auto minmax(120px, 1fr) auto; }
  .broadcast-status { grid-column: 2 / -1; }
}
@media (max-width: 680px) {
  .broadcast-bar { grid-template-columns: minmax(0, 1fr) auto; }
  .broadcast-toggle { grid-column: 1 / -1; }
  .broadcast-status { grid-column: 1 / -1; }
}
</style>
