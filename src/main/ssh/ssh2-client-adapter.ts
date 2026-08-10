import { Client } from 'ssh2'
import type { ClientChannel } from 'ssh2'
import { StringDecoder } from 'node:string_decoder'
import type { SshClientPort, SshConnectOptions, SshConnection, SshShell } from './ssh-client-port'

export class Ssh2ClientAdapter implements SshClientPort {
  async connect(options: SshConnectOptions): Promise<SshConnection> {
    const client = new Client()

    await new Promise<void>((resolve, reject) => {
      client.once('ready', resolve)
      client.once('error', reject)
      client.connect(options)
    })

    return {
      openShell: async (columns, rows) => adaptShell(await openShell(client, columns, rows)),
      execute: command => executeCommand(client, command),
      close: () => client.end(),
    }
  }
}

function executeCommand(client: Client, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, channel) => {
      if (error) {
        reject(error)
        return
      }

      const decoder = new StringDecoder('utf8')
      let output = ''
      let settled = false
      const fail = (reason: unknown) => {
        if (settled) return
        settled = true
        reject(reason instanceof Error ? reason : new Error(String(reason)))
      }

      channel.on('data', (data: Buffer) => {
        output += decoder.write(data)
      })
      channel.once('error', fail)
      channel.once('close', (code?: number, signal?: string) => {
        if (settled) return
        settled = true
        const tail = decoder.end()
        if (code !== undefined && code !== 0) {
          reject(new Error(`SSH command exited with code ${code}${signal ? ` (${signal})` : ''}`))
          return
        }
        resolve(output + tail)
      })
    })
  })
}

function openShell(client: Client, columns: number, rows: number): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    client.shell({ term: 'xterm-256color', cols: columns, rows }, (error, channel) => {
      if (error) {
        reject(error)
        return
      }
      resolve(channel)
    })
  })
}

function adaptShell(channel: ClientChannel): SshShell {
  return {
    write: data => { channel.write(data) },
    resize: (columns, rows) => { channel.setWindow(rows, columns, 0, 0) },
    close: () => { channel.close() },
    onData: listener => { channel.on('data', listener) },
    onClose: listener => { channel.once('close', listener) },
  }
}
