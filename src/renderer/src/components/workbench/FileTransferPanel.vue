<script setup lang="ts">
import { ArrowUp, ChevronLeft, ChevronRight, Download, File, Folder, FolderOpen, MoreHorizontal, RefreshCw, Upload, X } from '@lucide/vue'
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

type PaneKind = 'local' | 'remote'

type ContextMenuState = {
  x: number
  y: number
  pane: PaneKind
  entry: FileTransferDirectoryEntry | null
}

const remotePath = ref('/')
const remoteCurrentPath = ref('/')
const remoteEntries = ref<FileTransferDirectoryEntry[]>([])
const localPath = ref('')
const localCurrentPath = ref('')
const localRootPath = ref('')
const localEntries = ref<FileTransferDirectoryEntry[]>([])
const loadingRemoteDirectory = ref(false)
const loadingLocalDirectory = ref(false)
const remoteDirectorySupported = ref(true)
const localDirectorySupported = ref(true)
const selectedRemoteEntryName = ref<string | null>(null)
const selectedLocalEntryName = ref<string | null>(null)
const activeTransferIds = ref(new Set<string>())
const transfers = ref<TransferLog[]>([])
const contextMenu = ref<ContextMenuState | null>(null)
const draggedRemoteEntry = ref<FileTransferDirectoryEntry | null>(null)
const draggedLocalEntry = ref<FileTransferDirectoryEntry | null>(null)
const localDropActive = ref(false)
const remoteDropActive = ref(false)
const error = ref('')
const status = ref('正在准备文件传输目录。')
let unsubscribeProgress: (() => void) | undefined
let remoteDirectoryRequestId = 0
let localDirectoryRequestId = 0

const busy = computed(() => activeTransferIds.value.size > 0)
const selectedRemoteEntry = computed(() => remoteEntries.value.find(entry => entry.name === selectedRemoteEntryName.value) ?? null)
const selectedLocalEntry = computed(() => localEntries.value.find(entry => entry.name === selectedLocalEntryName.value) ?? null)
const remoteBreadcrumbParts = computed(() => {
  const normalized = normalizeRemotePath(remoteCurrentPath.value)
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

function normalizeLocalPath(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  const driveRoot = /^([a-zA-Z]:)[\\/]*$/.exec(trimmed)
  if (driveRoot) return `${driveRoot[1]}\\`
  if (/^[\\/]+$/.test(trimmed)) return trimmed[0]
  return trimmed.replace(/[\\/]+$/, '')
}

function localPathKey(value: string): string {
  return normalizeLocalPath(value).replaceAll('\\', '/').toLocaleLowerCase()
}

function sameLocalPath(left: string, right: string): boolean {
  return Boolean(left && right) && localPathKey(left) === localPathKey(right)
}

function joinLocalPath(directory: string, name: string): string {
  const base = normalizeLocalPath(directory)
  if (!base || !name) return base
  const separator = base.includes('\\') ? '\\' : '/'
  return `${base}${/[\\/]$/.test(base) ? '' : separator}${name}`
}

function parentLocalPath(path: string): string {
  const normalized = normalizeLocalPath(path)
  if (!normalized || /^[a-zA-Z]:\\$/.test(normalized) || normalized === '/' || normalized === '\\') return normalized
  const parent = normalized.replace(/[\\/][^\\/]+$/, '')
  return normalizeLocalPath(parent) || normalized
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

async function refreshRemoteDirectory(path = remotePath.value): Promise<void> {
  const normalized = normalizeRemotePath(path)
  const requestId = ++remoteDirectoryRequestId
  remotePath.value = normalized
  error.value = ''
  contextMenu.value = null
  loadingRemoteDirectory.value = true
  status.value = '正在读取远程目录…'
  const list = window.terminalAgent.fileTransfer?.list
  if (typeof list !== 'function') {
    remoteDirectorySupported.value = false
    remoteEntries.value = []
    remoteCurrentPath.value = normalized
    status.value = '当前版本不支持远程目录浏览。'
    loadingRemoteDirectory.value = false
    return
  }
  remoteDirectorySupported.value = true
  try {
    const result = await list({ sessionId: props.sessionId, remotePath: normalized })
    if (requestId !== remoteDirectoryRequestId) return
    remoteCurrentPath.value = normalizeRemotePath(result.remotePath || normalized)
    remotePath.value = remoteCurrentPath.value
    remoteEntries.value = sortEntries(result.entries)
    selectedRemoteEntryName.value = null
    status.value = remoteEntries.value.length ? `${remoteEntries.value.length} 个远程条目` : '远程目录为空。'
  } catch (cause) {
    if (requestId !== remoteDirectoryRequestId) return
    remoteEntries.value = []
    const message = cause instanceof Error ? cause.message : '远程目录读取失败。'
    if (isSftpUnsupportedMessage(message)) remoteDirectorySupported.value = false
    error.value = message || '远程目录读取失败。'
    status.value = '远程目录读取失败。'
  } finally {
    if (requestId === remoteDirectoryRequestId) loadingRemoteDirectory.value = false
  }
}

async function refreshLocalDirectory(path?: string): Promise<void> {
  const requestedPath = path === undefined ? (localPath.value || undefined) : path
  const requestId = ++localDirectoryRequestId
  error.value = ''
  contextMenu.value = null
  loadingLocalDirectory.value = true
  status.value = '正在读取本地目录…'
  const listLocal = window.terminalAgent.fileTransfer?.listLocal
  if (typeof listLocal !== 'function') {
    localDirectorySupported.value = false
    localEntries.value = []
    status.value = '当前版本不支持本地目录浏览。'
    loadingLocalDirectory.value = false
    return
  }
  localDirectorySupported.value = true
  try {
    const result = await listLocal(requestedPath ? { localPath: requestedPath } : {})
    if (requestId !== localDirectoryRequestId) return
    const resolvedPath = normalizeLocalPath(result.localPath)
    localCurrentPath.value = resolvedPath
    localPath.value = resolvedPath
    if (!localRootPath.value) localRootPath.value = resolvedPath
    localEntries.value = sortEntries(result.entries)
    selectedLocalEntryName.value = null
    status.value = localEntries.value.length ? `${localEntries.value.length} 个本地条目` : '本地目录为空。'
  } catch (cause) {
    if (requestId !== localDirectoryRequestId) return
    localEntries.value = []
    const message = cause instanceof Error ? cause.message : '本地目录读取失败。'
    error.value = message || '本地目录读取失败。'
    status.value = '本地目录读取失败。'
  } finally {
    if (requestId === localDirectoryRequestId) loadingLocalDirectory.value = false
  }
}

async function selectLocalDirectory(): Promise<void> {
  const selectDirectory = window.terminalAgent.fileTransfer?.selectLocalDirectory
  if (typeof selectDirectory !== 'function') {
    localDirectorySupported.value = false
    error.value = '当前版本不支持选择本地目录。'
    return
  }
  error.value = ''
  try {
    const result = await selectDirectory()
    if (result.canceled) {
      status.value = '已取消选择本地目录。'
      return
    }
    localRootPath.value = normalizeLocalPath(result.localPath)
    localPath.value = localRootPath.value
    await refreshLocalDirectory(localRootPath.value)
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : '本地目录选择失败。'
    error.value = message
    status.value = '本地目录选择失败。'
  }
}

function selectRemoteEntry(entry: FileTransferDirectoryEntry): void {
  selectedRemoteEntryName.value = entry.name
  contextMenu.value = null
}

function selectLocalEntry(entry: FileTransferDirectoryEntry): void {
  selectedLocalEntryName.value = entry.name
  contextMenu.value = null
}

function openRemoteEntry(entry: FileTransferDirectoryEntry): void {
  selectRemoteEntry(entry)
  if (entry.kind !== 'directory') return
  void refreshRemoteDirectory(joinRemotePath(remoteCurrentPath.value, entry.name))
}

function openLocalEntry(entry: FileTransferDirectoryEntry): void {
  selectLocalEntry(entry)
  if (entry.kind !== 'directory') return
  void refreshLocalDirectory(joinLocalPath(localCurrentPath.value, entry.name))
}

function goToRemoteParent(): void {
  void refreshRemoteDirectory(parentRemotePath(remoteCurrentPath.value))
}

function goToLocalParent(): void {
  const parent = parentLocalPath(localCurrentPath.value)
  if (!parent || sameLocalPath(parent, localCurrentPath.value)) return
  void refreshLocalDirectory(parent)
}

function goToRemoteBreadcrumb(path: string): void {
  void refreshRemoteDirectory(path)
}

function showContextMenu(event: MouseEvent, pane: PaneKind, entry: FileTransferDirectoryEntry | null = null): void {
  const panel = (event.currentTarget as HTMLElement | null)?.closest('.file-transfer-panel') as HTMLElement | null
  const panelBounds = panel?.getBoundingClientRect()
  const rawX = event.clientX - (panelBounds?.left ?? 0)
  const rawY = event.clientY - (panelBounds?.top ?? 0)
  const maxX = Math.max(8, (panelBounds?.width ?? 320) - 180)
  const maxY = Math.max(8, (panelBounds?.height ?? 200) - 106)
  contextMenu.value = {
    x: Math.min(Math.max(8, rawX), maxX),
    y: Math.min(Math.max(8, rawY), maxY),
    pane,
    entry,
  }
  if (entry) {
    if (pane === 'local') selectedLocalEntryName.value = entry.name
    else selectedRemoteEntryName.value = entry.name
  }
}

function closeContextMenu(): void {
  contextMenu.value = null
}

function onRemoteDirectoryKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    closeContextMenu()
    return
  }
  if (event.key === 'Backspace' && !loadingRemoteDirectory.value) {
    event.preventDefault()
    goToRemoteParent()
  }
}

function onLocalDirectoryKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    closeContextMenu()
    return
  }
  if (event.key === 'Backspace' && !loadingLocalDirectory.value) {
    event.preventDefault()
    goToLocalParent()
  }
}

function createTransferId(): string {
  const candidate = globalThis.crypto?.randomUUID?.()
  if (candidate) return candidate
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
    name: name || (direction === 'upload' ? '未命名文件' : remoteBaseName(targetPath)),
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

function startRemoteEntryDrag(entry: FileTransferDirectoryEntry, event: DragEvent): void {
  if (entry.kind !== 'file') {
    event.preventDefault()
    return
  }
  draggedRemoteEntry.value = entry
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'copy'
    event.dataTransfer.setData('application/x-terminal-agent-remote-file', entry.name)
    event.dataTransfer.setData('text/plain', entry.name)
  }
}

function finishRemoteEntryDrag(): void {
  draggedRemoteEntry.value = null
  localDropActive.value = false
}

function startLocalEntryDrag(entry: FileTransferDirectoryEntry, event: DragEvent): void {
  if (entry.kind !== 'file') {
    event.preventDefault()
    return
  }
  draggedLocalEntry.value = entry
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'copy'
    // The drag marker contains only a display name; the source path is used
    // only with the main process's directory-authorized transfer boundary.
    event.dataTransfer.setData('application/x-terminal-agent-local-file', entry.name)
    event.dataTransfer.setData('text/plain', entry.name)
  }
}

function finishLocalEntryDrag(): void {
  draggedLocalEntry.value = null
  remoteDropActive.value = false
}

function onLocalDragOver(event: DragEvent): void {
  const hasRemoteEntry = Boolean(draggedRemoteEntry.value || event.dataTransfer?.types.includes('application/x-terminal-agent-remote-file'))
  if (!hasRemoteEntry) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
  localDropActive.value = true
}

function onRemoteDragOver(event: DragEvent): void {
  const hasLocalEntry = Boolean(draggedLocalEntry.value || event.dataTransfer?.types.includes('application/x-terminal-agent-local-file'))
  if (!hasLocalEntry) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
  remoteDropActive.value = true
}

function onLocalDragLeave(event: DragEvent): void {
  if ((event.currentTarget as HTMLElement | null)?.contains(event.relatedTarget as Node | null)) return
  localDropActive.value = false
}

function onRemoteDragLeave(event: DragEvent): void {
  if ((event.currentTarget as HTMLElement | null)?.contains(event.relatedTarget as Node | null)) return
  remoteDropActive.value = false
}

function remoteEntryFromDrag(event: DragEvent): FileTransferDirectoryEntry | undefined {
  const draggedName = event.dataTransfer?.getData('application/x-terminal-agent-remote-file')
    || event.dataTransfer?.getData('text/plain')
    || ''
  return draggedRemoteEntry.value ?? remoteEntries.value.find(entry => entry.name === draggedName)
}

function localEntryFromDrag(event: DragEvent): FileTransferDirectoryEntry | undefined {
  const draggedName = event.dataTransfer?.getData('application/x-terminal-agent-local-file')
    || event.dataTransfer?.getData('text/plain')
    || ''
  return draggedLocalEntry.value ?? localEntries.value.find(entry => entry.name === draggedName)
}

function onLocalDrop(event: DragEvent, destinationDirectory = localCurrentPath.value): void {
  event.preventDefault()
  const entry = remoteEntryFromDrag(event)
  localDropActive.value = false
  draggedRemoteEntry.value = null
  if (busy.value) {
    status.value = '文件传输中，请等待当前传输完成。'
    return
  }
  if (!entry || entry.kind !== 'file') {
    status.value = '请将右侧的远程文件拖到本地目录。'
    return
  }
  void downloadRemoteEntry(entry, destinationDirectory)
}

function onRemoteDrop(event: DragEvent, destinationDirectory = remoteCurrentPath.value): void {
  event.preventDefault()
  const entry = localEntryFromDrag(event)
  remoteDropActive.value = false
  draggedLocalEntry.value = null
  if (!remoteDirectorySupported.value) {
    status.value = '当前 SSH 会话不支持 SFTP 文件传输。'
    return
  }
  if (busy.value) {
    status.value = '文件传输中，请等待当前传输完成。'
    return
  }
  if (!entry || entry.kind !== 'file') {
    status.value = '请将左侧的本地文件拖到远程目录。'
    return
  }
  void uploadLocalEntry(entry, destinationDirectory)
}

function onLocalEntryDrop(entry: FileTransferDirectoryEntry, event: DragEvent): void {
  const destinationDirectory = entry.kind === 'directory'
    ? joinLocalPath(localCurrentPath.value, entry.name)
    : localCurrentPath.value
  onLocalDrop(event, destinationDirectory)
}

function onRemoteEntryDrop(entry: FileTransferDirectoryEntry, event: DragEvent): void {
  const destinationDirectory = entry.kind === 'directory'
    ? joinRemotePath(remoteCurrentPath.value, entry.name)
    : remoteCurrentPath.value
  onRemoteDrop(event, destinationDirectory)
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
  if (event.phase === 'completed' || event.phase === 'canceled' || event.phase === 'failed') {
    markTransferSettled(event.transferId)
  }
  if (event.message && event.phase !== 'failed') status.value = event.message
  if (event.phase === 'failed') error.value = event.message || '文件传输失败。'
}

async function uploadLocalEntry(entry = selectedLocalEntry.value, destinationDirectory = remoteCurrentPath.value): Promise<void> {
  if (!entry || entry.kind !== 'file') {
    error.value = '请先选择要上传的本地文件。'
    return
  }
  if (!localCurrentPath.value) {
    error.value = '请先选择本地目录。'
    return
  }
  if (!remoteDirectorySupported.value) {
    error.value = '当前 SSH 会话不支持 SFTP 文件传输。'
    return
  }
  const localSource = joinLocalPath(localCurrentPath.value, entry.name)
  const remoteDestination = pathForUpload(destinationDirectory)
  const transferId = createTransferId()
  addTransfer('upload', joinRemotePath(destinationDirectory, entry.name), entry.name, transferId)
  markTransferActive(transferId)
  error.value = ''
  status.value = '正在准备上传…'
  try {
    const result = await window.terminalAgent.fileTransfer.upload({
      sessionId: props.sessionId,
      remotePath: remoteDestination,
      localPath: localSource,
      transferId,
    })
    applyTransferResult(result, transferId, 'upload')
    if (result.status === 'completed') await refreshRemoteDirectory(remoteCurrentPath.value)
  } catch (cause) {
    failLocalTransfer(transferId, cause)
  }
}

async function downloadRemoteEntry(entry = selectedRemoteEntry.value, destinationDirectory = localCurrentPath.value): Promise<void> {
  if (!entry || entry.kind !== 'file') {
    error.value = '请先选择要下载的远程文件。'
    return
  }
  if (!destinationDirectory) {
    error.value = '请先选择本地目录。'
    return
  }
  const remoteSource = joinRemotePath(remoteCurrentPath.value, entry.name)
  const transferId = createTransferId()
  addTransfer('download', remoteSource, entry.name, transferId)
  markTransferActive(transferId)
  error.value = ''
  status.value = '正在准备下载…'
  try {
    const result = await window.terminalAgent.fileTransfer.download({
      sessionId: props.sessionId,
      remotePath: remoteSource,
      fileName: entry.name,
      localPath: destinationDirectory,
      transferId,
    })
    applyTransferResult(result, transferId, 'download')
    if (result.status === 'completed' && sameLocalPath(destinationDirectory, localCurrentPath.value)) {
      await refreshLocalDirectory(localCurrentPath.value)
    }
  } catch (cause) {
    failLocalTransfer(transferId, cause)
  }
}

function applyTransferResult(result: FileTransferResult, transferId: string, direction: 'upload' | 'download'): void {
  const item = transfers.value.find(transfer => transfer.id === transferId)
  if (item) {
    item.phase = result.status === 'canceled' ? 'canceled' : 'completed'
    item.transferredBytes = result.transferredBytes
    item.totalBytes = result.transferredBytes
    item.name = result.fileName || item.name
    item.message = result.status === 'canceled' ? '已取消。' : `${direction === 'upload' ? '上传' : '下载'}完成。`
  }
  markTransferSettled(transferId)
  status.value = result.status === 'canceled' ? '已取消。' : `${direction === 'upload' ? '上传' : '下载'}完成。`
}

function failLocalTransfer(transferId: string, cause: unknown): void {
  markTransferSettled(transferId)
  const message = cause instanceof Error ? cause.message : '文件传输失败。'
  const item = transfers.value.find(transfer => transfer.id === transferId)
  if (item) {
    item.phase = 'failed'
    item.message = message
  }
  error.value = message
  status.value = '传输失败。'
}

function uploadSelectedLocalFile(): void {
  void uploadLocalEntry()
  closeContextMenu()
}

function downloadSelectedRemoteFile(): void {
  void downloadRemoteEntry()
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
  if (item.phase === 'selecting') return '准备中'
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

function onRemotePathSubmit(): void {
  void refreshRemoteDirectory(remotePath.value)
}

function onLocalPathSubmit(): void {
  void refreshLocalDirectory(localPath.value)
}

function onPanelClick(): void {
  if (contextMenu.value) closeContextMenu()
}

watch(busy, value => emit('busyChange', value), { immediate: true })

watch(() => props.sessionId, () => {
  ++remoteDirectoryRequestId
  ++localDirectoryRequestId
  remotePath.value = '/'
  remoteCurrentPath.value = '/'
  remoteEntries.value = []
  localPath.value = ''
  localCurrentPath.value = ''
  localRootPath.value = ''
  localEntries.value = []
  selectedRemoteEntryName.value = null
  selectedLocalEntryName.value = null
  transfers.value = []
  draggedRemoteEntry.value = null
  draggedLocalEntry.value = null
  localDropActive.value = false
  remoteDropActive.value = false
  activeTransferIds.value = new Set()
  error.value = ''
  status.value = '正在准备文件传输目录。'
  void refreshRemoteDirectory('/')
  void refreshLocalDirectory()
})

onMounted(() => {
  const onProgress = window.terminalAgent.fileTransfer?.onProgress
  if (typeof onProgress === 'function') unsubscribeProgress = onProgress(setTransferProgress)
  void refreshRemoteDirectory('/')
  void refreshLocalDirectory()
  window.addEventListener('click', closeContextMenu)
})

onBeforeUnmount(() => {
  emit('busyChange', false)
  unsubscribeProgress?.()
  unsubscribeProgress = undefined
  window.removeEventListener('click', closeContextMenu)
})
</script>

<template>
  <section class="file-transfer-panel" aria-label="文件传输" @click="onPanelClick">
    <header class="file-transfer-header">
      <div class="file-transfer-title"><strong>文件传输</strong><span v-if="busy" class="file-transfer-busy">文件传输中</span><span v-if="hostname">{{ hostname }}</span></div>
      <button type="button" class="close-button" aria-label="关闭文件传输" title="关闭" @click.stop="emit('close')"><X :size="14" aria-hidden="true" /></button>
    </header>

    <section class="file-transfer-browser" aria-label="本地与远程文件目录">
      <section
        class="file-pane local-file-pane"
        :class="{ 'drop-active': localDropActive }"
        aria-label="本地文件区"
        @dragover="onLocalDragOver"
        @dragleave="onLocalDragLeave"
        @drop="onLocalDrop($event)"
      >
        <header class="file-pane-header">
          <div class="section-heading"><span>本地（左）</span><span>{{ loadingLocalDirectory ? '读取中…' : `${localEntries.length} 项` }}</span></div>
          <div class="file-pane-pathbar">
            <label :for="`file-transfer-local-path-${sessionId}`">路径</label>
            <input :id="`file-transfer-local-path-${sessionId}`" v-model="localPath" type="text" autocomplete="off" :disabled="loadingLocalDirectory || !localDirectorySupported" @keydown.enter.prevent="onLocalPathSubmit" />
            <button type="button" class="icon-button" aria-label="选择本地目录" title="选择本地目录" :disabled="loadingLocalDirectory || !localDirectorySupported" @click="selectLocalDirectory"><FolderOpen :size="14" aria-hidden="true" /></button>
            <button type="button" class="icon-button" aria-label="返回本地上级目录" title="返回上级目录" :disabled="loadingLocalDirectory || !localRootPath || sameLocalPath(localCurrentPath, localRootPath)" @click="goToLocalParent"><ChevronLeft :size="14" aria-hidden="true" /></button>
            <button type="button" class="icon-button" aria-label="刷新本地目录" title="刷新" :disabled="loadingLocalDirectory || !localDirectorySupported" @click="refreshLocalDirectory(localCurrentPath)"><RefreshCw :size="14" aria-hidden="true" :class="{ spinning: loadingLocalDirectory }" /></button>
          </div>
        </header>
        <div class="directory-list" role="listbox" aria-label="本地文件目录" @keydown="onLocalDirectoryKeydown">
          <button v-if="localCurrentPath && localRootPath && !sameLocalPath(localCurrentPath, localRootPath)" type="button" class="directory-entry parent-entry" role="option" aria-label="返回本地上级目录" @dblclick="goToLocalParent" @click="goToLocalParent"><ArrowUp :size="14" aria-hidden="true" /><span>..</span><small>上级目录</small></button>
          <button
            v-for="entry in localEntries"
            :key="entry.name"
            type="button"
            class="directory-entry"
            :class="{ selected: selectedLocalEntryName === entry.name }"
            role="option"
            :aria-selected="selectedLocalEntryName === entry.name"
            :draggable="entry.kind === 'file'"
            :title="entry.kind === 'directory' ? entry.name : `拖到右侧远程目录上传：${entry.name}`"
            @click="selectLocalEntry(entry)"
            @dblclick="openLocalEntry(entry)"
            @dragstart="startLocalEntryDrag(entry, $event)"
            @dragend="finishLocalEntryDrag"
            @dragover="onLocalDragOver"
            @drop.stop="onLocalEntryDrop(entry, $event)"
            @contextmenu.stop.prevent="showContextMenu($event, 'local', entry)"
          >
            <Folder v-if="displayEntryIcon(entry) === 'directory'" :size="14" aria-hidden="true" class="entry-icon directory-icon" /><File v-else :size="14" aria-hidden="true" class="entry-icon" />
            <span class="entry-name" :title="entry.name">{{ entryLabel(entry) }}</span>
            <small>{{ formatEntrySize(entry) }}</small>
            <MoreHorizontal :size="14" aria-hidden="true" class="entry-menu-hint" />
          </button>
          <div v-if="!loadingLocalDirectory && !localEntries.length && localDirectorySupported" class="directory-empty">此目录没有可显示的条目</div>
          <div v-if="loadingLocalDirectory" class="directory-empty">正在读取本地目录…</div>
          <div v-if="!localDirectorySupported" class="directory-empty">当前版本不支持本地目录浏览</div>
          <div v-if="localDropActive" class="directory-drop-overlay" aria-hidden="true">松开后下载到当前本地目录</div>
        </div>
      </section>

      <section
        class="file-pane remote-file-pane"
        :class="{ 'drop-active': remoteDropActive }"
        aria-label="远程文件区"
        @dragover="onRemoteDragOver"
        @dragleave="onRemoteDragLeave"
        @drop="onRemoteDrop($event)"
      >
        <header class="file-pane-header">
          <div class="section-heading"><span>远程（右）</span><span>{{ loadingRemoteDirectory ? '读取中…' : `${remoteEntries.length} 项` }}</span></div>
          <div class="file-pane-pathbar">
            <label :for="`file-transfer-remote-path-${sessionId}`">路径</label>
            <input :id="`file-transfer-remote-path-${sessionId}`" v-model="remotePath" type="text" autocomplete="off" :disabled="loadingRemoteDirectory || !remoteDirectorySupported" @keydown.enter.prevent="onRemotePathSubmit" />
            <button type="button" class="icon-button" aria-label="返回远程上级目录" title="返回上级目录" :disabled="loadingRemoteDirectory || remoteCurrentPath === '/'" @click="goToRemoteParent"><ChevronLeft :size="14" aria-hidden="true" /></button>
            <button type="button" class="icon-button" aria-label="刷新远程目录" title="刷新" :disabled="loadingRemoteDirectory || !remoteDirectorySupported" @click="refreshRemoteDirectory(remoteCurrentPath)"><RefreshCw :size="14" aria-hidden="true" :class="{ spinning: loadingRemoteDirectory }" /></button>
          </div>
          <nav class="file-pane-breadcrumbs" aria-label="远程路径导航">
            <button v-for="(part, index) in remoteBreadcrumbParts" :key="part.path" type="button" :class="{ current: index === remoteBreadcrumbParts.length - 1 }" @click="goToRemoteBreadcrumb(part.path)">{{ part.label }}<ChevronRight v-if="index < remoteBreadcrumbParts.length - 1" :size="12" aria-hidden="true" /></button>
          </nav>
        </header>
        <div class="directory-list" role="listbox" aria-label="远程文件目录" @keydown="onRemoteDirectoryKeydown">
          <button v-if="remoteCurrentPath !== '/'" type="button" class="directory-entry parent-entry" role="option" aria-label="返回远程上级目录" @dblclick="goToRemoteParent" @click="goToRemoteParent"><ArrowUp :size="14" aria-hidden="true" /><span>..</span><small>上级目录</small></button>
          <button
            v-for="entry in remoteEntries"
            :key="entry.name"
            type="button"
            class="directory-entry"
            :class="{ selected: selectedRemoteEntryName === entry.name }"
            role="option"
            :aria-selected="selectedRemoteEntryName === entry.name"
            :draggable="entry.kind === 'file'"
            :title="entry.kind === 'directory' ? entry.name : `拖到左侧本地目录下载：${entry.name}`"
            @click="selectRemoteEntry(entry)"
            @dblclick="openRemoteEntry(entry)"
            @dragstart="startRemoteEntryDrag(entry, $event)"
            @dragend="finishRemoteEntryDrag"
            @dragover="onRemoteDragOver"
            @drop.stop="onRemoteEntryDrop(entry, $event)"
            @contextmenu.stop.prevent="showContextMenu($event, 'remote', entry)"
          >
            <Folder v-if="displayEntryIcon(entry) === 'directory'" :size="14" aria-hidden="true" class="entry-icon directory-icon" /><File v-else :size="14" aria-hidden="true" class="entry-icon" />
            <span class="entry-name" :title="entry.name">{{ entryLabel(entry) }}</span>
            <small>{{ formatEntrySize(entry) }}</small>
            <MoreHorizontal :size="14" aria-hidden="true" class="entry-menu-hint" />
          </button>
          <div v-if="!loadingRemoteDirectory && !remoteEntries.length && remoteDirectorySupported" class="directory-empty">此目录没有可显示的条目</div>
          <div v-if="loadingRemoteDirectory" class="directory-empty">正在读取远程目录…</div>
          <div v-if="!remoteDirectorySupported" class="directory-empty">当前 SSH 会话不支持 SFTP 目录浏览</div>
          <div v-if="remoteDropActive" class="directory-drop-overlay" aria-hidden="true">松开后上传到当前远程目录</div>
        </div>
      </section>
    </section>

    <div v-if="contextMenu" class="directory-context-menu" :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }" role="menu" @click.stop>
      <template v-if="contextMenu.pane === 'local'">
        <button v-if="contextMenu.entry?.kind === 'directory'" type="button" role="menuitem" @click="openLocalEntry(contextMenu.entry); closeContextMenu()"><Folder :size="13" aria-hidden="true" />进入目录</button>
        <button v-if="contextMenu.entry?.kind === 'file'" type="button" role="menuitem" :disabled="busy || !remoteDirectorySupported" @click="uploadSelectedLocalFile"><Upload :size="13" aria-hidden="true" />上传到当前远程目录</button>
      </template>
      <template v-else>
        <button v-if="contextMenu.entry?.kind === 'directory'" type="button" role="menuitem" @click="openRemoteEntry(contextMenu.entry); closeContextMenu()"><Folder :size="13" aria-hidden="true" />进入目录</button>
        <button v-if="contextMenu.entry?.kind === 'file'" type="button" role="menuitem" :disabled="busy || !localCurrentPath" @click="downloadSelectedRemoteFile"><Download :size="13" aria-hidden="true" />下载到当前本地目录</button>
      </template>
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
.file-transfer-panel { position: relative; display: grid; grid-template-rows: auto minmax(126px, 1fr) minmax(50px, .72fr) auto; gap: 6px; box-sizing: border-box; width: 100%; min-width: 0; min-height: 190px; max-height: 368px; padding: 8px 10px 9px; border-top: 1px solid var(--line); background: var(--panel); color: var(--text); }
.file-transfer-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }.file-transfer-title { display: flex; align-items: baseline; gap: 8px; min-width: 0; overflow: hidden; }.file-transfer-title strong { flex: 0 0 auto; color: var(--text-strong); font-size: 11px; font-weight: 720; }.file-transfer-title span { min-width: 0; overflow: hidden; color: var(--muted); font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }.file-transfer-title .file-transfer-busy { flex: 0 0 auto; padding: 1px 4px; border: 1px solid var(--amber-line); border-radius: 3px; background: var(--amber-soft); color: var(--amber); font-size: 8px; font-weight: 700; }
.close-button,.icon-button { display: grid; place-items: center; width: 25px; height: 25px; padding: 0; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); color: var(--muted); }.close-button:hover,.icon-button:hover:not(:disabled) { border-color: var(--focus); color: var(--text-strong); }.close-button:disabled,.icon-button:disabled { cursor: not-allowed; opacity: .52; }
.file-transfer-browser { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 6px; min-width: 0; min-height: 0; overflow: hidden; }.file-pane,.file-transfer-log { display: grid; grid-template-rows: auto minmax(0, 1fr); min-width: 0; min-height: 0; overflow: hidden; border: 1px solid var(--line-soft); background: var(--surface); }.file-pane-header { display: grid; grid-template-rows: auto auto auto; min-width: 0; border-bottom: 1px solid var(--line-soft); }.file-transfer-log { min-height: 50px; }.section-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; min-height: 23px; padding: 0 7px; border-bottom: 1px solid var(--line-soft); color: var(--text-strong); font-size: 9px; font-weight: 650; }.file-pane-header .section-heading { border-bottom: 0; }.section-heading span:last-child { color: var(--muted); font-size: 8px; font-weight: 500; }
.file-pane-pathbar { display: grid; grid-template-columns: auto minmax(0, 1fr) 25px 25px 25px; align-items: center; gap: 4px; min-width: 0; padding: 0 5px 4px; }.remote-file-pane .file-pane-pathbar { grid-template-columns: auto minmax(0, 1fr) 25px 25px; }.file-pane-pathbar label { color: var(--muted); font-size: 8px; }.file-pane-pathbar input { box-sizing: border-box; width: 100%; min-width: 0; height: 25px; padding: 0 6px; border: 1px solid var(--line); border-radius: 4px; background: var(--surface-soft); color: var(--text-strong); font: inherit; font-size: 9px; }.file-pane-pathbar input:focus { border-color: var(--focus); outline: 2px solid color-mix(in srgb, var(--focus) 22%, transparent); }
.file-pane-breadcrumbs { display: flex; align-items: center; min-width: 0; min-height: 17px; padding: 0 5px 3px; overflow: hidden; color: var(--muted); }.file-pane-breadcrumbs button { display: inline-flex; align-items: center; gap: 2px; min-width: 0; max-width: 120px; padding: 1px 3px; border: 0; background: transparent; color: inherit; font-size: 8px; text-overflow: ellipsis; white-space: nowrap; }.file-pane-breadcrumbs button:hover,.file-pane-breadcrumbs button.current { color: var(--text-strong); }.file-pane-breadcrumbs button.current { font-weight: 650; }
.directory-list { position: relative; min-width: 0; min-height: 0; overflow: auto; padding: 2px; scrollbar-width: thin; scrollbar-color: transparent transparent; }.directory-list:hover,.directory-list:focus-within { scrollbar-color: color-mix(in srgb, var(--muted) 55%, transparent) transparent; }.directory-entry { display: grid; grid-template-columns: 18px minmax(0, 1fr) auto 17px; align-items: center; gap: 4px; width: 100%; min-height: 24px; padding: 2px 5px; border: 1px solid transparent; border-radius: 3px; background: transparent; color: var(--text); font-size: 9px; text-align: left; }.directory-entry:hover,.directory-entry.selected { border-color: var(--amber-line); background: var(--amber-soft); }.directory-entry .entry-icon { color: var(--muted); }.directory-entry .directory-icon { color: var(--amber); }.entry-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.directory-entry small { color: var(--muted); font-size: 8px; white-space: nowrap; }.entry-menu-hint { color: var(--faint); }.parent-entry { color: var(--muted); }.directory-empty { display: grid; place-items: center; min-height: 48px; padding: 8px; color: var(--muted); font-size: 9px; text-align: center; }.local-file-pane.drop-active,.remote-file-pane.drop-active { border-color: var(--focus); box-shadow: inset 0 0 0 1px var(--focus); }.directory-drop-overlay { position: absolute; inset: 4px; z-index: 2; display: grid; place-items: center; border: 1px dashed var(--focus); border-radius: 4px; background: color-mix(in srgb, var(--focus) 13%, var(--surface)); color: var(--text-strong); font-size: 9px; pointer-events: none; }
.directory-context-menu { position: absolute; z-index: 5; display: grid; min-width: 164px; padding: 3px; border: 1px solid var(--line); border-radius: 5px; background: var(--surface); box-shadow: 0 10px 24px rgb(24 31 40 / 22%); }.directory-context-menu button { display: inline-flex; align-items: center; gap: 6px; min-height: 26px; padding: 0 7px; border: 0; border-radius: 3px; background: transparent; color: var(--text); font-size: 9px; text-align: left; }.directory-context-menu button:hover:not(:disabled) { background: var(--hover); }.directory-context-menu button:disabled { cursor: not-allowed; opacity: .52; }
.transfer-table { min-width: 0; min-height: 0; overflow: auto; scrollbar-width: thin; scrollbar-color: transparent transparent; }.transfer-table:hover { scrollbar-color: color-mix(in srgb, var(--muted) 55%, transparent) transparent; }.transfer-row { display: grid; grid-template-columns: 38px minmax(60px, 1fr) 64px minmax(55px, .9fr); align-items: center; gap: 6px; min-width: 300px; min-height: 22px; padding: 0 7px; border-bottom: 1px solid var(--line-soft); color: var(--muted); font-size: 8px; }.transfer-row:last-child { border-bottom: 0; }.transfer-head { position: sticky; top: 0; z-index: 1; min-height: 21px; background: var(--surface-soft); color: var(--faint); font-size: 8px; }.transfer-name { min-width: 0; overflow: hidden; color: var(--text); text-overflow: ellipsis; white-space: nowrap; }.direction.upload { color: var(--accent); }.direction.download { color: var(--focus); }.transfer-state.completed { color: var(--accent); }.transfer-state.failed { color: var(--red); }.transfer-state.canceled { color: var(--muted); }.transfer-row small { color: var(--faint); }.log-empty { display: grid; place-items: center; margin: 0; padding: 8px; color: var(--muted); font-size: 9px; }
.file-transfer-status,.file-transfer-error { min-width: 0; margin: 0; overflow: hidden; font-size: 9px; line-height: 1.3; text-overflow: ellipsis; white-space: nowrap; }.file-transfer-status { color: var(--muted); }.file-transfer-error { color: var(--red); }.spinning { animation: file-transfer-spin .9s linear infinite; }@keyframes file-transfer-spin { to { transform: rotate(360deg); } }
@media (max-width: 760px) { .file-transfer-panel { max-height: 460px; }.file-transfer-browser { grid-template-columns: 1fr; grid-template-rows: minmax(120px, 1fr) minmax(120px, 1fr); overflow: auto; }.transfer-row { grid-template-columns: 38px minmax(70px, 1fr) 54px minmax(45px, .8fr); } }
</style>
