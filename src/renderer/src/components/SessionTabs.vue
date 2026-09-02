<script setup lang="ts">
import { Circle, X } from '@lucide/vue'
import { ref } from 'vue'
import { sessionDisplayLabel, sessionDisplayParts, sessionHasDuplicateHost, type SessionView } from '../stores/sessions'

const props = defineProps<{ sessions: SessionView[]; activeSessionId: string | null }>()
const emit = defineEmits<{
  select: [sessionId: string]
  close: [sessionId: string]
  reorder: [sessionIds: string[]]
}>()
const draggingSessionId = ref<string | null>(null)
const dragOverSessionId = ref<string | null>(null)

function beginDrag(sessionId: string, event: DragEvent): void {
  draggingSessionId.value = sessionId
  dragOverSessionId.value = sessionId
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', sessionId)
  }
}

function trackDragOver(sessionId: string, event: DragEvent): void {
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  dragOverSessionId.value = sessionId
}

function finishDrag(): void {
  draggingSessionId.value = null
  dragOverSessionId.value = null
}

function dropOn(sessionId: string, event: DragEvent): void {
  event.preventDefault()
  const sourceId = draggingSessionId.value ?? event.dataTransfer?.getData('text/plain') ?? null
  if (!sourceId || sourceId === sessionId) {
    finishDrag()
    return
  }
  const ids = props.sessions.map(session => session.id)
  const fromIndex = ids.indexOf(sourceId)
  const toIndex = ids.indexOf(sessionId)
  if (fromIndex < 0 || toIndex < 0) {
    finishDrag()
    return
  }
  ids.splice(fromIndex, 1)
  // Treat the drop target as a real insertion zone.  Without this adjustment
  // dragging an item onto its immediate neighbour (for example A -> B) would
  // remove and reinsert it at the same index, making the gesture appear to do
  // nothing.  The pointer half determines whether the item lands before or
  // after the target, while keyboard/synthetic events naturally use before.
  const targetElement = event.currentTarget as HTMLElement
  const bounds = targetElement.getBoundingClientRect()
  const afterTarget = Number.isFinite(event.clientX)
    && bounds.width > 0
    && event.clientX > bounds.left + bounds.width / 2
  const adjustedTargetIndex = ids.indexOf(sessionId)
  const insertionIndex = Math.max(0, adjustedTargetIndex + (afterTarget ? 1 : 0))
  ids.splice(insertionIndex, 0, sourceId)
  emit('reorder', ids)
  finishDrag()
}
</script>

<template>
  <nav class="session-tabs" aria-label="终端会话">
    <div
      v-for="session in sessions"
      :key="session.id"
      class="session-tab"
      :class="{ active: session.id === activeSessionId, dragging: session.id === draggingSessionId, 'drag-over': session.id === dragOverSessionId && session.id !== draggingSessionId }"
      draggable="true"
      :title="sessionDisplayLabel(session, sessions)"
      @dragstart="beginDrag(session.id, $event)"
      @dragover="trackDragOver(session.id, $event)"
      @drop="dropOn(session.id, $event)"
      @dragend="finishDrag"
    >
      <button type="button" class="select" :aria-label="`选择终端会话 ${sessionDisplayLabel(session, sessions)}`" :aria-current="session.id === activeSessionId ? 'page' : undefined" :title="sessionDisplayLabel(session, sessions)" @click="emit('select', session.id)">
        <Circle :size="7" :stroke-width="0" fill="currentColor" aria-hidden="true" />
        <strong>{{ sessionDisplayParts(session, sessions)?.displayLabel.replace(/\s+#\d+$/, '') ?? sessionDisplayLabel(session, sessions) }}</strong>
        <span v-if="sessionHasDuplicateHost(session, sessions)" class="host-ordinal">#{{ sessionDisplayParts(session, sessions)?.ordinal }}</span>
        <small>已连接</small>
      </button>
      <button type="button" class="close" :aria-label="`关闭 SSH 会话 ${sessionDisplayLabel(session, sessions)}`" title="关闭 SSH" @click="emit('close', session.id)"><X :size="13" aria-hidden="true" /></button>
    </div>
  </nav>
</template>

<style scoped>
.session-tabs { display: flex; min-width: 0; min-height: 0; height: 100%; flex: 1 1 auto; overflow-x: auto; overflow-y: hidden; background: var(--panel); scrollbar-gutter: stable; scrollbar-width: thin; scrollbar-color: transparent transparent; }
.session-tabs:hover,.session-tabs:focus-within { scrollbar-color: color-mix(in srgb, var(--muted) 58%, transparent) transparent; }
.session-tabs::-webkit-scrollbar { width: 0; height: 5px; }
.session-tabs::-webkit-scrollbar-track { background: transparent; }
.session-tabs::-webkit-scrollbar-thumb { border: 1px solid transparent; border-radius: 999px; background: transparent; background-clip: padding-box; }
.session-tabs:hover::-webkit-scrollbar-thumb,.session-tabs:focus-within::-webkit-scrollbar-thumb { background-color: color-mix(in srgb, var(--muted) 58%, transparent); }
.session-tabs:hover::-webkit-scrollbar-thumb:hover,.session-tabs:focus-within::-webkit-scrollbar-thumb:hover { background-color: var(--muted); }
.session-tab { display: flex; box-sizing: border-box; height: 100%; min-height: 0; flex: 0 0 auto; align-items: center; max-width: 245px; border: 1px solid transparent; border-bottom-width: 2px; background: transparent; color: var(--muted); white-space: nowrap; cursor: grab; }
.session-tab:hover { background: var(--hover); }
.session-tab:active { cursor: grabbing; }
.session-tab.active { border-color: var(--red); background: var(--amber-soft); color: var(--text-strong); }
.session-tab.dragging { opacity: .48; }
.session-tab.drag-over { box-shadow: inset 2px 0 0 var(--focus); }
button { border: 0; background: transparent; color: inherit; }
.select { display: flex; min-width: 0; align-items: center; gap: 7px; height: 100%; padding: 0 4px 0 10px; text-align: left; }
.select > svg { flex: 0 0 auto; color: var(--green); }.session-tab.active .select > svg { color: var(--accent); }
.select strong { max-width: 128px; overflow: hidden; color: var(--text-strong); font-size: 11px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }.host-ordinal { align-self: flex-start; margin-top: 8px; padding: 1px 4px; border: 1px solid var(--amber-line); border-radius: 3px; background: var(--amber-soft); color: var(--amber); font-size: 8px; font-weight: 750; line-height: 1.1; }
small { color: var(--faint); font-size: 9px; }
.close { display: grid; place-items: center; width: 26px; height: 26px; flex: 0 0 auto; padding: 0; border-radius: 4px; color: var(--faint); }.close:hover { background: var(--hover); color: var(--red); }
</style>
