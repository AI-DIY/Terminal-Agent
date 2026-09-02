import { Client } from 'ssh2'
import type { ClientChannel, FileEntryWithStats, SFTPWrapper, TransferOptions } from 'ssh2'
import { StringDecoder } from 'node:string_decoder'
import { isIP } from 'node:net'
import { stat } from 'node:fs/promises'
import { FILE_TRANSFER_MAX_DIRECTORY_ENTRIES } from '../../shared/file-transfer-contracts'
import type { SshClientPort, SshConnectOptions, SshConnection, SshDirectoryEntry, SshShell } from './ssh-client-port'
import type { SshFileTransferProgress } from './ssh-client-port'

// A server that does not implement the SFTP subsystem can otherwise leave an
// invoke promise pending forever.  Bound both channel setup and operations so
// the renderer receives a normal rejection instead of Electron's
// "reply was never sent" diagnostic.
const SFTP_OPERATION_TIMEOUT_MS = 30_000

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
        listDirectory: remotePath => listDirectory(client, remotePath),
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
    const timeout = setTimeout(() => finish(new Error('SFTP 操作超时，请检查远程服务是否启用 SFTP。')), SFTP_OPERATION_TIMEOUT_MS)
    const finish = (error?: Error | null): void => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
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
      try {
        onProgress?.({ transferredBytes: lastTransferred, ...(totalBytes === undefined ? {} : { totalBytes }) })
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    }
    const options: TransferOptions = { step }
    const callback = (error?: Error | null): void => finish(error)
    const onSftpError = (error: unknown): void => finish(error instanceof Error ? error : new Error(String(error)))
    const onSftpClose = (): void => {
      if (!settled) finish(new Error('SFTP channel closed before transfer completed'))
    }
    listenSftpEvent(sftp, 'error', onSftpError)
    listenSftpEvent(sftp, 'close', onSftpClose)
    timeout.unref?.()
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
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error('SFTP 通道建立超时，请检查远程服务是否启用 SFTP。'))
    }, SFTP_OPERATION_TIMEOUT_MS)
    timeout.unref?.()
    const finish = (error?: Error, sftp?: SFTPWrapper): void => {
      if (settled) {
        if (sftp) {
          try { sftp.end() } catch { /* The late channel is already closed. */ }
        }
        return
      }
      settled = true
      clearTimeout(timeout)
      if (error) reject(error)
      else if (!sftp) reject(new Error('SSH server returned no SFTP channel'))
      else resolve(sftp)
    }
    try {
      client.sftp((error, sftp) => {
        if (error) {
          finish(error)
          return
        }
        finish(undefined, sftp)
      })
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

async function listDirectory(client: Client, remotePath: string): Promise<readonly SshDirectoryEntry[]> {
  const sftp = await openSftp(client)
  return await new Promise<readonly SshDirectoryEntry[]>((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => finish(new Error('SFTP 目录读取超时，请检查远程服务是否启用 SFTP。')), SFTP_OPERATION_TIMEOUT_MS)
    const finish = (error?: Error, entries?: readonly SshDirectoryEntry[]): void => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      try { sftp.end() } catch { /* The channel may already be closed. */ }
      if (error) reject(error)
      else resolve(entries ?? [])
    }

    const onError = (error: unknown): void => finish(error instanceof Error ? error : new Error(String(error)))
    const onClose = (): void => {
      if (!settled) finish(new Error('SFTP channel closed before directory listing completed'))
    }
    listenSftpEvent(sftp, 'error', onError)
    listenSftpEvent(sftp, 'close', onClose)
    timeout.unref?.()
    try {
      sftp.readdir(remotePath, (error, entries) => {
        if (error) {
          finish(error)
          return
        }
        if (!entries) {
          finish(new Error('SFTP server returned no directory listing'))
          return
        }
        if (entries.length > FILE_TRANSFER_MAX_DIRECTORY_ENTRIES) {
          finish(new Error('远程目录条目过多，请缩小目录范围后重试。'))
          return
        }
        try {
          finish(undefined, entries.map(toDirectoryEntry).filter((entry): entry is SshDirectoryEntry => entry !== undefined))
        } catch (conversionError) {
          finish(conversionError instanceof Error ? conversionError : new Error(String(conversionError)))
        }
      })
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

function toDirectoryEntry(entry: FileEntryWithStats): SshDirectoryEntry | undefined {
  const name = typeof entry.filename === 'string' ? entry.filename : ''
  if (!name || !name.trim() || name === '.' || name === '..' || name.length > 255 || /[\\/]/.test(name) || containsControlCharacters(name)) {
    return undefined
  }
  const attrs = entry.attrs
  const kind = isAttrKind(attrs, 'directory')
    ? 'directory'
    : isAttrKind(attrs, 'file')
      ? 'file'
      : isAttrKind(attrs, 'symlink')
        ? 'symlink'
        : 'other'
  const size = finiteNonNegativeInteger(attrs.size) ?? 0
  const modifiedAt = toIsoTimestamp(attrs.mtime)
  const mode = finiteNonNegativeInteger(attrs.mode)
  const uid = finiteNonNegativeInteger(attrs.uid)
  const gid = finiteNonNegativeInteger(attrs.gid)
  return {
    name,
    kind,
    size,
    ...(modifiedAt ? { modifiedAt } : {}),
    ...(mode === undefined ? {} : { mode: mode & 0o7777 }),
    ...(uid === undefined ? {} : { uid }),
    ...(gid === undefined ? {} : { gid }),
  }
}

function isAttrKind(attrs: FileEntryWithStats['attrs'], kind: 'directory' | 'file' | 'symlink'): boolean {
  const method = kind === 'directory' ? attrs.isDirectory : kind === 'file' ? attrs.isFile : attrs.isSymbolicLink
  return typeof method === 'function' ? method.call(attrs) : false
}

function listenSftpEvent(
  sftp: SFTPWrapper,
  event: 'error' | 'close',
  listener: (...args: unknown[]) => void,
): void {
  const candidate = sftp as SFTPWrapper & { once?: (name: string, callback: (...args: unknown[]) => void) => unknown }
  if (typeof candidate.once === 'function') candidate.once(event, listener)
}

function finiteNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function toIsoTimestamp(value: unknown): string | undefined {
  const seconds = typeof value === 'number' && Number.isFinite(value) ? value : undefined
  if (seconds === undefined) return undefined
  const milliseconds = seconds * 1_000
  if (!Number.isFinite(milliseconds)) return undefined
  const date = new Date(milliseconds)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

function containsControlCharacters(value: string): boolean {
  return [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
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
