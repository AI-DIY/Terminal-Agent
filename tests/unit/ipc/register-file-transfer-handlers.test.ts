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

  it('removes both transfer handlers on dispose', () => {
    const dispose = registerFileTransferHandlers({ uploadFile: vi.fn(), downloadFile: vi.fn() }, createSender() as never)
    dispose()
    dispose()
    expect(removeHandler.mock.calls.map(([channel]) => channel)).toEqual(['file-transfer:upload', 'file-transfer:download'])
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
