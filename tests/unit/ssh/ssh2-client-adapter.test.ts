import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Ssh2ClientAdapter } from '../../../src/main/ssh/ssh2-client-adapter'

const { channel, client, clientConstructor, setCommandOutput } = vi.hoisted(() => {
  let dataListener: ((data: Buffer) => void) | undefined
  let commandOutput: Buffer = Buffer.from('api-prod\n')
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
          dataListener?.(commandOutput)
          listener()
        })
      }
      return channel
    }),
    close: vi.fn(),
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
  return { channel, client, clientConstructor, setCommandOutput: (value: Buffer) => { commandOutput = value } }
})

vi.mock('ssh2', () => ({ Client: clientConstructor }))

describe('Ssh2ClientAdapter', () => {
  beforeEach(() => { setCommandOutput(Buffer.from('api-prod\n')); channel.close.mockClear() })

  it('runs observation commands through a non-interactive SSH exec channel', async () => {
    const connection = await new Ssh2ClientAdapter().connect({ host: 'server-a', port: 22, username: 'ops' })

    expect(connection.execute).toBeTypeOf('function')
    await expect(connection.execute!('hostname')).resolves.toBe('api-prod\n')
    expect(client.exec).toHaveBeenCalledWith('hostname', expect.any(Function))
    expect(client.shell).not.toHaveBeenCalled()
  })

  it('exposes only a strict IP-literal target as transport metadata', async () => {
    const ipConnection = await new Ssh2ClientAdapter().connect({ host: '192.0.2.10', port: 22, username: 'ops' })
    const hostnameConnection = await new Ssh2ClientAdapter().connect({ host: 'api.example.invalid', port: 22, username: 'ops' })

    expect(ipConnection.remoteAddress).toBe('192.0.2.10')
    expect(hostnameConnection.remoteAddress).toBeUndefined()
  })

  it('stops buffering an observation response at the requested byte limit', async () => {
    setCommandOutput(Buffer.from('12345'))
    const connection = await new Ssh2ClientAdapter().connect({ host: 'server-a', port: 22, username: 'ops' })

    await expect(connection.execute!('hostname', 4)).rejects.toThrow('output exceeded limit')
    expect(channel.close).toHaveBeenCalledOnce()
  })
})
