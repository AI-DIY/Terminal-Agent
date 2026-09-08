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
