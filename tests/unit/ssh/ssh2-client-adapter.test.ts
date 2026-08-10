import { describe, expect, it, vi } from 'vitest'
import { Ssh2ClientAdapter } from '../../../src/main/ssh/ssh2-client-adapter'

const { client, clientConstructor } = vi.hoisted(() => {
  let dataListener: ((data: Buffer) => void) | undefined
  const channel = {
    on: vi.fn((event: string, listener: (data?: Buffer) => void) => {
      if (event === 'data') {
        dataListener = listener as (data: Buffer) => void
      }
      return channel
    }),
    once: vi.fn((event: string, listener: (data?: Buffer) => void) => {
      if (event === 'close') {
        queueMicrotask(() => {
          dataListener?.(Buffer.from('api-prod\n'))
          listener()
        })
      }
      return channel
    }),
  }
  let readyListener: (() => void) | undefined
  const client = {
    once: vi.fn((event: string, listener: () => void) => {
      if (event === 'ready') readyListener = listener
      return client
    }),
    connect: vi.fn(() => readyListener?.()),
    exec: vi.fn((_command: string, callback: (error: Error | undefined, result: typeof channel) => void) => callback(undefined, channel)),
    shell: vi.fn(),
    end: vi.fn(),
  }
  const clientConstructor = class {
    constructor() {
      return client
    }
  }
  return { client, clientConstructor }
})

vi.mock('ssh2', () => ({ Client: clientConstructor }))

describe('Ssh2ClientAdapter', () => {
  it('runs observation commands through a non-interactive SSH exec channel', async () => {
    const connection = await new Ssh2ClientAdapter().connect({ host: 'server-a', port: 22, username: 'ops' })

    expect(connection.execute).toBeTypeOf('function')
    await expect(connection.execute!('hostname')).resolves.toBe('api-prod\n')
    expect(client.exec).toHaveBeenCalledWith('hostname', expect.any(Function))
    expect(client.shell).not.toHaveBeenCalled()
  })
})
