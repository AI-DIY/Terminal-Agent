import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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

  it('removes both transfer handlers on dispose', () => {
    const dispose = registerFileTransferHandlers({ uploadFile: vi.fn(), downloadFile: vi.fn() }, createSender() as never)
    dispose()
    dispose()
    expect(removeHandler.mock.calls.map(([channel]) => channel)).toEqual(['file-transfer:list', 'file-transfer:upload', 'file-transfer:download'])
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
