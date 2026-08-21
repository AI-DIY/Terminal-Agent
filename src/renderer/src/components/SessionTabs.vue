<script setup lang="ts">
import { sessionLabel, type SessionView } from '../stores/sessions'

defineProps<{ sessions: SessionView[]; activeSessionId: string | null }>()
const emit = defineEmits<{ select: [sessionId: string]; close: [sessionId: string] }>()
</script>

<template>
  <nav class="session-tabs" aria-label="终端会话">
    <div
      v-for="session in sessions"
      :key="session.id"
      class="session-tab"
      :class="{ active: session.id === activeSessionId }"
    >
      <button type="button" class="select" :aria-label="`选择终端会话 ${sessionLabel(session)}`" @click="emit('select', session.id)">
        <span>{{ sessionLabel(session) }}</span>
        <small>{{ session.mode === 'copilot' ? '辅助驾驶' : '全自动驾驶' }}</small>
      </button>
      <button type="button" class="close" :aria-label="`关闭终端会话 ${sessionLabel(session)}`" @click="emit('close', session.id)">×</button>
    </div>
  </nav>
</template>

<style scoped>
.session-tabs { display: flex; gap: 7px; overflow-x: auto; padding: 7px 10px; background: var(--surface-soft, #f5f7f9); }
.session-tab { display: flex; border: 1px solid var(--line, #d9dfe6); background: var(--surface, #fff); border-radius: 5px; white-space: nowrap; }
.session-tab.active { border-color: var(--accent, #2f6fc4); background: var(--accent-soft, #dfeafa); }
button { border: 0; background: transparent; color: var(--text, #39424c); }
.select { display: flex; gap: 8px; align-items: center; padding: 7px 9px; }
small { color: var(--muted, #68737f); }
.close { padding: 5px 9px; font-size: 18px; line-height: 12px; color: var(--muted, #68737f); }
</style>
