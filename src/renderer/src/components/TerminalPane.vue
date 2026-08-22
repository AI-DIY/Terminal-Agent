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
  const styles = getComputedStyle(terminalElement.value!)
  const background = styles.getPropertyValue('--terminal').trim() || '#151a20'
  terminal = new Terminal({
    convertEol: true,
    cursorBlink: true,
    fontFamily: '"Cascadia Mono", Consolas, "Courier New", monospace',
    fontSize: 13,
    theme: {
      background,
      foreground: '#d8dade',
      cursor: '#eef2f7',
      selectionBackground: '#35577a',
    },
  })
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
.terminal-pane { min-width: 0; min-height: 0; overflow: hidden; background: var(--terminal, #151a20); }
.terminal-element { height: 100%; min-height: 0; padding: 11px 12px; }
</style>
