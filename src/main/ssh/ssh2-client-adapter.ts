import { Client } from 'ssh2'
import type { ClientChannel, SFTPWrapper, TransferOptions } from 'ssh2'
import { StringDecoder } from 'node:string_decoder'
import { isIP } from 'node:net'
import { stat } from 'node:fs/promises'
import type { SshClientPort, SshConnectOptions, SshConnection, SshShell } from './ssh-client-port'
import type { SshFileTransferProgress } from './ssh-client-port'

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
      // SFTP opens an independent SSH channel.  The PTY channel returned by
      // openShell remains alive while either operation is in progress.
      fileTransfer: {
        uploadFile: (localPath, remotePath, onProgress) => transferFile(client, 'upload', localPath, remotePath, onProgress),
        downloadFile: (remotePath, localPath, onProgress) => transferFile(client, 'download', remotePath, localPath, onProgress),
      },
      close: () => client.end(),
    }
  }
}

type TransferDirection = 'upload' | 'download'

/**
 * Run one ssh2 fastPut/fastGet operation and close only its SFTP channel.
 * The callback is intentionally translated to byte counts before it leaves
 * this adapter; no ssh2 objects or credentials cross the process boundary.
 */
async function transferFile(
  client: Client,
  direction: TransferDirection,
  sourcePath: string,
  targetPath: string,
  onProgress?: (progress: SshFileTransferProgress) => void,
): Promise<number> {
  const uploadSize = direction === 'upload'
    ? await stat(sourcePath).then(result => result.size)
    : undefined
  if (uploadSize !== undefined) onProgress?.({ transferredBytes: 0, totalBytes: uploadSize })
  else onProgress?.({ transferredBytes: 0 })

  const sftp = await openSftp(client)
  let lastTransferred = 0
  let settled = false

  return await new Promise<number>((resolve, reject) => {
    const finish = (error?: Error | null): void => {
      if (settled) return
      settled = true
      try { sftp.end() } catch { /* The channel may already be closed. */ }
      if (error) {
        reject(error)
        return
      }
      // fastGet does not always provide a final step callback.  Reading the
      // resulting local file gives callers an accurate completed byte count.
      if (direction === 'download') {
        void stat(targetPath)
          .then(result => resolve(result.size))
          .catch(() => resolve(lastTransferred))
      } else {
        resolve(uploadSize ?? lastTransferred)
      }
    }
    const step = (total: number, _chunk: number, fileSize: number): void => {
      // ssh2 reports the cumulative transferred amount as `total`; retain a
      // monotonic value even with unusual server implementations.
      lastTransferred = Math.max(lastTransferred, Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0)
      const totalBytes = Number.isFinite(fileSize) && fileSize >= 0 ? Math.floor(fileSize) : undefined
      onProgress?.({ transferredBytes: lastTransferred, ...(totalBytes === undefined ? {} : { totalBytes }) })
    }
    const options: TransferOptions = { step }
    const callback = (error?: Error | null): void => finish(error)
    try {
      if (direction === 'upload') sftp.fastPut(sourcePath, targetPath, options, callback)
      else sftp.fastGet(sourcePath, targetPath, options, callback)
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

function openSftp(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    try {
      client.sftp((error, sftp) => {
        if (error) {
          reject(error)
          return
        }
        resolve(sftp)
      })
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
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
