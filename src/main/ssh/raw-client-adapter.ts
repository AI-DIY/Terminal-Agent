import { Socket } from 'node:net'
import type { SshClientPort, SshConnection, SshConnectOptions, SshShell } from './ssh-client-port'

export class RawClientAdapter implements SshClientPort {
  constructor(private readonly createSocket: () => Socket = () => new Socket()) {}

  async connect(options: SshConnectOptions): Promise<SshConnection> {
    const socket = await connectSocket(options.host, options.port, this.createSocket)
    const shell = new RawShell(socket)
    return {
      openShell: async () => shell,
      close: () => shell.close(),
    }
  }
}

class RawShell implements SshShell {
  constructor(private readonly socket: Socket) {}

  write(data: string): void {
    this.socket.write(data)
  }

  resize(): void {
    // Raw TCP has no PTY window-size negotiation.
  }

  close(): void {
    if (!this.socket.destroyed) this.socket.end()
  }

  onData(listener: (data: Buffer) => void): void {
    this.socket.on('data', listener)
  }

  onClose(listener: () => void): void {
    this.socket.once('close', listener)
  }
}

function connectSocket(host: string, port: number, createSocket: () => Socket): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createSocket()
    const onError = (error: Error) => reject(error)
    socket.once('error', onError)
    socket.connect(port, host, () => {
      socket.removeListener('error', onError)
      socket.on('error', () => undefined)
      resolve(socket)
    })
  })
}
