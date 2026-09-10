import { dialog, ipcMain, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, sep, win32 } from 'node:path'
import { lstat, readdir, realpath, rename, rmdir, stat, unlink } from 'node:fs/promises'
import {
  FILE_TRANSFER_MAX_BYTES,
  FILE_TRANSFER_MAX_DIRECTORY_DEPTH,
  FILE_TRANSFER_MAX_DIRECTORY_ENTRIES,
  fileTransferCancelRequestSchema,
  fileTransferCancelResultSchema,
  fileTransferChannels,
  fileTransferDownloadRequestSchema,
  fileTransferLocalDeleteRequestSchema,
  fileTransferLocalDeleteResultSchema,
  fileTransferLocalDirectorySelectionSchema,
  fileTransferLocalListRequestSchema,
  fileTransferLocalListResultSchema,
  fileTransferLocalRenameRequestSchema,
  fileTransferLocalRenameResultSchema,
  fileTransferListRequestSchema,
  fileTransferListResultSchema,
  fileTransferProgressSchema,
  fileTransferRemoteDeleteRequestSchema,
  fileTransferRemoteDeleteResultSchema,
  fileTransferRemoteRenameRequestSchema,
  fileTransferRemoteRenameResultSchema,
  fileTransferResultSchema,
  fileTransferUploadRequestSchema,
  fileTransferUploadAllRequestSchema,
  fileTransferUploadAllResultSchema,
  fileTransferUploadDirectoryRequestSchema,
  fileTransferWorkingDirectoryRequestSchema,
  fileTransferWorkingDirectoryResultSchema,
  type FileTransferDirection,
  type FileTransferDirectoryEntry,
  type FileTransferLocalDirectorySelection,
  type FileTransferLocalListResult,
  type FileTransferListResult,
  type FileTransferProgress,
  type FileTransferResult,
  type FileTransferUploadAllResult,
  type FileTransferWorkingDirectoryResult,
  type FileTransferLocalDeleteResult,
  type FileTransferLocalRenameResult,
  type FileTransferRemoteDeleteResult,
  type FileTransferRemoteRenameResult,
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
  getWorkingDirectory?(sessionId: string): Promise<string>
  ensureDirectory?(sessionId: string, remotePath: string): Promise<void>
  rename?(sessionId: string, fromPath: string, toPath: string): Promise<void>
  removeFile?(sessionId: string, remotePath: string): Promise<void>
  removeDirectory?(sessionId: string, remotePath: string): Promise<void>
  uploadFile(
    sessionId: string,
    localPath: string,
    remotePath: string,
    onProgress: (progress: { transferredBytes: number; totalBytes?: number }) => void,
    signal?: AbortSignal,
  ): Promise<number>
  downloadFile(
    sessionId: string,
    remotePath: string,
    localPath: string,
    onProgress: (progress: { transferredBytes: number; totalBytes?: number }) => void,
    signal?: AbortSignal,
  ): Promise<number>
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
  // Directory uploads are the only multi-item operation. Keep their abort
  // controllers in the main process so a renderer can request cancellation
  // without receiving a filesystem or transport capability.
  const activeDirectoryTransfers = new Map<string, AbortController>()

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

  ipcMain.handle(fileTransferChannels.workingDirectory, async (event, request: unknown): Promise<FileTransferWorkingDirectoryResult> => {
    assertTrustedSender(event, trustedSender)
    const parsed = fileTransferWorkingDirectoryRequestSchema.safeParse(request)
    if (!parsed.success) throw new Error('SSH 工作目录请求无效。')
    if (!sessions.getWorkingDirectory) throw new Error('当前 SSH 会话不支持获取 SFTP 工作目录。')
    try {
      return fileTransferWorkingDirectoryResultSchema.parse({
        sessionId: parsed.data.sessionId,
        remotePath: normalizeRemoteMutationDirectory(await sessions.getWorkingDirectory(parsed.data.sessionId)),
      })
    } catch (error) {
      throw new Error(publicDirectoryError(error), { cause: error })
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

  ipcMain.handle(fileTransferChannels.renameLocal, async (event, request: unknown): Promise<FileTransferLocalRenameResult> => {
    assertTrustedSender(event, trustedSender)
    const parsed = fileTransferLocalRenameRequestSchema.safeParse(request)
    if (!parsed.success) throw new Error('本地重命名请求无效。')
    try {
      await ensureDefaultLocalDirectory()
      const directory = await resolveGrantedLocalDirectory(parsed.data.directory, selectedLocalDirectoryRoots)
      const entry = await resolveLocalMutationEntry(directory, parsed.data.name)
      const target = join(directory, parsed.data.newName)
      if (!isWithinLocalRoot(directory, target)) throw new Error('本地条目路径无效。')
      await assertLocalRenameTarget(target)
      await rename(entry.path, target)
      return fileTransferLocalRenameResultSchema.parse({ directory, name: parsed.data.name, newName: parsed.data.newName })
    } catch (error) {
      throw new Error(publicLocalMutationError('重命名', error), { cause: error })
    }
  })

  ipcMain.handle(fileTransferChannels.deleteLocal, async (event, request: unknown): Promise<FileTransferLocalDeleteResult> => {
    assertTrustedSender(event, trustedSender)
    const parsed = fileTransferLocalDeleteRequestSchema.safeParse(request)
    if (!parsed.success) throw new Error('本地删除请求无效。')
    try {
      await ensureDefaultLocalDirectory()
      const directory = await resolveGrantedLocalDirectory(parsed.data.directory, selectedLocalDirectoryRoots)
      const entry = await resolveLocalMutationEntry(directory, parsed.data.name)
      if (entry.kind !== parsed.data.kind) throw new Error('本地条目已变化，请刷新目录后重试。')
      const plan = await buildLocalDeletePlan(entry.path, entry.kind)
      for (const item of plan) {
        if (item.kind === 'directory') await rmdir(item.path)
        else await unlink(item.path)
      }
      return fileTransferLocalDeleteResultSchema.parse({ directory, name: parsed.data.name })
    } catch (error) {
      throw new Error(publicLocalMutationError('删除', error), { cause: error })
    }
  })

  ipcMain.handle(fileTransferChannels.renameRemote, async (event, request: unknown): Promise<FileTransferRemoteRenameResult> => {
    assertTrustedSender(event, trustedSender)
    const parsed = fileTransferRemoteRenameRequestSchema.safeParse(request)
    if (!parsed.success) throw new Error('远程重命名请求无效。')
    if (!sessions.rename || !sessions.listDirectory) throw new Error('当前 SSH 会话不支持重命名远程文件。')
    try {
      const directory = normalizeRemoteMutationDirectory(parsed.data.directory)
      const entries = await listRemoteDirectoryForMutation(sessions, parsed.data.sessionId, directory)
      if (!entries.some(entry => entry.name === parsed.data.name)) throw new Error('远程条目不存在或已变化。')
      if (parsed.data.name !== parsed.data.newName && entries.some(entry => entry.name === parsed.data.newName)) {
        throw new Error('目标名称已存在，请使用其他名称。')
      }
      if (parsed.data.name !== parsed.data.newName) {
        await sessions.rename(
          parsed.data.sessionId,
          joinRemoteMutationPath(directory, parsed.data.name),
          joinRemoteMutationPath(directory, parsed.data.newName),
        )
      }
      return fileTransferRemoteRenameResultSchema.parse({
        sessionId: parsed.data.sessionId, directory, name: parsed.data.name, newName: parsed.data.newName,
      })
    } catch (error) {
      throw new Error(publicRemoteMutationError('重命名', error), { cause: error })
    }
  })

  ipcMain.handle(fileTransferChannels.deleteRemote, async (event, request: unknown): Promise<FileTransferRemoteDeleteResult> => {
    assertTrustedSender(event, trustedSender)
    const parsed = fileTransferRemoteDeleteRequestSchema.safeParse(request)
    if (!parsed.success) throw new Error('远程删除请求无效。')
    if (!sessions.listDirectory || !sessions.removeFile) {
      throw new Error('当前 SSH 会话不支持删除远程文件。')
    }
    try {
      const directory = normalizeRemoteMutationDirectory(parsed.data.directory)
      const entries = await listRemoteDirectoryForMutation(sessions, parsed.data.sessionId, directory)
      const entry = entries.find(candidate => candidate.name === parsed.data.name)
      if (!entry || entry.kind !== parsed.data.kind) throw new Error('远程条目不存在或已变化，请刷新目录后重试。')
      if (entry.kind === 'directory' && !sessions.removeDirectory) throw new Error('当前 SSH 会话不支持删除远程目录。')
      const rootPath = joinRemoteMutationPath(directory, entry.name)
      const plan = entry.kind === 'directory'
        ? await buildRemoteDeletePlan(sessions, parsed.data.sessionId, rootPath)
        : [{ path: rootPath, kind: entry.kind }]
      for (const item of plan) {
        if (item.kind === 'directory') {
          if (!sessions.removeDirectory) throw new Error('当前 SSH 会话不支持删除远程目录。')
          await sessions.removeDirectory(parsed.data.sessionId, item.path)
        }
        else await sessions.removeFile(parsed.data.sessionId, item.path)
      }
      return fileTransferRemoteDeleteResultSchema.parse({ sessionId: parsed.data.sessionId, directory, name: parsed.data.name })
    } catch (error) {
      throw new Error(publicRemoteMutationError('删除', error), { cause: error })
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

  /**
   * Pick one local file and upload it concurrently to every requested SSH
   * session.  The native picker is deliberately resolved before any SFTP
   * operation starts, so a batch action never opens one dialog per session.
   */
  ipcMain.handle(fileTransferChannels.uploadAll, async (event, request: unknown): Promise<FileTransferUploadAllResult> => {
    assertTrustedSender(event, trustedSender)
    const parsed = fileTransferUploadAllRequestSchema.safeParse(request)
    if (!parsed.success) throw new Error('批量文件上传请求无效。')

    const startedAt = now().toISOString()
    const requestedSessions = new Set(parsed.data.sessionIds)
    const suppliedTransferIds = new Map<string, string>()
    const seenTransferIds = new Set<string>()
    for (const mapping of parsed.data.transferIds ?? []) {
      // The shared schema validates UUID syntax, but the relationship between
      // the two lists is intentionally checked here as well.  A malformed
      // mapping must never cause two progress streams to share one row.
      if (!requestedSessions.has(mapping.sessionId) || suppliedTransferIds.has(mapping.sessionId) || seenTransferIds.has(mapping.transferId)) {
        throw new Error('批量文件上传请求的传输标识无效。')
      }
      suppliedTransferIds.set(mapping.sessionId, mapping.transferId)
      seenTransferIds.add(mapping.transferId)
    }
    const transferIds = new Map(parsed.data.sessionIds.map(sessionId => [sessionId, suppliedTransferIds.get(sessionId) ?? randomUUID()]))
    const direction: FileTransferDirection = 'upload'
    let selectedPath: string | undefined
    let fileName = '未命名文件'

    // Notify all rows that the shared native picker is open.  Each row gets a
    // distinct id so the normal progress listener can correlate updates.
    for (const sessionId of parsed.data.sessionIds) {
      emitProgress(trustedSender, {
        transferId: transferIds.get(sessionId)!, sessionId, direction,
        phase: 'selecting', transferredBytes: 0,
      })
    }

    try {
      if (parsed.data.localPath) {
        await ensureDefaultLocalDirectory()
        selectedPath = await validateGrantedUploadPath(parsed.data.localPath, selectedLocalDirectoryRoots)
      } else {
        const selected = await dialogs.selectUploadFile()
        if (selected.canceled || !selected.filePath) {
          const results = parsed.data.sessionIds.map(sessionId => {
            const transferId = transferIds.get(sessionId)!
            emitProgress(trustedSender, {
              transferId, sessionId, direction, phase: 'canceled', transferredBytes: 0,
              message: '已取消批量文件上传。',
            })
            return { sessionId, transferId, status: 'canceled' as const, transferredBytes: 0, message: '已取消批量文件上传。' }
          })
          return fileTransferUploadAllResultSchema.parse({ status: 'canceled', results })
        }
        selectedPath = await validateUploadPath(selected.filePath)
      }
      fileName = displayFileName(selectedPath)
      const totalBytes = (await lstat(selectedPath)).size

      const results = await Promise.all(parsed.data.sessionIds.map(async sessionId => {
        const transferId = transferIds.get(sessionId)!
        const remoteTarget = uploadRemoteTarget(parsed.data.remotePath, fileName)
        try {
          emitProgress(trustedSender, {
            transferId, sessionId, direction, phase: 'transferring', transferredBytes: 0,
            totalBytes, fileName,
          })
          const transferredBytes = await sessions.uploadFile(
            sessionId,
            selectedPath!,
            remoteTarget,
            progress => emitProgress(trustedSender, {
              transferId, sessionId, direction, phase: 'transferring',
              transferredBytes: progress.transferredBytes,
              ...(progress.totalBytes === undefined ? {} : { totalBytes: progress.totalBytes }),
              fileName,
            }),
          )
          const boundedTransferred = boundedBytes(transferredBytes)
          emitProgress(trustedSender, {
            transferId, sessionId, direction, phase: 'completed',
            transferredBytes: boundedTransferred, totalBytes: boundedBytes(totalBytes), fileName,
            message: '文件上传完成。',
          })
          await recordTransfer(options.history, {
            sessionId, id: transferId, direction, fileName, remotePath: remoteTarget,
            status: 'completed', transferredBytes: boundedTransferred, totalBytes,
            message: '文件上传完成。', startedAt, endedAt: now().toISOString(),
          })
          return { sessionId, transferId, status: 'completed' as const, transferredBytes: boundedTransferred, fileName, message: '文件上传完成。' }
        } catch (cause) {
          const message = publicTransferError(direction, cause)
          emitProgress(trustedSender, {
            transferId, sessionId, direction, phase: 'failed', transferredBytes: 0,
            fileName, message,
          })
          await recordTransfer(options.history, {
            sessionId, id: transferId, direction, fileName, remotePath: remoteTarget,
            status: 'failed', transferredBytes: 0, totalBytes,
            message, startedAt, endedAt: now().toISOString(),
          })
          return { sessionId, transferId, status: 'failed' as const, transferredBytes: 0, fileName, message }
        }
      }))
      // Once a file has been selected, each fan-out leg can only complete or
      // fail; cancellation is handled above while the shared picker is open.
      const status = results.every(item => item.status === 'completed') ? 'completed' : 'partial'
      return fileTransferUploadAllResultSchema.parse({ status, fileName, results })
    } catch (cause) {
      // Selection/validation errors happen before a per-session transfer is
      // started.  Surface one public error while still notifying every row.
      const message = publicTransferError(direction, cause)
      for (const sessionId of parsed.data.sessionIds) {
        const transferId = transferIds.get(sessionId)!
        emitProgress(trustedSender, { transferId, sessionId, direction, phase: 'failed', transferredBytes: 0, message })
        await recordTransfer(options.history, {
          sessionId, id: transferId, direction, fileName,
          remotePath: parsed.data.remotePath, status: 'failed', transferredBytes: 0,
          message, startedAt, endedAt: now().toISOString(),
        })
      }
      throw new Error(message, { cause })
    }
  })

  ipcMain.handle(fileTransferChannels.uploadDirectory, async (event, request: unknown): Promise<FileTransferResult> => {
    assertTrustedSender(event, trustedSender)
    const parsed = fileTransferUploadDirectoryRequestSchema.safeParse(request)
    if (!parsed.success) throw new Error('目录上传请求无效。')
    if (!sessions.ensureDirectory || !sessions.uploadFile) throw new Error('当前 SSH 会话不支持上传目录。')
    const transferId = parsed.data.transferId ?? randomUUID()
    const direction: FileTransferDirection = 'upload'
    const startedAt = now().toISOString()
    const transferKey = directoryTransferKey(parsed.data.sessionId, transferId)
    if (activeDirectoryTransfers.has(transferKey)) throw new Error('该目录上传已在进行中。')
    const controller = new AbortController()
    activeDirectoryTransfers.set(transferKey, controller)
    let fileName = displayFileName(parsed.data.localPath)
    let remoteTarget = parsed.data.remotePath
    let totalBytes: number | undefined
    let transferredBytes = 0
    emitProgress(trustedSender, {
      transferId,
      sessionId: parsed.data.sessionId,
      direction,
      phase: 'selecting',
      transferredBytes,
      fileName,
    })

    try {
      await ensureDefaultLocalDirectory()
      const localRoot = await validateGrantedUploadDirectory(parsed.data.localPath, selectedLocalDirectoryRoots)
      const plan = await buildLocalUploadPlan(localRoot)
      fileName = plan.rootName
      totalBytes = plan.totalBytes
      const uploadTotalBytes = plan.totalBytes
      const remoteDirectory = normalizeRemoteMutationDirectory(parsed.data.remotePath)
      remoteTarget = joinRemoteMutationPath(remoteDirectory, plan.rootName)
      throwIfDirectoryTransferCanceled(controller.signal)
      emitProgress(trustedSender, {
        transferId,
        sessionId: parsed.data.sessionId,
        direction,
        phase: 'transferring',
        transferredBytes,
        totalBytes,
        fileName,
      })

      for (const directory of plan.directories) {
        throwIfDirectoryTransferCanceled(controller.signal)
        await sessions.ensureDirectory(parsed.data.sessionId, joinRemoteUploadPath(remoteTarget, directory.relativePath))
      }
      for (const file of plan.files) {
        throwIfDirectoryTransferCanceled(controller.signal)
        const localSource = await validatePlannedUploadFile(file.localPath, localRoot, file.size)
        const beforeFile = transferredBytes
        await sessions.uploadFile(
          parsed.data.sessionId,
          localSource,
          joinRemoteUploadPath(remoteTarget, file.relativePath),
          progress => {
            const currentFileBytes = Math.max(0, Math.min(file.size, boundedBytes(progress.transferredBytes)))
            const nextTransferred = Math.min(plan.totalBytes, beforeFile + currentFileBytes)
            transferredBytes = Math.max(transferredBytes, nextTransferred)
            emitProgress(trustedSender, {
              transferId,
              sessionId: parsed.data.sessionId,
              direction,
              phase: 'transferring',
              transferredBytes,
              totalBytes: plan.totalBytes,
              fileName,
            })
          },
          controller.signal,
        )
        throwIfDirectoryTransferCanceled(controller.signal)
        transferredBytes = Math.min(plan.totalBytes, beforeFile + file.size)
        emitProgress(trustedSender, {
          transferId,
          sessionId: parsed.data.sessionId,
          direction,
          phase: 'transferring',
          transferredBytes,
          totalBytes: plan.totalBytes,
          fileName,
        })
      }
      throwIfDirectoryTransferCanceled(controller.signal)
      emitProgress(trustedSender, {
        transferId,
        sessionId: parsed.data.sessionId,
        direction,
        phase: 'completed',
        transferredBytes: uploadTotalBytes,
        totalBytes: uploadTotalBytes,
        fileName,
        message: '目录上传完成。',
      })
      await recordTransfer(options.history, {
        sessionId: parsed.data.sessionId, id: transferId, direction, fileName, remotePath: remoteTarget,
        status: 'completed', transferredBytes: boundedBytes(uploadTotalBytes), totalBytes: uploadTotalBytes,
        message: '目录上传完成。', startedAt, endedAt: now().toISOString(),
      })
      return fileTransferResultSchema.parse({
        transferId, sessionId: parsed.data.sessionId, direction, status: 'completed',
        transferredBytes: boundedBytes(uploadTotalBytes), fileName,
      })
    } catch (error) {
      if (controller.signal.aborted || isDirectoryTransferCancellation(error)) {
        emitProgress(trustedSender, {
          transferId,
          sessionId: parsed.data.sessionId,
          direction,
          phase: 'canceled',
          transferredBytes,
          ...(totalBytes === undefined ? {} : { totalBytes }),
          fileName,
          message: '已取消目录上传。',
        })
        await recordTransfer(options.history, {
          sessionId: parsed.data.sessionId, id: transferId, direction, fileName, remotePath: remoteTarget,
          status: 'canceled', transferredBytes: boundedBytes(transferredBytes),
          ...(totalBytes === undefined ? {} : { totalBytes }),
          message: '已取消目录上传。', startedAt, endedAt: now().toISOString(),
        })
        return fileTransferResultSchema.parse({
          transferId, sessionId: parsed.data.sessionId, direction, status: 'canceled',
          transferredBytes: boundedBytes(transferredBytes), fileName,
        })
      }
      const failed = failTransfer(trustedSender, transferId, parsed.data.sessionId, direction, error)
      await recordTransfer(options.history, {
        sessionId: parsed.data.sessionId, id: transferId, direction, fileName, remotePath: remoteTarget,
        status: 'failed', transferredBytes: boundedBytes(transferredBytes),
        ...(totalBytes === undefined ? {} : { totalBytes }),
        message: failed.message, startedAt, endedAt: now().toISOString(),
      })
      throw failed
    } finally {
      activeDirectoryTransfers.delete(transferKey)
    }
  })

  ipcMain.handle(fileTransferChannels.cancel, async (event, request: unknown) => {
    assertTrustedSender(event, trustedSender)
    const parsed = fileTransferCancelRequestSchema.safeParse(request)
    if (!parsed.success) throw new Error('取消文件传输请求无效。')
    const controller = activeDirectoryTransfers.get(directoryTransferKey(parsed.data.sessionId, parsed.data.transferId))
    const canceled = Boolean(controller && !controller.signal.aborted)
    if (canceled) controller!.abort()
    return fileTransferCancelResultSchema.parse({
      sessionId: parsed.data.sessionId,
      transferId: parsed.data.transferId,
      canceled,
    })
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
    for (const controller of activeDirectoryTransfers.values()) controller.abort()
    activeDirectoryTransfers.clear()
    ipcMain.removeHandler(fileTransferChannels.list)
    ipcMain.removeHandler(fileTransferChannels.workingDirectory)
    ipcMain.removeHandler(fileTransferChannels.selectLocalDirectory)
    ipcMain.removeHandler(fileTransferChannels.listLocal)
    ipcMain.removeHandler(fileTransferChannels.renameLocal)
    ipcMain.removeHandler(fileTransferChannels.deleteLocal)
    ipcMain.removeHandler(fileTransferChannels.renameRemote)
    ipcMain.removeHandler(fileTransferChannels.deleteRemote)
    ipcMain.removeHandler(fileTransferChannels.upload)
    ipcMain.removeHandler(fileTransferChannels.uploadAll)
    ipcMain.removeHandler(fileTransferChannels.uploadDirectory)
    ipcMain.removeHandler(fileTransferChannels.cancel)
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

async function validateGrantedUploadDirectory(value: string, roots: ReadonlySet<string>): Promise<string> {
  const directory = await resolveGrantedLocalDirectory(value, roots)
  const details = await lstat(directory).catch(() => undefined)
  if (!details || !details.isDirectory() || details.isSymbolicLink()) {
    throw new Error('请选择存在的普通本地目录。')
  }
  return directory
}

type LocalMutationEntry = {
  path: string
  kind: FileTransferDirectoryEntry['kind']
}

type FileDeletionPlanItem = {
  path: string
  kind: FileTransferDirectoryEntry['kind']
}

type LocalUploadPlan = {
  rootName: string
  directories: Array<{ relativePath: string }>
  files: Array<{ localPath: string; relativePath: string; size: number }>
  totalBytes: number
}

async function resolveLocalMutationEntry(directory: string, name: string): Promise<LocalMutationEntry> {
  if (!isSafeLocalEntryName(name)) throw new Error('本地文件名无效。')
  const path = join(directory, name)
  if (!isWithinLocalRoot(directory, path)) throw new Error('本地条目路径无效。')
  const details = await lstat(path).catch(() => undefined)
  if (!details) throw new Error('本地条目不存在或已变化。')
  if (details.isSymbolicLink()) throw new Error('为了保护本地目录，不能操作符号链接。')
  return {
    path,
    kind: details.isDirectory() ? 'directory' : details.isFile() ? 'file' : 'other',
  }
}

async function assertLocalRenameTarget(path: string): Promise<void> {
  const existing = await lstat(path).catch(() => undefined)
  if (existing) throw new Error('目标名称已存在，请使用其他名称。')
}

async function buildLocalDeletePlan(rootPath: string, expectedRootKind: FileTransferDirectoryEntry['kind']): Promise<FileDeletionPlanItem[]> {
  const plan: FileDeletionPlanItem[] = []
  let entries = 0
  const visit = async (path: string, depth: number, expectedKind?: FileTransferDirectoryEntry['kind']): Promise<void> => {
    if (depth > FILE_TRANSFER_MAX_DIRECTORY_DEPTH) throw new Error('本地目录层级过深，无法删除。')
    const details = await lstat(path).catch(() => undefined)
    if (!details) throw new Error('本地条目不存在或已变化。')
    const kind: FileTransferDirectoryEntry['kind'] = details.isDirectory()
      ? 'directory'
      : details.isFile()
        ? 'file'
        : details.isSymbolicLink()
          ? 'symlink'
          : 'other'
    if (expectedKind && kind !== expectedKind) throw new Error('本地条目已变化，请刷新目录后重试。')
    entries += 1
    if (entries > FILE_TRANSFER_MAX_DIRECTORY_ENTRIES) throw new Error('本地目录条目过多，无法删除。')
    if (kind === 'directory') {
      const children = (await readdir(path)).sort((left, right) => left.localeCompare(right))
      for (const childName of children) {
        if (!isSafeLocalEntryName(childName)) throw new Error('本地目录包含不安全的条目，无法删除。')
        await visit(join(path, childName), depth + 1)
      }
    }
    // A symbolic link is retained as a leaf. It is deleted with unlink and is
    // never traversed, including when it appears below a normal directory.
    plan.push({ path, kind })
  }
  await visit(rootPath, 0, expectedRootKind)
  return plan
}

async function buildLocalUploadPlan(localRoot: string): Promise<LocalUploadPlan> {
  const rootName = basename(localRoot)
  if (!isSafeRemoteEntryName(rootName)) throw new Error('本地目录名称无法用于远程上传。')
  const directories: LocalUploadPlan['directories'] = [{ relativePath: '' }]
  const files: LocalUploadPlan['files'] = []
  let entries = 1
  let totalBytes = 0
  const visit = async (directory: string, relativePath: string, depth: number): Promise<void> => {
    if (depth > FILE_TRANSFER_MAX_DIRECTORY_DEPTH) throw new Error('本地目录层级过深，无法上传。')
    const children = (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))
    for (const child of children) {
      if (!isSafeLocalEntryName(child.name) || !isSafeRemoteEntryName(child.name)) {
        throw new Error('本地目录包含不安全的条目，无法上传。')
      }
      entries += 1
      if (entries > FILE_TRANSFER_MAX_DIRECTORY_ENTRIES) throw new Error('本地目录条目过多，请缩小目录范围后重试。')
      const localPath = join(directory, child.name)
      const details = await lstat(localPath).catch(() => undefined)
      if (!details) throw new Error('本地目录内容已变化，请刷新后重试。')
      if (details.isSymbolicLink()) throw new Error('为了保护本地目录，上传不包含符号链接。')
      const childRelativePath = relativePath ? `${relativePath}/${child.name}` : child.name
      if (details.isDirectory()) {
        directories.push({ relativePath: childRelativePath })
        await visit(localPath, childRelativePath, depth + 1)
        continue
      }
      if (!details.isFile()) throw new Error('本地目录包含不支持的条目，无法上传。')
      if (details.size > FILE_TRANSFER_MAX_BYTES) throw new Error('目录中的文件超过允许的大小限制。')
      if (totalBytes > FILE_TRANSFER_MAX_BYTES - details.size) throw new Error('目录总大小超过允许的大小限制。')
      totalBytes += details.size
      files.push({ localPath, relativePath: childRelativePath, size: details.size })
    }
  }
  await visit(localRoot, '', 0)
  return { rootName, directories, files, totalBytes }
}

async function validatePlannedUploadFile(path: string, root: string, expectedSize: number): Promise<string> {
  const details = await lstat(path).catch(() => undefined)
  if (!details || !details.isFile() || details.isSymbolicLink() || details.size !== expectedSize) {
    throw new Error('本地目录内容已变化，请刷新后重试。')
  }
  const canonical = await realpath(path).catch(() => undefined)
  if (!canonical || !isWithinLocalRoot(root, canonical)) throw new Error('为了保护本地目录，上传不包含符号链接。')
  return canonical
}

async function listRemoteDirectoryForMutation(
  sessions: FileTransferSource,
  sessionId: string,
  remotePath: string,
): Promise<readonly FileTransferDirectoryEntry[]> {
  if (!sessions.listDirectory) throw new Error('当前 SSH 会话不支持读取远程目录。')
  const entries = await sessions.listDirectory(sessionId, remotePath)
  if (entries.length > FILE_TRANSFER_MAX_DIRECTORY_ENTRIES) throw new Error('远程目录条目过多，请缩小目录范围后重试。')
  for (const entry of entries) {
    if (!isSafeRemoteEntryName(entry.name) || !isFileTransferEntryKind(entry.kind)) {
      throw new Error('远程目录包含不安全的条目。')
    }
  }
  return entries
}

async function buildRemoteDeletePlan(
  sessions: FileTransferSource,
  sessionId: string,
  rootPath: string,
): Promise<FileDeletionPlanItem[]> {
  const plan: FileDeletionPlanItem[] = []
  let entries = 1
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > FILE_TRANSFER_MAX_DIRECTORY_DEPTH) throw new Error('远程目录层级过深，无法删除。')
    const children = await listRemoteDirectoryForMutation(sessions, sessionId, directory)
    for (const child of children) {
      entries += 1
      if (entries > FILE_TRANSFER_MAX_DIRECTORY_ENTRIES) throw new Error('远程目录条目过多，无法删除。')
      const childPath = joinRemoteMutationPath(directory, child.name)
      if (child.kind === 'directory') await visit(childPath, depth + 1)
      else plan.push({ path: childPath, kind: child.kind })
    }
    plan.push({ path: directory, kind: 'directory' })
  }
  await visit(rootPath, 0)
  return plan
}

function normalizeRemoteMutationDirectory(value: string): string {
  if (typeof value !== 'string') throw new Error('远程目录路径无效。')
  const path = value.trim()
  if (!path || path.length > 4_096 || path.includes('\\') || containsControlCharacters(path)) {
    throw new Error('远程目录路径无效。')
  }
  const absolute = path.startsWith('/')
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') throw new Error('远程目录路径不能包含上级目录。')
    parts.push(part)
  }
  if (!parts.length) return absolute ? '/' : '.'
  return absolute ? `/${parts.join('/')}` : parts.join('/')
}

function joinRemoteMutationPath(directory: string, name: string): string {
  if (!isSafeRemoteEntryName(name)) throw new Error('远程文件名无效。')
  const parent = normalizeRemoteMutationDirectory(directory)
  return parent === '/' ? `/${name}` : parent === '.' ? `./${name}` : `${parent}/${name}`
}

function joinRemoteUploadPath(root: string, relativePath: string): string {
  if (!relativePath) return root
  return relativePath.split('/').reduce((parent, name) => joinRemoteMutationPath(parent, name), root)
}

function isSafeRemoteEntryName(value: string): boolean {
  return Boolean(value?.trim()) && value !== '.' && value !== '..' && value.length <= 255
    && !/[\\/]/.test(value) && !containsControlCharacters(value)
}

function isSafeLocalEntryName(value: string): boolean {
  return Boolean(value.trim()) && value !== '.' && value !== '..' && value.length <= 255
    && !/[\\/]/.test(value) && !containsControlCharacters(value)
}

function isFileTransferEntryKind(value: unknown): value is FileTransferDirectoryEntry['kind'] {
  return value === 'file' || value === 'directory' || value === 'symlink' || value === 'other'
}

function directoryTransferKey(sessionId: string, transferId: string): string {
  return `${sessionId}\u0000${transferId}`
}

function createDirectoryTransferAbortError(): Error {
  const error = new Error('目录上传已取消。')
  error.name = 'AbortError'
  return error
}

function throwIfDirectoryTransferCanceled(signal: AbortSignal): void {
  if (signal.aborted) throw createDirectoryTransferAbortError()
}

function isDirectoryTransferCancellation(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.message.includes('已取消'))
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

function publicLocalMutationError(operation: '重命名' | '删除', error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  if (raw.includes('请选择') || raw.includes('本地条目') || raw.includes('本地文件名')
    || raw.includes('本地目录') || raw.includes('目标名称') || raw.includes('符号链接')
    || raw.includes('层级过深') || raw.includes('条目过多') || raw.includes('不安全的条目')) return raw
  return `本地${operation}失败，请刷新目录后重试。`
}

function publicRemoteMutationError(operation: '重命名' | '删除', error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  if (raw.includes('当前 SSH 会话不支持')) return raw
  if (raw.includes('Unknown terminal session')) return 'SSH 会话已关闭，请重新连接后重试。'
  if (raw.includes('远程条目') || raw.includes('远程目录') || raw.includes('远程文件名')
    || raw.includes('目标名称') || raw.includes('层级过深') || raw.includes('条目过多')
    || raw.includes('不安全的条目')) return raw
  return `远程${operation}失败，请检查 SSH 连接和远程路径。`
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
