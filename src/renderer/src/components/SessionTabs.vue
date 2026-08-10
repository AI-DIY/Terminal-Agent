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
.session-tabs { display: flex; gap: 8px; overflow-x: auto; padding: 8px; background: #111827; }
.session-tab { display: flex; border: 1px solid #334155; background: #1e293b; border-radius: 6px; white-space: nowrap; }
.session-tab.active { border-color: #38bdf8; background: #0f3a55; }
button { border: 0; background: transparent; color: #e2e8f0; }
.select { display: flex; gap: 8px; align-items: center; padding: 7px 9px; }
small { color: #94a3b8; }
.close { padding: 5px 9px; font-size: 18px; line-height: 12px; color: #94a3b8; }
</style>
