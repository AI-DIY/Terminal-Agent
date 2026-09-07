<script setup lang="ts">
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { MAX_SESSION_BUFFER_CHARS, type SessionView } from '../stores/sessions'
import { getLayoutPreferencesStore } from '../stores/layout-preferences'
import type { ShellFontSize } from '../../../shared/contracts'

const props = defineProps<{ session: SessionView; active: boolean; fontSize: ShellFontSize }>()
const emit = defineEmits<{ activate: [] }>()
const layout = getLayoutPreferencesStore()
const paneElement = ref<HTMLElement>()
const terminalElement = ref<HTMLElement>()
const contextMenuOpen = ref(false)
const contextMenuStyle = ref({ left: '8px', top: '8px' })
const hasSelection = ref(false)
const clipboardAvailable = typeof navigator !== 'undefined' && Boolean(navigator.clipboard)
let terminal: Terminal | undefined
let fit: FitAddon | undefined
let observer: ResizeObserver | undefined
let unsubscribe: (() => void) | undefined
let inputSubscription: { dispose(): void } | undefined
let selectionSubscription: { dispose(): void } | undefined
let initialBufferFrame: number | undefined
let themeFrame: number | undefined
let renderedBuffer = ''

/**
 * Keep the xterm instance aligned with the renderer's retained output.
 *
 * An SSH data IPC event can be queued for the workbench's next animation
 * frame immediately before this pane mounts. In that narrow interval the
 * event is correctly stored, but this pane has not installed its live data
 * listener yet. Reconcile the retained buffer after mounting so the initial
 * greeting is never skipped by that timing boundary.
 */
function syncTerminalBuffer(): void {
  const buffered = props.session.buffer
  if (!terminal || buffered === renderedBuffer) return
  if (buffered.startsWith(renderedBuffer)) {
    writeTerminalData(buffered.slice(renderedBuffer.length))
    return
  }
  // A bounded retained buffer can discard its prefix. Resetting is rare, and
  // it prevents duplicated/stale text when a pane is remounted after that
  // rollover.
  terminal.reset()
  terminal.write(buffered)
  renderedBuffer = buffered
}

function writeTerminalData(data: string): void {
  if (!terminal || !data) return
  terminal.write(data)
  renderedBuffer = `${renderedBuffer}${data}`.slice(-MAX_SESSION_BUFFER_CHARS)
}

function openContextMenu(event: MouseEvent): void {
  const bounds = paneElement.value?.getBoundingClientRect()
  if (!bounds) return
  const width = 158
  const height = 148
  const left = Math.max(6, Math.min(event.clientX - bounds.left, Math.max(6, bounds.width - width - 6)))
  const top = Math.max(6, Math.min(event.clientY - bounds.top, Math.max(6, bounds.height - height - 6)))
  contextMenuStyle.value = { left: `${left}px`, top: `${top}px` }
  contextMenuOpen.value = true
}

function closeContextMenu(): void { contextMenuOpen.value = false }

function fallbackCopy(value: string): boolean {
  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.append(textarea)
  textarea.select()
  try { return document.execCommand('copy') } catch { return false } finally { textarea.remove() }
}

async function copySelection(): Promise<void> {
  const value = terminal?.getSelection() ?? ''
  if (!value) return
  let copied = false
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(value)
      copied = true
    } else {
      copied = fallbackCopy(value)
    }
  } catch { copied = fallbackCopy(value) }
  if (!copied) {
    closeContextMenu()
    return
  }
  terminal?.clearSelection()
  hasSelection.value = false
  closeContextMenu()
}

async function pasteClipboard(): Promise<void> {
  if (!terminal || !clipboardAvailable) return
  try {
    const value = await navigator.clipboard.readText()
    if (value) terminal.paste(value)
  } catch { /* Clipboard permissions are controlled by the host. */ }
  closeContextMenu()
  // The context-menu button takes focus away from xterm. Restore it so the
  // next keystroke continues in the terminal without an extra click.
  terminal.focus()
}

function selectAll(): void {
  terminal?.selectAll()
  hasSelection.value = terminal?.hasSelection() ?? false
  closeContextMenu()
}

function clearSelection(): void {
  terminal?.clearSelection()
  hasSelection.value = false
  closeContextMenu()
}

function resize(): void {
  const element = terminalElement.value
  if (!terminal || !fit || !element || !element.isConnected) return
  // WorkbenchView stays mounted while settings/skills are visible. During
  // that interval its `v-show` ancestor has no layout box; FitAddon otherwise
  // proposes its minimum 2x1 grid and sends that transient size to the PTY.
  const bounds = element.getBoundingClientRect()
  if (bounds.width <= 0 || bounds.height <= 0) return
  fit.fit()
  void window.terminalAgent.sessions.resize(props.session.id, terminal.cols, terminal.rows)
}

function readTerminalTheme(): { background: string; foreground: string; cursor: string; selectionBackground: string } {
  const styles = getComputedStyle(terminalElement.value ?? document.documentElement)
  return {
    background: styles.getPropertyValue('--terminal').trim() || '#151a20',
    foreground: styles.getPropertyValue('--terminal-text').trim() || '#d8dade',
    cursor: styles.getPropertyValue('--focus').trim() || '#eef2f7',
    selectionBackground: styles.getPropertyValue('--selected').trim() || '#35577a',
  }
}

function applyTerminalTheme(): void {
  if (!terminal) return
  terminal.options.theme = readTerminalTheme()
}

function scheduleTerminalTheme(): void {
  if (themeFrame !== undefined) window.cancelAnimationFrame(themeFrame)
  // Theme selection persists before the appearance screen writes the document
  // data attribute.  Sampling on the next frame ensures xterm observes the
  // freshly applied CSS variables rather than the previous palette.
  themeFrame = window.requestAnimationFrame(() => {
    themeFrame = undefined
    applyTerminalTheme()
  })
}

onMounted(() => {
  terminal = new Terminal({
    convertEol: true,
    cursorBlink: true,
    fontFamily: '"Cascadia Mono", Consolas, "Courier New", monospace',
    fontSize: props.fontSize,
    theme: readTerminalTheme(),
  })
  fit = new FitAddon()
  terminal.loadAddon(fit)
  terminal.open(terminalElement.value!)
  syncTerminalBuffer()
  inputSubscription = terminal.onData(data => { void window.terminalAgent.sessions.write(props.session.id, data) })
  selectionSubscription = terminal.onSelectionChange(() => { hasSelection.value = terminal?.hasSelection() ?? false })
  unsubscribe = window.terminalAgent.sessions.onData(event => {
    if (event.sessionId === props.session.id) writeTerminalData(event.data)
  })
  // The workbench batches data into requestAnimationFrame. Queue a second,
  // later frame after registering the live listener to bridge the only gap:
  // data queued before this component mounts but flushed after its first
  // initial-buffer write.
  initialBufferFrame = window.requestAnimationFrame(() => {
    initialBufferFrame = undefined
    syncTerminalBuffer()
  })
  observer = new ResizeObserver(resize)
  observer.observe(terminalElement.value!)
  resize()
})

onBeforeUnmount(() => {
  if (initialBufferFrame !== undefined) window.cancelAnimationFrame(initialBufferFrame)
  initialBufferFrame = undefined
  if (themeFrame !== undefined) window.cancelAnimationFrame(themeFrame)
  themeFrame = undefined
  unsubscribe?.()
  inputSubscription?.dispose()
  selectionSubscription?.dispose()
  observer?.disconnect()
  fit?.dispose()
  terminal?.dispose()
  window.removeEventListener('pointerdown', closeContextMenu)
})
onMounted(() => window.addEventListener('pointerdown', closeContextMenu))

watch(
  () => props.fontSize,
  fontSize => {
    if (!terminal) return
    terminal.options.fontSize = fontSize
    resize()
  },
)

watch(
  () => layout.state.theme,
  scheduleTerminalTheme,
)
</script>

<template>
  <section
    ref="paneElement"
    class="terminal-pane"
    :class="{ active }"
    :data-testid="`terminal-pane-${session.id}`"
    :aria-label="`终端会话 ${session.hostname}`"
    role="region"
    @pointerdown="emit('activate')"
    @contextmenu.stop.prevent="openContextMenu"
  >
    <div ref="terminalElement" class="terminal-element" />
    <nav v-if="contextMenuOpen" class="terminal-context-menu" role="menu" aria-label="终端剪贴板操作" :style="contextMenuStyle" @pointerdown.stop>
      <button type="button" role="menuitem" :disabled="!hasSelection" @click="copySelection">复制</button>
      <button type="button" role="menuitem" :disabled="!clipboardAvailable" @click="pasteClipboard">粘贴</button>
      <button type="button" role="menuitem" @click="selectAll">全选</button>
      <button type="button" role="menuitem" :disabled="!hasSelection" @click="clearSelection">取消选择</button>
    </nav>
  </section>
</template>

<style scoped>
.terminal-pane { position: relative; min-width: 0; min-height: 0; overflow: hidden; padding: 11px 12px; background: var(--terminal, #151a20); }
.terminal-element { height: 100%; min-height: 0; }
.terminal-context-menu { position: absolute; z-index: 9; display: grid; min-width: 154px; padding: 4px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); box-shadow: 0 14px 36px rgb(24 31 40 / 22%); }
.terminal-context-menu button { min-height: 29px; padding: 0 8px; border: 0; border-radius: 3px; background: transparent; color: var(--text); font-size: 11px; text-align: left; }
.terminal-context-menu button:hover,.terminal-context-menu button:focus-visible { background: var(--surface-soft); outline: 1px solid var(--accent); }
.terminal-context-menu button:disabled { color: var(--muted); cursor: not-allowed; }
</style>
