<script setup lang="ts">
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { SessionView } from '../stores/sessions'

const props = defineProps<{ session: SessionView; active: boolean }>()
const emit = defineEmits<{ activate: [] }>()
const terminalElement = ref<HTMLElement>()
let terminal: Terminal | undefined
let fit: FitAddon | undefined
let observer: ResizeObserver | undefined
let unsubscribe: (() => void) | undefined
let inputSubscription: { dispose(): void } | undefined

function resize(): void {
  if (!terminal || !fit) return
  fit.fit()
  void window.terminalAgent.sessions.resize(props.session.id, terminal.cols, terminal.rows)
}

onMounted(() => {
  terminal = new Terminal({ convertEol: true, cursorBlink: true, theme: { background: '#151a20', foreground: '#d8dade' } })
  fit = new FitAddon()
  terminal.loadAddon(fit)
  terminal.open(terminalElement.value!)
  terminal.write(props.session.buffer)
  inputSubscription = terminal.onData(data => { void window.terminalAgent.sessions.write(props.session.id, data) })
  unsubscribe = window.terminalAgent.sessions.onData(event => {
    if (event.sessionId === props.session.id) terminal?.write(event.data)
  })
  observer = new ResizeObserver(resize)
  observer.observe(terminalElement.value!)
  resize()
})

onBeforeUnmount(() => {
  unsubscribe?.()
  inputSubscription?.dispose()
  observer?.disconnect()
  fit?.dispose()
  terminal?.dispose()
})
</script>

<template>
  <section
    class="terminal-pane"
    :class="{ active }"
    :data-testid="`terminal-pane-${session.id}`"
    :aria-label="`终端会话 ${session.hostname}`"
    role="region"
    @pointerdown="emit('activate')"
  >
    <div ref="terminalElement" class="terminal-element" />
  </section>
</template>

<style scoped>
.terminal-pane { min-width: 0; min-height: 0; overflow: hidden; border: 1px solid var(--line, #3d4046); background: var(--terminal, #151a20); }
.terminal-pane.active { border-color: var(--accent, #2f6fc4); }
.terminal-element { height: 100%; min-height: 0; padding: 8px; }
</style>
