<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { ChatShellAssociation, ShellHistorySummary } from '../../../../shared/contracts'
import ModeIndicator from '../ModeIndicator.vue'
import SessionTabs from '../SessionTabs.vue'
import TerminalPane from '../TerminalPane.vue'
import { sessionLabel, type SessionView } from '../../stores/sessions'
import {
  createShellCanvasState,
  getLayoutPreferencesStore,
  shellPanePresentations,
} from '../../stores/layout-preferences'

const props = defineProps<{
  sessions: SessionView[]
  currentSessions: SessionView[]
  visibleSessionIds: string[]
  activeSessionId: string | null
  shellCount: number
  isLive: boolean
  liveChatAvailable: boolean
  historyShells: ChatShellAssociation[]
  historyRecords: ShellHistorySummary[]
}>()
const emit = defineEmits<{
  select: [sessionId: string]
  close: [sessionId: string]
  connect: []
  openSaved: []
  upgrade: []
  restoreLive: []
  duplicate: [sessionId: string]
  history: [hostname: string]
  historyMenu: [historyId: string]
  reconnect: [historyId: string]
}>()

const layout = getLayoutPreferencesStore()
const canvas = createShellCanvasState()
const layoutMenuOpen = ref(false)
const menuSessionId = ref<string | null>(null)
const menuHistoryId = ref<string | null>(null)
const focused = computed(() => canvas.maximizedSessionId.value !== null)
const activeSession = computed(() => props.currentSessions.find(session => session.id === props.activeSessionId) ?? null)
const currentSessionIds = computed(() => new Set(props.currentSessions.map(session => session.id)))
const displayedSessionIds = computed(() => props.visibleSessionIds.slice(0, layout.state.visibleCount))
const presentations = computed(() => shellPanePresentations(
  props.sessions.map(session => session.id),
  props.isLive ? displayedSessionIds.value : [],
  props.isLive ? canvas.maximizedSessionId.value : null,
))
const visibleBySessionId = computed(() => new Map(presentations.value.map(item => [item.sessionId, item.visible])))
const gridColumns = computed(() => Math.max(1, Math.min(layout.state.columns, displayedSessionIds.value.length || 1)))
const gridStyle = computed(() => focused.value
  ? { gridTemplateColumns: 'minmax(0, 1fr)', gridAutoRows: 'minmax(0, 1fr)' }
  : {
      gridTemplateColumns: `repeat(${gridColumns.value}, minmax(210px, 1fr))`,
      gridAutoRows: `${layout.state.rowHeight}px`,
    })
const layoutSummary = computed(() => {
  const count = Math.min(displayedSessionIds.value.length, props.currentSessions.length)
  return count === 0 ? '尚未接入 Shell' : `${count} 个 Shell · ${Math.ceil(count / gridColumns.value)} 行`
})

function paneVisible(sessionId: string): boolean {
  return currentSessionIds.value.has(sessionId) && visibleBySessionId.value.get(sessionId) === true
}

function selectSession(sessionId: string): void {
  if (canvas.maximizedSessionId.value) canvas.maximizedSessionId.value = sessionId
  emit('select', sessionId)
}

function updateLayout(field: 'visibleCount' | 'columns' | 'rowHeight', event: Event): void {
  const value = Number((event.target as HTMLSelectElement).value)
  const patch = { [field]: value }
  layout.previewLayout(patch)
  void layout.saveLayout(patch).catch(() => undefined)
}

function closeSession(sessionId: string): void {
  if (canvas.maximizedSessionId.value === sessionId) canvas.restore()
  emit('close', sessionId)
}

function toggleMaximize(sessionId: string): void {
  layoutMenuOpen.value = false
  canvas.toggleMaximize(sessionId)
}

function openTerminalMenu(sessionId: string): void {
  layoutMenuOpen.value = false
  menuHistoryId.value = null
  menuSessionId.value = menuSessionId.value === sessionId ? null : sessionId
}

function duplicateSession(sessionId: string): void {
  menuSessionId.value = null
  emit('duplicate', sessionId)
}

function historyRecord(historyId: string): ShellHistorySummary | undefined {
  return props.historyRecords.find(record => record.id === historyId)
}

function openHistoryMenu(historyId: string): void {
  layoutMenuOpen.value = false
  menuSessionId.value = null
  menuHistoryId.value = menuHistoryId.value === historyId ? null : historyId
}

defineExpose({ openHistoryMenu })

function reconnectHistory(historyId: string): void {
  menuHistoryId.value = null
  emit('reconnect', historyId)
}

function openSessionHistory(session: SessionView): void {
  menuSessionId.value = null
  menuHistoryId.value = null
  emit('history', session.hostname)
}

function openHistoricalSessionHistory(hostname: string): void {
  menuHistoryId.value = null
  emit('history', hostname)
}

watch(
  () => props.currentSessions.map(session => session.id),
  sessionIds => {
    layoutMenuOpen.value = false
    if (canvas.maximizedSessionId.value && !sessionIds.includes(canvas.maximizedSessionId.value)) canvas.restore()
  },
)
watch(
  [() => props.isLive, () => props.currentSessions.length],
  ([isLive, currentSessionCount]) => {
    if (!isLive || currentSessionCount === 0) layoutMenuOpen.value = false
    if (!isLive || currentSessionCount === 0) menuSessionId.value = null
    if (isLive || currentSessionCount === 0) menuHistoryId.value = null
  },
)
</script>

<template>
  <section class="shell-canvas" :class="{ focused }">
    <header v-show="!focused" class="shell-toolbar-content">
      <div class="shell-title">
        <strong>Shell 工作区</strong>
        <span>{{ shellCount }} 个关联 · {{ displayedSessionIds.length }} 个正在显示</span>
      </div>
      <div class="toolbar-actions">
        <ModeIndicator v-if="activeSession" :mode="activeSession.mode" />
        <button v-if="activeSession?.mode === 'copilot'" type="button" class="upgrade-button" @click="emit('upgrade')">升级为全自动驾驶</button>
        <button v-if="isLive" type="button" class="saved-sessions-button" @click="emit('openSaved')">已保存会话</button>
        <button v-if="isLive" type="button" class="connect-button" @click="emit('connect')">新建 SSH 连接</button>
        <button v-else-if="liveChatAvailable" type="button" class="connect-button" @click="emit('restoreLive')">返回实时聊天</button>
        <button
          v-if="isLive && currentSessions.length"
          type="button"
          class="layout-button"
          aria-haspopup="true"
          :aria-expanded="layoutMenuOpen"
          @click="layoutMenuOpen = !layoutMenuOpen"
        >Shell 布局</button>
      </div>
      <section v-if="layoutMenuOpen && isLive && currentSessions.length" class="layout-menu" aria-label="Shell 布局设置">
        <strong>Shell 布局</strong>
        <label>当前展示数量
          <select :value="layout.state.visibleCount" @change="updateLayout('visibleCount', $event)">
            <option v-for="value in 4" :key="value" :value="value">{{ value }}</option>
          </select>
        </label>
        <label>每行数量
          <select :value="layout.state.columns" @change="updateLayout('columns', $event)">
            <option v-for="value in 4" :key="value" :value="value">{{ value }}</option>
          </select>
        </label>
        <label>单行高度
          <select :value="layout.state.rowHeight" @change="updateLayout('rowHeight', $event)">
            <option value="260">紧凑</option>
            <option value="330">标准</option>
            <option value="410">宽松</option>
          </select>
        </label>
        <span>{{ layoutSummary }}</span>
      </section>
    </header>

    <SessionTabs
      v-show="isLive && !focused"
      v-if="currentSessions.length"
      :sessions="currentSessions"
      :active-session-id="activeSessionId"
      @select="selectSession"
      @close="closeSession"
    />
    <div v-if="historyShells.length" class="history-shell-tabs" aria-label="历史 Shell 关联">
      <template v-for="shell in historyShells" :key="shell.id">
        <button
          type="button"
          class="history-shell-tab"
          :aria-label="`历史 Shell ${shell.hostname}`"
          @click="emit('history', shell.hostname)"
          @contextmenu.prevent="emit('historyMenu', shell.historyId)"
        >{{ shell.title }}</button>
        <section v-if="menuHistoryId === shell.historyId" class="terminal-context-menu history-context-menu" role="menu" :aria-label="`历史 Shell 操作 ${shell.hostname}`">
          <button type="button" role="menuitem" disabled title="历史 Shell 没有可复制的实时会话">复制 SSH 通道</button>
          <button
            type="button"
            role="menuitem"
            :disabled="!historyRecord(shell.historyId)?.reconnectable"
            title="仅仍保留安全连接描述的历史 Shell 可以重新连接"
            @click="reconnectHistory(shell.historyId)"
          >重新连接</button>
          <button type="button" role="menuitem" @click="openHistoricalSessionHistory(shell.hostname)">查看 Shell 历史</button>
        </section>
      </template>
    </div>

    <div class="canvas-content">
      <section
        v-show="isLive && currentSessions.length > 0"
        class="terminal-grid"
        aria-label="可见终端面板"
        :data-columns="gridColumns"
        :data-row-height="layout.state.rowHeight"
        :style="gridStyle"
      >
        <article
          v-for="session in sessions"
          v-show="paneVisible(session.id)"
          :key="session.id"
          class="terminal-frame"
          :class="{ maximized: canvas.maximizedSessionId.value === session.id }"
          @contextmenu.prevent="openTerminalMenu(session.id)"
        >
          <header>
            <strong>{{ sessionLabel(session) }}</strong>
            <span>{{ session.mode === 'copilot' ? '辅助驾驶' : '全自动驾驶' }}</span>
            <div class="terminal-actions">
              <button
                type="button"
                :aria-label="`${canvas.maximizedSessionId.value === session.id ? '还原' : '最大化'}终端会话 ${sessionLabel(session)}`"
                :title="canvas.maximizedSessionId.value === session.id ? '还原' : '最大化'"
                @click="toggleMaximize(session.id)"
              >{{ canvas.maximizedSessionId.value === session.id ? '↙' : '↗' }}</button>
              <button type="button" :aria-label="`终端操作 ${sessionLabel(session)}`" title="终端操作" @click="openTerminalMenu(session.id)">⋯</button>
              <button type="button" :aria-label="`关闭画布终端会话 ${sessionLabel(session)}`" title="关闭 Shell" @click="closeSession(session.id)">×</button>
            </div>
          </header>
          <section v-if="menuSessionId === session.id" class="terminal-context-menu" role="menu" :aria-label="`终端操作 ${sessionLabel(session)}`">
            <button type="button" role="menuitem" @click="duplicateSession(session.id)">复制 SSH 通道</button>
            <button type="button" role="menuitem" disabled title="仅已关闭且仍保留安全连接描述的 Shell 可以重新连接">重新连接</button>
            <button type="button" role="menuitem" @click="openSessionHistory(session)">查看 Shell 历史</button>
          </section>
          <TerminalPane :session="session" :active="session.id === activeSessionId" @activate="selectSession(session.id)" />
        </article>
      </section>

      <section v-if="!isLive" class="history-slot"><slot name="history" /></section>
      <section v-else-if="currentSessions.length === 0" class="empty-slot"><slot name="empty" /></section>
    </div>
  </section>
</template>

<style scoped>
.shell-canvas { position: relative; display: grid; grid-template-rows: auto auto minmax(0, 1fr); width: 100%; height: 100%; min-width: 0; min-height: 0; overflow: hidden; background: var(--surface); }
.shell-canvas.focused { grid-template-rows: minmax(0, 1fr); }
.shell-toolbar-content { position: relative; display: flex; align-items: center; justify-content: space-between; gap: 10px; min-width: 0; min-height: 45px; padding: 0 10px; border-bottom: 1px solid var(--line); background: var(--surface-soft); }
.shell-title { display: flex; align-items: baseline; gap: 8px; min-width: 0; overflow: hidden; }
.shell-title strong { color: var(--text-strong); font-size: 12px; white-space: nowrap; }
.shell-title span { overflow: hidden; color: var(--muted); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.toolbar-actions { display: flex; align-items: center; justify-content: flex-end; gap: 6px; min-width: 0; }
.toolbar-actions button { min-height: 30px; padding: 0 10px; border: 1px solid var(--line); border-radius: 5px; background: var(--surface); color: var(--text); font-size: 11px; white-space: nowrap; }
.toolbar-actions .connect-button { border-color: var(--accent); background: var(--accent); color: #fff; font-weight: 650; }
.toolbar-actions .upgrade-button { border-color: var(--green); color: var(--green); }
.layout-menu { position: absolute; z-index: 5; top: calc(100% + 5px); right: 8px; display: grid; grid-template-columns: minmax(120px, 1fr) 86px; gap: 9px 12px; width: 264px; padding: 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); box-shadow: 0 12px 30px rgb(16 24 40 / 14%); }
.layout-menu > strong,.layout-menu > span { grid-column: 1 / -1; color: var(--text-strong); font-size: 11px; }
.layout-menu > span { color: var(--muted); }
.layout-menu label { display: contents; color: var(--text); font-size: 11px; }
.layout-menu select { width: 86px; height: 28px; padding: 0 6px; border: 1px solid var(--line); border-radius: 4px; background: var(--surface-soft); color: var(--text); }
.canvas-content { position: relative; min-width: 0; min-height: 0; overflow: hidden; }
.terminal-grid { display: grid; align-content: start; width: 100%; height: 100%; min-width: 0; min-height: 0; gap: 8px; padding: 8px; overflow: auto; }
.terminal-frame { position: relative; display: grid; grid-template-rows: 30px minmax(0, 1fr); min-width: 0; min-height: 0; overflow: hidden; border: 1px solid var(--line); background: var(--terminal); }
.terminal-frame > header { display: flex; align-items: center; gap: 7px; min-width: 0; padding: 0 5px 0 9px; border-bottom: 1px solid #343a42; background: #20262d; color: #d8dade; }
.terminal-frame > header strong { overflow: hidden; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.terminal-frame > header > span { color: #9ca5af; font-size: 9px; white-space: nowrap; }
.terminal-actions { display: flex; gap: 2px; margin-left: auto; }
.terminal-actions button { width: 26px; height: 26px; padding: 0; border: 0; border-radius: 3px; background: transparent; color: #b7bec6; font-size: 15px; }
.terminal-actions button:hover,.terminal-actions button:focus-visible { background: #343b44; color: #fff; outline: 1px solid var(--accent); }
.terminal-frame :deep(.terminal-pane) { height: 100%; border: 0; }
.terminal-frame.maximized { grid-column: 1 / -1; height: 100%; }
.terminal-context-menu { position: absolute; z-index: 6; top: 30px; right: 5px; display: grid; min-width: 142px; padding: 4px; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); box-shadow: 0 10px 24px rgb(16 24 40 / 20%); }
.terminal-context-menu button { min-height: 29px; padding: 0 8px; border: 0; border-radius: 3px; background: transparent; color: var(--text); font-size: 11px; text-align: left; }.terminal-context-menu button:hover,.terminal-context-menu button:focus-visible { background: var(--surface-soft); outline: 1px solid var(--accent); }.terminal-context-menu button:disabled { color: var(--muted); cursor: not-allowed; }
.empty-slot,.history-slot { width: 100%; height: 100%; min-width: 0; min-height: 0; overflow: auto; }
.history-shell-tabs { position: relative; display: flex; gap: 6px; min-height: 34px; padding: 5px 10px; overflow-x: auto; border-bottom: 1px solid var(--line-soft); }
.history-shell-tabs button { padding: 4px 8px; border: 1px solid var(--line); border-radius: 4px; background: transparent; color: var(--muted); font-size: 10px; white-space: nowrap; }
.history-shell-tabs button:hover,.history-shell-tabs button:focus-visible { border-color: var(--accent); color: var(--text); outline: 0; }
.history-context-menu { top: 34px; right: 8px; }
@media (max-width: 1060px) { .upgrade-button,.saved-sessions-button { display: none; } .shell-title span { display: none; } }
</style>
