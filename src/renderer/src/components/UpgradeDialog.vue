<script setup lang="ts">
import { CheckCircle2, Download, RefreshCw, X } from '@lucide/vue'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { UpdaterCheckResult, UpdaterProgress, UpdaterState } from '../../../main/updater/updater-contracts'

const props = defineProps<{ open: boolean; currentVersion: string }>()
const emit = defineEmits<{ close: []; restarted: [] }>()

const state = ref<UpdaterState | null>(null)
const checkResult = ref<UpdaterCheckResult | null>(null)
const busy = ref(false)
const message = ref('')
const progress = ref<UpdaterProgress | null>(null)
let stopProgress: (() => void) | undefined
let stopStatus: (() => void) | undefined
let stopError: (() => void) | undefined

const phase = computed(() => state.value?.phase ?? 'idle')
const release = computed(() => checkResult.value?.release ?? state.value?.release ?? null)
const downloaded = computed(() => state.value?.downloaded)
const progressPercent = computed(() => Math.round(progress.value?.percent ?? state.value?.progress?.percent ?? 0))
const isChecking = computed(() => busy.value && phase.value === 'checking')
const isDownloading = computed(() => busy.value && phase.value === 'downloading')
const isInstalling = computed(() => busy.value && phase.value === 'installing')

function updaterBridge(): Window['terminalAgent']['updater'] | undefined {
  return typeof window !== 'undefined' ? window.terminalAgent?.updater : undefined
}

function applyState(next: UpdaterState): void {
  state.value = next
  progress.value = next.progress
  if (next.error) message.value = next.error
}

async function loadState(): Promise<void> {
  const updater = updaterBridge()
  if (!updater) return
  try { applyState(await updater.getState()) } catch { /* A missing updater bridge is reported by the action below. */ }
}

async function check(): Promise<void> {
  if (busy.value) return
  busy.value = true
  message.value = ''
  checkResult.value = null
  const updater = updaterBridge()
  if (!updater) {
    busy.value = false
    message.value = '当前运行环境不支持升级功能。'
    return
  }
  try {
    const result = await updater.check()
    checkResult.value = result
    await loadState()
    message.value = result.updateAvailable ? '发现可用更新。' : '当前已是最新版本。'
  } catch (error) {
    message.value = error instanceof Error ? error.message : '检查更新失败，请稍后重试。'
  } finally { busy.value = false }
}

async function download(): Promise<void> {
  if (busy.value) return
  busy.value = true
  message.value = ''
  const updater = updaterBridge()
  if (!updater) {
    busy.value = false
    message.value = '当前运行环境不支持升级功能。'
    return
  }
  try {
    await updater.download()
    await loadState()
    message.value = '下载完成，可以安装更新。'
  } catch (error) {
    message.value = error instanceof Error ? error.message : '下载更新失败，请稍后重试。'
  } finally { busy.value = false }
}

async function install(): Promise<void> {
  if (!downloaded.value || busy.value) return
  if (typeof window.confirm === 'function' && !window.confirm('更新安装程序即将启动，当前应用将关闭。请在安装向导中完成升级。是否继续？')) return
  busy.value = true
  message.value = '正在启动安装程序…'
  const updater = updaterBridge()
  if (!updater) {
    busy.value = false
    message.value = '当前运行环境不支持升级功能。'
    return
  }
  try {
    await updater.install()
    await loadState()
    message.value = '安装程序已启动，正在关闭当前应用…'
    await updater.restart()
    emit('restarted')
  } catch (error) {
    busy.value = false
    message.value = error instanceof Error ? error.message : '启动安装程序失败，请稍后重试。'
  }
}

function close(): void {
  // Keep the dialog mounted until the in-flight IPC operation settles.  The
  // phase can briefly lag the local busy flag while the main process publishes
  // its first status event, so checking `busy` alone avoids a close race.
  if (busy.value) return
  emit('close')
}

function progressLabel(): string {
  if (isChecking.value) return '正在检查更新服务最新版本…'
  if (isDownloading.value) return `正在下载更新… ${progressPercent.value}%`
  if (isInstalling.value) return `正在启动安装… ${progressPercent.value}%`
  if (phase.value === 'installed') return '安装程序已启动'
  return ''
}

watch(() => props.open, open => {
  if (open) {
    void loadState().then(() => check())
  }
})

const updater = updaterBridge()
if (updater) {
  stopProgress = updater.onProgress(event => { progress.value = event })
  stopStatus = updater.onStatus(next => { applyState(next) })
  stopError = updater.onError(error => { message.value = error })
}

onBeforeUnmount(() => { stopProgress?.(); stopStatus?.(); stopError?.() })
</script>

<template>
  <div v-if="open" class="upgrade-backdrop" @pointerdown.self="close">
    <section class="upgrade-dialog" role="dialog" aria-modal="true" aria-label="升级" tabindex="-1">
      <header class="upgrade-header">
        <div><p class="eyebrow">Terminal-Agent</p><h2>升级</h2><p>当前版本 <strong>v{{ currentVersion }}</strong><span v-if="release"> · 可升级至 <strong>v{{ release.version }}</strong></span></p></div>
        <button type="button" class="close-button" aria-label="关闭升级" title="关闭" :disabled="busy" @click="close"><X :size="16" aria-hidden="true" /></button>
      </header>
      <div class="upgrade-body">
        <p v-if="progressLabel()" class="progress-label" role="status" aria-live="polite"><RefreshCw :size="14" class="spin" aria-hidden="true" />{{ progressLabel() }}</p>
        <div v-if="busy && (isDownloading || isInstalling || isChecking)" class="progress-track" role="progressbar" aria-label="升级进度" :aria-valuenow="progressPercent" aria-valuemin="0" aria-valuemax="100"><span :style="{ width: `${progressPercent}%` }" /></div>
        <section v-if="release" class="release-card">
          <div class="release-card-head"><div><strong>{{ release.name }}</strong><span>版本 v{{ release.version }} · Windows x64</span></div><CheckCircle2 :size="18" aria-hidden="true" /></div>
          <p v-if="release.notes" class="release-notes">{{ release.notes }}</p>
          <p class="release-source">版本来源：Nuts 更新服务；安装包：官方 GitHub Release</p>
        </section>
        <p v-if="message" class="upgrade-message" :class="{ error: phase === 'error' }" role="status">{{ message }}</p>
        <p v-if="!release && !busy && phase !== 'error'" class="upgrade-hint">点击“检查更新”获取更新服务中的最新版本。</p>
      </div>
      <footer class="upgrade-actions">
        <button type="button" class="secondary-action" :disabled="busy" @click="check"><RefreshCw :size="13" :class="{ spin: isChecking }" aria-hidden="true" />{{ isChecking ? '检查中…' : '检查更新' }}</button>
        <button v-if="release && !downloaded" type="button" class="primary-action" :disabled="busy" @click="download"><Download :size="13" aria-hidden="true" />{{ isDownloading ? '下载中…' : '下载更新' }}</button>
        <button v-else-if="downloaded && phase !== 'installed'" type="button" class="primary-action" :disabled="busy" @click="install">安装更新</button>
        <button v-else-if="phase === 'installed'" type="button" class="primary-action" disabled>已启动安装</button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.upgrade-backdrop { position: fixed; z-index: 30; inset: 48px 0 0; display: grid; place-items: center; padding: 18px; background: rgb(20 24 29 / 45%); backdrop-filter: blur(2px); }
.upgrade-dialog { display: grid; grid-template-rows: auto minmax(0, 1fr) auto; width: min(560px, calc(100vw - 36px)); max-height: min(680px, calc(100vh - 84px)); overflow: hidden; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); color: var(--text); box-shadow: 0 22px 60px rgb(16 24 40 / 28%); }
.upgrade-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 17px 18px 14px; border-bottom: 1px solid var(--line); }.upgrade-header h2,.upgrade-header p { margin: 0; }.upgrade-header h2 { margin-top: 3px; color: var(--text-strong); font-size: 18px; }.upgrade-header p:last-child { margin-top: 6px; color: var(--muted); font-size: 10px; }.upgrade-header p strong { color: var(--text-strong); }.eyebrow { color: var(--muted); font-size: 9px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.close-button { display: grid; place-items: center; width: 29px; height: 29px; padding: 0; border: 1px solid var(--line); border-radius: 5px; background: var(--surface-soft); color: var(--muted); }.close-button:hover { color: var(--text-strong); }
.upgrade-body { min-height: 0; overflow: auto; padding: 17px 18px; }.progress-label { display: flex; align-items: center; gap: 7px; margin: 0 0 9px; color: var(--accent); font-size: 11px; font-weight: 650; }.progress-track { height: 7px; margin-bottom: 14px; overflow: hidden; border-radius: 4px; background: var(--line); }.progress-track span { display: block; height: 100%; border-radius: inherit; background: var(--accent); transition: width .2s ease; }
.release-card { display: grid; gap: 10px; padding: 13px; border: 1px solid var(--amber-line); border-radius: 6px; background: var(--amber-soft); }.release-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }.release-card-head > div { display: grid; gap: 4px; min-width: 0; }.release-card-head strong { color: var(--text-strong); font-size: 12px; }.release-card-head span,.release-source { color: var(--muted); font-size: 9px; }.release-card-head > svg { flex: 0 0 auto; color: var(--green); }.release-notes { max-height: 180px; margin: 0; overflow: auto; color: var(--text); font-size: 10px; line-height: 1.55; white-space: pre-wrap; }
.upgrade-message,.upgrade-hint { margin: 13px 0 0; color: var(--muted); font-size: 11px; line-height: 1.5; }.upgrade-message.error { color: var(--red); }.upgrade-hint { margin-top: 0; }.upgrade-actions { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 18px 15px; border-top: 1px solid var(--line); }.secondary-action,.primary-action { display: inline-flex; align-items: center; justify-content: center; gap: 5px; min-height: 31px; padding: 0 11px; border: 1px solid var(--line); border-radius: 5px; background: var(--surface); color: var(--text); font-size: 10px; font-weight: 650; }.secondary-action:hover { border-color: var(--focus); background: var(--hover); }.primary-action { border-color: var(--accent); background: var(--accent); color: #fff; }.secondary-action:disabled,.primary-action:disabled { cursor: not-allowed; opacity: .6; }.spin { animation: upgrade-spin 1s linear infinite; }@keyframes upgrade-spin { to { transform: rotate(360deg); } }
</style>
