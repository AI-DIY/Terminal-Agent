import { describe, expect, it, vi } from 'vitest'
import { Ssh2ClientAdapter } from '../../../src/main/ssh/ssh2-client-adapter'

const state = vi.hoisted(() => {
  const sftp = {
    end: vi.fn(),
    fastPut: vi.fn((_local: string, _remote: string, options: { step?: (total: number, chunk: number, size: number) => void }, callback: (error?: Error | null) => void) => {
      options.step?.(4, 4, 4)
      callback()
    }),
    fastGet: vi.fn((_remote: string, _local: string, options: { step?: (total: number, chunk: number, size: number) => void }, callback: (error?: Error | null) => void) => {
      options.step?.(7, 7, 7)
      callback()
    }),
  }
  let ready: (() => void) | undefined
  const client = {
    once: vi.fn((event: string, listener: () => void) => {
      if (event === 'ready') ready = listener
      return client
    }),
    connect: vi.fn(() => ready?.()),
    sftp: vi.fn((callback: (error: Error | null, value: typeof sftp) => void) => callback(null, sftp)),
    exec: vi.fn(),
    shell: vi.fn(),
    end: vi.fn(),
  }
  const Client = class {
    constructor() { return client }
  }
  return { client, Client, sftp }
})

vi.mock('ssh2', () => ({ Client: state.Client }))
vi.mock('node:fs/promises', () => ({ stat: vi.fn(async (path: string) => ({ size: path.includes('archive') ? 7 : 4 })) }))

describe('Ssh2ClientAdapter SFTP transfer channel', () => {
  it('uploads and downloads over an independent SFTP channel with byte progress', async () => {
    const progress: Array<{ transferredBytes: number; totalBytes?: number }> = []
    const connection = await new Ssh2ClientAdapter().connect({ host: 'server-a', port: 22, username: 'ops' })

    await expect(connection.fileTransfer?.uploadFile('C:/report.txt', '/tmp/report.txt', value => progress.push(value))).resolves.toBe(4)
    await expect(connection.fileTransfer?.downloadFile('/tmp/archive.zip', 'C:/archive.zip', value => progress.push(value))).resolves.toBe(7)

    expect(state.client.sftp).toHaveBeenCalledTimes(2)
    expect(state.sftp.fastPut).toHaveBeenCalledWith('C:/report.txt', '/tmp/report.txt', expect.objectContaining({ step: expect.any(Function) }), expect.any(Function))
    expect(state.sftp.fastGet).toHaveBeenCalledWith('/tmp/archive.zip', 'C:/archive.zip', expect.objectContaining({ step: expect.any(Function) }), expect.any(Function))
    expect(state.sftp.end).toHaveBeenCalledTimes(2)
    expect(progress).toEqual([
      { transferredBytes: 0, totalBytes: 4 },
      { transferredBytes: 4, totalBytes: 4 },
      { transferredBytes: 0 },
      { transferredBytes: 7, totalBytes: 7 },
    ])
    expect(state.client.shell).not.toHaveBeenCalled()
  })

  it('rejects an SFTP setup error without ending the interactive client', async () => {
    state.client.sftp.mockImplementationOnce((callback: (error: Error | null, value: typeof state.sftp) => void) => callback(new Error('subsystem unavailable'), state.sftp))
    const connection = await new Ssh2ClientAdapter().connect({ host: 'server-a', port: 22, username: 'ops' })

    await expect(connection.fileTransfer?.uploadFile('C:/report.txt', '/tmp/report.txt')).rejects.toThrow('subsystem unavailable')
    expect(state.client.end).not.toHaveBeenCalled()
  })
})
