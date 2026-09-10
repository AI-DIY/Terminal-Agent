import { beforeEach, describe, expect, it, vi } from 'vitest'
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { registerFileTransferHandlers } from '../../../src/main/ipc/register-file-transfer-handlers'

const { handle, removeHandler } = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn() }))
vi.mock('electron', () => ({
  ipcMain: { handle, removeHandler },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
}))

describe('registerFileTransferHandlers', () => {
  beforeEach(() => {
    handle.mockReset()
    removeHandler.mockReset()
  })

  it('lists remote directory metadata through the active session without opening a native dialog', async () => {
    const sender = createSender()
    const listDirectory = vi.fn().mockResolvedValue([
      { name: 'logs', kind: 'directory', size: 4_096, modifiedAt: '2023-11-14T22:13:20.000Z', mode: 0o755, uid: 1000, gid: 1000 },
      { name: 'report.txt', kind: 'file', size: 4 },
    ])
    registerFileTransferHandlers({ listDirectory, uploadFile: vi.fn(), downloadFile: vi.fn() }, sender as never)

    const result = await handlerFor('file-transfer:list')(trustedEvent(sender), {
      sessionId: 'session-1', remotePath: '/tmp',
    })
    expect(result).toEqual({
      sessionId: 'session-1',
      remotePath: '/tmp',
      entries: expect.arrayContaining([
        expect.objectContaining({ name: 'logs', kind: 'directory' }),
        expect.objectContaining({ name: 'report.txt', kind: 'file' }),
      ]),
    })
    expect(listDirectory).toHaveBeenCalledWith('session-1', '/tmp')
    expect(sender.send).not.toHaveBeenCalled()
  })

  it('starts local browsing at a stable home directory and permits an explicitly selected directory', async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), 'terminal-agent-local-browser-home-'))
    const selectedDirectory = await mkdtemp(join(tmpdir(), 'terminal-agent-local-browser-selected-'))
    await mkdir(join(homeDirectory, 'nested'))
    await writeFile(join(homeDirectory, 'report.txt'), 'data', 'utf8')
    await writeFile(join(selectedDirectory, 'external.txt'), 'data', 'utf8')
    const sender = createSender()
    const selectLocalDirectory = vi.fn().mockResolvedValue({ canceled: false, filePath: selectedDirectory })
    registerFileTransferHandlers({ uploadFile: vi.fn(), downloadFile: vi.fn() }, sender as never, {
      localHomeDirectory: homeDirectory,
      selectLocalDirectory,
    })

    try {
      const home = await handlerFor('file-transfer:list-local')(trustedEvent(sender), {})
      expect(home).toMatchObject({
        entries: expect.arrayContaining([
          expect.objectContaining({ name: 'nested', kind: 'directory' }),
          expect.objectContaining({ name: 'report.txt', kind: 'file', size: 4 }),
        ]),
      })

      const selected = await handlerFor('file-transfer:select-local-directory')(trustedEvent(sender))
      expect(selected).toMatchObject({ canceled: false, localPath: expect.any(String) })
      expect(selectLocalDirectory).toHaveBeenCalledOnce()

      const external = await handlerFor('file-transfer:list-local')(trustedEvent(sender), { localPath: (selected as { localPath: string }).localPath })
      expect(external).toMatchObject({ entries: [expect.objectContaining({ name: 'external.txt', kind: 'file' })] })

      const outsideDirectory = await mkdtemp(join(tmpdir(), 'terminal-agent-local-browser-outside-'))
      try {
        await expect(handlerFor('file-transfer:list-local')(trustedEvent(sender), { localPath: outsideDirectory })).rejects.toThrow('请先选择本地目录后重试。')
      } finally {
        await rm(outsideDirectory, { recursive: true, force: true })
      }
    } finally {
      await rm(homeDirectory, { recursive: true, force: true })
      await rm(selectedDirectory, { recursive: true, force: true })
    }
  })

  it('keeps local rename/delete inside an authorized directory and rejects traversal-like names', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-local-mutate-'))
    const sourcePath = join(directory, 'draft.txt')
    const nestedDirectory = join(directory, 'obsolete')
    await writeFile(sourcePath, 'data', 'utf8')
    await mkdir(nestedDirectory)
    await writeFile(join(nestedDirectory, 'nested.txt'), 'data', 'utf8')
    const sender = createSender()
    registerFileTransferHandlers({ uploadFile: vi.fn(), downloadFile: vi.fn() }, sender as never, { localHomeDirectory: directory })

    try {
      await expect(handlerFor('file-transfer:rename-local')(trustedEvent(sender), {
        directory, name: 'draft.txt', newName: 'renamed.txt',
      })).resolves.toMatchObject({ name: 'draft.txt', newName: 'renamed.txt' })
      await expect(lstat(join(directory, 'renamed.txt'))).resolves.toMatchObject({ isFile: expect.any(Function) })

      await expect(handlerFor('file-transfer:delete-local')(trustedEvent(sender), {
        directory, name: 'obsolete', kind: 'directory',
      })).resolves.toMatchObject({ name: 'obsolete' })
      await expect(lstat(nestedDirectory)).rejects.toThrow()

      await expect(handlerFor('file-transfer:rename-local')(trustedEvent(sender), {
        directory, name: 'renamed.txt', newName: '../escape.txt',
      })).rejects.toThrow('本地重命名请求无效。')
      await expect(handlerFor('file-transfer:delete-local')(trustedEvent(sender), {
        directory, name: '..', kind: 'directory',
      })).rejects.toThrow('本地删除请求无效。')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('renames and recursively deletes only validated remote entries', async () => {
    const sender = createSender()
    const listDirectory = vi.fn(async (_sessionId: string, path: string) => {
      if (path === '/srv') return [
        { name: 'old.txt', kind: 'file' as const, size: 4 },
        { name: 'folder', kind: 'directory' as const, size: 0 },
      ]
      if (path === '/srv/folder') return [
        { name: 'child.txt', kind: 'file' as const, size: 4 },
        { name: 'empty', kind: 'directory' as const, size: 0 },
      ]
      if (path === '/srv/folder/empty') return []
      return []
    })
    const rename = vi.fn()
    const removeFile = vi.fn()
    const removeDirectory = vi.fn()
    registerFileTransferHandlers({ listDirectory, rename, removeFile, removeDirectory, uploadFile: vi.fn(), downloadFile: vi.fn() }, sender as never)

    await expect(handlerFor('file-transfer:rename-remote')(trustedEvent(sender), {
      sessionId: 'session-1', directory: '/srv', name: 'old.txt', newName: 'renamed.txt',
    })).resolves.toMatchObject({ name: 'old.txt', newName: 'renamed.txt' })
    expect(rename).toHaveBeenCalledWith('session-1', '/srv/old.txt', '/srv/renamed.txt')

    await expect(handlerFor('file-transfer:delete-remote')(trustedEvent(sender), {
      sessionId: 'session-1', directory: '/srv', name: 'folder', kind: 'directory',
    })).resolves.toMatchObject({ name: 'folder' })
    expect(removeFile).toHaveBeenCalledWith('session-1', '/srv/folder/child.txt')
    expect(removeDirectory.mock.calls).toEqual([
      ['session-1', '/srv/folder/empty'],
      ['session-1', '/srv/folder'],
    ])

    await expect(handlerFor('file-transfer:delete-remote')(trustedEvent(sender), {
      sessionId: 'session-1', directory: '/srv/../etc', name: 'passwd', kind: 'file',
    })).rejects.toThrow('远程删除请求无效。')
    expect(removeFile).toHaveBeenCalledTimes(1)
  })

  it('uploads an authorized directory recursively, preserves empty directories, and reports aggregate progress', async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), 'terminal-agent-directory-upload-parent-'))
    const localRoot = join(parentDirectory, 'bundle')
    const nestedDirectory = join(localRoot, 'nested')
    const emptyDirectory = join(localRoot, 'empty')
    await mkdir(nestedDirectory, { recursive: true })
    await mkdir(emptyDirectory)
    await writeFile(join(localRoot, 'root.txt'), 'root', 'utf8')
    await writeFile(join(nestedDirectory, 'child.txt'), 'child', 'utf8')
    const sender = createSender()
    const ensureDirectory = vi.fn().mockResolvedValue(undefined)
    const uploadFile = vi.fn(async (_sessionId: string, localPath: string, _remotePath: string, onProgress: (value: { transferredBytes: number; totalBytes?: number }) => void) => {
      const size = (await lstat(localPath)).size
      onProgress({ transferredBytes: size, totalBytes: size })
      return size
    })
    registerFileTransferHandlers({ ensureDirectory, uploadFile, downloadFile: vi.fn() }, sender as never, {
      localHomeDirectory: parentDirectory,
    })

    try {
      const result = await handlerFor('file-transfer:upload-directory')(trustedEvent(sender), {
        sessionId: 'session-1', remotePath: '/incoming', localPath: localRoot,
        transferId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      })
      expect(result).toMatchObject({ status: 'completed', fileName: 'bundle', transferredBytes: 9 })
      expect(ensureDirectory.mock.calls).toEqual([
        ['session-1', '/incoming/bundle'],
        ['session-1', '/incoming/bundle/empty'],
        ['session-1', '/incoming/bundle/nested'],
      ])
      expect(uploadFile.mock.calls.map(([, , remotePath]) => remotePath)).toEqual([
        '/incoming/bundle/nested/child.txt',
        '/incoming/bundle/root.txt',
      ])
      const progress = sender.send.mock.calls.filter(([channel]) => channel === 'file-transfer:progress').map(([, payload]) => payload)
      expect(progress.at(-1)).toMatchObject({ phase: 'completed', transferredBytes: 9, totalBytes: 9 })
    } finally {
      await rm(parentDirectory, { recursive: true, force: true })
    }
  })

  it('cancels an active directory upload before the next item starts', async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), 'terminal-agent-directory-upload-cancel-'))
    const localRoot = join(parentDirectory, 'bundle')
    await mkdir(localRoot)
    await writeFile(join(localRoot, 'first.txt'), 'first', 'utf8')
    await writeFile(join(localRoot, 'second.txt'), 'second', 'utf8')
    const sender = createSender()
    let startFirstUpload!: () => void
    const firstUploadStarted = new Promise<void>(resolve => { startFirstUpload = resolve })
    const uploadFile = vi.fn((_sessionId: string, _localPath: string, _remotePath: string, _onProgress: unknown, signal?: AbortSignal) => new Promise<number>((_resolve, reject) => {
      startFirstUpload()
      signal?.addEventListener('abort', () => {
        const error = new Error('已取消')
        error.name = 'AbortError'
        reject(error)
      }, { once: true })
    }))
    registerFileTransferHandlers({ ensureDirectory: vi.fn(), uploadFile, downloadFile: vi.fn() }, sender as never, {
      localHomeDirectory: parentDirectory,
    })

    try {
      const transfer = handlerFor('file-transfer:upload-directory')(trustedEvent(sender), {
        sessionId: 'session-1', remotePath: '/incoming', localPath: localRoot,
        transferId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      }) as Promise<unknown>
      await firstUploadStarted
      await expect(handlerFor('file-transfer:cancel')(trustedEvent(sender), {
        sessionId: 'session-1', transferId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      })).resolves.toEqual({ sessionId: 'session-1', transferId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', canceled: true })
      await expect(transfer).resolves.toMatchObject({ status: 'canceled' })
      expect(uploadFile).toHaveBeenCalledOnce()
    } finally {
      await rm(parentDirectory, { recursive: true, force: true })
    }
  })

  it('returns the session-controlled SFTP working directory without a terminal command', async () => {
    const sender = createSender()
    const getWorkingDirectory = vi.fn().mockResolvedValue('/home/ops')
    registerFileTransferHandlers({ getWorkingDirectory, uploadFile: vi.fn(), downloadFile: vi.fn() }, sender as never)

    await expect(handlerFor('file-transfer:working-directory')(trustedEvent(sender), { sessionId: 'session-1' })).resolves.toEqual({
      sessionId: 'session-1', remotePath: '/home/ops',
    })
    expect(getWorkingDirectory).toHaveBeenCalledWith('session-1')
  })

  it('uses authorized explicit local paths without opening dialogs or recording their absolute paths', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-explicit-local-transfer-'))
    const uploadPath = join(directory, 'upload.txt')
    const downloadDirectory = join(directory, 'downloads')
    await writeFile(uploadPath, 'data', 'utf8')
    await mkdir(downloadDirectory)
    const sender = createSender()
    const selectUploadFile = vi.fn()
    const selectDownloadPath = vi.fn()
    const history = { recordFileTransfer: vi.fn() }
    const uploadFile = vi.fn().mockResolvedValue(4)
    const downloadFile = vi.fn().mockResolvedValue(4)
    registerFileTransferHandlers({ uploadFile, downloadFile }, sender as never, {
      localHomeDirectory: directory,
      selectUploadFile,
      selectDownloadPath,
      history,
    })

    try {
      await handlerFor('file-transfer:upload')(trustedEvent(sender), {
        sessionId: 'session-explicit-upload', remotePath: '/srv/upload.txt', localPath: uploadPath,
      })
      await handlerFor('file-transfer:download')(trustedEvent(sender), {
        sessionId: 'session-explicit-download', remotePath: '/srv/download.txt', localPath: downloadDirectory,
      })

      expect(uploadFile).toHaveBeenCalledWith('session-explicit-upload', uploadPath, '/srv/upload.txt', expect.any(Function))
      expect(downloadFile).toHaveBeenCalledWith('session-explicit-download', '/srv/download.txt', join(downloadDirectory, 'download.txt'), expect.any(Function))
      expect(selectUploadFile).not.toHaveBeenCalled()
      expect(selectDownloadPath).not.toHaveBeenCalled()
      expect(JSON.stringify(history.recordFileTransfer.mock.calls)).not.toContain(directory)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('keeps native file selection in the main process and reports upload progress', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-transfer-'))
    const localPath = join(directory, 'report.txt')
    await writeFile(localPath, 'data', 'utf8')
    const sender = createSender()
    const uploadFile = vi.fn(async (_sessionId: string, _local: string, _remote: string, onProgress: (value: { transferredBytes: number; totalBytes: number }) => void) => {
      onProgress({ transferredBytes: 4, totalBytes: 4 })
      return 4
    })
    const dispose = registerFileTransferHandlers({ uploadFile, downloadFile: vi.fn() }, sender as never, {
      selectUploadFile: vi.fn().mockResolvedValue({ canceled: false, filePath: localPath }),
    })

    try {
      const result = await handlerFor('file-transfer:upload')(trustedEvent(sender), {
        sessionId: 'session-1', remotePath: '/tmp/report.txt', transferId: '11111111-1111-4111-8111-111111111111',
      })
      expect(result).toEqual({
        transferId: '11111111-1111-4111-8111-111111111111', sessionId: 'session-1', direction: 'upload', status: 'completed', transferredBytes: 4, fileName: 'report.txt',
      })
      expect(uploadFile).toHaveBeenCalledWith('session-1', localPath, '/tmp/report.txt', expect.any(Function))
      expect(sender.send.mock.calls.map(([channel, payload]) => [channel, payload.phase])).toEqual([
        ['file-transfer:progress', 'selecting'],
        ['file-transfer:progress', 'transferring'],
        ['file-transfer:progress', 'transferring'],
        ['file-transfer:progress', 'completed'],
      ])
    } finally {
      dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('appends the selected basename when upload target denotes a remote directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-transfer-directory-'))
    const localPath = join(directory, 'release package.txt')
    await writeFile(localPath, 'data', 'utf8')
    const sender = createSender()
    const uploadFile = vi.fn().mockResolvedValue(4)
    registerFileTransferHandlers({ uploadFile, downloadFile: vi.fn() }, sender as never, {
      selectUploadFile: vi.fn().mockResolvedValue({ canceled: false, filePath: localPath }),
    })

    try {
      await handlerFor('file-transfer:upload')(trustedEvent(sender), {
        sessionId: 'session-1', remotePath: '/tmp/incoming/',
      })
      expect(uploadFile).toHaveBeenCalledWith('session-1', localPath, '/tmp/incoming/release package.txt', expect.any(Function))
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('returns a typed canceled result when the user closes the save dialog', async () => {
    const sender = createSender()
    const downloadFile = vi.fn()
    registerFileTransferHandlers({ uploadFile: vi.fn(), downloadFile }, sender as never, {
      selectDownloadPath: vi.fn().mockResolvedValue({ canceled: true }),
    })

    const result = await handlerFor('file-transfer:download')(trustedEvent(sender), {
      sessionId: 'session-1', remotePath: '/tmp/archive.zip',
    })
    expect(result).toMatchObject({ sessionId: 'session-1', direction: 'download', status: 'canceled', transferredBytes: 0 })
    expect(downloadFile).not.toHaveBeenCalled()
    expect(sender.send.mock.calls.at(-1)?.[1]).toMatchObject({ phase: 'canceled' })
  })

  it('records completed, canceled, and failed transfers without exposing a local path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-transfer-history-'))
    const localPath = join(directory, 'release.zip')
    await writeFile(localPath, 'data', 'utf8')
    const sender = createSender()
    const history = { recordFileTransfer: vi.fn() }
    const uploadFile = vi.fn(async (sessionId: string) => {
      if (sessionId === 'session-failed') throw new Error('connection lost')
      return 4
    })
    registerFileTransferHandlers({ uploadFile, downloadFile: vi.fn() }, sender as never, {
      history,
      now: () => new Date('2026-09-07T10:00:00.000Z'),
      selectUploadFile: vi.fn().mockResolvedValue({ canceled: false, filePath: localPath }),
      selectDownloadPath: vi.fn().mockResolvedValue({ canceled: true }),
    })

    try {
      await handlerFor('file-transfer:upload')(trustedEvent(sender), {
        sessionId: 'session-completed', remotePath: '/srv/releases/', transferId: '11111111-1111-4111-8111-111111111111',
      })
      await handlerFor('file-transfer:download')(trustedEvent(sender), {
        sessionId: 'session-canceled', remotePath: '/srv/releases/archive.zip', transferId: '22222222-2222-4222-8222-222222222222',
      })
      await expect(handlerFor('file-transfer:upload')(trustedEvent(sender), {
        sessionId: 'session-failed', remotePath: '/srv/releases/failure.zip', transferId: '33333333-3333-4333-8333-333333333333',
      })).rejects.toThrow('文件上传失败，请检查 SSH 连接和远程路径。')

      expect(history.recordFileTransfer).toHaveBeenCalledTimes(3)
      expect(history.recordFileTransfer).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'session-completed', id: '11111111-1111-4111-8111-111111111111', direction: 'upload', status: 'completed',
        fileName: 'release.zip', remotePath: '/srv/releases/release.zip', transferredBytes: 4,
      }))
      expect(history.recordFileTransfer).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'session-canceled', id: '22222222-2222-4222-8222-222222222222', direction: 'download', status: 'canceled', transferredBytes: 0,
      }))
      expect(history.recordFileTransfer).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'session-failed', id: '33333333-3333-4333-8333-333333333333', direction: 'upload', status: 'failed', transferredBytes: 0,
      }))
      expect(JSON.stringify(history.recordFileTransfer.mock.calls)).not.toContain(localPath)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('waits for a best-effort transfer audit before settling the IPC result', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-transfer-history-tail-'))
    const localPath = join(directory, 'tail.txt')
    await writeFile(localPath, 'data', 'utf8')
    const persisted = deferred<void>()
    const history = { recordFileTransfer: vi.fn(() => persisted.promise) }
    const sender = createSender()
    registerFileTransferHandlers({ uploadFile: vi.fn().mockResolvedValue(4), downloadFile: vi.fn() }, sender as never, {
      history,
      selectUploadFile: vi.fn().mockResolvedValue({ canceled: false, filePath: localPath }),
    })

    try {
      const transfer = handlerFor('file-transfer:upload')(trustedEvent(sender), {
        sessionId: 'session-history-tail', remotePath: '/srv/tail.txt', transferId: '44444444-4444-4444-8444-444444444444',
      }) as Promise<unknown>
      await vi.waitFor(() => expect(history.recordFileTransfer).toHaveBeenCalledOnce())

      let settled = false
      void transfer.then(() => { settled = true })
      await Promise.resolve()
      expect(settled).toBe(false)

      persisted.resolve()
      await expect(transfer).resolves.toMatchObject({ status: 'completed', fileName: 'tail.txt' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('still settles the transfer when a progress notification cannot reach the renderer', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-transfer-renderer-'))
    const localPath = join(directory, 'report.txt')
    await writeFile(localPath, 'data', 'utf8')
    const sender = createSender()
    sender.send.mockImplementation(() => { throw new Error('renderer gone') })
    const uploadFile = vi.fn().mockResolvedValue(4)
    registerFileTransferHandlers({ uploadFile, downloadFile: vi.fn() }, sender as never, {
      selectUploadFile: vi.fn().mockResolvedValue({ canceled: false, filePath: localPath }),
    })

    try {
      await expect(handlerFor('file-transfer:upload')(trustedEvent(sender), {
        sessionId: 'session-1', remotePath: '/tmp/report.txt',
      })).resolves.toMatchObject({ status: 'completed', transferredBytes: 4 })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects untrusted renderers before opening a dialog or invoking a session', async () => {
    const sender = createSender()
    const selectUploadFile = vi.fn()
    const uploadFile = vi.fn()
    registerFileTransferHandlers({ uploadFile, downloadFile: vi.fn() }, sender as never, { selectUploadFile })

    await expect(handlerFor('file-transfer:upload')({ sender: createSender() }, {
      sessionId: 'session-1', remotePath: '/tmp/report.txt',
    })).rejects.toThrow('Untrusted renderer')
    expect(selectUploadFile).not.toHaveBeenCalled()
    expect(uploadFile).not.toHaveBeenCalled()
  })

  it('rejects an untrusted directory listing before invoking the session', async () => {
    const sender = createSender()
    const listDirectory = vi.fn()
    registerFileTransferHandlers({ listDirectory, uploadFile: vi.fn(), downloadFile: vi.fn() }, sender as never)

    await expect(handlerFor('file-transfer:list')({ sender: createSender() }, {
      sessionId: 'session-1', remotePath: '/tmp',
    })).rejects.toThrow('Untrusted renderer')
    expect(listDirectory).not.toHaveBeenCalled()
  })

  it('removes all transfer handlers on dispose', () => {
    const dispose = registerFileTransferHandlers({ uploadFile: vi.fn(), downloadFile: vi.fn() }, createSender() as never)
    dispose()
    dispose()
    expect(removeHandler.mock.calls.map(([channel]) => channel)).toEqual([
      'file-transfer:list',
      'file-transfer:working-directory',
      'file-transfer:select-local-directory',
      'file-transfer:list-local',
      'file-transfer:rename-local',
      'file-transfer:delete-local',
      'file-transfer:rename-remote',
      'file-transfer:delete-remote',
      'file-transfer:upload',
      'file-transfer:upload-all',
      'file-transfer:upload-directory',
      'file-transfer:cancel',
      'file-transfer:download',
    ])
  })
})

function handlerFor(channel: string): (...args: unknown[]) => unknown {
  const match = handle.mock.calls.find(([registeredChannel]) => registeredChannel === channel)
  if (!match) throw new Error(`Missing handler: ${channel}`)
  return match[1] as (...args: unknown[]) => unknown
}

function createSender() {
  return { send: vi.fn(), isDestroyed: vi.fn(() => false) }
}

function trustedEvent(sender: ReturnType<typeof createSender>) {
  return { sender }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(currentResolve => { resolve = currentResolve })
  return { promise, resolve }
}
