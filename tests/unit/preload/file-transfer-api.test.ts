import { describe, expect, it, vi } from 'vitest'
import { createTerminalAgentApi } from '../../../src/preload/api'

function createIpc() {
  return { invoke: vi.fn().mockImplementation(async (channel: string) => {
    if (channel === 'file-transfer:list') {
      return {
        sessionId: 'session-1', remotePath: '/tmp', entries: [{ name: 'report.txt', kind: 'file', size: 4 }],
      }
    }
    if (channel === 'file-transfer:list-local') {
      return {
        localPath: 'C:\\Users\\tester', entries: [{ name: 'report.txt', kind: 'file', size: 4 }],
      }
    }
    if (channel === 'file-transfer:select-local-directory') {
      return { canceled: false, localPath: 'C:\\Users\\tester' }
    }
    if (channel === 'file-transfer:working-directory') {
      return { sessionId: 'session-1', remotePath: '/home/tester' }
    }
    if (channel === 'file-transfer:rename-remote') {
      return { sessionId: 'session-1', directory: '/tmp', name: 'report.txt', newName: 'renamed.txt' }
    }
    if (channel === 'file-transfer:delete-remote') {
      return { sessionId: 'session-1', directory: '/tmp', name: 'report.txt' }
    }
    if (channel === 'file-transfer:rename-local') {
      return { directory: 'C:\\Users\\tester', name: 'report.txt', newName: 'renamed.txt' }
    }
    if (channel === 'file-transfer:delete-local') {
      return { directory: 'C:\\Users\\tester', name: 'report.txt' }
    }
    if (channel === 'file-transfer:cancel') {
      return { sessionId: 'session-1', transferId: '11111111-1111-4111-8111-111111111111', canceled: true }
    }
    return {
      transferId: '11111111-1111-4111-8111-111111111111',
      sessionId: 'session-1', direction: 'upload', status: 'completed', transferredBytes: 4, fileName: 'report.txt',
    }
  }), on: vi.fn(), removeListener: vi.fn() }
}

describe('file transfer preload API', () => {
  it('validates requests/results and routes only the typed transfer channels', async () => {
    const ipc = createIpc()
    const api = createTerminalAgentApi(ipc)

    await expect(api.fileTransfer.upload({
      sessionId: 'session-1', remotePath: '/tmp/report.txt',
      transferId: '11111111-1111-4111-8111-111111111111',
    })).resolves.toMatchObject({ status: 'completed', transferredBytes: 4 })
    expect(ipc.invoke).toHaveBeenCalledWith('file-transfer:upload', {
      sessionId: 'session-1', remotePath: '/tmp/report.txt',
      transferId: '11111111-1111-4111-8111-111111111111',
    })

    await expect(api.fileTransfer.upload({ sessionId: 'session-1', remotePath: '' })).rejects.toThrow()
    expect(ipc.invoke).toHaveBeenCalledTimes(1)
  })

  it('validates and routes remote directory listing requests', async () => {
    const ipc = createIpc()
    const api = createTerminalAgentApi(ipc)

    await expect(api.fileTransfer.list({ sessionId: 'session-1', remotePath: '/tmp' })).resolves.toEqual({
      sessionId: 'session-1', remotePath: '/tmp', entries: [{ name: 'report.txt', kind: 'file', size: 4 }],
    })
    expect(ipc.invoke).toHaveBeenCalledWith('file-transfer:list', { sessionId: 'session-1', remotePath: '/tmp' })
    await expect(api.fileTransfer.list({ sessionId: 'session-1', remotePath: '' })).rejects.toThrow()
    expect(ipc.invoke).toHaveBeenCalledTimes(1)
  })

  it('validates local-browser selection and listing through their dedicated channels', async () => {
    const ipc = createIpc()
    const api = createTerminalAgentApi(ipc)

    await expect(api.fileTransfer.listLocal({})).resolves.toEqual({
      localPath: 'C:\\Users\\tester', entries: [{ name: 'report.txt', kind: 'file', size: 4 }],
    })
    await expect(api.fileTransfer.selectLocalDirectory()).resolves.toEqual({ canceled: false, localPath: 'C:\\Users\\tester' })
    expect(ipc.invoke).toHaveBeenNthCalledWith(1, 'file-transfer:list-local', {})
    expect(ipc.invoke).toHaveBeenNthCalledWith(2, 'file-transfer:select-local-directory')

    await expect(api.fileTransfer.listLocal({ localPath: '' })).rejects.toThrow()
    expect(ipc.invoke).toHaveBeenCalledTimes(2)
  })

  it('validates and routes controlled directory, mutation, working-directory, and cancellation APIs', async () => {
    const ipc = createIpc()
    const api = createTerminalAgentApi(ipc)
    const transferId = '11111111-1111-4111-8111-111111111111'

    await expect(api.fileTransfer.workingDirectory({ sessionId: 'session-1' })).resolves.toEqual({
      sessionId: 'session-1', remotePath: '/home/tester',
    })
    await expect(api.fileTransfer.uploadDirectory({
      sessionId: 'session-1', remotePath: '/tmp', localPath: 'C:\\Users\\tester\\bundle', transferId,
    })).resolves.toMatchObject({ status: 'completed' })
    await expect(api.fileTransfer.renameRemote({
      sessionId: 'session-1', directory: '/tmp', name: 'report.txt', newName: 'renamed.txt',
    })).resolves.toMatchObject({ newName: 'renamed.txt' })
    await expect(api.fileTransfer.deleteRemote({
      sessionId: 'session-1', directory: '/tmp', name: 'report.txt', kind: 'file',
    })).resolves.toMatchObject({ name: 'report.txt' })
    await expect(api.fileTransfer.renameLocal({
      directory: 'C:\\Users\\tester', name: 'report.txt', newName: 'renamed.txt',
    })).resolves.toMatchObject({ newName: 'renamed.txt' })
    await expect(api.fileTransfer.deleteLocal({
      directory: 'C:\\Users\\tester', name: 'report.txt', kind: 'file',
    })).resolves.toMatchObject({ name: 'report.txt' })
    await expect(api.fileTransfer.cancel({ sessionId: 'session-1', transferId })).resolves.toEqual({
      sessionId: 'session-1', transferId, canceled: true,
    })

    await expect(api.fileTransfer.renameLocal({
      directory: 'C:\\Users\\tester', name: 'report.txt', newName: '../escape.txt',
    })).rejects.toThrow()
    expect(ipc.invoke.mock.calls.map(([channel]) => channel)).toEqual([
      'file-transfer:working-directory',
      'file-transfer:upload-directory',
      'file-transfer:rename-remote',
      'file-transfer:delete-remote',
      'file-transfer:rename-local',
      'file-transfer:delete-local',
      'file-transfer:cancel',
    ])
  })

  it('validates inbound progress events and removes the exact listener wrapper', () => {
    const ipc = createIpc()
    const api = createTerminalAgentApi(ipc)
    const listener = vi.fn()
    const unsubscribe = api.fileTransfer.onProgress(listener)
    const wrapper = ipc.on.mock.calls.find(([channel]) => channel === 'file-transfer:progress')?.[1]
    wrapper?.({}, {
      transferId: '11111111-1111-4111-8111-111111111111', sessionId: 'session-1', direction: 'download', phase: 'transferring', transferredBytes: 2,
    })
    expect(listener).toHaveBeenCalledOnce()
    expect(() => wrapper?.({}, { phase: 'transferring' })).toThrow()
    unsubscribe()
    expect(ipc.removeListener).toHaveBeenCalledWith('file-transfer:progress', wrapper)
  })
})
