<script setup lang="ts">
import { Download, Upload, X } from '@lucide/vue'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type {
  FileTransferProgress,
  FileTransferResult,
} from '../../../../shared/file-transfer-contracts'

const props = defineProps<{
  sessionId: string
  hostname?: string
}>()

const emit = defineEmits<{
  close: []
}>()

const remotePath = ref('')
const busy = ref(false)
const status = ref('请选择操作。')
const error = ref('')
const progress = ref<FileTransferProgress | null>(null)
let unsubscribeProgress: (() => void) | undefined

const progressPercent = computed(() => {
  const current = progress.value
  if (!current?.totalBytes || current.totalBytes <= 0) return current?.phase === 'completed' ? 100 : 0
  return Math.max(0, Math.min(100, Math.round(current.transferredBytes / current.totalBytes * 100)))
})

const progressLabel = computed(() => {
  const current = progress.value
  if (!current) return ''
  if (current.phase === 'selecting') return current.direction === 'upload' ? '等待选择本地文件…' : '等待选择保存位置…'
  if (current.phase === 'transferring') return `传输中… ${progressPercent.value}%`
  if (current.phase === 'completed') return '传输完成'
  if (current.phase === 'canceled') return '已取消'
  return '传输失败'
})

function resetForSession(): void {
  busy.value = false
  error.value = ''
  progress.value = null
  status.value = '请选择操作。'
}

function setProgress(event: FileTransferProgress): void {
  if (event.sessionId !== props.sessionId) return
  progress.value = event
  if (event.message && event.phase !== 'failed') status.value = event.message
  if (event.phase === 'failed') error.value = event.message ?? '文件传输失败。'
}

async function upload(): Promise<void> {
  await transfer('upload')
}

async function download(): Promise<void> {
  await transfer('download')
}

async function transfer(direction: 'upload' | 'download'): Promise<void> {
  if (busy.value) return
  const target = remotePath.value.trim()
  if (!target) {
    error.value = '请输入远程路径。'
    return
  }
  busy.value = true
  error.value = ''
  status.value = direction === 'upload' ? '正在准备上传…' : '正在准备下载…'
  progress.value = {
    transferId: crypto.randomUUID(),
    sessionId: props.sessionId,
    direction,
    phase: 'selecting',
    transferredBytes: 0,
  }
  const transferId = progress.value.transferId
  try {
    const result: FileTransferResult = direction === 'upload'
      ? await window.terminalAgent.fileTransfer.upload({ sessionId: props.sessionId, remotePath: target, transferId })
      : await window.terminalAgent.fileTransfer.download({ sessionId: props.sessionId, remotePath: target, transferId })
    if (result.status === 'canceled') status.value = '已取消。'
    else status.value = `${direction === 'upload' ? '上传' : '下载'}完成：${result.fileName ?? '文件'}`
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '文件传输失败。'
    status.value = '传输失败。'
  } finally {
    busy.value = false
  }
}

watch(() => props.sessionId, resetForSession)

onMounted(() => {
  unsubscribeProgress = window.terminalAgent.fileTransfer.onProgress(setProgress)
})

onBeforeUnmount(() => {
  unsubscribeProgress?.()
  unsubscribeProgress = undefined
})
</script>

<template>
  <section class="file-transfer-panel" aria-label="文件传输">
    <header class="file-transfer-header">
      <div>
        <h2>文件传输</h2>
        <p>通过当前 SSH 的独立 SFTP 通道传输，不会中断终端。</p>
      </div>
      <button type="button" class="close-button" aria-label="关闭文件传输" title="关闭" @click="emit('close')"><X :size="14" aria-hidden="true" /></button>
    </header>

    <div class="file-transfer-form">
      <label for="file-transfer-remote-path">远程路径</label>
      <input id="file-transfer-remote-path" v-model="remotePath" type="text" autocomplete="off" placeholder="例如 /tmp/report.txt" :disabled="busy" @keydown.enter.prevent="upload" />
      <span v-if="hostname" class="target">目标：{{ hostname }}</span>
      <div class="file-transfer-actions">
        <button type="button" :disabled="busy" @click="upload"><Upload :size="14" aria-hidden="true" />上传文件</button>
        <button type="button" :disabled="busy" @click="download"><Download :size="14" aria-hidden="true" />下载文件</button>
      </div>
    </div>

    <div v-if="progress" class="file-transfer-progress" aria-live="polite">
      <div class="progress-copy"><span>{{ progressLabel }}</span><span v-if="progress.fileName">{{ progress.fileName }}</span></div>
      <div class="progress-track" role="progressbar" aria-label="文件传输进度" :aria-valuenow="progressPercent" aria-valuemin="0" aria-valuemax="100"><span :style="{ width: `${progressPercent}%` }" /></div>
    </div>
    <p v-if="error" class="file-transfer-error" role="alert">{{ error }}</p>
    <p v-else class="file-transfer-status">{{ status }}</p>
  </section>
</template>

<style scoped>
.file-transfer-panel { display: grid; gap: 10px; box-sizing: border-box; width: 100%; min-width: 0; padding: 12px 14px 14px; border-top: 1px solid var(--line); background: var(--panel); color: var(--text); }
.file-transfer-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; min-width: 0; }
.file-transfer-header h2 { margin: 0; color: var(--text-strong); font-size: 12px; font-weight: 720; }
.file-transfer-header p { margin: 4px 0 0; color: var(--muted); font-size: 10px; }
.close-button { display: grid; place-items: center; width: 26px; height: 26px; padding: 0; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); color: var(--muted); }
.close-button:hover { border-color: var(--focus); color: var(--text-strong); }
.file-transfer-form { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 7px; min-width: 0; }
.file-transfer-form label { color: var(--text-strong); font-size: 10px; font-weight: 650; white-space: nowrap; }
.file-transfer-form input { box-sizing: border-box; width: 100%; min-width: 0; height: 30px; padding: 0 8px; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); color: var(--text-strong); font: inherit; font-size: 11px; }
.file-transfer-form input:focus { border-color: var(--focus); outline: 2px solid color-mix(in srgb, var(--focus) 24%, transparent); }
.target { overflow: hidden; max-width: 220px; color: var(--muted); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.file-transfer-actions { display: flex; grid-column: 2 / -1; gap: 7px; }
.file-transfer-actions button { display: inline-flex; align-items: center; justify-content: center; gap: 5px; min-width: 102px; height: 29px; padding: 0 10px; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); color: var(--text-strong); font-size: 10px; font-weight: 650; }
.file-transfer-actions button:hover:not(:disabled) { border-color: var(--focus); background: var(--hover); }
.file-transfer-actions button:disabled { opacity: .58; cursor: not-allowed; }
.file-transfer-progress { display: grid; gap: 5px; min-width: 0; }
.progress-copy { display: flex; justify-content: space-between; gap: 8px; color: var(--muted); font-size: 10px; }
.progress-copy span:last-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.progress-track { width: 100%; height: 5px; overflow: hidden; border-radius: 3px; background: var(--surface-soft); }
.progress-track span { display: block; height: 100%; border-radius: inherit; background: var(--accent); transition: width .16s ease; }
.file-transfer-status,.file-transfer-error { margin: 0; font-size: 10px; line-height: 1.4; }
.file-transfer-status { color: var(--muted); }
.file-transfer-error { color: var(--red); }
@media (max-width: 640px) {
  .file-transfer-form { grid-template-columns: auto minmax(0, 1fr); }
  .target { grid-column: 2; max-width: none; }
  .file-transfer-actions { grid-column: 1 / -1; }
}
</style>
