import { dialog, ipcMain, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, sep, win32 } from 'node:path'
import { lstat, readdir, realpath, stat } from 'node:fs/promises'
import {
  FILE_TRANSFER_MAX_BYTES,
  FILE_TRANSFER_MAX_DIRECTORY_ENTRIES,
  fileTransferChannels,
  fileTransferDownloadRequestSchema,
  fileTransferLocalDirectorySelectionSchema,
  fileTransferLocalListRequestSchema,
  fileTransferLocalListResultSchema,
  fileTransferListRequestSchema,
  fileTransferListResultSchema,
  fileTransferProgressSchema,
  fileTransferResultSchema,
  fileTransferUploadRequestSchema,
  type FileTransferDirection,
  type FileTransferDirectoryEntry,
  type FileTransferLocalDirectorySelection,
  type FileTransferLocalListResult,
  type FileTransferListResult,
  type FileTransferProgress,
  type FileTransferResult,
} from '../../shared/file-transfer-contracts'
import type { ShellHistoryFileTransferLog } from '../../shared/contracts'

type TransferDialogResult = { canceled: boolean; filePath?: string }

export type FileTransferDialogDependencies = {
  selectUploadFile: () => Promise<TransferDialogResult>
  selectDownloadPath: (defaultFileName: string) => Promise<TransferDialogResult>
  selectLocalDirectory: () => Promise<TransferDialogResult>
}

/**
 * A narrow optional audit sink.  It deliberately accepts only display-safe
 * transfer metadata, never the selected local path or any file contents.
 */
export type FileTransferHistorySink = {
  recordFileTransfer(input: ShellHistoryFileTransferLog & { sessionId: string }): void | Promise<void>
}

export type FileTransferHandlerOptions = Partial<FileTransferDialogDependencies> & {
  history?: FileTransferHistorySink
  now?: () => Date
  /** Testable override for the stable first local-browser directory. */
  localHomeDirectory?: string
}

type FileTransferSource = {
  listDirectory?(sessionId: string, remotePath: string): Promise<readonly FileTransferDirectoryEntry[]>
  uploadFile(sessionId: string, localPath: string, remotePath: string, onProgress: (progress: { transferredBytes: number; totalBytes?: number }) => void): Promise<number>
  downloadFile(sessionId: string, remotePath: string, localPath: string, onProgress: (progress: { transferredBytes: number; totalBytes?: number }) => void): Promise<number>
}

const defaultDialogDependencies: FileTransferDialogDependencies = {
  selectUploadFile: async () => {
    const result = await dialog.showOpenDialog({
      title: '选择要上传的文件',
      properties: ['openFile'],
    })
    return { canceled: result.canceled, filePath: result.filePaths[0] }
  },
  selectDownloadPath: async defaultFileName => {
    const result = await dialog.showSaveDialog({
      title: '选择下载保存位置',
      defaultPath: defaultFileName,
    })
    return { canceled: result.canceled, filePath: result.filePath }
  },
  selectLocalDirectory: async () => {
    const result = await dialog.showOpenDialog({
      title: '选择本地文件夹',
      properties: ['openDirectory'],
    })
    return { canceled: result.canceled, filePath: result.filePaths[0] }
  },
}

/**
 * Register the isolated SFTP IPC surface.  Native dialogs remain in the main
 * process, so an untrusted renderer cannot turn this API into an arbitrary
 * local-file reader/writer.  Only a selected file's display name and byte
 * counts are sent back to the renderer.
 */
export function registerFileTransferHandlers(
  sessions: FileTransferSource,
  trustedSender: WebContents,
  options: FileTransferHandlerOptions = {},
): () => void {
  const dialogs = {
    ...defaultDialogDependencies,
    ...(options.selectUploadFile ? { selectUploadFile: options.selectUploadFile } : {}),
    ...(options.selectDownloadPath ? { selectDownloadPath: options.selectDownloadPath } : {}),
    ...(options.selectLocalDirectory ? { selectLocalDirectory: options.selectLocalDirectory } : {}),
  }
  const now = options.now ?? (() => new Date())
  // Explicit local paths are accepted only after the main-process picker has
  // granted their containing directory.  This retains the existing boundary:
  // a compromised renderer cannot turn file-transfer IPC into arbitrary local
  // file system access merely by fabricating an absolute path.
  const selectedLocalDirectoryRoots = new Set<string>()
  const localHomeDirectory = options.localHomeDirectory ?? homedir()
  let defaultLocalDirectory: Promise<string> | undefined
  const ensureDefaultLocalDirectory = (): Promise<string> => {
    defaultLocalDirectory ??= grantLocalDirectory(localHomeDirectory, selectedLocalDirectoryRoots)
    return defaultLocalDirectory
  }

  ipcMain.handle(fileTransferChannels.list, async (event, request: unknown): Promise<FileTransferListResult> => {
    assertTrustedSender(event, trustedSender)
    const parsed = fileTransferListRequestSchema.safeParse(request)
    if (!parsed.success) throw new Error('远程目录请求无效。')
    if (!sessions.listDirectory) throw new Error('当前 SSH 会话不支持 SFTP 文件传输。')
    try {
      return fileTransferListResultSchema.parse({
        sessionId: parsed.data.sessionId,
        remotePath: parsed.data.remotePath,
        entries: await sessions.listDirectory(parsed.data.sessionId, parsed.data.remotePath),
      })
    } catch (error) {
      throw new Error(publicDirectoryError(error), { cause: error })
    }
  })

  ipcMain.handle(fileTransferChannels.selectLocalDirectory, async (event): Promise<FileTransferLocalDirectorySelection> => {
    assertTrustedSender(event, trustedSender)
    let selected: TransferDialogResult
    try {
      selected = await dialogs.selectLocalDirectory()
    } catch (error) {
      throw new Error('本地目录选择失败。', { cause: error })
    }
    if (selected.canceled || !selected.filePath) return fileTransferLocalDirectorySelectionSchema.parse({ canceled: true })
    try {
      const localPath = await grantLocalDirectory(selected.filePath, selectedLocalDirectoryRoots)
      return fileTransferLocalDirectorySelectionSchema.parse({ canceled: false, localPath })
    } catch (error) {
      throw new Error(publicLocalDirectoryError(error), { cause: error })
    }
  })

  ipcMain.handle(fileTransferChannels.listLocal, async (event, request: unknown): Promise<FileTransferLocalListResult> => {
    assertTrustedSender(event, trustedSender)
    const parsed = fileTransferLocalListRequestSchema.safeParse(request)
    if (!parsed.success) throw new Error('本地目录请求无效。')
    try {
      const requestedPath = parsed.data.localPath ?? await ensureDefaultLocalDirectory()
      const localPath = await resolveGrantedLocalDirectory(requestedPath, selectedLocalDirectoryRoots)
      return fileTransferLocalListResultSchema.parse({
        localPath,
        entries: await listLocalDirectory(localPath),
      })
    } catch (error) {
      throw new Error(publicLocalDirectoryError(error), { cause: error })
    }
  })

  ipcMain.handle(fileTransferChannels.upload, async (event, request: unknown): Promise<FileTransferResult> => {
    assertTrustedSender(event, trustedSender)
    const parsed = fileTransferUploadRequestSchema.safeParse(request)
    if (!parsed.success) throw new Error('文件上传请求无效。')
    const transferId = parsed.data.transferId ?? randomUUID()
    const direction: FileTransferDirection = 'upload'
    const startedAt = now().toISOString()
    let fileName = fileNameForPendingUpload(parsed.data.remotePath)
    let remotePath = parsed.data.remotePath
    let totalBytes: number | undefined
    emitProgress(trustedSender, {
      transferId,
      sessionId: parsed.data.sessionId,
      direction,
      phase: 'selecting',
      transferredBytes: 0,
    })

    let selected: TransferDialogResult | undefined
    if (!parsed.data.localPath) {
      try {
        selected = await dialogs.selectUploadFile()
      } catch (error) {
        const failed = failTransfer(trustedSender, transferId, parsed.data.sessionId, direction, error)
        await recordTransfer(options.history, {
          sessionId: parsed.data.sessionId, id: transferId, direction, fileName, remotePath,
          status: 'failed', transferredBytes: 0, message: failed.message, startedAt, endedAt: now().toISOString(),
        })
        throw failed
      }
      if (selected.canceled || !selected.filePath) {
        emitProgress(trustedSender, {
          transferId,
          sessionId: parsed.data.sessionId,
          direction,
          phase: 'canceled',
          transferredBytes: 0,
          message: '已取消文件上传。',
        })
        await recordTransfer(options.history, {
          sessionId: parsed.data.sessionId, id: transferId, direction, fileName, remotePath,
          status: 'canceled', transferredBytes: 0, message: '已取消文件上传。', startedAt, endedAt: now().toISOString(),
        })
        return fileTransferResultSchema.parse({
          transferId,
          sessionId: parsed.data.sessionId,
          direction,
          status: 'canceled',
          transferredBytes: 0,
        })
      }
    }

    try {
      if (parsed.data.localPath) await ensureDefaultLocalDirectory()
      const localPath = parsed.data.localPath
        ? await validateGrantedUploadPath(parsed.data.localPath, selectedLocalDirectoryRoots)
        : await validateUploadPath(selected!.filePath!)
      fileName = displayFileName(localPath)
      const remoteTarget = uploadRemoteTarget(parsed.data.remotePath, fileName)
      remotePath = remoteTarget
      totalBytes = (await lstat(localPath)).size
      emitProgress(trustedSender, {
        transferId,
        sessionId: parsed.data.sessionId,
        direction,
        phase: 'transferring',
        transferredBytes: 0,
        totalBytes,
        fileName,
      })
      const transferredBytes = await sessions.uploadFile(
        parsed.data.sessionId,
        localPath,
        remoteTarget,
        progress => emitProgress(trustedSender, {
          transferId,
          sessionId: parsed.data.sessionId,
          direction,
          phase: 'transferring',
          transferredBytes: progress.transferredBytes,
          ...(progress.totalBytes === undefined ? {} : { totalBytes: progress.totalBytes }),
          fileName,
        }),
      )
      emitProgress(trustedSender, {
        transferId,
        sessionId: parsed.data.sessionId,
        direction,
        phase: 'completed',
        transferredBytes,
        totalBytes: transferredBytes,
        fileName,
        message: '文件上传完成。',
      })
      await recordTransfer(options.history, {
        sessionId: parsed.data.sessionId, id: transferId, direction, fileName, remotePath,
        status: 'completed', transferredBytes: boundedBytes(transferredBytes), totalBytes,
        message: '文件上传完成。', startedAt, endedAt: now().toISOString(),
      })
      return fileTransferResultSchema.parse({ transferId, sessionId: parsed.data.sessionId, direction, status: 'completed', transferredBytes: boundedBytes(transferredBytes), fileName })
    } catch (error) {
      const failed = failTransfer(trustedSender, transferId, parsed.data.sessionId, direction, error)
      await recordTransfer(options.history, {
        sessionId: parsed.data.sessionId, id: transferId, direction, fileName, remotePath,
        status: 'failed', transferredBytes: 0, ...(totalBytes === undefined ? {} : { totalBytes }),
        message: failed.message, startedAt, endedAt: now().toISOString(),
      })
      throw failed
    }
  })

  ipcMain.handle(fileTransferChannels.download, async (event, request: unknown): Promise<FileTransferResult> => {
    assertTrustedSender(event, trustedSender)
    const parsed = fileTransferDownloadRequestSchema.safeParse(request)
    if (!parsed.success) throw new Error('文件下载请求无效。')
    const transferId = parsed.data.transferId ?? randomUUID()
    const direction: FileTransferDirection = 'download'
    const startedAt = now().toISOString()
    emitProgress(trustedSender, {
      transferId,
      sessionId: parsed.data.sessionId,
      direction,
      phase: 'selecting',
      transferredBytes: 0,
    })

    const suggestedName = safeSuggestedFileName(parsed.data.fileName ?? remoteBaseName(parsed.data.remotePath))
    let fileName = suggestedName
    const remotePath = parsed.data.remotePath
    let totalBytes: number | undefined
    let selected: TransferDialogResult | undefined
    if (!parsed.data.localPath) {
      try {
        selected = await dialogs.selectDownloadPath(suggestedName)
      } catch (error) {
        const failed = failTransfer(trustedSender, transferId, parsed.data.sessionId, direction, error)
        await recordTransfer(options.history, {
          sessionId: parsed.data.sessionId, id: transferId, direction, fileName, remotePath,
          status: 'failed', transferredBytes: 0, message: failed.message, startedAt, endedAt: now().toISOString(),
        })
        throw failed
      }
      if (selected.canceled || !selected.filePath) {
        emitProgress(trustedSender, {
          transferId,
          sessionId: parsed.data.sessionId,
          direction,
          phase: 'canceled',
          transferredBytes: 0,
          message: '已取消文件下载。',
        })
        await recordTransfer(options.history, {
          sessionId: parsed.data.sessionId, id: transferId, direction, fileName, remotePath,
          status: 'canceled', transferredBytes: 0, message: '已取消文件下载。', startedAt, endedAt: now().toISOString(),
        })
        return fileTransferResultSchema.parse({
          transferId,
          sessionId: parsed.data.sessionId,
          direction,
          status: 'canceled',
          transferredBytes: 0,
        })
      }
    }

    try {
      if (parsed.data.localPath) await ensureDefaultLocalDirectory()
      const localPath = parsed.data.localPath
        ? await validateGrantedDownloadDirectory(parsed.data.localPath, suggestedName, selectedLocalDirectoryRoots)
        : await validateDownloadPath(selected!.filePath!)
      fileName = displayFileName(localPath)
      emitProgress(trustedSender, {
        transferId,
        sessionId: parsed.data.sessionId,
        direction,
        phase: 'transferring',
        transferredBytes: 0,
        fileName,
      })
      const transferredBytes = await sessions.downloadFile(
        parsed.data.sessionId,
        parsed.data.remotePath,
        localPath,
        progress => {
          totalBytes = progress.totalBytes ?? totalBytes
          emitProgress(trustedSender, {
            transferId,
            sessionId: parsed.data.sessionId,
            direction,
            phase: 'transferring',
            transferredBytes: progress.transferredBytes,
            ...(progress.totalBytes === undefined ? {} : { totalBytes: progress.totalBytes }),
            fileName,
          })
        },
      )
      emitProgress(trustedSender, {
        transferId,
        sessionId: parsed.data.sessionId,
        direction,
        phase: 'completed',
        transferredBytes,
        totalBytes: transferredBytes,
        fileName,
        message: '文件下载完成。',
      })
      await recordTransfer(options.history, {
        sessionId: parsed.data.sessionId, id: transferId, direction, fileName, remotePath,
        status: 'completed', transferredBytes: boundedBytes(transferredBytes), ...(totalBytes === undefined ? {} : { totalBytes }),
        message: '文件下载完成。', startedAt, endedAt: now().toISOString(),
      })
      return fileTransferResultSchema.parse({ transferId, sessionId: parsed.data.sessionId, direction, status: 'completed', transferredBytes: boundedBytes(transferredBytes), fileName })
    } catch (error) {
      const failed = failTransfer(trustedSender, transferId, parsed.data.sessionId, direction, error)
      await recordTransfer(options.history, {
        sessionId: parsed.data.sessionId, id: transferId, direction, fileName, remotePath,
        status: 'failed', transferredBytes: 0, ...(totalBytes === undefined ? {} : { totalBytes }),
        message: failed.message, startedAt, endedAt: now().toISOString(),
      })
      throw failed
    }
  })

  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    ipcMain.removeHandler(fileTransferChannels.list)
    ipcMain.removeHandler(fileTransferChannels.selectLocalDirectory)
    ipcMain.removeHandler(fileTransferChannels.listLocal)
    ipcMain.removeHandler(fileTransferChannels.upload)
    ipcMain.removeHandler(fileTransferChannels.download)
  }
}

function assertTrustedSender(event: { sender: WebContents }, trustedSender: WebContents): void {
  if (event.sender !== trustedSender) throw new Error('Untrusted renderer')
}

function emitProgress(sender: WebContents, value: FileTransferProgress): void {
  const parsed = fileTransferProgressSchema.parse({
    ...value,
    transferredBytes: boundedBytes(value.transferredBytes),
    ...(value.totalBytes === undefined ? {} : { totalBytes: boundedBytes(value.totalBytes) }),
  })
  if (typeof sender.isDestroyed === 'function' && sender.isDestroyed()) return
  // A renderer can close while a native dialog or SFTP operation is active.
  // Progress is best-effort; swallowing a send failure keeps the in-flight
  // invoke handler able to settle its promise instead of producing Electron's
  // misleading "reply was never sent" error.
  try { sender.send(fileTransferChannels.progress, parsed) } catch { /* Renderer already gone. */ }
}

function failTransfer(
  sender: WebContents,
  transferId: string,
  sessionId: string,
  direction: FileTransferDirection,
  error: unknown,
): Error {
  const message = publicTransferError(direction, error)
  emitProgress(sender, {
    transferId,
    sessionId,
    direction,
    phase: 'failed',
    transferredBytes: 0,
    message,
  })
  return new Error(message)
}

async function validateUploadPath(value: string): Promise<string> {
  const path = validateLocalPath(value, '上传')
  const details = await lstat(path).catch(() => undefined)
  if (!details || !details.isFile() || details.isSymbolicLink()) throw new Error('请选择存在的普通本地文件。')
  if (details.size > FILE_TRANSFER_MAX_BYTES) throw new Error('文件超过允许的大小限制。')
  return path
}

async function validateDownloadPath(value: string): Promise<string> {
  const path = validateLocalPath(value, '下载')
  const parent = await stat(dirname(path)).catch(() => undefined)
  if (!parent?.isDirectory()) throw new Error('本地保存目录不存在。')
  const existing = await lstat(path).catch(() => undefined)
  if (existing && (existing.isDirectory() || existing.isSymbolicLink() || !existing.isFile())) {
    throw new Error('本地保存路径必须是普通文件。')
  }
  return path
}

/** Add one picker-confirmed directory as a root available to local browsing. */
async function grantLocalDirectory(value: string, roots: Set<string>): Promise<string> {
  const localPath = await resolveLocalDirectory(value)
  roots.add(localPath)
  return localPath
}

/** Resolve a browsed local directory without allowing symlink traversal. */
async function resolveGrantedLocalDirectory(value: string, roots: ReadonlySet<string>): Promise<string> {
  const localPath = await resolveLocalDirectory(value)
  if (![...roots].some(root => isWithinLocalRoot(root, localPath))) {
    throw new Error('请先选择本地目录后重试。')
  }
  return localPath
}

async function resolveLocalDirectory(value: string): Promise<string> {
  const path = validateLocalPath(value, '本地目录')
  const details = await lstat(path).catch(() => undefined)
  if (!details || !details.isDirectory() || details.isSymbolicLink()) {
    throw new Error('请选择存在的普通本地目录。')
  }
  try {
    return await realpath(path)
  } catch {
    throw new Error('本地目录不存在或不可访问。')
  }
}

async function validateGrantedUploadPath(value: string, roots: ReadonlySet<string>): Promise<string> {
  const path = await validateUploadPath(value)
  let canonical: string
  try {
    canonical = await realpath(path)
  } catch {
    throw new Error('请选择存在的普通本地文件。')
  }
  if (![...roots].some(root => isWithinLocalRoot(root, canonical))) {
    throw new Error('请选择本地目录中的文件后重试。')
  }
  return canonical
}

async function validateGrantedDownloadDirectory(
  value: string,
  fileName: string,
  roots: ReadonlySet<string>,
): Promise<string> {
  const directory = await resolveGrantedLocalDirectory(value, roots)
  return validateDownloadPath(join(directory, fileName))
}

function isWithinLocalRoot(root: string, candidate: string): boolean {
  const pathDifference = relative(root, candidate)
  return pathDifference === '' || (!pathDifference.startsWith(`..${sep}`) && pathDifference !== '..' && !isAbsolute(pathDifference))
}

async function listLocalDirectory(directory: string): Promise<FileTransferDirectoryEntry[]> {
  const rawEntries = await readdir(directory, { withFileTypes: true })
  if (rawEntries.length > FILE_TRANSFER_MAX_DIRECTORY_ENTRIES) {
    throw new Error('本地目录条目过多，请缩小目录范围后重试。')
  }
  const entries: Array<FileTransferDirectoryEntry | undefined> = await Promise.all(rawEntries.map(async entry => {
    if (!isSafeLocalEntryName(entry.name)) return undefined
    const details = await lstat(join(directory, entry.name)).catch(() => undefined)
    if (!details) return undefined
    const kind = details.isDirectory()
      ? 'directory'
      : details.isFile()
        ? 'file'
        : details.isSymbolicLink()
          ? 'symlink'
          : 'other'
    return {
      name: entry.name,
      kind,
      size: finiteNonNegativeInteger(details.size) ?? 0,
      modifiedAt: details.mtime.toISOString(),
      mode: details.mode & 0o7777,
      ...(finiteNonNegativeInteger(details.uid) === undefined ? {} : { uid: finiteNonNegativeInteger(details.uid) }),
      ...(finiteNonNegativeInteger(details.gid) === undefined ? {} : { gid: finiteNonNegativeInteger(details.gid) }),
    } as FileTransferDirectoryEntry
  }))
  return entries.filter((entry): entry is FileTransferDirectoryEntry => entry !== undefined)
}

function isSafeLocalEntryName(value: string): boolean {
  return Boolean(value.trim()) && value !== '.' && value !== '..' && value.length <= 255
    && !/[\\/]/.test(value) && !containsControlCharacters(value)
}

function finiteNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function validateLocalPath(value: string, operation: string): string {
  if (typeof value !== 'string') throw new Error(`${operation}路径无效。`)
  const path = value.trim()
  if (!path || path.length > 4_096 || containsControlCharacters(path) || !(isAbsolute(path) || win32.isAbsolute(path))) {
    throw new Error(`${operation}路径无效。`)
  }
  return path
}

function containsControlCharacters(value: string): boolean {
  return [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
}

function displayFileName(path: string): string {
  const name = path.split(/[\\/]/).pop()?.trim()
  return name && name.length <= 255 ? name : '未命名文件'
}

function remoteBaseName(remotePath: string): string {
  const name = remotePath.split(/[\\/]/).filter(Boolean).at(-1)
  return name || 'download.bin'
}

/**
 * Display-safe fallback name used while an upload dialog is still pending.
 * The renderer/main-process boundary only receives the remote target here;
 * never persist or expose a local absolute path before the native picker has
 * returned one.
 */
function fileNameForPendingUpload(remotePath: string): string {
  return safeSuggestedFileName(remoteBaseName(remotePath))
}

function uploadRemoteTarget(remotePath: string, fileName: string): string {
  // The browser uses a trailing slash to represent "upload into this
  // directory".  Resolve that form in the main process after the native file
  // picker returns the basename; callers cannot inject shell syntax here
  // because the path is passed directly to SFTP.
  if (!/[\\/]$/.test(remotePath)) return remotePath
  if (remotePath === '/' || remotePath === '\\') return `/${fileName}`
  return `${remotePath}${fileName}`
}

function safeSuggestedFileName(value: string): string {
  const name = displayFileName(value).replace(/[<>:"/\\|?*]/g, '_').trim()
  return !name || name === '.' || name === '..' ? 'download.bin' : name
}

function boundedBytes(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(FILE_TRANSFER_MAX_BYTES, Math.floor(value)))
}

/**
 * Persist transfer history on a best-effort basis.  A failure in the history
 * store must never turn a completed/canceled/failed SFTP operation into a
 * different user-visible result, so both synchronous and asynchronous sink
 * errors are intentionally swallowed.
 */
async function recordTransfer(
  history: FileTransferHistorySink | undefined,
  input: ShellHistoryFileTransferLog & { sessionId: string },
): Promise<void> {
  if (!history) return
  try {
    await history.recordFileTransfer(input)
  } catch {
    // History persistence is supplemental to the transfer operation.
  }
}

function publicTransferError(direction: FileTransferDirection, error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  if (raw.includes('当前 SSH 会话不支持')) return raw
  if (raw.includes('Unknown terminal session')) return 'SSH 会话已关闭，请重新连接后重试。'
  if (raw.includes('普通本地文件') || raw.includes('本地保存')) return raw
  return direction === 'upload'
    ? '文件上传失败，请检查 SSH 连接和远程路径。'
    : '文件下载失败，请检查 SSH 连接和远程路径。'
}

function publicDirectoryError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  if (raw.includes('当前 SSH 会话不支持')) return raw
  if (raw.includes('Unknown terminal session')) return 'SSH 会话已关闭，请重新连接后重试。'
  if (raw.includes('目录条目过多')) return raw
  return '远程目录读取失败，请检查 SSH 连接和远程路径。'
}

function publicLocalDirectoryError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  if (raw.includes('请选择') || raw.includes('本地目录') || raw.includes('目录条目过多')) return raw
  return '本地目录读取失败，请重新选择本地目录后重试。'
}
