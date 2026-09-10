<script setup lang="ts">
import { ArrowUp, ChevronDown, ChevronLeft, ChevronRight, Download, File, Folder, FolderOpen, FolderUp, LocateFixed, Maximize2, Minimize2, MoreHorizontal, Pencil, RefreshCw, Trash2, Upload, X } from '@lucide/vue'
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
  hide: []
  /** Kept for callers compiled against the pre-v3.3.2 event name. */
  close: []
  busyChange: [busy: boolean]
}>()

type TransferLog = {
  id: string
  sessionId: string
  direction: 'upload' | 'download'
  name: string
  localPath?: string
  remotePath: string
  phase: FileTransferProgress['phase']
  transferredBytes: number
  totalBytes?: number
  startedAt: number
  finishedAt?: number
  speedBytesPerSecond?: number
  remainingSeconds?: number
  message?: string
  canCancel?: boolean
}

type PaneKind = 'local' | 'remote'

type ContextMenuState = {
  x: number
  y: number
  pane: PaneKind
  entry: FileTransferDirectoryEntry | null
}

type EntryDialogState = {
  mode: 'rename' | 'delete'
  pane: PaneKind
  entry: FileTransferDirectoryEntry
}

const PROGRESS_LOG_STORAGE_KEY = 'terminal-agent:file-transfer-progress-height'
const PROGRESS_LOG_MIN_HEIGHT = 64
const PROGRESS_LOG_MAX_HEIGHT = 180
const PROGRESS_LOG_KEYBOARD_STEP = 12

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
const entryDialog = ref<EntryDialogState | null>(null)
const entryRenameValue = ref('')
const entryDialogError = ref('')
const entryActionBusy = ref(false)
const draggedRemoteEntry = ref<FileTransferDirectoryEntry | null>(null)
const draggedLocalEntry = ref<FileTransferDirectoryEntry | null>(null)
const localDropActive = ref(false)
const remoteDropActive = ref(false)
const error = ref('')
const status = ref('正在准备文件传输目录。')
const fullscreen = ref(false)
const clockNow = ref(Date.now())
const remoteWorkingDirectory = ref<string | null>(null)
const loadingRemoteWorkingDirectory = ref(false)
const progressLogHeight = ref(readProgressLogHeight())
let elapsedTimer: ReturnType<typeof setInterval> | undefined
let unsubscribeProgress: (() => void) | undefined
let remoteDirectoryRequestId = 0
let localDirectoryRequestId = 0
let remoteWorkingDirectoryRequestId = 0
let progressResizeStartY = 0
let progressResizeStartHeight = progressLogHeight.value

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

async function loadRemoteWorkingDirectory(): Promise<void> {
  const requestId = ++remoteWorkingDirectoryRequestId
  const workingDirectory = window.terminalAgent.fileTransfer?.workingDirectory
  remoteWorkingDirectory.value = null
  if (typeof workingDirectory !== 'function') return
  loadingRemoteWorkingDirectory.value = true
  try {
    const result = await workingDirectory({ sessionId: props.sessionId })
    if (requestId !== remoteWorkingDirectoryRequestId) return
    remoteWorkingDirectory.value = normalizeRemotePath(result.remotePath)
  } catch {
    // The directory shortcut is intentionally disabled when SFTP is not
    // connected or cannot report a working directory. Do not inspect terminal
    // output as a fallback because that would make UI text authoritative.
    if (requestId === remoteWorkingDirectoryRequestId) remoteWorkingDirectory.value = null
  } finally {
    if (requestId === remoteWorkingDirectoryRequestId) loadingRemoteWorkingDirectory.value = false
  }
}

function jumpToRemoteWorkingDirectory(): void {
  const path = remoteWorkingDirectory.value
  if (!path || loadingRemoteWorkingDirectory.value) return
  void refreshRemoteDirectory(path)
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
  const maxY = Math.max(8, (panelBounds?.height ?? 200) - 174)
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

function openRenameDialog(pane: PaneKind, entry: FileTransferDirectoryEntry | null): void {
  if (!entry) return
  closeContextMenu()
  entryDialog.value = { mode: 'rename', pane, entry }
  entryRenameValue.value = entry.name
  entryDialogError.value = ''
}

function openDeleteDialog(pane: PaneKind, entry: FileTransferDirectoryEntry | null): void {
  if (!entry) return
  closeContextMenu()
  entryDialog.value = { mode: 'delete', pane, entry }
  entryRenameValue.value = entry.name
  entryDialogError.value = ''
}

function closeEntryDialog(): void {
  if (entryActionBusy.value) return
  entryDialog.value = null
  entryDialogError.value = ''
}

function entryNameValidationError(value: string, pane: PaneKind): string | undefined {
  if (!value || !value.trim() || value === '.' || value === '..' || value.length > 255) return '请输入有效的名称。'
  if (/[\\/]/.test(value) || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    return '名称不能包含路径分隔符或控制字符。'
  }
  if (pane !== 'local') return undefined
  if (/[<>:"/\\|?*]/.test(value)) return '本地名称包含不可用字符。'
  if (/[. ]$/.test(value)) return '本地名称不能以空格或句点结尾。'
  const base = value.split('.')[0]?.toUpperCase()
  if (base === 'CON' || base === 'PRN' || base === 'AUX' || base === 'NUL' || /^COM[1-9]$/.test(base ?? '') || /^LPT[1-9]$/.test(base ?? '')) {
    return '本地名称不能使用系统保留名称。'
  }
  return undefined
}

async function submitEntryDialog(): Promise<void> {
  const dialog = entryDialog.value
  if (!dialog || entryActionBusy.value || busy.value) return
  const newName = entryRenameValue.value
  if (dialog.mode === 'rename') {
    const validationError = entryNameValidationError(newName, dialog.pane)
    if (validationError) {
      entryDialogError.value = validationError
      return
    }
  }
  entryActionBusy.value = true
  entryDialogError.value = ''
  error.value = ''
  try {
    if (dialog.pane === 'local') {
      const directory = localCurrentPath.value
      if (!directory) throw new Error('请先选择本地目录。')
      if (dialog.mode === 'rename') {
        await window.terminalAgent.fileTransfer.renameLocal({ directory, name: dialog.entry.name, newName })
        status.value = '本地条目已重命名。'
      } else {
        await window.terminalAgent.fileTransfer.deleteLocal({ directory, name: dialog.entry.name, kind: dialog.entry.kind })
        status.value = '本地条目已删除。'
      }
      entryDialog.value = null
      await refreshLocalDirectory(directory)
      return
    }
    const directory = remoteCurrentPath.value
    if (dialog.mode === 'rename') {
      await window.terminalAgent.fileTransfer.renameRemote({
        sessionId: props.sessionId, directory, name: dialog.entry.name, newName,
      })
      status.value = '远程条目已重命名。'
    } else {
      await window.terminalAgent.fileTransfer.deleteRemote({
        sessionId: props.sessionId, directory, name: dialog.entry.name, kind: dialog.entry.kind,
      })
      status.value = '远程条目已删除。'
    }
    entryDialog.value = null
    await refreshRemoteDirectory(directory)
  } catch (cause) {
    entryDialogError.value = cause instanceof Error ? cause.message : '操作失败，请重试。'
  } finally {
    entryActionBusy.value = false
  }
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

function addTransfer(
  direction: 'upload' | 'download',
  targetPath: string,
  name: string,
  transferId: string,
  localSource?: string,
  totalBytes?: number,
  transferSessionId = props.sessionId,
  canCancel = false,
): void {
  transfers.value.unshift({
    id: transferId,
    sessionId: transferSessionId,
    direction,
    name: name || (direction === 'upload' ? '未命名文件' : remoteBaseName(targetPath)),
    ...(localSource ? { localPath: localSource } : {}),
    remotePath: targetPath,
    phase: 'selecting',
    transferredBytes: 0,
    ...(totalBytes === undefined ? {} : { totalBytes }),
    ...(canCancel ? { canCancel: true } : {}),
    startedAt: Date.now(),
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
  if (entry.kind !== 'file' && entry.kind !== 'directory') {
    event.preventDefault()
    return
  }
  draggedLocalEntry.value = entry
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'copy'
    // The drag marker contains only a display name; the source path is used
    // only with the main process's directory-authorized transfer boundary.
    event.dataTransfer.setData('application/x-terminal-agent-local-entry', entry.name)
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
  const hasLocalEntry = Boolean(draggedLocalEntry.value || event.dataTransfer?.types.includes('application/x-terminal-agent-local-entry'))
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
  const draggedName = event.dataTransfer?.getData('application/x-terminal-agent-local-entry')
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
  if (!entry || (entry.kind !== 'file' && entry.kind !== 'directory')) {
    status.value = '请将左侧的本地文件或目录拖到远程目录。'
    return
  }
  if (entry.kind === 'directory') void uploadLocalDirectory(entry, destinationDirectory)
  else void uploadLocalEntry(entry, destinationDirectory)
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
  // Progress is broadcast over one renderer channel. A regular transfer row
  // exists only in the card that started it, so matching by transfer id keeps
  // other mounted cards from duplicating the row.
  const target = transfers.value.find(transfer => transfer.id === event.transferId)
  if (!target) return
  target.phase = event.phase
  target.transferredBytes = event.transferredBytes
  if (event.totalBytes !== undefined) target.totalBytes = event.totalBytes
  target.name = event.fileName || target.name
  // A batch upload starts with `./` as its safe home-directory target. Once
  // the picker has returned the basename, make the concrete remote path
  // visible in the progress table without exposing the local absolute path.
  if (target.direction === 'upload' && target.remotePath === './' && event.fileName) {
    target.remotePath = `./${event.fileName}`
  }
  target.message = event.message
  const elapsedSeconds = Math.max(0.001, (Date.now() - target.startedAt) / 1_000)
  target.speedBytesPerSecond = event.transferredBytes > 0 ? event.transferredBytes / elapsedSeconds : undefined
  target.remainingSeconds = event.totalBytes && event.totalBytes > event.transferredBytes && target.speedBytesPerSecond
    ? (event.totalBytes - event.transferredBytes) / target.speedBytesPerSecond
    : undefined
  if (event.phase === 'completed' || event.phase === 'canceled' || event.phase === 'failed') {
    target.finishedAt = Date.now()
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
  addTransfer('upload', joinRemotePath(destinationDirectory, entry.name), entry.name, transferId, localSource, entry.size)
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

async function uploadLocalDirectory(entry = selectedLocalEntry.value, destinationDirectory = remoteCurrentPath.value): Promise<void> {
  if (!entry || entry.kind !== 'directory') {
    error.value = '请先选择要上传的本地目录。'
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
  const uploadDirectory = window.terminalAgent.fileTransfer?.uploadDirectory
  if (typeof uploadDirectory !== 'function') {
    error.value = '当前版本不支持递归上传本地目录。'
    return
  }
  const localSource = joinLocalPath(localCurrentPath.value, entry.name)
  const transferId = createTransferId()
  addTransfer('upload', joinRemotePath(destinationDirectory, entry.name), entry.name, transferId, localSource, undefined, props.sessionId, true)
  markTransferActive(transferId)
  error.value = ''
  status.value = '正在准备上传目录…'
  try {
    const result = await uploadDirectory({
      sessionId: props.sessionId,
      remotePath: normalizeRemotePath(destinationDirectory),
      localPath: localSource,
      transferId,
    })
    applyTransferResult(result, transferId, 'upload')
    await refreshRemoteDirectory(remoteCurrentPath.value)
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
  addTransfer('download', remoteSource, entry.name, transferId, joinLocalPath(destinationDirectory, entry.name))
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
    // Keep a size learned from the directory entry/progress event; the
    // completion result only carries transferred bytes for compatibility.
    if (item.totalBytes === undefined) item.totalBytes = result.transferredBytes
    item.name = result.fileName || item.name
    if (direction === 'upload' && item.remotePath === './' && result.fileName) item.remotePath = `./${result.fileName}`
    item.message = result.status === 'canceled' ? '已取消。' : `${direction === 'upload' ? '上传' : '下载'}完成。`
    item.finishedAt = Date.now()
    item.speedBytesPerSecond = item.transferredBytes > 0
      ? item.transferredBytes / Math.max(0.001, (Date.now() - item.startedAt) / 1_000)
      : undefined
    item.remainingSeconds = 0
  }
  markTransferSettled(transferId)
  status.value = result.status === 'canceled' ? '已取消。' : `${direction === 'upload' ? '上传' : '下载'}完成。`
}

function toggleFullscreen(): void {
  fullscreen.value = !fullscreen.value
}

function hidePanel(): void {
  if (fullscreen.value) fullscreen.value = false
  emit('hide')
}

function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '—'
  const rounded = Math.max(0, Math.round(seconds))
  if (rounded < 60) return `${rounded}s`
  const minutes = Math.floor(rounded / 60)
  const rest = rounded % 60
  return `${minutes}m ${String(rest).padStart(2, '0')}s`
}

function formatSpeed(value: number | undefined): string {
  return value && value > 0 ? `${formatBytes(value)}/s` : '—'
}

function elapsedSeconds(item: TransferLog): number {
  return Math.max(0, ((item.finishedAt ?? clockNow.value) - item.startedAt) / 1_000)
}

function onFullscreenKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && fullscreen.value) {
    event.preventDefault()
    fullscreen.value = false
  }
}

function failLocalTransfer(transferId: string, cause: unknown): void {
  markTransferSettled(transferId)
  const message = cause instanceof Error ? cause.message : '文件传输失败。'
  const item = transfers.value.find(transfer => transfer.id === transferId)
  if (item) {
    item.phase = 'failed'
    item.message = message
    item.finishedAt = Date.now()
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

function uploadSelectedLocalDirectory(): void {
  void uploadLocalDirectory()
  closeContextMenu()
}

async function cancelDirectoryTransfer(item: TransferLog): Promise<void> {
  if (!item.canCancel || item.phase !== 'transferring' || entryActionBusy.value) return
  const cancel = window.terminalAgent.fileTransfer?.cancel
  if (typeof cancel !== 'function') return
  try {
    const result = await cancel({ sessionId: item.sessionId, transferId: item.id })
    if (result.canceled) {
      item.message = '正在取消…'
      status.value = '正在取消目录上传…'
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '取消目录上传失败。'
  }
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

function readProgressLogHeight(): number {
  try {
    const raw = window.localStorage.getItem(PROGRESS_LOG_STORAGE_KEY)
    const value = raw === null ? Number.NaN : Number(raw)
    return clampProgressLogHeight(value)
  } catch {
    return 118
  }
}

function clampProgressLogHeight(value: number): number {
  if (!Number.isFinite(value)) return 118
  return Math.min(PROGRESS_LOG_MAX_HEIGHT, Math.max(PROGRESS_LOG_MIN_HEIGHT, Math.round(value)))
}

function persistProgressLogHeight(value: number): void {
  try { window.localStorage.setItem(PROGRESS_LOG_STORAGE_KEY, String(clampProgressLogHeight(value))) } catch { /* Storage can be disabled. */ }
}

function beginProgressResize(event: PointerEvent): void {
  if (event.button !== 0) return
  event.preventDefault()
  progressResizeStartY = event.clientY
  progressResizeStartHeight = progressLogHeight.value
  const handle = event.currentTarget as HTMLElement | null
  handle?.setPointerCapture?.(event.pointerId)
  window.addEventListener('pointermove', resizeProgressLog)
  window.addEventListener('pointerup', finishProgressResize, { once: true })
  window.addEventListener('pointercancel', finishProgressResize, { once: true })
}

function resizeProgressLog(event: PointerEvent): void {
  // The handle sits above the log: moving upward increases its height.
  progressLogHeight.value = clampProgressLogHeight(progressResizeStartHeight + progressResizeStartY - event.clientY)
}

function finishProgressResize(): void {
  window.removeEventListener('pointermove', resizeProgressLog)
  window.removeEventListener('pointerup', finishProgressResize)
  window.removeEventListener('pointercancel', finishProgressResize)
  persistProgressLogHeight(progressLogHeight.value)
}

function onProgressResizeKeydown(event: KeyboardEvent): void {
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
  event.preventDefault()
  const step = event.shiftKey ? PROGRESS_LOG_KEYBOARD_STEP * 2 : PROGRESS_LOG_KEYBOARD_STEP
  progressLogHeight.value = clampProgressLogHeight(progressLogHeight.value + (event.key === 'ArrowUp' ? step : -step))
  persistProgressLogHeight(progressLogHeight.value)
}

watch(busy, value => emit('busyChange', value), { immediate: true })

watch(progressLogHeight, persistProgressLogHeight)

watch(() => props.sessionId, () => {
  ++remoteDirectoryRequestId
  ++localDirectoryRequestId
  ++remoteWorkingDirectoryRequestId
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
  entryDialog.value = null
  entryDialogError.value = ''
  draggedRemoteEntry.value = null
  draggedLocalEntry.value = null
  localDropActive.value = false
  remoteDropActive.value = false
  activeTransferIds.value = new Set()
  remoteWorkingDirectory.value = null
  error.value = ''
  status.value = '正在准备文件传输目录。'
  void refreshRemoteDirectory('/')
  void loadRemoteWorkingDirectory()
  void refreshLocalDirectory()
})

onMounted(() => {
  const onProgress = window.terminalAgent.fileTransfer?.onProgress
  if (typeof onProgress === 'function') unsubscribeProgress = onProgress(setTransferProgress)
  void refreshRemoteDirectory('/')
  void loadRemoteWorkingDirectory()
  void refreshLocalDirectory()
  window.addEventListener('click', closeContextMenu)
  elapsedTimer = setInterval(() => { clockNow.value = Date.now() }, 1_000)
})

onBeforeUnmount(() => {
  emit('busyChange', false)
  unsubscribeProgress?.()
  unsubscribeProgress = undefined
  window.removeEventListener('click', closeContextMenu)
  finishProgressResize()
  if (elapsedTimer) clearInterval(elapsedTimer)
  elapsedTimer = undefined
})
</script>

<template>
  <section class="file-transfer-panel" :class="{ fullscreen }" :style="{ '--file-transfer-log-height': `${progressLogHeight}px` }" aria-label="文件传输" tabindex="-1" @click="onPanelClick" @keydown="onFullscreenKeydown">
    <header class="file-transfer-header">
      <div class="file-transfer-title"><strong>文件传输</strong><span v-if="busy" class="file-transfer-busy">文件传输中</span><span v-if="hostname">{{ hostname }}</span></div>
      <div class="file-transfer-actions">
        <button type="button" class="close-button" :aria-label="fullscreen ? '退出文件传输全屏' : '文件传输全屏'" :title="fullscreen ? '退出全屏' : '全屏'" @click.stop="toggleFullscreen"><Minimize2 v-if="fullscreen" :size="14" aria-hidden="true" /><Maximize2 v-else :size="14" aria-hidden="true" /></button>
        <button type="button" class="close-button" aria-label="隐藏文件传输" title="隐藏文件传输" @click.stop="hidePanel"><ChevronDown :size="15" aria-hidden="true" /></button>
      </div>
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
            :draggable="entry.kind === 'file' || entry.kind === 'directory'"
            :title="entry.kind === 'directory' ? `拖到右侧远程目录递归上传：${entry.name}` : `拖到右侧远程目录上传：${entry.name}`"
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
            <button type="button" class="icon-button" aria-label="跳转到当前 SSH 工作目录" :title="remoteWorkingDirectory ? `跳转到 SSH 工作目录：${remoteWorkingDirectory}` : '当前 SSH 工作目录不可用'" :disabled="loadingRemoteDirectory || loadingRemoteWorkingDirectory || !remoteDirectorySupported || !remoteWorkingDirectory" @click="jumpToRemoteWorkingDirectory"><LocateFixed :size="14" aria-hidden="true" /></button>
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
        <button v-if="contextMenu.entry?.kind === 'directory'" type="button" role="menuitem" :disabled="busy || !remoteDirectorySupported" @click="uploadSelectedLocalDirectory"><FolderUp :size="13" aria-hidden="true" />递归上传到当前远程目录</button>
        <button v-if="contextMenu.entry?.kind === 'file' || contextMenu.entry?.kind === 'directory'" type="button" role="menuitem" :disabled="busy || entryActionBusy" @click="openRenameDialog('local', contextMenu.entry)"><Pencil :size="13" aria-hidden="true" />重命名</button>
        <button v-if="contextMenu.entry?.kind === 'file' || contextMenu.entry?.kind === 'directory'" type="button" role="menuitem" :disabled="busy || entryActionBusy" @click="openDeleteDialog('local', contextMenu.entry)"><Trash2 :size="13" aria-hidden="true" />删除</button>
      </template>
      <template v-else>
        <button v-if="contextMenu.entry?.kind === 'directory'" type="button" role="menuitem" @click="openRemoteEntry(contextMenu.entry); closeContextMenu()"><Folder :size="13" aria-hidden="true" />进入目录</button>
        <button v-if="contextMenu.entry?.kind === 'file'" type="button" role="menuitem" :disabled="busy || !localCurrentPath" @click="downloadSelectedRemoteFile"><Download :size="13" aria-hidden="true" />下载到当前本地目录</button>
        <button v-if="contextMenu.entry?.kind === 'file' || contextMenu.entry?.kind === 'directory'" type="button" role="menuitem" :disabled="busy || entryActionBusy" @click="openRenameDialog('remote', contextMenu.entry)"><Pencil :size="13" aria-hidden="true" />重命名</button>
        <button v-if="contextMenu.entry?.kind === 'file' || contextMenu.entry?.kind === 'directory'" type="button" role="menuitem" :disabled="busy || entryActionBusy" @click="openDeleteDialog('remote', contextMenu.entry)"><Trash2 :size="13" aria-hidden="true" />删除</button>
      </template>
    </div>

    <div v-if="entryDialog" class="entry-action-dialog-backdrop" role="presentation" @click.self="closeEntryDialog">
      <section class="entry-action-dialog" role="dialog" aria-modal="true" :aria-labelledby="`file-transfer-entry-dialog-title-${sessionId}`" @keydown.esc.prevent="closeEntryDialog">
        <header><strong :id="`file-transfer-entry-dialog-title-${sessionId}`">{{ entryDialog.mode === 'rename' ? '重命名条目' : '删除条目' }}</strong><button type="button" class="icon-button" aria-label="关闭" title="关闭" :disabled="entryActionBusy" @click="closeEntryDialog"><X :size="14" aria-hidden="true" /></button></header>
        <template v-if="entryDialog.mode === 'rename'">
          <label :for="`file-transfer-entry-name-${sessionId}`">新名称</label>
          <input :id="`file-transfer-entry-name-${sessionId}`" v-model="entryRenameValue" type="text" autocomplete="off" :disabled="entryActionBusy" @keydown.enter.prevent="submitEntryDialog" />
        </template>
        <p v-else>确认删除“{{ entryDialog.entry.name }}”{{ entryDialog.entry.kind === 'directory' ? '及其中的所有内容' : '' }}？</p>
        <p v-if="entryDialogError" class="entry-action-error" role="alert">{{ entryDialogError }}</p>
        <footer><button type="button" class="dialog-button" :disabled="entryActionBusy" @click="closeEntryDialog">取消</button><button type="button" class="dialog-button" :class="{ danger: entryDialog.mode === 'delete' }" :disabled="entryActionBusy || busy" @click="submitEntryDialog">{{ entryActionBusy ? '处理中…' : entryDialog.mode === 'rename' ? '重命名' : '删除' }}</button></footer>
      </section>
    </div>

    <div class="file-transfer-log-resize-handle" role="separator" aria-orientation="horizontal" aria-label="调整上传下载进度区域高度" tabindex="0" :aria-valuemin="PROGRESS_LOG_MIN_HEIGHT" :aria-valuemax="PROGRESS_LOG_MAX_HEIGHT" :aria-valuenow="progressLogHeight" title="拖动调整进度区域高度" @pointerdown="beginProgressResize" @keydown="onProgressResizeKeydown"></div>
    <section class="file-transfer-log" aria-label="上传下载进度">
      <header class="section-heading"><span>上传下载进度</span><span>{{ transfers.length ? `${transfers.length} 条记录` : '暂无记录' }}</span></header>
      <div v-if="transfers.length" class="transfer-table" role="table" aria-label="上传下载进度表">
        <div class="transfer-row transfer-head" role="row"><span>状态</span><span>进度</span><span>大小</span><span>本地路径</span><span>方向</span><span>远程路径</span><span>速度</span><span>预计剩余时间</span><span>经过时间</span></div>
        <div v-for="item in transfers" :key="item.id" class="transfer-row" role="row">
          <span :class="['transfer-state', item.phase]" :title="item.message || formatTransferProgress(item)"><span>{{ item.message || formatTransferProgress(item) }}</span><button v-if="item.canCancel && item.phase === 'transferring'" type="button" class="transfer-cancel" aria-label="取消目录上传" title="取消目录上传" @click="cancelDirectoryTransfer(item)"><X :size="12" aria-hidden="true" /></button></span>
          <span>{{ formatTransferProgress(item) }}<small v-if="item.phase === 'transferring' && item.totalBytes"> · {{ formatBytes(item.transferredBytes) }}/{{ formatBytes(item.totalBytes) }}</small></span>
          <span>{{ item.totalBytes ? formatBytes(item.totalBytes) : '—' }}</span>
          <span class="transfer-name" :title="item.localPath || '由本机文件选择器选择'">{{ item.localPath || '本机选择器' }}</span>
          <span :class="['direction', item.direction]">{{ item.direction === 'upload' ? '上传' : '下载' }}</span>
          <span class="transfer-name" :title="item.remotePath">{{ item.remotePath }}</span>
          <span>{{ formatSpeed(item.speedBytesPerSecond) }}</span>
          <span>{{ formatDuration(item.remainingSeconds) }}</span>
          <span>{{ formatDuration(elapsedSeconds(item)) }}</span>
        </div>
      </div>
      <p v-else class="log-empty">上传或下载记录会显示在这里。</p>
    </section>

    <p v-if="error" class="file-transfer-error" role="alert">{{ error }}</p>
    <p v-else class="file-transfer-status" aria-live="polite">{{ status }}</p>
  </section>
</template>

<style scoped>
.file-transfer-panel { position: relative; display: grid; grid-template-rows: auto minmax(126px, 1fr) 7px var(--file-transfer-log-height, 118px) auto; gap: 6px; box-sizing: border-box; width: 100%; min-width: 0; min-height: 240px; max-height: 440px; padding: 8px 10px 9px; border-top: 1px solid var(--line); background: var(--panel); color: var(--text); }
/* Native title-bar controls occupy the top overlay area. Keep a fullscreen
   transfer surface below it so its header actions remain independently
   clickable instead of sitting underneath the window buttons. */
.file-transfer-panel.fullscreen { position: fixed; z-index: 40; top: max(52px, calc(env(titlebar-area-height, 0px) + 10px)); right: 18px; bottom: 18px; left: 18px; width: auto; height: auto; max-height: none; min-height: 0; padding: 14px; border: 1px solid var(--line); border-radius: 8px; box-shadow: 0 24px 72px rgb(0 0 0 / 34%); }
.file-transfer-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }.file-transfer-title { display: flex; align-items: baseline; gap: 8px; min-width: 0; overflow: hidden; }.file-transfer-title strong { flex: 0 0 auto; color: var(--text-strong); font-size: 11px; font-weight: 720; }.file-transfer-title span { min-width: 0; overflow: hidden; color: var(--muted); font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }.file-transfer-title .file-transfer-busy { flex: 0 0 auto; padding: 1px 4px; border: 1px solid var(--amber-line); border-radius: 3px; background: var(--amber-soft); color: var(--amber); font-size: 8px; font-weight: 700; }
.file-transfer-panel.fullscreen .file-transfer-header { flex-wrap: wrap; }.file-transfer-panel.fullscreen .file-transfer-actions { flex: 0 0 auto; }
.file-transfer-actions { display: flex; align-items: center; gap: 4px; min-width: 0; }
.close-button,.icon-button { display: grid; place-items: center; width: 25px; height: 25px; padding: 0; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); color: var(--muted); }.close-button:hover,.icon-button:hover:not(:disabled) { border-color: var(--focus); color: var(--text-strong); }.close-button:disabled,.icon-button:disabled { cursor: not-allowed; opacity: .52; }
.file-transfer-browser { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 6px; min-width: 0; min-height: 0; overflow: hidden; }.file-pane,.file-transfer-log { display: grid; grid-template-rows: auto minmax(0, 1fr); min-width: 0; min-height: 0; overflow: hidden; border: 1px solid var(--line-soft); background: var(--surface); }.file-pane-header { display: grid; grid-template-rows: auto auto auto; min-width: 0; border-bottom: 1px solid var(--line-soft); }.file-transfer-log { min-height: 50px; }.section-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; min-height: 23px; padding: 0 7px; border-bottom: 1px solid var(--line-soft); color: var(--text-strong); font-size: 9px; font-weight: 650; }.file-pane-header .section-heading { border-bottom: 0; }.section-heading span:last-child { color: var(--muted); font-size: 8px; font-weight: 500; }
.file-pane-pathbar { display: grid; grid-template-columns: auto minmax(0, 1fr) 25px 25px 25px; align-items: center; gap: 4px; min-width: 0; padding: 0 5px 4px; }.remote-file-pane .file-pane-pathbar { grid-template-columns: auto minmax(0, 1fr) 25px 25px 25px; }.file-pane-pathbar label { color: var(--muted); font-size: 8px; }.file-pane-pathbar input { box-sizing: border-box; width: 100%; min-width: 0; height: 25px; padding: 0 6px; border: 1px solid var(--line); border-radius: 4px; background: var(--surface-soft); color: var(--text-strong); font: inherit; font-size: 9px; }.file-pane-pathbar input:focus { border-color: var(--focus); outline: 2px solid color-mix(in srgb, var(--focus) 22%, transparent); }
.file-pane-breadcrumbs { display: flex; align-items: center; min-width: 0; min-height: 17px; padding: 0 5px 3px; overflow: hidden; color: var(--muted); }.file-pane-breadcrumbs button { display: inline-flex; align-items: center; gap: 2px; min-width: 0; max-width: 120px; padding: 1px 3px; border: 0; background: transparent; color: inherit; font-size: 8px; text-overflow: ellipsis; white-space: nowrap; }.file-pane-breadcrumbs button:hover,.file-pane-breadcrumbs button.current { color: var(--text-strong); }.file-pane-breadcrumbs button.current { font-weight: 650; }
.directory-list { position: relative; min-width: 0; min-height: 0; overflow: auto; padding: 2px; scrollbar-width: thin; scrollbar-color: transparent transparent; }.directory-list:hover,.directory-list:focus-within { scrollbar-color: color-mix(in srgb, var(--muted) 55%, transparent) transparent; }.directory-entry { display: grid; grid-template-columns: 18px minmax(0, 1fr) auto 17px; align-items: center; gap: 4px; width: 100%; min-height: 24px; padding: 2px 5px; border: 1px solid transparent; border-radius: 3px; background: transparent; color: var(--text); font-size: 9px; text-align: left; }.directory-entry:hover,.directory-entry.selected { border-color: var(--amber-line); background: var(--amber-soft); }.directory-entry .entry-icon { color: var(--muted); }.directory-entry .directory-icon { color: var(--amber); }.entry-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.directory-entry small { color: var(--muted); font-size: 8px; white-space: nowrap; }.entry-menu-hint { color: var(--faint); }.parent-entry { color: var(--muted); }.directory-empty { display: grid; place-items: center; min-height: 48px; padding: 8px; color: var(--muted); font-size: 9px; text-align: center; }.local-file-pane.drop-active,.remote-file-pane.drop-active { border-color: var(--focus); box-shadow: inset 0 0 0 1px var(--focus); }.directory-drop-overlay { position: absolute; inset: 4px; z-index: 2; display: grid; place-items: center; border: 1px dashed var(--focus); border-radius: 4px; background: color-mix(in srgb, var(--focus) 13%, var(--surface)); color: var(--text-strong); font-size: 9px; pointer-events: none; }
.directory-context-menu { position: absolute; z-index: 5; display: grid; min-width: 164px; padding: 3px; border: 1px solid var(--line); border-radius: 5px; background: var(--surface); box-shadow: 0 10px 24px rgb(24 31 40 / 22%); }.directory-context-menu button { display: inline-flex; align-items: center; gap: 6px; min-height: 26px; padding: 0 7px; border: 0; border-radius: 3px; background: transparent; color: var(--text); font-size: 9px; text-align: left; }.directory-context-menu button:hover:not(:disabled) { background: var(--hover); }.directory-context-menu button:disabled { cursor: not-allowed; opacity: .52; }
.entry-action-dialog-backdrop { position: absolute; z-index: 12; inset: 0; display: grid; place-items: center; padding: 12px; background: rgb(20 26 34 / 42%); }.entry-action-dialog { display: grid; gap: 10px; box-sizing: border-box; width: min(100%, 340px); padding: 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); box-shadow: 0 18px 42px rgb(0 0 0 / 28%); color: var(--text); }.entry-action-dialog header,.entry-action-dialog footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; }.entry-action-dialog header strong { color: var(--text-strong); font-size: 11px; }.entry-action-dialog label,.entry-action-dialog p { margin: 0; color: var(--muted); font-size: 9px; line-height: 1.5; }.entry-action-dialog input { box-sizing: border-box; width: 100%; height: 28px; padding: 0 7px; border: 1px solid var(--line); border-radius: 4px; background: var(--surface-soft); color: var(--text-strong); font: inherit; font-size: 10px; }.entry-action-dialog input:focus { border-color: var(--focus); outline: 2px solid color-mix(in srgb, var(--focus) 22%, transparent); }.entry-action-error { color: var(--red) !important; }.entry-action-dialog footer { justify-content: flex-end; }.dialog-button { min-height: 27px; padding: 0 9px; border: 1px solid var(--line); border-radius: 4px; background: var(--surface-soft); color: var(--text); font-size: 9px; }.dialog-button:hover:not(:disabled) { border-color: var(--focus); color: var(--text-strong); }.dialog-button.danger { border-color: color-mix(in srgb, var(--red) 45%, var(--line)); color: var(--red); }.dialog-button:disabled { cursor: not-allowed; opacity: .56; }
.file-transfer-log-resize-handle { position: relative; min-height: 7px; cursor: row-resize; touch-action: none; }.file-transfer-log-resize-handle::after { position: absolute; top: 3px; right: 35%; left: 35%; height: 1px; border-radius: 1px; background: var(--line); content: ''; }.file-transfer-log-resize-handle:hover::after,.file-transfer-log-resize-handle:focus-visible::after { right: 25%; left: 25%; background: var(--focus); }.file-transfer-log-resize-handle:focus-visible { outline: 2px solid color-mix(in srgb, var(--focus) 35%, transparent); outline-offset: 1px; }
.transfer-table { min-width: 0; min-height: 0; overflow: auto; scrollbar-width: thin; scrollbar-color: transparent transparent; }.transfer-table:hover,.transfer-table:focus-within { scrollbar-color: color-mix(in srgb, var(--muted) 55%, transparent) transparent; }.transfer-table::-webkit-scrollbar { width: 8px; height: 8px; }.transfer-table::-webkit-scrollbar-track { background: transparent; }.transfer-table::-webkit-scrollbar-thumb { border: 2px solid transparent; border-radius: 999px; background: transparent; background-clip: padding-box; }.transfer-table:hover::-webkit-scrollbar-thumb,.transfer-table:focus-within::-webkit-scrollbar-thumb { background-color: color-mix(in srgb, var(--muted) 55%, transparent); }.transfer-row { display: grid; grid-template-columns: minmax(70px, .8fr) minmax(76px, .8fr) 68px minmax(160px, 1.4fr) 44px minmax(160px, 1.4fr) 78px 92px 76px; align-items: center; gap: 7px; min-width: 900px; min-height: 25px; padding: 0 7px; border-bottom: 1px solid var(--line-soft); color: var(--muted); font-size: 8px; }.transfer-row:last-child { border-bottom: 0; }.transfer-head { position: sticky; top: 0; z-index: 1; min-height: 23px; background: var(--surface-soft); color: var(--faint); font-size: 8px; }.transfer-name { min-width: 0; overflow: hidden; color: var(--text); text-overflow: ellipsis; white-space: nowrap; }.direction.upload { color: var(--accent); }.direction.download { color: var(--focus); }.transfer-state { display: inline-flex; align-items: center; gap: 4px; min-width: 0; }.transfer-state > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.transfer-state.completed { color: var(--accent); }.transfer-state.failed { color: var(--red); }.transfer-state.canceled { color: var(--muted); }.transfer-cancel { display: grid; flex: 0 0 auto; place-items: center; width: 18px; height: 18px; padding: 0; border: 1px solid var(--line); border-radius: 3px; background: var(--surface); color: var(--muted); }.transfer-cancel:hover { border-color: var(--red); color: var(--red); }.transfer-row small { color: var(--faint); }.log-empty { display: grid; place-items: center; margin: 0; padding: 8px; color: var(--muted); }
.file-transfer-status,.file-transfer-error { min-width: 0; margin: 0; overflow: hidden; font-size: 9px; line-height: 1.3; text-overflow: ellipsis; white-space: nowrap; }.file-transfer-status { color: var(--muted); }.file-transfer-error { color: var(--red); }.spinning { animation: file-transfer-spin .9s linear infinite; }@keyframes file-transfer-spin { to { transform: rotate(360deg); } }
@media (max-width: 760px) { .file-transfer-panel { max-height: 460px; }.file-transfer-panel.fullscreen { top: max(48px, calc(env(titlebar-area-height, 0px) + 8px)); right: 8px; bottom: 8px; left: 8px; }.file-transfer-browser { grid-template-columns: 1fr; grid-template-rows: minmax(120px, 1fr) minmax(120px, 1fr); overflow: auto; }.transfer-row { grid-template-columns: minmax(70px, .8fr) minmax(76px, .8fr) 68px minmax(140px, 1.2fr) 44px minmax(140px, 1.2fr) 78px 76px 76px; } }
</style>
