<script setup lang="ts">
import { computed, nextTick, ref, type ComponentPublicInstance, watch } from 'vue'
import type { ShellFontSize, ShellHistoryDetail, ShellHistoryFileTransferLog, ShellHistorySummary } from '../../../../shared/contracts'

type DisplayHistoryRecord = ShellHistorySummary & {
  /** Optional renderer-only hostname/time labels supplied by the workbench. */
  displayLabel?: string
  connectionTimeLabel?: string
}

type HistoryLogTab = 'operations' | 'transfers'

const props = withDefaults(defineProps<{
  open: boolean
  records: DisplayHistoryRecord[]
  selectedId: string | null
  selected: ShellHistoryDetail | null
  loading: boolean
  error: string
  /** Keep the read-only preview typography in lockstep with SSH window layout. */
  fontSize: ShellFontSize
}>(), { fontSize: 13 })
const emit = defineEmits<{
  close: []
  select: [historyId: string]
}>()

const dialog = ref<HTMLElement | null>(null)
const firstRecord = ref<HTMLButtonElement | null>(null)
const selectedRecord = computed(() => props.records.find(record => record.id === props.selectedId) ?? null)
const activeLogTab = ref<HistoryLogTab>('operations')
const fileTransferLogs = computed(() => props.selected?.fileTransferLogs ?? [])
const commandAudit = computed(() => props.selected?.commandAudit?.input ?? '')

function historyConnectionTimeLabel(record: Pick<ShellHistorySummary, 'startedAt'> & { connectionTimeLabel?: string }): string {
  return record.connectionTimeLabel ?? `连接于 ${record.startedAt}`
}

function historyRecordLabel(record: Pick<ShellHistorySummary, 'hostname' | 'startedAt'> & { connectionTimeLabel?: string }): string {
  return `${record.hostname}，${historyConnectionTimeLabel(record)}`
}

function transferDirectionLabel(entry: ShellHistoryFileTransferLog): string {
  if (entry.direction === 'upload') return '上传'
  if (entry.direction === 'download') return '下载'
  return '传输'
}

function transferStatusLabel(entry: ShellHistoryFileTransferLog): string {
  const value = entry.status
  if (value === 'completed') return '完成'
  if (value === 'canceled') return '已取消'
  if (value === 'failed') return '失败'
  return '已记录'
}

function transferFileLabel(entry: ShellHistoryFileTransferLog): string {
  return entry.fileName
}

function transferTimestampLabel(entry: ShellHistoryFileTransferLog): string {
  return entry.endedAt || entry.startedAt
}

function formatTransferBytes(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return ''
  if (value < 1024) return `${value} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`
  return `${(value / 1024 ** 3).toFixed(1)} GB`
}

function transferProgressLabel(entry: ShellHistoryFileTransferLog): string {
  const transferred = formatTransferBytes(entry.transferredBytes)
  const total = formatTransferBytes(entry.totalBytes)
  return transferred && total ? `${transferred} / ${total}` : transferred || total
}

function focusFirstRecord(): void {
  void nextTick(() => {
    if (firstRecord.value) firstRecord.value.focus()
    else dialog.value?.focus()
  })
}

function setFirstRecord(element: Element | ComponentPublicInstance | null): void {
  firstRecord.value = element instanceof HTMLButtonElement ? element : null
}

function close(): void {
  emit('close')
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    close()
    return
  }
  if (event.key !== 'Tab') return
  const focusable = [...(dialog.value?.querySelectorAll<HTMLElement>(
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

watch(() => props.open, open => {
  if (open) {
    activeLogTab.value = 'operations'
    focusFirstRecord()
  }
})
watch(() => props.selectedId, () => { activeLogTab.value = 'operations' })
watch(() => props.records.map(record => record.id).join('\u0000'), () => { if (props.open) focusFirstRecord() })
</script>

<template>
  <div v-if="open" class="shell-history-backdrop" @pointerdown.self="close">
    <section ref="dialog" class="shell-history-dialog" role="dialog" aria-modal="true" aria-label="Shell 历史" tabindex="-1" @keydown.capture="handleKeydown">
      <header class="dialog-header">
        <div><h2>Shell 历史</h2><p>已关闭 Shell 的只读终端快照</p></div>
        <button type="button" aria-label="关闭 Shell 历史" title="关闭" @click="close">×</button>
      </header>
      <div class="dialog-body">
        <nav class="history-list" aria-label="Shell 历史记录">
          <button
            v-for="(record, index) in records"
            :key="record.id"
            :ref="index === 0 ? setFirstRecord : undefined"
            type="button"
            role="option"
            :aria-label="`选择 Shell 历史 ${historyRecordLabel(record)}`"
            :aria-selected="record.id === selectedId"
            :class="{ selected: record.id === selectedId }"
            @click="emit('select', record.id)"
          >
            <strong>{{ record.hostname }}</strong><time :datetime="record.startedAt">{{ historyConnectionTimeLabel(record) }}</time>
          </button>
          <p v-if="!loading && !records.length">没有可用的 Shell 历史。</p>
        </nav>
        <section class="history-preview" aria-label="Shell 历史预览">
          <template v-if="selected">
            <header><strong>{{ selected.hostname }}</strong><span>{{ historyConnectionTimeLabel(selectedRecord ?? selected) }}</span></header>
            <nav class="history-log-tabs" role="tablist" aria-label="连接详情日志类型">
              <button type="button" role="tab" id="history-operations-tab" :aria-selected="activeLogTab === 'operations'" aria-controls="history-operations-panel" :class="{ active: activeLogTab === 'operations' }" @click="activeLogTab = 'operations'">SSH连接操作记录</button>
              <button type="button" role="tab" id="history-transfers-tab" :aria-selected="activeLogTab === 'transfers'" aria-controls="history-transfers-panel" :class="{ active: activeLogTab === 'transfers' }" @click="activeLogTab = 'transfers'">文件传输日志</button>
            </nav>
            <section v-if="activeLogTab === 'operations'" id="history-operations-panel" class="history-log-panel" role="tabpanel" aria-labelledby="history-operations-tab">
              <div v-if="commandAudit || selected.output" class="operation-history-list">
                <section v-if="commandAudit" class="operation-history-block">
                  <h3>发送的命令</h3>
                  <pre aria-label="SSH连接操作记录：发送的命令" data-read-only="true" tabindex="0" :style="{ fontSize: `${fontSize}px` }">{{ commandAudit }}</pre>
                </section>
                <section v-if="selected.output" class="operation-history-block">
                  <h3>SSH终端输出</h3>
                  <pre :aria-label="`只读终端历史 ${historyRecordLabel(selectedRecord ?? selected)} · SSH连接操作记录`" data-read-only="true" tabindex="0" :style="{ fontSize: `${fontSize}px` }">{{ selected.output }}</pre>
                </section>
              </div>
              <p v-else class="history-empty-state">暂无 SSH 连接操作记录</p>
            </section>
            <section v-else id="history-transfers-panel" class="history-log-panel" role="tabpanel" aria-labelledby="history-transfers-tab">
              <ul v-if="fileTransferLogs.length" class="transfer-history-list" aria-label="文件传输日志列表">
                <li v-for="entry in fileTransferLogs" :key="entry.id" class="transfer-history-item">
                  <div><strong>{{ transferDirectionLabel(entry) }}</strong><span :title="entry.remotePath || transferFileLabel(entry)">{{ transferFileLabel(entry) }}</span><em>{{ transferStatusLabel(entry) }}</em></div>
                  <small>{{ transferProgressLabel(entry) }}<span v-if="transferProgressLabel(entry) && transferTimestampLabel(entry)"> · </span>{{ transferTimestampLabel(entry) }}</small>
                  <p v-if="entry.message">{{ entry.message }}</p>
                </li>
              </ul>
              <p v-else class="history-empty-state">暂无文件传输日志</p>
            </section>
          </template>
          <p v-else-if="loading">正在读取 Shell 历史...</p>
          <p v-else>选择一条 Shell 历史以查看只读终端输出。</p>
          <p v-if="error" class="history-error" role="alert">{{ error }}</p>
        </section>
      </div>
    </section>
  </div>
</template>

<style scoped>
.shell-history-backdrop { position: fixed; z-index: 20; inset: 40px 0 0; display: grid; place-items: center; padding: 16px; background: rgb(20 24 29 / 42%); }
.shell-history-dialog { display: grid; grid-template-rows: auto minmax(0, 1fr); width: min(900px, calc(100vw - 32px)); height: min(620px, calc(100vh - 72px)); overflow: hidden; border: 1px solid var(--line); border-radius: 7px; background: var(--surface); color: var(--text); box-shadow: 0 18px 48px rgb(16 24 40 / 22%); }
.dialog-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 60px; padding: 10px 14px; border-bottom: 1px solid var(--line); }
.dialog-header h2,.dialog-header p { margin: 0; }.dialog-header h2 { color: var(--text-strong); font-size: 15px; }.dialog-header p { margin-top: 3px; color: var(--muted); font-size: 10px; }
.dialog-header button { width: 30px; height: 30px; padding: 0; border: 1px solid var(--line); border-radius: 4px; background: var(--surface-soft); color: var(--text); font-size: 18px; }
.dialog-body { display: grid; grid-template-columns: minmax(190px, 32%) minmax(0, 1fr); min-height: 0; }
.history-list { display: grid; align-content: start; gap: 4px; min-width: 0; padding: 8px; overflow: auto; border-right: 1px solid var(--line); background: var(--surface-soft); }
.history-list button { display: grid; gap: 3px; min-width: 0; padding: 9px; border: 1px solid transparent; border-radius: 4px; background: transparent; color: var(--text); text-align: left; }.history-list button.selected,.history-list button:hover,.history-list button:focus-visible { border-color: var(--accent); background: var(--surface); outline: 0; }
.history-list strong,.history-list span,.history-list time { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.history-list strong { color: var(--text-strong); font-size: 11px; }.history-list span,.history-list time,.history-list p { color: var(--muted); font-size: 10px; }.history-list time { font-size: 9px; }
.history-preview { display: grid; grid-template-rows: auto auto minmax(0, 1fr); min-width: 0; min-height: 0; padding: 12px; gap: 9px; }.history-preview > header { display: flex; justify-content: space-between; gap: 10px; min-width: 0; }.history-preview header strong,.history-preview header span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.history-preview header strong { color: var(--text-strong); font-size: 12px; }.history-preview header span { color: var(--muted); font-size: 10px; }
.history-log-tabs { display: flex; align-items: end; gap: 3px; min-width: 0; border-bottom: 1px solid var(--line); }
.history-log-tabs button { min-height: 29px; padding: 0 10px; border: 1px solid transparent; border-bottom: 2px solid transparent; border-radius: 4px 4px 0 0; background: transparent; color: var(--muted); font-size: 10px; white-space: nowrap; }
.history-log-tabs button:hover,.history-log-tabs button:focus-visible { background: var(--surface-soft); color: var(--text-strong); outline: 0; }
.history-log-tabs button.active { border-bottom-color: var(--accent); color: var(--text-strong); font-weight: 700; }
.history-log-panel { display: grid; min-width: 0; min-height: 0; overflow: hidden; }
.history-log-panel pre { min-width: 0; min-height: 0; margin: 0; padding: 10px; overflow: auto; border: 1px solid var(--line); border-radius: 4px; background: var(--terminal); color: var(--terminal-text); font: 11px/1.5 ui-monospace, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
.history-preview > p { margin: 0; color: var(--muted); font-size: 11px; }
.operation-history-list { display: grid; align-content: start; gap: 8px; min-width: 0; min-height: 0; overflow: auto; }
.operation-history-block { display: grid; gap: 5px; min-width: 0; min-height: 0; }.operation-history-block h3 { margin: 0; color: var(--muted); font-size: 9px; font-weight: 650; }.operation-history-block pre { min-height: 96px; max-height: 240px; }
.transfer-history-list { min-width: 0; min-height: 0; margin: 0; padding: 0; overflow: auto; list-style: none; }
.transfer-history-item { display: grid; gap: 4px; padding: 9px 10px; border: 1px solid var(--line-soft); border-radius: 4px; background: var(--surface-soft); color: var(--text); }
.transfer-history-item + .transfer-history-item { margin-top: 6px; }
.transfer-history-item > div { display: flex; align-items: center; gap: 8px; min-width: 0; }
.transfer-history-item strong { flex: 0 0 auto; color: var(--accent); font-size: 10px; }
.transfer-history-item > div span { min-width: 0; overflow: hidden; color: var(--text-strong); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.transfer-history-item em { margin-left: auto; color: var(--muted); font-size: 9px; font-style: normal; }
.transfer-history-item small { color: var(--muted); font-size: 9px; }
.transfer-history-item p { margin: 0; color: var(--red); font-size: 9px; line-height: 1.4; }
.history-empty-state { display: grid; place-items: center; min-height: 80px; border: 1px dashed var(--line); color: var(--muted) !important; }
.history-error { color: var(--red) !important; }
@media (max-width: 680px) { .dialog-body { grid-template-columns: minmax(150px, 42%) minmax(0, 1fr); }.history-preview { padding: 8px; }.history-log-tabs { overflow-x: auto; }.history-log-tabs button { padding-inline: 8px; } }
</style>
