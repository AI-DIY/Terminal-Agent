<script setup lang="ts">
import { Files, History, LayoutGrid, Plus, X } from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import type { ShellHistorySummary } from '../../../../shared/contracts'
import SessionTabs from '../SessionTabs.vue'
import TerminalPane from '../TerminalPane.vue'
import FileTransferPanel from './FileTransferPanel.vue'
import { sessionDisplayLabel, sessionDisplayParts, sessionHasDuplicateHost, sessionLabel, type SessionView } from '../../stores/sessions'
import {
  getLayoutPreferencesStore,
  SHELL_FONT_SIZE_PRESETS,
  SHELL_ROW_HEIGHT_PRESETS,
  shellGridStyle,
} from '../../stores/layout-preferences'

const props = defineProps<{
  sessions: SessionView[]
  currentSessions: SessionView[]
  visibleSessionIds: string[]
  activeSessionId: string | null
  shellCount: number
  isLive: boolean
  liveChatAvailable: boolean
  historyHosts: ShellHistorySummary[]
  selectedHistoryHosts: string[]
}>()
const emit = defineEmits<{
  select: [sessionId: string]
  close: [sessionId: string]
  connect: []
  restoreLive: []
  history: [hostname: string]
  historyMenu: [historyId: string]
  reconnect: [historyId: string]
  toggleHistoryHost: [hostname: string]
  reorder: [sessionIds: string[]]
}>()

const layout = getLayoutPreferencesStore()
const layoutMenuOpen = ref(false)
const menuHistoryId = ref<string | null>(null)
const fileTransferSessionId = ref<string | null>(null)
const draggingSessionId = ref<string | null>(null)
const dragOverSessionId = ref<string | null>(null)
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
const layoutItemCount = computed(() => props.isLive
  ? orderedCurrentSessions.value.length
  : props.historyHosts.length)
const layoutSummary = computed(() => {
  const count = layoutItemCount.value
  const columns = Math.max(1, Math.min(layout.state.columns, count || 1))
  return count === 0 ? '尚未接入 SSH' : `${count} 个 SSH · ${Math.ceil(count / columns)} 行`
})

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

function openFileTransfer(session: SessionView): void {
  layoutMenuOpen.value = false
  menuHistoryId.value = null
  fileTransferSessionId.value = fileTransferSessionId.value === session.id ? null : session.id
}

function closeFileTransfer(): void {
  fileTransferSessionId.value = null
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

const fileTransferSession = computed(() => fileTransferSessionId.value
  ? orderedCurrentSessions.value.find(session => session.id === fileTransferSessionId.value) ?? null
  : null)

function openHistoryMenu(historyId: string): void {
  layoutMenuOpen.value = false
  menuHistoryId.value = menuHistoryId.value === historyId ? null : historyId
}

defineExpose({ openHistoryMenu })

function reconnectHistory(historyId: string): void {
  menuHistoryId.value = null
  emit('reconnect', historyId)
}

function openSessionHistory(session: SessionView): void {
  menuHistoryId.value = null
  emit('history', sessionLabel(session))
}

function openHistoricalSessionHistory(hostname: string): void {
  menuHistoryId.value = null
  emit('history', hostname)
}

function displayBaseLabel(session: SessionView): string {
  return sessionDisplayParts(session, orderedCurrentSessions.value)?.displayLabel.replace(/\s+#\d+$/, '') ?? sessionDisplayLabel(session, orderedCurrentSessions.value)
}

function displayOrdinal(session: SessionView): number | null {
  return sessionHasDuplicateHost(session, orderedCurrentSessions.value)
    ? sessionDisplayParts(session, orderedCurrentSessions.value)?.ordinal ?? null
    : null
}

/**
 * A historical host is still a filter in the read-only task view.  When a
 * live task has terminals mounted, however, the historical row sits beside
 * the live canvas and must open the same Shell History dialog as the card
 * action; otherwise the click appears to do nothing because the playback
 * slot is intentionally not mounted in the live view.
 */
function handleHistoryHostClick(hostname: string): void {
  if (props.isLive && props.currentSessions.length > 0) {
    openHistoricalSessionHistory(hostname)
    return
  }
  emit('toggleHistoryHost', hostname)
}

function historyHostActionLabel(hostname: string): string {
  return props.isLive && props.currentSessions.length > 0
    ? `打开 SSH 历史 ${hostname}`
    : `筛选 SSH 历史 ${hostname}`
}

watch(
  () => props.currentSessions.map(session => session.id),
  () => {
    layoutMenuOpen.value = false
    if (fileTransferSessionId.value && !props.currentSessions.some(session => session.id === fileTransferSessionId.value)) {
      fileTransferSessionId.value = null
    }
  },
)
watch(
  [() => props.isLive, () => props.currentSessions.length],
  ([isLive, currentSessionCount]) => {
    if (!isLive || currentSessionCount === 0) layoutMenuOpen.value = false
    if (isLive || currentSessionCount === 0) menuHistoryId.value = null
  },
)
</script>

<template>
  <section class="shell-canvas" :class="{ empty: isLive && currentSessions.length === 0 }">
    <header v-show="currentSessions.length > 0 || !isLive" class="shell-toolbar-content">
      <SessionTabs
        v-if="isLive && currentSessions.length"
        :sessions="orderedCurrentSessions"
        :active-session-id="activeSessionId"
        @select="selectSession"
        @close="closeSession"
        @reorder="emit('reorder', $event)"
      />
       <div v-else class="history-toolbar-title"><strong>SSH 历史回放</strong><span>{{ historyHosts.length }} 台主机 · {{ historyHosts.length }} 条记录</span></div>
      <div class="hostbar-tools">
        <div v-if="isLive" class="shell-title">
          <strong>SSH</strong>
          <span>{{ shellCount }} 个主机 · {{ displayedSessionIds.length }} 个连接</span>
        </div>
        <span v-else class="history-readonly-note">以下 SSH 已关闭，仅提供只读回放</span>
        <button v-if="isLive" type="button" class="connect-button" @click="emit('connect')"><Plus :size="13" aria-hidden="true" /><span>新建 SSH 连接</span></button>
        <button v-else-if="liveChatAvailable" type="button" class="connect-button" @click="emit('restoreLive')">返回实时任务</button>
        <button
          v-if="(isLive && currentSessions.length) || (!isLive && historyHosts.length)"
          type="button"
          class="layout-button"
          aria-label="SSH 窗口布局"
          aria-haspopup="true"
          :aria-expanded="layoutMenuOpen"
          @click="layoutMenuOpen = !layoutMenuOpen"
        ><LayoutGrid :size="13" aria-hidden="true" /><span>SSH 窗口布局</span></button>
      </div>
      <section v-if="layoutMenuOpen && ((isLive && currentSessions.length) || (!isLive && historyHosts.length))" class="layout-menu" aria-label="SSH 窗口布局设置">
        <strong>SSH 窗口布局</strong>
        <label>每行数量
          <select :value="layout.state.columns" @change="updateLayout('columns', $event)">
            <option v-for="value in 4" :key="value" :value="value">{{ value }}</option>
          </select>
        </label>
        <label>SSH 字体大小
          <select :value="layout.state.fontSize" @change="updateLayout('fontSize', $event)">
            <option v-for="preset in SHELL_FONT_SIZE_PRESETS" :key="preset.value" :value="preset.value">{{ preset.label }} · {{ preset.value }}px</option>
          </select>
        </label>
        <label>单行高度（占工作区）
          <select :value="layout.state.rowHeightPercent" @change="updateLayout('rowHeightPercent', $event)">
            <option v-for="preset in SHELL_ROW_HEIGHT_PRESETS" :key="preset.value" :value="preset.value">{{ preset.label }} · {{ preset.value }}%</option>
          </select>
        </label>
        <span>{{ layoutSummary }}</span>
      </section>
    </header>
    <section v-if="historyHosts.length" class="history-shell-toolbar" aria-label="历史 SSH 连接">
      <div class="history-shell-heading"><strong>历史 SSH 连接</strong><span>{{ selectedHistoryHosts.length }} / {{ historyHosts.length }} 台已选择</span></div>
      <div class="history-shell-tabs">
        <div v-for="host in historyHosts" :key="host.hostname" class="history-host-item">
          <button
            type="button"
            class="history-shell-tab"
            :class="{ selected: selectedHistoryHosts.includes(host.hostname) }"
            :aria-label="historyHostActionLabel(host.hostname)"
            :aria-pressed="selectedHistoryHosts.includes(host.hostname)"
            @click="handleHistoryHostClick(host.hostname)"
            @contextmenu.prevent="emit('historyMenu', host.id)"
          ><span class="host-status" aria-hidden="true" />{{ host.title }}</button>
          <section v-if="menuHistoryId === host.id" class="history-context-menu" role="menu" :aria-label="`历史 SSH 操作 ${host.hostname}`">
            <button
              type="button"
              role="menuitem"
              :disabled="!host.reconnectable"
              title="重新连接：仅仍保留安全连接描述的历史 SSH 可以重连"
              @click="reconnectHistory(host.id)"
            >重连</button>
            <button type="button" role="menuitem" @click="openHistoricalSessionHistory(host.hostname)">查看 SSH 历史</button>
          </section>
        </div>
      </div>
    </section>

    <div class="canvas-content">
      <section
        v-show="isLive && currentSessions.length > 0"
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
              <button type="button" :aria-label="`文件传输 ${sessionDisplayLabel(session, orderedCurrentSessions)}`" title="文件传输" @click="openFileTransfer(session)"><Files :size="14" aria-hidden="true" /></button>
              <button type="button" :aria-label="`查看 SSH 历史 ${sessionDisplayLabel(session, orderedCurrentSessions)}`" title="历史会话" @click="openSessionHistory(session)"><History :size="14" aria-hidden="true" /></button>
              <button type="button" :aria-label="`关闭画布终端会话 ${sessionDisplayLabel(session, orderedCurrentSessions)}`" title="关闭 SSH" class="close-terminal" @click="closeSession(session.id)"><X :size="15" aria-hidden="true" /></button>
            </div>
          </header>
          <TerminalPane :session="session" :active="session.id === activeSessionId" :font-size="layout.state.fontSize" @activate="selectSession(session.id)" />
        </article>
      </section>

      <section v-if="!isLive" class="history-slot"><slot name="history" /></section>
      <section v-else-if="currentSessions.length === 0" class="empty-slot"><slot name="empty" /></section>
      <FileTransferPanel
        v-if="fileTransferSession"
        :session-id="fileTransferSession.id"
        :hostname="fileTransferSession.observedHostname || fileTransferSession.hostname"
        @close="closeFileTransfer"
      />
    </div>
  </section>
</template>

<style scoped>
.shell-canvas { position: relative; display: grid; grid-template-rows: 42px auto minmax(0, 1fr); width: 100%; height: 100%; min-width: 0; min-height: 0; overflow: hidden; background: var(--surface); }
.shell-canvas.empty { grid-template-rows: minmax(0, 1fr); }
.shell-canvas.empty .canvas-content { grid-row: 1; }
.shell-toolbar-content { position: relative; display: flex; align-items: stretch; min-width: 0; height: 42px; border-bottom: 1px solid var(--line); background: var(--panel); }
.history-toolbar-title { display: flex; min-width: 0; flex: 1 1 auto; align-items: center; gap: 7px; padding: 0 11px; }.history-toolbar-title strong { color: var(--text-strong); font-size: 11px; }.history-toolbar-title span { color: var(--muted); font-size: 9px; }
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
.terminal-frame.selected { border-color: var(--red); box-shadow: inset 0 2px 0 var(--red); }
.terminal-frame > header { display: flex; align-items: center; gap: 7px; min-width: 0; padding: 0 7px 0 10px; border-bottom: 1px solid var(--line); background: var(--panel); color: var(--text); cursor: grab; }
.terminal-frame > header:active { cursor: grabbing; }
.terminal-frame > header strong { min-width: 36px; max-width: min(30cqw, 180px); overflow: hidden; color: var(--text-strong); font-size: 10px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.terminal-frame > header > span:not(.host-ordinal) { min-width: 0; flex: 1 1 auto; overflow: hidden; color: var(--faint); font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }
.terminal-frame > header > .host-ordinal { align-self: flex-start; flex: 0 0 auto; margin-top: 5px; padding: 1px 4px; border: 1px solid var(--amber-line); border-radius: 3px; background: var(--amber-soft); color: var(--amber); font-size: 8px; font-weight: 750; line-height: 1.1; }
.terminal-actions { display: flex; flex: 0 0 auto; gap: 3px; margin-left: auto; }
.terminal-actions button { display: grid; place-items: center; width: 26px; height: 26px; padding: 0; border: 0; border-radius: 4px; background: transparent; color: var(--muted); }
.terminal-actions button:hover,.terminal-actions button:focus-visible { background: var(--hover); color: var(--text-strong); }.terminal-actions .close-terminal:hover { color: var(--red); }
.terminal-frame :deep(.terminal-pane) { height: 100%; border: 0; }
.history-context-menu { position: absolute; z-index: 9; top: 30px; right: auto; left: 0; display: grid; min-width: 154px; padding: 4px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); box-shadow: 0 14px 36px rgb(24 31 40 / 22%); }
.history-context-menu button { min-height: 29px; padding: 0 8px; border: 0; border-radius: 3px; background: transparent; color: var(--text); font-size: 11px; text-align: left; }.history-context-menu button:hover,.history-context-menu button:focus-visible { background: var(--surface-soft); outline: 1px solid var(--accent); }.history-context-menu button:disabled { color: var(--muted); cursor: not-allowed; }
.empty-slot,.history-slot { width: 100%; height: 100%; min-width: 0; min-height: 0; overflow: hidden; }
.history-shell-toolbar { position: relative; display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 10px; min-height: 38px; padding: 4px 9px; border-bottom: 1px solid var(--line); background: color-mix(in srgb, var(--panel) 86%, var(--surface)); }
.history-shell-heading { display: flex; align-items: baseline; gap: 6px; white-space: nowrap; }.history-shell-heading strong { color: var(--text-strong); font-size: 10px; }.history-shell-heading span { color: var(--muted); font-size: 9px; }
.history-shell-tabs { display: flex; gap: 5px; min-width: 0; overflow-x: auto; overflow-y: hidden; }.history-host-item { position: relative; flex: 0 0 auto; }.history-shell-tab { display: flex; align-items: center; gap: 5px; min-height: 27px; padding: 3px 8px; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); color: var(--muted); font-size: 10px; white-space: nowrap; }.history-shell-tab:hover,.history-shell-tab:focus-visible { border-color: var(--accent); color: var(--text); outline: 0; }.history-shell-tab.selected { border-color: color-mix(in srgb, var(--accent) 68%, var(--line)); background: var(--accent-soft); color: var(--text-strong); }.host-status { width: 6px; height: 6px; border-radius: 50%; background: var(--muted); }.history-shell-tab.selected .host-status { background: var(--accent); }
@media (max-width: 1180px) {
  .shell-title { display: none; }
  .history-shell-heading span { display: none; }
  .hostbar-tools button { padding-inline: 7px; }
}
@media (max-width: 980px) {
  .hostbar-tools button span { display: none; }
  .hostbar-tools button { width: 29px; padding: 0; }
}
</style>
