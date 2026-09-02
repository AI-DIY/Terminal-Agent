import { describe, expect, it, vi } from 'vitest'
import { createTerminalAgentApi } from '../../../src/preload/api'

function createIpc() {
  return { invoke: vi.fn().mockImplementation(async (channel: string) => channel === 'file-transfer:list'
    ? {
      sessionId: 'session-1', remotePath: '/tmp', entries: [{ name: 'report.txt', kind: 'file', size: 4 }],
    }
    : {
    transferId: '11111111-1111-4111-8111-111111111111',
    sessionId: 'session-1', direction: 'upload', status: 'completed', transferredBytes: 4, fileName: 'report.txt',
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
