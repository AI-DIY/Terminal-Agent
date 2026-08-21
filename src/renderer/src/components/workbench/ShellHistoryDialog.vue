<script setup lang="ts">
import { computed, nextTick, ref, type ComponentPublicInstance, watch } from 'vue'
import type { ShellHistoryDetail, ShellHistorySummary } from '../../../../shared/contracts'

const props = defineProps<{
  open: boolean
  records: ShellHistorySummary[]
  selectedId: string | null
  selected: ShellHistoryDetail | null
  loading: boolean
  error: string
}>()
const emit = defineEmits<{
  close: []
  select: [historyId: string]
  reconnect: [historyId: string]
}>()

const dialog = ref<HTMLElement | null>(null)
const firstRecord = ref<HTMLButtonElement | null>(null)
const selectedRecord = computed(() => props.records.find(record => record.id === props.selectedId) ?? null)

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

watch(() => props.open, open => { if (open) focusFirstRecord() })
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
            :aria-label="`选择 Shell 历史 ${record.title}`"
            :aria-selected="record.id === selectedId"
            :class="{ selected: record.id === selectedId }"
            @click="emit('select', record.id)"
          >
            <strong>{{ record.title }}</strong><span>{{ record.hostname }}</span><time>{{ record.endedAt }}</time>
          </button>
          <p v-if="!loading && !records.length">没有可用的 Shell 历史。</p>
        </nav>
        <section class="history-preview" aria-label="Shell 历史预览">
          <template v-if="selected">
            <header><strong>{{ selected.title }}</strong><span>{{ selected.hostname }}</span></header>
            <pre :aria-label="`只读终端历史 ${selected.hostname}`" data-read-only="true" tabindex="0">{{ selected.output }}</pre>
            <div class="preview-actions">
              <span v-if="selectedRecord?.reconnectable">可使用现有安全连接描述重新连接</span>
              <span v-else>该 Shell 的安全连接描述已不可用</span>
              <button type="button" :disabled="!selectedRecord?.reconnectable" @click="emit('reconnect', selected.id)">重新连接</button>
            </div>
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
.history-preview { display: grid; grid-template-rows: auto minmax(0, 1fr) auto; min-width: 0; min-height: 0; padding: 12px; gap: 9px; }.history-preview > header { display: flex; justify-content: space-between; gap: 10px; min-width: 0; }.history-preview header strong,.history-preview header span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.history-preview header strong { color: var(--text-strong); font-size: 12px; }.history-preview header span { color: var(--muted); font-size: 10px; }
.history-preview pre { min-width: 0; min-height: 0; margin: 0; padding: 10px; overflow: auto; border: 1px solid #343a42; border-radius: 4px; background: var(--terminal); color: #d8dade; font: 11px/1.5 ui-monospace, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }.history-preview > p { margin: 0; color: var(--muted); font-size: 11px; }
.preview-actions { display: flex; align-items: center; justify-content: space-between; gap: 10px; color: var(--muted); font-size: 10px; }.preview-actions button { min-height: 30px; padding: 0 10px; border: 1px solid var(--accent); border-radius: 4px; background: var(--accent); color: #fff; font-size: 11px; }.preview-actions button:disabled { border-color: var(--line); background: var(--surface-soft); color: var(--muted); cursor: not-allowed; }.history-error { color: var(--red) !important; }
@media (max-width: 680px) { .dialog-body { grid-template-columns: minmax(150px, 42%) minmax(0, 1fr); }.history-preview { padding: 8px; }.preview-actions { align-items: flex-end; flex-direction: column; } }
</style>
