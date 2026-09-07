<script setup lang="ts">
import { ArrowUp, ChevronLeft, ChevronRight, Download, File, Folder, MoreHorizontal, RefreshCw, Upload, X } from '@lucide/vue'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type {
  FileTransferDirectoryEntry,
  FileTransferProgress,
  FileTransferResult,
} from '../../../../shared/file-transfer-contracts'

const props = defineProps<{
  sessionId: string
  hostname?: string
}>()

const emit = defineEmits<{
  close: []
  busyChange: [busy: boolean]
}>()

type TransferLog = {
  id: string
  direction: 'upload' | 'download'
  name: string
  remotePath: string
  phase: FileTransferProgress['phase']
  transferredBytes: number
  totalBytes?: number
  message?: string
}

type ContextMenuState = {
  x: number
  y: number
  entry: FileTransferDirectoryEntry | null
}

/**
 * This is intentionally a display-only recent-local-files list.  Electron's
 * native picker owns local paths, and the renderer must never retain or send
 * those absolute paths over IPC.  Each row can still be dragged to the remote
 * pane to start the same secure picker-based upload flow.
 */
type LocalFileEntry = {
  id: string
  name: string
  direction: 'upload' | 'download'
  phase: FileTransferProgress['phase']
}

const remotePath = ref('/')
const currentPath = ref('/')
const entries = ref<FileTransferDirectoryEntry[]>([])
const loadingDirectory = ref(false)
const activeTransferIds = ref(new Set<string>())
const selectedEntryName = ref<string | null>(null)
const contextMenu = ref<ContextMenuState | null>(null)
const transfers = ref<TransferLog[]>([])
const localFiles = ref<LocalFileEntry[]>([])
const draggedRemoteEntry = ref<FileTransferDirectoryEntry | null>(null)
const localDropActive = ref(false)
const remoteDropActive = ref(false)
const error = ref('')
const status = ref('正在准备远程目录。')
const directorySupported = ref(true)
let unsubscribeProgress: (() => void) | undefined
let directoryRequestId = 0

const busy = computed(() => activeTransferIds.value.size > 0)
const selectedEntry = computed(() => entries.value.find(entry => entry.name === selectedEntryName.value) ?? null)
const breadcrumbParts = computed(() => {
  const normalized = normalizeRemotePath(currentPath.value)
  if (normalized === '/') return [{ label: '/', path: '/' }]
  const parts = normalized.split('/').filter(Boolean)
  return parts.map((part, index) => ({
    label: part,
    path: `/${parts.slice(0, index + 1).join('/')}`,
  }))
})

function normalizeRemotePath(value: string): string {
  const normalized = value.trim().replaceAll('\\', '/')
  if (!normalized) return '/'
  if (normalized === '/') return '/'
  const hasLeadingSlash = normalized.startsWith('/')
  const parts: string[] = []
  for (const part of normalized.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (parts.length > 0 && parts.at(-1) !== '..') parts.pop()
      else if (!hasLeadingSlash) parts.push(part)
      continue
    }
    parts.push(part)
  }
  const result = `${hasLeadingSlash ? '/' : ''}${parts.join('/')}`
  return result || (hasLeadingSlash ? '/' : '.')
}

function isSftpUnsupportedMessage(message: string): boolean {
  const normalized = message.toLowerCase()
  return message.includes('不支持 SFTP')
    || normalized.includes('sftp subsystem unavailable')
    || normalized.includes('sftp subsystem not available')
    || normalized.includes('sftp subsystem unsupported')
}

function joinRemotePath(directory: string, name: string): string {
  const base = normalizeRemotePath(directory)
  if (!name) return base
  return base === '/' ? `/${name}` : `${base}/${name}`
}

function parentRemotePath(path: string): string {
  const normalized = normalizeRemotePath(path)
  if (normalized === '/' || normalized === '.') return normalized
  const index = normalized.lastIndexOf('/')
  if (index <= 0) return normalized.startsWith('/') ? '/' : '.'
  return normalized.slice(0, index) || '/'
}

function pathForUpload(directory: string): string {
  const normalized = normalizeRemotePath(directory)
  return normalized === '/' ? '/' : `${normalized}/`
}

function displayEntryIcon(entry: FileTransferDirectoryEntry): 'directory' | 'file' {
  return entry.kind === 'directory' ? 'directory' : 'file'
}

function entryLabel(entry: FileTransferDirectoryEntry): string {
  if (entry.kind === 'symlink') return `${entry.name}（链接）`
  if (entry.kind === 'other') return `${entry.name}（其他）`
  return entry.name
}

function sortEntries(value: readonly FileTransferDirectoryEntry[]): FileTransferDirectoryEntry[] {
  return [...value].sort((left, right) => {
    const kindOrder = (entry: FileTransferDirectoryEntry) => entry.kind === 'directory' ? 0 : 1
    const orderDifference = kindOrder(left) - kindOrder(right)
    if (orderDifference !== 0) return orderDifference
    return left.name.localeCompare(right.name, 'zh-CN', { sensitivity: 'base' })
  })
}

async function refreshDirectory(path = remotePath.value): Promise<void> {
  const normalized = normalizeRemotePath(path)
  const requestId = ++directoryRequestId
  remotePath.value = normalized
  error.value = ''
  contextMenu.value = null
  loadingDirectory.value = true
  status.value = '正在读取远程目录…'
  const list = window.terminalAgent.fileTransfer?.list
  if (typeof list !== 'function') {
    directorySupported.value = false
    entries.value = []
    currentPath.value = normalized
    status.value = '当前版本不支持远程目录浏览。'
    loadingDirectory.value = false
    return
  }
  directorySupported.value = true
  try {
    const result = await list({ sessionId: props.sessionId, remotePath: normalized })
    if (requestId !== directoryRequestId) return
    currentPath.value = normalizeRemotePath(result.remotePath || normalized)
    remotePath.value = currentPath.value
    entries.value = sortEntries(result.entries)
    selectedEntryName.value = null
    status.value = entries.value.length ? `${entries.value.length} 个远程条目` : '目录为空。'
  } catch (cause) {
    if (requestId !== directoryRequestId) return
    entries.value = []
    const message = cause instanceof Error ? cause.message : '远程目录读取失败。'
    if (isSftpUnsupportedMessage(message)) directorySupported.value = false
    error.value = message || '远程目录读取失败。'
    status.value = '目录读取失败。'
  } finally {
    if (requestId === directoryRequestId) loadingDirectory.value = false
  }
}

function selectEntry(entry: FileTransferDirectoryEntry): void {
  selectedEntryName.value = entry.name
  contextMenu.value = null
}

function openEntry(entry: FileTransferDirectoryEntry): void {
  selectEntry(entry)
  if (entry.kind !== 'directory') return
  void refreshDirectory(joinRemotePath(currentPath.value, entry.name))
}

function goToParent(): void {
  void refreshDirectory(parentRemotePath(currentPath.value))
}

function goToBreadcrumb(path: string): void {
  void refreshDirectory(path)
}

function showContextMenu(event: MouseEvent, entry: FileTransferDirectoryEntry | null = null): void {
  const target = event.currentTarget as HTMLElement | null
  const bounds = target?.getBoundingClientRect()
  const panel = (event.currentTarget as HTMLElement | null)?.closest('.file-transfer-panel') as HTMLElement | null
  const panelBounds = panel?.getBoundingClientRect()
  const rawX = event.clientX - (panelBounds?.left ?? 0)
  const rawY = event.clientY - (panelBounds?.top ?? 0)
  const maxX = Math.max(8, (panelBounds?.width ?? 320) - 178)
  const maxY = Math.max(8, (panelBounds?.height ?? 200) - 100)
  contextMenu.value = {
    x: Math.min(Math.max(8, rawX || bounds?.left || 8), maxX),
    y: Math.min(Math.max(8, rawY || bounds?.top || 8), maxY),
    entry,
  }
  if (entry) selectedEntryName.value = entry.name
}

function closeContextMenu(): void {
  contextMenu.value = null
}

function onDirectoryKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    closeContextMenu()
    return
  }
  if (event.key === 'Backspace' && !loadingDirectory.value) {
    event.preventDefault()
    goToParent()
  }
}

function createTransferId(): string {
  const candidate = globalThis.crypto?.randomUUID?.()
  if (candidate) return candidate
  // Electron exposes crypto.randomUUID, but retain a valid UUID fallback for
  // older test runners and preloaded renderer mocks.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
    const random = Math.random() * 16 | 0
    const value = character === 'x' ? random : (random & 0x3 | 0x8)
    return value.toString(16)
  })
}

function addTransfer(direction: 'upload' | 'download', targetPath: string, name: string, transferId: string): void {
  transfers.value.unshift({
    id: transferId,
    direction,
    name: name || (direction === 'upload' ? '待选择文件' : remoteBaseName(targetPath)),
    remotePath: targetPath,
    phase: 'selecting',
    transferredBytes: 0,
  })
  if (transfers.value.length > 24) transfers.value.length = 24
}

function markTransferActive(transferId: string): void {
  activeTransferIds.value = new Set([...activeTransferIds.value, transferId])
}

function markTransferSettled(transferId: string): void {
  const next = new Set(activeTransferIds.value)
  next.delete(transferId)
  activeTransferIds.value = next
}

function rememberLocalFile(
  transferId: string,
  name: string | undefined,
  direction: 'upload' | 'download',
  phase: FileTransferProgress['phase'],
): void {
  const displayName = name?.trim()
  if (!displayName) return
  const previous = localFiles.value.filter(item => item.id !== transferId)
  localFiles.value = [{ id: transferId, name: displayName, direction, phase }, ...previous].slice(0, 18)
}

function startRemoteEntryDrag(entry: FileTransferDirectoryEntry, event: DragEvent): void {
  if (entry.kind === 'directory') {
    event.preventDefault()
    return
  }
  draggedRemoteEntry.value = entry
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'copy'
    // The custom marker carries no path or file content.  The target uses the
    // in-memory entry and lets the native save dialog choose the local target.
    event.dataTransfer.setData('application/x-terminal-agent-remote-file', entry.name)
    event.dataTransfer.setData('text/plain', entry.name)
  }
}

function finishRemoteEntryDrag(): void {
  draggedRemoteEntry.value = null
  localDropActive.value = false
}

function startLocalEntryDrag(entry: LocalFileEntry, event: DragEvent): void {
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'copy'
    // Do not put an absolute local path in drag data.  The drop invokes the
    // trusted native picker, which lets the user affirm the upload source.
    event.dataTransfer.setData('application/x-terminal-agent-local-file', entry.id)
    event.dataTransfer.setData('text/plain', entry.name)
  }
}

function finishLocalEntryDrag(): void {
  remoteDropActive.value = false
}

function onLocalDragOver(event: DragEvent): void {
  if (!draggedRemoteEntry.value && !event.dataTransfer?.types.includes('application/x-terminal-agent-remote-file')) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
  localDropActive.value = true
}

function onLocalDragLeave(event: DragEvent): void {
  if ((event.currentTarget as HTMLElement | null)?.contains(event.relatedTarget as Node | null)) return
  localDropActive.value = false
}

function onLocalDrop(event: DragEvent): void {
  event.preventDefault()
  const draggedName = event.dataTransfer?.getData('application/x-terminal-agent-remote-file')
    || event.dataTransfer?.getData('text/plain')
    || ''
  const entry = draggedRemoteEntry.value
    ?? entries.value.find(candidate => candidate.name === draggedName)
  localDropActive.value = false
  draggedRemoteEntry.value = null
  if (busy.value) {
    status.value = '文件传输中，请等待当前传输完成。'
    return
  }
  if (!entry || entry.kind === 'directory') {
    status.value = '请将右侧的远程文件拖到本地文件区下载。'
    return
  }
  selectEntry(entry)
  void transfer('download', joinRemotePath(currentPath.value, entry.name), entry)
}

function onRemoteDragOver(event: DragEvent): void {
  const types = event.dataTransfer?.types
  const isLocalEntry = Boolean(types?.includes('application/x-terminal-agent-local-file'))
  const isExternalFile = Boolean(types?.includes('Files'))
  if (!isLocalEntry && !isExternalFile) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
  remoteDropActive.value = true
}

function onRemoteDragLeave(event: DragEvent): void {
  if ((event.currentTarget as HTMLElement | null)?.contains(event.relatedTarget as Node | null)) return
  remoteDropActive.value = false
}

function onRemoteDrop(event: DragEvent): void {
  event.preventDefault()
  remoteDropActive.value = false
  if (!directorySupported.value) {
    status.value = '当前 SSH 会话不支持 SFTP 文件传输。'
    return
  }
  if (busy.value) {
    status.value = '文件传输中，请等待当前传输完成。'
    return
  }
  // Browser/Electron drag events must not be used to expose native filesystem
  // paths to the renderer.  Dropping into the remote pane therefore opens the
  // trusted file picker and uploads the user-confirmed file into this folder.
  status.value = '请选择要上传到当前远程目录的本地文件。'
  uploadToCurrentDirectory()
}

function setTransferProgress(event: FileTransferProgress): void {
  if (event.sessionId !== props.sessionId) return
  const item = transfers.value.find(transfer => transfer.id === event.transferId)
  if (!item) return
  item.phase = event.phase
  item.transferredBytes = event.transferredBytes
  item.totalBytes = event.totalBytes
  item.name = event.fileName || item.name
  item.message = event.message
  rememberLocalFile(event.transferId, event.fileName ?? item.name, event.direction, event.phase)
  if (event.phase === 'completed' || event.phase === 'canceled' || event.phase === 'failed') {
    markTransferSettled(event.transferId)
  }
  if (event.message && event.phase !== 'failed') status.value = event.message
  if (event.phase === 'failed') error.value = event.message || '文件传输失败。'
}

async function transfer(direction: 'upload' | 'download', targetPath?: string, entry?: FileTransferDirectoryEntry | null): Promise<void> {
  const selected = entry ?? selectedEntry.value
  if (direction === 'download' && (!selected || selected.kind === 'directory')) {
    error.value = '请先选择要下载的远程文件。'
    return
  }
  const rawDestination = targetPath || (direction === 'download' && selected ? joinRemotePath(currentPath.value, selected.name) : pathForUpload(currentPath.value))
  const normalizedDestination = normalizeRemotePath(rawDestination)
  const destination = direction === 'upload' && rawDestination.endsWith('/') && normalizedDestination !== '/'
    ? `${normalizedDestination}/`
    : normalizedDestination
  if (!destination) {
    error.value = '远程路径无效。'
    return
  }
  const transferId = createTransferId()
  addTransfer(direction, destination, selected?.name || '', transferId)
  markTransferActive(transferId)
  error.value = ''
  status.value = direction === 'upload' ? '正在准备上传…' : '正在准备下载…'
  try {
    let result: FileTransferResult
    if (direction === 'upload') {
      result = await window.terminalAgent.fileTransfer.upload({ sessionId: props.sessionId, remotePath: destination, transferId })
    } else {
      result = await window.terminalAgent.fileTransfer.download({
        sessionId: props.sessionId,
        remotePath: destination,
        transferId,
        ...(selected?.name ? { fileName: selected.name } : {}),
      })
    }
    const item = transfers.value.find(transferItem => transferItem.id === transferId)
    if (item) {
      item.phase = result.status === 'canceled' ? 'canceled' : 'completed'
      item.transferredBytes = result.transferredBytes
      item.totalBytes = result.transferredBytes
      item.name = result.fileName || item.name
      item.message = result.status === 'canceled' ? '已取消。' : `${direction === 'upload' ? '上传' : '下载'}完成。`
      rememberLocalFile(transferId, item.name, direction, item.phase)
    }
    markTransferSettled(transferId)
    status.value = result.status === 'canceled' ? '已取消。' : `${direction === 'upload' ? '上传' : '下载'}完成。`
    if (direction === 'upload' && result.status === 'completed') await refreshDirectory(currentPath.value)
  } catch (cause) {
    markTransferSettled(transferId)
    const message = cause instanceof Error ? cause.message : '文件传输失败。'
    const item = transfers.value.find(transferItem => transferItem.id === transferId)
    if (item) {
      item.phase = 'failed'
      item.message = message
      rememberLocalFile(transferId, item.name, direction, item.phase)
    }
    error.value = message
    status.value = '传输失败。'
  }
}

function uploadToCurrentDirectory(): void {
  void transfer('upload', pathForUpload(currentPath.value), null)
  closeContextMenu()
}

function uploadToEntry(entry: FileTransferDirectoryEntry | null): void {
  const directory = entry?.kind === 'directory' ? joinRemotePath(currentPath.value, entry.name) : currentPath.value
  void transfer('upload', pathForUpload(directory), null)
  closeContextMenu()
}

function downloadSelected(): void {
  void transfer('download', undefined, selectedEntry.value)
  closeContextMenu()
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)))
  return `${(value / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

function formatEntrySize(entry: FileTransferDirectoryEntry): string {
  return entry.kind === 'directory' ? '目录' : formatBytes(entry.size)
}

function formatTransferProgress(item: TransferLog): string {
  if (item.phase === 'selecting') return '等待选择'
  if (item.phase === 'transferring') {
    if (item.totalBytes && item.totalBytes > 0) return `${Math.round(item.transferredBytes / item.totalBytes * 100)}%`
    return formatBytes(item.transferredBytes)
  }
  if (item.phase === 'completed') return '完成'
  if (item.phase === 'canceled') return '取消'
  return '失败'
}

function remoteBaseName(path: string): string {
  return normalizeRemotePath(path).split('/').filter(Boolean).at(-1) || 'download.bin'
}

function onPathSubmit(): void {
  void refreshDirectory(remotePath.value)
}

function onPanelClick(): void {
  if (contextMenu.value) closeContextMenu()
}

watch(busy, value => emit('busyChange', value), { immediate: true })

watch(() => props.sessionId, () => {
  ++directoryRequestId
  remotePath.value = '/'
  currentPath.value = '/'
  entries.value = []
  selectedEntryName.value = null
  transfers.value = []
  localFiles.value = []
  draggedRemoteEntry.value = null
  localDropActive.value = false
  remoteDropActive.value = false
  activeTransferIds.value = new Set()
  error.value = ''
  status.value = '正在准备远程目录。'
  void refreshDirectory('/')
})

onMounted(() => {
  const onProgress = window.terminalAgent.fileTransfer?.onProgress
  if (typeof onProgress === 'function') unsubscribeProgress = onProgress(setTransferProgress)
  void refreshDirectory('/')
  window.addEventListener('click', closeContextMenu)
})

onBeforeUnmount(() => {
  // The parent indicator must not remain lit after a session closes and this
  // still-mounted-while-hidden panel is finally removed.
  emit('busyChange', false)
  unsubscribeProgress?.()
  unsubscribeProgress = undefined
  window.removeEventListener('click', closeContextMenu)
})
</script>

<template>
  <section class="file-transfer-panel" aria-label="文件传输" @click="onPanelClick">
    <header class="file-transfer-header">
      <div class="file-transfer-title"><strong>文件传输</strong><span v-if="busy" class="file-transfer-busy">文件传输中</span><span v-if="hostname">{{ hostname }}</span><span class="file-transfer-description">通过当前 SSH 的独立 SFTP 通道传输，不会中断终端。</span></div>
      <button type="button" class="close-button" aria-label="关闭文件传输" title="关闭" @click.stop="emit('close')"><X :size="14" aria-hidden="true" /></button>
    </header>

    <div class="file-transfer-pathbar">
      <label :for="`file-transfer-remote-path-${sessionId}`">远程路径</label>
      <input :id="`file-transfer-remote-path-${sessionId}`" v-model="remotePath" type="text" autocomplete="off" :disabled="loadingDirectory" @keydown.enter.prevent="onPathSubmit" />
      <button type="button" class="icon-button" aria-label="返回上级目录" title="返回上级目录" :disabled="loadingDirectory || currentPath === '/'" @click="goToParent"><ChevronLeft :size="14" aria-hidden="true" /></button>
      <button type="button" class="icon-button" aria-label="刷新远程目录" title="刷新" :disabled="loadingDirectory || !directorySupported" @click="refreshDirectory(currentPath)"><RefreshCw :size="14" aria-hidden="true" :class="{ spinning: loadingDirectory }" /></button>
      <button type="button" class="action-button" aria-label="上传文件" :disabled="busy || !directorySupported" @click="uploadToCurrentDirectory"><Upload :size="13" aria-hidden="true" /><span>上传</span></button>
      <button type="button" class="action-button" aria-label="下载文件" :disabled="busy || !directorySupported" @click="downloadSelected"><Download :size="13" aria-hidden="true" /><span>下载</span></button>
    </div>

    <nav class="file-transfer-breadcrumbs" aria-label="远程路径导航">
      <button v-for="(part, index) in breadcrumbParts" :key="part.path" type="button" :class="{ current: index === breadcrumbParts.length - 1 }" @click="goToBreadcrumb(part.path)">{{ part.label }}<ChevronRight v-if="index < breadcrumbParts.length - 1" :size="12" aria-hidden="true" /></button>
    </nav>

    <section class="file-transfer-browser" aria-label="本地与远程文件目录">
      <section
        class="file-pane local-file-pane"
        :class="{ 'drop-active': localDropActive }"
        aria-label="本地文件区"
        @dragover="onLocalDragOver"
        @dragleave="onLocalDragLeave"
        @drop="onLocalDrop"
      >
        <header class="section-heading"><span>本地（左）</span><span>最近选择 {{ localFiles.length }} 项</span></header>
        <div class="directory-list local-file-list" role="listbox" aria-label="本地文件">
          <button
            v-for="entry in localFiles"
            :key="entry.id"
            type="button"
            class="directory-entry local-file-entry"
            role="option"
            draggable="true"
            :disabled="busy || !directorySupported"
            :title="`拖到右侧远程目录后重新确认上传：${entry.name}`"
            @dragstart="startLocalEntryDrag(entry, $event)"
            @dragend="finishLocalEntryDrag"
            @click="uploadToCurrentDirectory"
          ><File :size="14" aria-hidden="true" class="entry-icon" /><span class="entry-name">{{ entry.name }}</span><small>{{ entry.direction === 'upload' ? '上传' : '下载' }}</small><MoreHorizontal :size="14" aria-hidden="true" class="entry-menu-hint" /></button>
          <button v-if="!localFiles.length" type="button" class="directory-empty local-empty-action" :disabled="busy || !directorySupported" @click="uploadToCurrentDirectory">选择本地文件上传<br /><small>或把右侧远程文件拖到这里下载</small></button>
          <div v-else class="directory-empty local-drop-hint">把右侧远程文件拖到这里下载</div>
        </div>
      </section>

      <section
        class="file-pane remote-file-pane"
        :class="{ 'drop-active': remoteDropActive }"
        aria-label="远程文件区"
        @keydown="onDirectoryKeydown"
        @contextmenu.prevent="showContextMenu($event)"
        @dragover="onRemoteDragOver"
        @dragleave="onRemoteDragLeave"
        @drop="onRemoteDrop"
      >
        <header class="section-heading"><span>远程（右）</span><span>{{ loadingDirectory ? '读取中…' : `${entries.length} 项` }}</span></header>
        <div class="directory-list" role="listbox" aria-label="远程文件目录">
          <button v-if="currentPath !== '/'" type="button" class="directory-entry parent-entry" role="option" aria-label="返回上级目录" @dblclick="goToParent" @click="goToParent"><ArrowUp :size="14" aria-hidden="true" /><span>..</span><small>上级目录</small></button>
          <button
            v-for="entry in entries"
            :key="entry.name"
            type="button"
            class="directory-entry"
            :class="{ selected: selectedEntryName === entry.name }"
            role="option"
            :aria-selected="selectedEntryName === entry.name"
            :draggable="entry.kind !== 'directory'"
            :title="entry.kind === 'directory' ? entry.name : `拖到左侧本地文件区下载：${entry.name}`"
            @click="selectEntry(entry)"
            @dblclick="openEntry(entry)"
            @dragstart="startRemoteEntryDrag(entry, $event)"
            @dragend="finishRemoteEntryDrag"
            @contextmenu.stop.prevent="showContextMenu($event, entry)"
          >
            <Folder v-if="displayEntryIcon(entry) === 'directory'" :size="14" aria-hidden="true" class="entry-icon directory-icon" /><File v-else :size="14" aria-hidden="true" class="entry-icon" />
            <span class="entry-name" :title="entry.name">{{ entryLabel(entry) }}</span>
            <small>{{ formatEntrySize(entry) }}</small>
            <MoreHorizontal :size="14" aria-hidden="true" class="entry-menu-hint" />
          </button>
          <div v-if="!loadingDirectory && !entries.length && directorySupported" class="directory-empty">此目录没有可显示的条目</div>
          <div v-if="loadingDirectory" class="directory-empty">正在读取远程目录…</div>
          <div v-if="!directorySupported" class="directory-empty">当前 SSH 会话不支持 SFTP 目录浏览</div>
          <div v-if="remoteDropActive" class="directory-drop-overlay" aria-hidden="true">松开后选择本地文件上传</div>
        </div>
      </section>
    </section>

    <div v-if="contextMenu" class="directory-context-menu" :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }" role="menu" @click.stop>
      <button v-if="contextMenu.entry?.kind === 'directory'" type="button" role="menuitem" @click="openEntry(contextMenu.entry); closeContextMenu()"><Folder :size="13" aria-hidden="true" />进入目录</button>
      <button type="button" role="menuitem" :disabled="busy || !directorySupported" @click="uploadToEntry(contextMenu.entry)"><Upload :size="13" aria-hidden="true" />上传到此处</button>
      <button v-if="contextMenu.entry && contextMenu.entry.kind !== 'directory'" type="button" role="menuitem" :disabled="busy" @click="downloadSelected(); closeContextMenu()"><Download :size="13" aria-hidden="true" />下载文件</button>
    </div>

    <section class="file-transfer-log" aria-label="上传下载进度">
      <header class="section-heading"><span>上传下载进度</span><span>{{ transfers.length ? `${transfers.length} 条记录` : '暂无记录' }}</span></header>
      <div v-if="transfers.length" class="transfer-table" role="table" aria-label="上传下载进度表">
        <div class="transfer-row transfer-head" role="row"><span>方向</span><span>文件</span><span>进度</span><span>状态</span></div>
        <div v-for="item in transfers" :key="item.id" class="transfer-row" role="row">
          <span :class="['direction', item.direction]">{{ item.direction === 'upload' ? '上传' : '下载' }}</span>
          <span class="transfer-name" :title="item.remotePath">{{ item.name }}</span>
          <span>{{ formatTransferProgress(item) }}<small v-if="item.phase === 'transferring' && item.totalBytes"> · {{ formatBytes(item.transferredBytes) }}/{{ formatBytes(item.totalBytes) }}</small></span>
          <span :class="['transfer-state', item.phase]">{{ item.message || formatTransferProgress(item) }}</span>
        </div>
      </div>
      <p v-else class="log-empty">上传或下载记录会显示在这里。</p>
    </section>

    <p v-if="error" class="file-transfer-error" role="alert">{{ error }}</p>
    <p v-else class="file-transfer-status" aria-live="polite">{{ status }}</p>
  </section>
</template>

<style scoped>
.file-transfer-panel { position: relative; display: grid; grid-template-rows: auto auto auto minmax(56px, 1fr) minmax(50px, .8fr) auto; gap: 6px; box-sizing: border-box; width: 100%; min-width: 0; min-height: 150px; max-height: 300px; padding: 8px 10px 9px; border-top: 1px solid var(--line); background: var(--panel); color: var(--text); }
.file-transfer-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }.file-transfer-title { display: flex; align-items: baseline; gap: 8px; min-width: 0; overflow: hidden; }.file-transfer-title strong { flex: 0 0 auto; color: var(--text-strong); font-size: 11px; font-weight: 720; }.file-transfer-title span { min-width: 0; overflow: hidden; color: var(--muted); font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }.file-transfer-title .file-transfer-busy { flex: 0 0 auto; padding: 1px 4px; border: 1px solid var(--amber-line); border-radius: 3px; background: var(--amber-soft); color: var(--amber); font-size: 8px; font-weight: 700; }.file-transfer-description { flex: 1 1 auto; color: var(--faint) !important; font-size: 8px !important; }
.close-button,.icon-button { display: grid; place-items: center; width: 25px; height: 25px; padding: 0; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); color: var(--muted); }.close-button:hover,.icon-button:hover:not(:disabled) { border-color: var(--focus); color: var(--text-strong); }.close-button:disabled,.icon-button:disabled { cursor: not-allowed; opacity: .52; }
.file-transfer-pathbar { display: grid; grid-template-columns: auto minmax(0, 1fr) 25px 25px auto auto; align-items: center; gap: 5px; min-width: 0; }.file-transfer-pathbar label { color: var(--text-strong); font-size: 9px; font-weight: 650; }.file-transfer-pathbar input { box-sizing: border-box; width: 100%; min-width: 0; height: 25px; padding: 0 7px; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); color: var(--text-strong); font: inherit; font-size: 10px; }.file-transfer-pathbar input:focus { border-color: var(--focus); outline: 2px solid color-mix(in srgb, var(--focus) 22%, transparent); }
.action-button { display: inline-flex; align-items: center; justify-content: center; gap: 4px; min-width: 54px; height: 25px; padding: 0 7px; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); color: var(--text-strong); font-size: 9px; font-weight: 650; white-space: nowrap; }.action-button:hover:not(:disabled) { border-color: var(--focus); background: var(--hover); }.action-button:disabled { cursor: not-allowed; opacity: .52; }
.file-transfer-breadcrumbs { display: flex; align-items: center; min-width: 0; min-height: 17px; overflow: hidden; color: var(--muted); }.file-transfer-breadcrumbs button { display: inline-flex; align-items: center; gap: 2px; min-width: 0; max-width: 150px; padding: 1px 3px; border: 0; background: transparent; color: inherit; font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }.file-transfer-breadcrumbs button:hover,.file-transfer-breadcrumbs button.current { color: var(--text-strong); }.file-transfer-breadcrumbs button.current { font-weight: 650; }
.file-transfer-browser { display: grid; grid-template-columns: minmax(0, .86fr) minmax(0, 1.14fr); gap: 6px; min-width: 0; min-height: 0; overflow: hidden; border: 0; background: transparent; }.file-pane,.file-transfer-log { display: grid; grid-template-rows: auto minmax(0, 1fr); min-width: 0; min-height: 0; overflow: hidden; border: 1px solid var(--line-soft); background: var(--surface); }.file-transfer-log { min-height: 50px; }.section-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; min-height: 23px; padding: 0 7px; border-bottom: 1px solid var(--line-soft); color: var(--text-strong); font-size: 9px; font-weight: 650; }.section-heading span:last-child { color: var(--muted); font-size: 8px; font-weight: 500; }
.directory-list { position: relative; min-width: 0; min-height: 0; overflow: auto; padding: 2px; scrollbar-width: thin; scrollbar-color: transparent transparent; }.directory-list:hover,.directory-list:focus-within { scrollbar-color: color-mix(in srgb, var(--muted) 55%, transparent) transparent; }.directory-entry { display: grid; grid-template-columns: 18px minmax(0, 1fr) auto 17px; align-items: center; gap: 4px; width: 100%; min-height: 24px; padding: 2px 5px; border: 1px solid transparent; border-radius: 3px; background: transparent; color: var(--text); font-size: 9px; text-align: left; }.directory-entry:hover,.directory-entry.selected { border-color: var(--amber-line); background: var(--amber-soft); }.directory-entry .entry-icon { color: var(--muted); }.directory-entry .directory-icon { color: var(--amber); }.entry-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.directory-entry small { color: var(--muted); font-size: 8px; white-space: nowrap; }.entry-menu-hint { color: var(--faint); }.parent-entry { color: var(--muted); }.directory-empty { display: grid; place-items: center; min-height: 48px; padding: 8px; color: var(--muted); font-size: 9px; text-align: center; }.directory-empty small { color: var(--faint); font-size: 8px; }.local-file-pane.drop-active,.remote-file-pane.drop-active { border-color: var(--focus); box-shadow: inset 0 0 0 1px var(--focus); }.local-file-entry { cursor: grab; }.local-file-entry:active { cursor: grabbing; }.local-empty-action { width: calc(100% - 8px); margin: 4px; border: 1px dashed var(--line); background: transparent; cursor: pointer; }.local-empty-action:hover:not(:disabled) { border-color: var(--focus); background: var(--hover); }.local-empty-action:disabled { cursor: not-allowed; opacity: .55; }.directory-drop-overlay { position: absolute; inset: 4px; z-index: 2; display: grid; place-items: center; border: 1px dashed var(--focus); border-radius: 4px; background: color-mix(in srgb, var(--focus) 13%, var(--surface)); color: var(--text-strong); font-size: 9px; pointer-events: none; }
.directory-context-menu { position: absolute; z-index: 5; display: grid; min-width: 154px; padding: 3px; border: 1px solid var(--line); border-radius: 5px; background: var(--surface); box-shadow: 0 10px 24px rgb(24 31 40 / 22%); }.directory-context-menu button { display: inline-flex; align-items: center; gap: 6px; min-height: 26px; padding: 0 7px; border: 0; border-radius: 3px; background: transparent; color: var(--text); font-size: 9px; text-align: left; }.directory-context-menu button:hover:not(:disabled) { background: var(--hover); }.directory-context-menu button:disabled { cursor: not-allowed; opacity: .52; }
.transfer-table { min-width: 0; min-height: 0; overflow: auto; scrollbar-width: thin; scrollbar-color: transparent transparent; }.transfer-table:hover { scrollbar-color: color-mix(in srgb, var(--muted) 55%, transparent) transparent; }.transfer-row { display: grid; grid-template-columns: 38px minmax(60px, 1fr) 64px minmax(55px, .9fr); align-items: center; gap: 6px; min-width: 300px; min-height: 22px; padding: 0 7px; border-bottom: 1px solid var(--line-soft); color: var(--muted); font-size: 8px; }.transfer-row:last-child { border-bottom: 0; }.transfer-head { position: sticky; top: 0; z-index: 1; min-height: 21px; background: var(--surface-soft); color: var(--faint); font-size: 8px; }.transfer-name { min-width: 0; overflow: hidden; color: var(--text); text-overflow: ellipsis; white-space: nowrap; }.direction.upload { color: var(--accent); }.direction.download { color: var(--focus); }.transfer-state.completed { color: var(--accent); }.transfer-state.failed { color: var(--red); }.transfer-state.canceled { color: var(--muted); }.transfer-row small { color: var(--faint); }.log-empty { display: grid; place-items: center; margin: 0; padding: 8px; color: var(--muted); font-size: 9px; }
.file-transfer-status,.file-transfer-error { min-width: 0; margin: 0; overflow: hidden; font-size: 9px; line-height: 1.3; text-overflow: ellipsis; white-space: nowrap; }.file-transfer-status { color: var(--muted); }.file-transfer-error { color: var(--red); }.spinning { animation: file-transfer-spin .9s linear infinite; }@keyframes file-transfer-spin { to { transform: rotate(360deg); } }
@media (max-width: 680px) { .file-transfer-pathbar { grid-template-columns: auto minmax(0, 1fr) 25px 25px; }.file-transfer-pathbar .action-button { grid-row: 2; }.file-transfer-pathbar .action-button:nth-last-child(2) { grid-column: 2; }.file-transfer-pathbar .action-button:last-child { grid-column: 3 / -1; }.file-transfer-browser { grid-template-columns: 1fr; grid-template-rows: minmax(70px, .8fr) minmax(110px, 1.2fr); overflow: auto; }.transfer-row { grid-template-columns: 38px minmax(70px, 1fr) 54px minmax(45px, .8fr); } }
</style>
