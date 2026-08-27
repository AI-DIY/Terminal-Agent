<script setup lang="ts">
import { Circle, X } from '@lucide/vue'
import { sessionDisplayLabel, type SessionView } from '../stores/sessions'

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
      <button type="button" class="select" :aria-label="`选择终端会话 ${sessionDisplayLabel(session, sessions)}`" :aria-current="session.id === activeSessionId ? 'page' : undefined" @click="emit('select', session.id)">
        <Circle :size="7" :stroke-width="0" fill="currentColor" aria-hidden="true" />
        <strong>{{ sessionDisplayLabel(session, sessions) }}</strong>
        <small>已连接</small>
      </button>
      <button type="button" class="close" :aria-label="`关闭终端会话 ${sessionDisplayLabel(session, sessions)}`" title="关闭 Shell" @click="emit('close', session.id)"><X :size="13" aria-hidden="true" /></button>
    </div>
  </nav>
</template>

<style scoped>
.session-tabs { display: flex; min-width: 0; flex: 1 1 auto; overflow-x: auto; background: var(--panel); scrollbar-width: thin; }
.session-tab { display: flex; height: 41px; flex: 0 0 auto; align-items: center; max-width: 245px; border-right: 1px solid var(--line-soft); background: transparent; color: var(--muted); white-space: nowrap; }
.session-tab:hover { background: var(--hover); }
.session-tab.active { background: var(--surface); box-shadow: inset 0 -2px 0 var(--accent); color: var(--text-strong); }
button { border: 0; background: transparent; color: inherit; }
.select { display: flex; min-width: 0; align-items: center; gap: 7px; height: 100%; padding: 0 4px 0 10px; text-align: left; }
.select > svg { flex: 0 0 auto; color: var(--green); }.session-tab.active .select > svg { color: var(--accent); }
.select strong { max-width: 128px; overflow: hidden; color: var(--text-strong); font-size: 11px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
small { color: var(--faint); font-size: 9px; }
.close { display: grid; place-items: center; width: 26px; height: 26px; flex: 0 0 auto; padding: 0; border-radius: 4px; color: var(--faint); }.close:hover { background: var(--hover); color: var(--red); }
</style>
