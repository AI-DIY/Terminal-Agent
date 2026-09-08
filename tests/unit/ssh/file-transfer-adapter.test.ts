import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SSH_KEEPALIVE_COUNT_MAX, SSH_KEEPALIVE_INTERVAL_MS, Ssh2ClientAdapter } from '../../../src/main/ssh/ssh2-client-adapter'

const state = vi.hoisted(() => {
  const sftp = {
    end: vi.fn(),
    readdir: vi.fn((_remote: string, callback: (error?: Error, entries?: unknown[]) => void) => {
      callback(undefined, [
        {
          filename: 'logs',
          longname: 'drwxr-xr-x 2 ops ops 4096 Jan 1 00:00 logs',
          attrs: {
            mode: 0o40755, uid: 1000, gid: 1000, size: 4096, atime: 0, mtime: 1_700_000_000,
            isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false,
          },
        },
        {
          filename: 'report.txt',
          longname: '-rw-r--r-- 1 ops ops 4 Jan 1 00:00 report.txt',
          attrs: {
            mode: 0o100644, uid: 1000, gid: 1000, size: 4, atime: 0, mtime: 1_700_000_001,
            isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false,
          },
        },
      ])
    }),
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
  const clientListeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const client = {
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      const listeners = clientListeners.get(event) ?? new Set<(...args: unknown[]) => void>()
      listeners.add(listener)
      clientListeners.set(event, listeners)
      return client
    }),
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
  const emitClient = (event: string, ...args: unknown[]): void => {
    for (const listener of [...(clientListeners.get(event) ?? [])]) listener(...args)
  }
  const clearClientListeners = (): void => clientListeners.clear()
  const Client = class {
    constructor() { return client }
  }
  return { client, Client, sftp, emitClient, clearClientListeners }
})

vi.mock('ssh2', () => ({ Client: state.Client }))
vi.mock('node:fs/promises', () => ({ stat: vi.fn(async (path: string) => ({ size: path.includes('archive') ? 7 : 4 })) }))

beforeEach(() => {
  state.clearClientListeners()
  state.client.on.mockClear()
  state.client.once.mockClear()
  state.client.connect.mockClear()
  state.client.sftp.mockClear()
  state.client.end.mockClear()
  state.sftp.end.mockClear()
  state.sftp.fastPut.mockClear()
  state.sftp.fastGet.mockClear()
  state.sftp.readdir.mockClear()
})

describe('Ssh2ClientAdapter SFTP transfer channel', () => {
  it('uploads and downloads over an independent SFTP channel with byte progress', async () => {
    const progress: Array<{ transferredBytes: number; totalBytes?: number }> = []
    const connection = await new Ssh2ClientAdapter().connect({ host: 'server-a', port: 22, username: 'ops' })

    await expect(connection.fileTransfer?.uploadFile('C:/report.txt', '/tmp/report.txt', value => progress.push(value))).resolves.toBe(4)
    await expect(connection.fileTransfer?.downloadFile('/tmp/archive.zip', 'C:/archive.zip', value => progress.push(value))).resolves.toBe(7)

    expect(state.client.sftp).toHaveBeenCalledTimes(2)
    expect(state.client.connect).toHaveBeenLastCalledWith(expect.objectContaining({
      keepaliveInterval: SSH_KEEPALIVE_INTERVAL_MS,
      keepaliveCountMax: SSH_KEEPALIVE_COUNT_MAX,
    }))
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

  it('lists remote directory metadata over a separate SFTP channel', async () => {
    const connection = await new Ssh2ClientAdapter().connect({ host: 'server-a', port: 22, username: 'ops' })

    await expect(connection.fileTransfer?.listDirectory?.('/var/log')).resolves.toEqual([
      {
        name: 'logs', kind: 'directory', size: 4096, modifiedAt: '2023-11-14T22:13:20.000Z', mode: 0o755, uid: 1000, gid: 1000,
      },
      {
        name: 'report.txt', kind: 'file', size: 4, modifiedAt: '2023-11-14T22:13:21.000Z', mode: 0o644, uid: 1000, gid: 1000,
      },
    ])
    expect(state.client.sftp).toHaveBeenCalled()
    expect(state.sftp.readdir).toHaveBeenCalledWith('/var/log', expect.any(Function))
  })

  it('rejects an SFTP setup error without ending the interactive client', async () => {
    state.client.sftp.mockImplementationOnce((callback: (error: Error | null, value: typeof state.sftp) => void) => callback(new Error('subsystem unavailable'), state.sftp))
    const connection = await new Ssh2ClientAdapter().connect({ host: 'server-a', port: 22, username: 'ops' })

    await expect(connection.fileTransfer?.uploadFile('C:/report.txt', '/tmp/report.txt')).rejects.toThrow('subsystem unavailable')
    expect(state.client.end).not.toHaveBeenCalled()
  })

  it('keeps a client error listener after ready and fails active and queued SFTP work on transport loss', async () => {
    let transferStarted!: () => void
    const started = new Promise<void>(resolve => { transferStarted = resolve })
    state.sftp.fastGet.mockImplementationOnce(() => {
      transferStarted()
    })

    const connection = await new Ssh2ClientAdapter().connect({ host: 'server-a', port: 22, username: 'ops' })
    const active = connection.fileTransfer?.downloadFile('/tmp/archive.zip', 'C:/archive.zip')
    await started
    const queued = connection.fileTransfer?.listDirectory?.('/second')

    expect(state.client.on).toHaveBeenCalledWith('error', expect.any(Function))
    expect(() => state.emitClient('error', new Error('connection reset after ready'))).not.toThrow()
    await expect(active).rejects.toThrow('connection reset after ready')
    await expect(queued).rejects.toThrow('connection reset after ready')
    expect(state.client.sftp).toHaveBeenCalledTimes(1)
  })

  it('does not close the whole SSH client when an SFTP channel completes normally', async () => {
    const connection = await new Ssh2ClientAdapter().connect({ host: 'server-a', port: 22, username: 'ops' })
    await expect(connection.fileTransfer?.uploadFile('C:/report.txt', '/tmp/report.txt')).resolves.toBe(4)
    expect(state.client.end).not.toHaveBeenCalled()
    expect(state.sftp.end).toHaveBeenCalledOnce()
  })

  it('returns rejected promises for operations requested after transport close', async () => {
    const connection = await new Ssh2ClientAdapter().connect({ host: 'server-a', port: 22, username: 'ops' })
    connection.close()
    await expect(connection.execute?.('hostname')).rejects.toThrow('SSH connection closed')
    await expect(connection.fileTransfer?.listDirectory?.('/')).rejects.toThrow('SSH connection closed')
  })

  it('rejects instead of leaving the invoke pending when a transfer callback never arrives', async () => {
    vi.useFakeTimers()
    state.sftp.fastGet.mockImplementationOnce(() => undefined)
    try {
      const connection = await new Ssh2ClientAdapter().connect({ host: 'server-a', port: 22, username: 'ops' })
      const pending = connection.fileTransfer?.downloadFile('/tmp/archive.zip', 'C:/archive.zip')
      const rejection = expect(pending).rejects.toThrow('SFTP 操作超时')
      await vi.advanceTimersByTimeAsync(30_000)
      await rejection
    } finally {
      vi.useRealTimers()
    }
  })

  it('treats transfer progress as activity so long-running copies do not time out', async () => {
    vi.useFakeTimers()
    let step: ((total: number, chunk: number, size: number) => void) | undefined
    let complete: (() => void) | undefined
    state.sftp.fastGet.mockImplementationOnce((_remote: string, _local: string, options: { step?: (total: number, chunk: number, size: number) => void }, callback: () => void) => {
      step = options.step
      complete = callback
    })
    try {
      const connection = await new Ssh2ClientAdapter().connect({ host: 'server-a', port: 22, username: 'ops' })
      const pending = connection.fileTransfer?.downloadFile('/tmp/archive.zip', 'C:/archive.zip')
      let settled = false
      void pending?.finally(() => { settled = true })
      await vi.advanceTimersByTimeAsync(29_000)
      step?.(1, 1, 7)
      await vi.advanceTimersByTimeAsync(29_000)
      await Promise.resolve()
      expect(settled).toBe(false)
      complete?.()
      await expect(pending).resolves.toBe(7)
    } finally {
      vi.useRealTimers()
    }
  })

  it('serializes SFTP requests on one SSH transport without blocking the terminal transport', async () => {
    let releaseFirstListing: ((error?: Error, entries?: unknown[]) => void) | undefined
    let markFirstListingStarted!: () => void
    const firstListingStarted = new Promise<void>(resolve => { markFirstListingStarted = resolve })
    state.client.sftp.mockClear()
    state.sftp.readdir.mockClear()
    state.sftp.readdir
      .mockImplementationOnce((_remote: string, callback: (error?: Error, entries?: unknown[]) => void) => {
        releaseFirstListing = callback
        markFirstListingStarted()
      })
      .mockImplementationOnce((_remote: string, callback: (error?: Error, entries?: unknown[]) => void) => {
        callback(undefined, [])
      })

    const connection = await new Ssh2ClientAdapter().connect({ host: 'server-a', port: 22, username: 'ops' })
    const first = connection.fileTransfer?.listDirectory?.('/first')
    const second = connection.fileTransfer?.listDirectory?.('/second')

    await firstListingStarted
    expect(state.client.sftp).toHaveBeenCalledTimes(1)
    expect(state.client.shell).not.toHaveBeenCalled()

    releaseFirstListing?.(undefined, [])
    await expect(first).resolves.toEqual([])
    await expect(second).resolves.toEqual([])
    expect(state.client.sftp).toHaveBeenCalledTimes(2)
  })
})
