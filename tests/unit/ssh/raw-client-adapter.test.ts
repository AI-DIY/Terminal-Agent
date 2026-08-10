import { once } from 'node:events'
import { createServer, Socket, type AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { RawClientAdapter } from '../../../src/main/ssh/raw-client-adapter'

describe('RawClientAdapter', () => {
  it('maps a local TCP stream into the terminal transport boundary', async () => {
    const server = createServer(socket => {
      socket.on('data', data => socket.write(`echo:${data.toString('utf8')}`))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')

    const connection = await new RawClientAdapter().connect({ host: '127.0.0.1', port: (server.address() as AddressInfo).port })
    const shell = await connection.openShell(80, 24)
    const output = new Promise<Buffer>(resolve => shell.onData(resolve))
    shell.write('ping')

    await expect(output).resolves.toEqual(Buffer.from('echo:ping'))
    shell.close()
    connection.close()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })

  it('keeps an error listener after a successful socket connection', async () => {
    const server = createServer()
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')

    let closeConnection: (() => void) | undefined
    try {
      const socket = new Socket()
      const connection = await new RawClientAdapter(() => socket).connect({
        host: '127.0.0.1',
        port: (server.address() as AddressInfo).port,
      })
      closeConnection = connection.close

      expect(() => socket.emit('error', new Error('connection reset after ready'))).not.toThrow()
    } finally {
      closeConnection?.()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })
})
