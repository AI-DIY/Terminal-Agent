<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { TerminalDataEvent } from '../../../shared/contracts'
import ConnectionDialog from '../components/ConnectionDialog.vue'
import type { ConnectionDialogRequest } from '../components/ConnectionDialog.vue'
import SavedSessionsDialog from '../components/SavedSessionsDialog.vue'
import SessionTabs from '../components/SessionTabs.vue'
import TerminalPane from '../components/TerminalPane.vue'
import ModeIndicator from '../components/ModeIndicator.vue'
import AgentPanel from '../components/AgentPanel.vue'
import { closeSession } from '../stores/close-session'
import { createFrameBatcher } from '../stores/data-batcher'
import { createSessionsStore, type SessionView } from '../stores/sessions'
import { selectVisiblePane } from '../stores/visible-panes'
import { createAutonomousUpgradeStore } from '../stores/autonomous-upgrade'

const store = createSessionsStore()
const sessions = ref<SessionView[]>([])
const activeSessionId = ref<string | null>(null)
const visibleSessionIds = ref<string[]>([])
const showConnection = ref(false)
const showSavedSessions = ref(false)
const connectionError = ref('')
const savedProfiles = ref<Awaited<ReturnType<typeof window.terminalAgent.sessions.listProfiles>>>([])
const autonomousUpgrade = createAutonomousUpgradeStore()
const visibleSessions = computed(() => visibleSessionIds.value
  .map(sessionId => sessions.value.find(session => session.id === sessionId))
  .filter((session): session is SessionView => Boolean(session)))
const activeSession = computed(() => activeSessionId.value ? sessions.value.find(session => session.id === activeSessionId.value) ?? null : null)
let unsubscribe: (() => void) | undefined
let unsubscribeClosed: (() => void) | undefined
let unsubscribeOpened: (() => void) | undefined
let unsubscribeUpdated: (() => void) | undefined
let unsubscribeAccessClientError: (() => void) | undefined

function sync(): void { sessions.value = store.all() }
const dataBatcher = createFrameBatcher<TerminalDataEvent>(
  events => {
    for (const event of events) store.appendData(event.sessionId, event.data)
    sync()
  },
  callback => window.requestAnimationFrame(callback),
  frameId => window.cancelAnimationFrame(frameId),
)

function select(sessionId: string): void {
  if (!store.byId(sessionId)) return
  visibleSessionIds.value = selectVisiblePane(visibleSessionIds.value, sessionId, activeSessionId.value)
  activeSessionId.value = sessionId
}

function addSession(session: Omit<SessionView, 'buffer'>, activate = true): void {
  const isNew = !store.byId(session.id)
  store.add(session)
  if (isNew && (activate || !activeSessionId.value)) select(session.id)
  sync()
}

function removeSession(sessionId: string): void {
  const wasActive = activeSessionId.value === sessionId
  store.remove(sessionId)
  visibleSessionIds.value = visibleSessionIds.value.filter(id => id !== sessionId)

  const replacement = store.all().find(session => !visibleSessionIds.value.includes(session.id))
  if (replacement) visibleSessionIds.value = selectVisiblePane(visibleSessionIds.value, replacement.id, null)
  if (wasActive) activeSessionId.value = visibleSessionIds.value[0] ?? store.all()[0]?.id ?? null
  sync()
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

async function connect(request: ConnectionDialogRequest): Promise<void> {
  connectionError.value = ''
  try {
    if (request.profile) {
      await window.terminalAgent.sessions.saveProfile(request.profile)
      await refreshSavedProfiles()
    }
    const session = await window.terminalAgent.sessions.connect(request.connection)
    addSession(session)
    showConnection.value = false
    sync()
  } catch (error) {
    connectionError.value = error instanceof Error ? error.message : '无法建立 SSH 会话。'
  }
}

async function openSavedProfile(id: string): Promise<void> {
  connectionError.value = ''
  try {
    const session = await window.terminalAgent.sessions.openProfile(id)
    addSession(session)
    showSavedSessions.value = false
  } catch (error) {
    connectionError.value = error instanceof Error ? error.message : '无法打开已保存的 SSH 会话。'
  }
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

onMounted(() => {
  unsubscribe = window.terminalAgent.sessions.onData(event => dataBatcher.enqueue(event))
  unsubscribeClosed = window.terminalAgent.sessions.onClosed(event => removeSession(event.sessionId))
  unsubscribeOpened = window.terminalAgent.sessions.onOpened(session => addSession(session))
  unsubscribeUpdated = window.terminalAgent.sessions.onUpdated(session => addSession(session, false))
  unsubscribeAccessClientError = window.terminalAgent.accessClient.onError(message => { connectionError.value = message })
  void window.terminalAgent.sessions.list()
    .then(existingSessions => existingSessions.forEach(session => addSession(session, false)))
    .catch(() => { connectionError.value = '无法同步已有终端会话。' })
  void window.terminalAgent.accessClient.errors()
    .then(errors => { connectionError.value = errors.at(-1) ?? connectionError.value })
    .catch(() => { connectionError.value = '无法读取 AccessClient 启动状态。' })
  void refreshSavedProfiles().catch(() => { connectionError.value = '无法读取已保存会话。' })
})
onBeforeUnmount(() => {
  unsubscribe?.()
  unsubscribeClosed?.()
  unsubscribeOpened?.()
  unsubscribeUpdated?.()
  unsubscribeAccessClientError?.()
  dataBatcher.dispose()
})
</script>

<template>
  <main class="workbench">
    <header class="workbench-toolbar">
      <SessionTabs :sessions="sessions" :active-session-id="activeSessionId" @select="select" @close="close" />
      <div class="toolbar-actions">
        <button class="connect-button" type="button" @click="showConnection = true">新建 SSH 连接</button>
        <button class="saved-sessions-button" type="button" @click="showSavedSessions = true">已保存会话</button>
        <ModeIndicator v-if="activeSession" :mode="activeSession.mode" />
        <button v-if="activeSession?.mode === 'copilot'" type="button" class="upgrade-button" @click="requestAutonomousUpgrade">升级为全自动驾驶</button>
        <button type="button" class="settings-button" @click="$emit('show-settings')">设置</button>
        <p v-if="connectionError" class="connection-error" role="alert">{{ connectionError }}</p>
      </div>
    </header>
    <AgentPanel v-if="activeSession" :key="activeSession.id" :session="activeSession" />
    <section v-if="visibleSessions.length" :class="['terminal-grid', `panes-${visibleSessions.length}`]" aria-label="可见终端面板">
      <TerminalPane
        v-for="session in visibleSessions"
        :key="session.id"
        :session="session"
        :active="session.id === activeSessionId"
        @activate="select(session.id)"
      />
    </section>
    <section v-else class="empty-state"><h1>Terminal-Agent</h1><p>请先通过连接面板创建 SSH 会话。</p></section>
    <div v-if="showConnection" class="connection-modal" role="dialog" aria-modal="true" aria-label="新建 SSH 连接">
      <ConnectionDialog @connect="connect" />
      <button class="cancel-button" type="button" @click="showConnection = false">取消</button>
    </div>
    <div v-if="showSavedSessions" class="connection-modal" role="dialog" aria-modal="true" aria-label="已保存会话">
      <SavedSessionsDialog
        :profiles="savedProfiles"
        @close="showSavedSessions = false"
        @create="showSavedSessions = false; showConnection = true"
        @connect="openSavedProfile"
        @remove="deleteSavedProfile"
      />
    </div>
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
  </main>
</template>

<style scoped>
.workbench { display: grid; grid-template-rows: auto auto minmax(0, 1fr); min-height: 100vh; height: 100vh; overflow: hidden; background: #020617; color: #e2e8f0; }
.workbench-toolbar { display: grid; gap: 8px; background: #111827; }
.toolbar-actions { display: flex; align-items: center; gap: 12px; padding: 0 12px 10px; }
.terminal-grid { display: grid; min-width: 0; min-height: 0; gap: 8px; padding: 8px; overflow: hidden; grid-auto-rows: minmax(0, 1fr); }
.terminal-grid.panes-1 { grid-template-columns: minmax(0, 1fr); }
.terminal-grid.panes-2, .terminal-grid.panes-4 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.terminal-grid.panes-3, .terminal-grid.panes-5, .terminal-grid.panes-6, .terminal-grid.panes-7, .terminal-grid.panes-8, .terminal-grid.panes-9 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.empty-state { display: grid; min-height: 0; place-content: center; text-align: center; }
.connect-button,.saved-sessions-button,.upgrade-button,.settings-button { margin: 12px; padding: 8px 12px; border: 0; border-radius: 5px; background: #0284c7; color: white; }.saved-sessions-button{background:#0f766e}.upgrade-button{background:#166534}.settings-button{background:#475569}
.connection-error { color: #fda4af; margin: 0; }
.connection-modal { position: fixed; z-index: 2; inset: 0; display: grid; align-content: center; justify-content: center; background: rgb(2 6 23 / 80%); }
.connection-modal :deep(.connection-dialog) { width: min(420px, calc(100vw - 32px)); border: 1px solid #334155; border-radius: 8px; background: #111827; }
.cancel-button { width: min(360px, calc(100vw - 64px)); justify-self: center; border: 0; border-radius: 5px; background: #334155; color: white; padding: 9px; }
.autonomous-upgrade-dialog { display: grid; gap: 12px; width: min(460px, calc(100vw - 32px)); padding: 20px; border: 1px solid #475569; border-radius: 8px; background: #111827; }.autonomous-upgrade-dialog h2,.autonomous-upgrade-dialog p{margin:0}.autonomous-upgrade-actions{display:flex;justify-content:flex-end;gap:8px}.autonomous-upgrade-actions .cancel-button{width:auto;margin:0}.confirm-upgrade-button{border:0;border-radius:5px;background:#166534;color:white;padding:9px 12px}
</style>
