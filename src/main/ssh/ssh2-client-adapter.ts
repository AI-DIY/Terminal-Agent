import { Client } from 'ssh2'
import type { ClientChannel } from 'ssh2'
import { StringDecoder } from 'node:string_decoder'
import { isIP } from 'node:net'
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
      ...(isIP(options.host) ? { remoteAddress: options.host.toLowerCase() } : {}),
      openShell: async (columns, rows) => adaptShell(await openShell(client, columns, rows)),
      execute: (command, maxOutputBytes) => executeCommand(client, command, maxOutputBytes),
      close: () => client.end(),
    }
  }
}

function executeCommand(client: Client, command: string, maxOutputBytes = 256 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) {
      reject(new Error('SSH command output limit is invalid'))
      return
    }
    client.exec(command, (error, channel) => {
      if (error) {
        reject(error)
        return
      }

      const decoder = new StringDecoder('utf8')
      let output = ''
      let outputBytes = 0
      let settled = false
      const fail = (reason: unknown) => {
        if (settled) return
        settled = true
        reject(reason instanceof Error ? reason : new Error(String(reason)))
      }

      channel.on('data', (data: Buffer) => {
        outputBytes += data.length
        if (outputBytes > maxOutputBytes) {
          fail(new Error('SSH command output exceeded limit'))
          channel.close()
          return
        }
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
