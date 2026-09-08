import { Client } from 'ssh2'
import type { ClientChannel, FileEntryWithStats, SFTPWrapper, TransferOptions } from 'ssh2'
import { StringDecoder } from 'node:string_decoder'
import { isIP } from 'node:net'
import { stat } from 'node:fs/promises'
import { FILE_TRANSFER_MAX_DIRECTORY_ENTRIES } from '../../shared/file-transfer-contracts'
import type { SshClientPort, SshConnectOptions, SshConnection, SshDirectoryEntry, SshShell } from './ssh-client-port'
import type { SshFileTransferProgress } from './ssh-client-port'

// A server that does not implement the SFTP subsystem can otherwise leave an
// invoke promise pending forever.  Bound channel setup and idle operations so
// the renderer receives a normal rejection instead of Electron's
// "reply was never sent" diagnostic.  Active transfers reset the idle timer
// whenever ssh2 reports progress, so large but healthy copies can continue.
const SFTP_CHANNEL_TIMEOUT_MS = 30_000
const SFTP_TRANSFER_IDLE_TIMEOUT_MS = 30_000
// Keep the interactive transport alive while a user leaves the file browser
// open.  Some bastion/SFTP proxies close an otherwise idle multiplexed SSH
// connection soon after an auxiliary channel is opened; ssh2's global
// keepalive request is independent from both the PTY and SFTP channels.
export const SSH_KEEPALIVE_INTERVAL_MS = 15_000
export const SSH_KEEPALIVE_COUNT_MAX = 4

type TransportFailureListener = (error: Error) => void

type TransportLifecycle = {
  assertOpen(): void
  fail(reason: unknown): Error
  subscribe(listener: TransportFailureListener): () => void
}

/**
 * Keep transport state separate from ssh2's channels.  A client-level socket
 * failure must reject SFTP work, but it must not become an uncaught
 * EventEmitter error or accidentally close an unrelated SSH client.
 */
function createTransportLifecycle(): TransportLifecycle {
  let failure: Error | undefined
  const listeners = new Set<TransportFailureListener>()
  const normalize = (reason: unknown): Error => reason instanceof Error
    ? reason
    : new Error(reason === undefined ? 'SSH connection failed' : String(reason))

  return {
    assertOpen: () => {
      if (failure) throw failure
    },
    fail: (reason: unknown): Error => {
      const normalized = normalize(reason)
      if (failure) return failure
      failure = normalized
      for (const listener of [...listeners]) {
        try { listener(normalized) } catch { /* One failed waiter must not break transport cleanup. */ }
      }
      listeners.clear()
      return normalized
    },
    subscribe: (listener: TransportFailureListener): (() => void) => {
      if (failure) {
        try { listener(failure) } catch { /* Keep the caller's rejection path isolated. */ }
        return () => undefined
      }
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

type ClientEventListener = (...args: unknown[]) => void
type ClientEventEmitter = {
  on?: (event: string, listener: ClientEventListener) => unknown
  once?: (event: string, listener: ClientEventListener) => unknown
}

function listenClientEvent(client: Client, event: 'error' | 'close' | 'end', listener: ClientEventListener): void {
  const candidate = client as unknown as ClientEventEmitter
  if (typeof candidate.on === 'function') {
    candidate.on(event, listener)
    return
  }
  // Lightweight test/custom clients may only expose once().  Real ssh2
  // clients always expose on(), which keeps the error listener persistent.
  if (typeof candidate.once === 'function') candidate.once(event, listener)
}

export class Ssh2ClientAdapter implements SshClientPort {
  async connect(options: SshConnectOptions): Promise<SshConnection> {
    const client = new Client()
    const transport = createTransportLifecycle()
    let ready = false
    let connectSettled = false

    // ssh2 can emit a client-level error long after the initial ready event.
    // Keep this listener for the entire connection lifetime: EventEmitter
    // treats an error without a listener as an uncaught process exception.
    let rejectConnect: ((error: Error) => void) | undefined
    const onClientError = (error: unknown): void => {
      const failure = transport.fail(error)
      if (!ready && !connectSettled) {
        connectSettled = true
        rejectConnect?.(failure)
      }
    }
    const onClientClose = (): void => {
      const failure = transport.fail(new Error('SSH connection closed'))
      if (!ready && !connectSettled) {
        connectSettled = true
        rejectConnect?.(failure)
      }
    }
    const onClientEnd = (): void => {
      const failure = transport.fail(new Error('SSH connection ended'))
      if (!ready && !connectSettled) {
        connectSettled = true
        rejectConnect?.(failure)
      }
    }
    listenClientEvent(client, 'error', onClientError)
    listenClientEvent(client, 'close', onClientClose)
    listenClientEvent(client, 'end', onClientEnd)

    try {
      await new Promise<void>((resolve, reject) => {
        rejectConnect = reject
        const onReady = (): void => {
          ready = true
          connectSettled = true
          resolve()
        }
        client.once('ready', onReady)
        try {
          client.connect({
            ...options,
            keepaliveInterval: SSH_KEEPALIVE_INTERVAL_MS,
            keepaliveCountMax: SSH_KEEPALIVE_COUNT_MAX,
          })
        } catch (error) {
          const failure = transport.fail(error)
          connectSettled = true
          reject(failure)
        }
      })
    } catch (error) {
      // Avoid leaving a half-open ssh2 client behind when authentication or
      // socket setup fails before the connection becomes usable.
      try { client.end() } catch { /* The client may already be closed. */ }
      throw error
    }

    // A number of enterprise bastions allow an interactive PTY and SFTP but
    // are fragile when multiple SFTP subsystem requests are made at once on
    // the same SSH transport (for example initial listing + a quick refresh).
    // Serialize only SFTP work per connection.  It never serializes terminal
    // input or work on another SSH connection, and every operation still gets
    // its own short-lived SFTP channel.
    let fileTransferTail: Promise<void> = Promise.resolve()
    const queueFileTransfer = <T>(operation: () => Promise<T>): Promise<T> => {
      const run = (): Promise<T> => {
        transport.assertOpen()
        return operation()
      }
      const result = fileTransferTail.then(run, run)
      fileTransferTail = result.then(() => undefined, () => undefined)
      return result
    }

    return {
      ...(isIP(options.host) ? { remoteAddress: options.host.toLowerCase() } : {}),
      openShell: async (columns, rows) => {
        transport.assertOpen()
        return adaptShell(await openShell(client, columns, rows))
      },
      execute: async (command, maxOutputBytes) => {
        transport.assertOpen()
        return executeCommand(client, command, maxOutputBytes)
      },
      // SFTP opens an independent SSH channel.  The PTY channel returned by
      // openShell remains alive while either operation is in progress.
      fileTransfer: {
        listDirectory: remotePath => queueFileTransfer(() => listDirectory(transport, client, remotePath)),
        uploadFile: (localPath, remotePath, onProgress) => queueFileTransfer(() => transferFile(transport, client, 'upload', localPath, remotePath, onProgress)),
        downloadFile: (remotePath, localPath, onProgress) => queueFileTransfer(() => transferFile(transport, client, 'download', remotePath, localPath, onProgress)),
      },
      close: () => {
        transport.fail(new Error('SSH connection closed'))
        client.end()
      },
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
  transport: TransportLifecycle,
  client: Client,
  direction: TransferDirection,
  sourcePath: string,
  targetPath: string,
  onProgress?: (progress: SshFileTransferProgress) => void,
): Promise<number> {
  transport.assertOpen()
  const uploadSize = direction === 'upload'
    ? await stat(sourcePath).then(result => result.size)
    : undefined
  transport.assertOpen()
  if (uploadSize !== undefined) onProgress?.({ transferredBytes: 0, totalBytes: uploadSize })
  else onProgress?.({ transferredBytes: 0 })

  const sftp = await openSftp(transport, client)
  let lastTransferred = 0
  let settled = false

  return await new Promise<number>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined
    let unsubscribeTransport = (): void => undefined
    const finish = (error?: Error | null): void => {
      if (settled) return
      settled = true
      unsubscribeTransport()
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
    const armTimeout = (): void => {
      if (timeout) clearTimeout(timeout)
      timeout = setTimeout(() => finish(new Error('SFTP 操作超时，请检查远程服务是否启用 SFTP。')), SFTP_TRANSFER_IDLE_TIMEOUT_MS)
      timeout.unref?.()
    }
    const step = (total: number, _chunk: number, fileSize: number): void => {
      if (settled) return
      // ssh2 reports the cumulative transferred amount as `total`; retain a
      // monotonic value even with unusual server implementations.
      lastTransferred = Math.max(lastTransferred, Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0)
      const totalBytes = Number.isFinite(fileSize) && fileSize >= 0 ? Math.floor(fileSize) : undefined
      try {
        onProgress?.({ transferredBytes: lastTransferred, ...(totalBytes === undefined ? {} : { totalBytes }) })
        armTimeout()
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
    unsubscribeTransport = transport.subscribe(finish)
    if (settled) return
    armTimeout()
    try {
      if (direction === 'upload') sftp.fastPut(sourcePath, targetPath, options, callback)
      else sftp.fastGet(sourcePath, targetPath, options, callback)
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

function openSftp(transport: TransportLifecycle, client: Client): Promise<SFTPWrapper> {
  transport.assertOpen()
  return new Promise((resolve, reject) => {
    let settled = false
    let unsubscribeTransport = (): void => undefined
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      unsubscribeTransport()
      reject(new Error('SFTP 通道建立超时，请检查远程服务是否启用 SFTP。'))
    }, SFTP_CHANNEL_TIMEOUT_MS)
    timeout.unref?.()
    const finish = (error?: Error, sftp?: SFTPWrapper): void => {
      if (settled) {
        if (sftp) {
          try { sftp.end() } catch { /* The late channel is already closed. */ }
        }
        return
      }
      settled = true
      unsubscribeTransport()
      clearTimeout(timeout)
      if (error) reject(error)
      else if (!sftp) reject(new Error('SSH server returned no SFTP channel'))
      else resolve(sftp)
    }
    unsubscribeTransport = transport.subscribe(finish)
    if (settled) return
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

async function listDirectory(transport: TransportLifecycle, client: Client, remotePath: string): Promise<readonly SshDirectoryEntry[]> {
  transport.assertOpen()
  const sftp = await openSftp(transport, client)
  return await new Promise<readonly SshDirectoryEntry[]>((resolve, reject) => {
    let settled = false
    let unsubscribeTransport = (): void => undefined
    const timeout = setTimeout(() => finish(new Error('SFTP 目录读取超时，请检查远程服务是否启用 SFTP。')), SFTP_CHANNEL_TIMEOUT_MS)
    const finish = (error?: Error, entries?: readonly SshDirectoryEntry[]): void => {
      if (settled) return
      settled = true
      unsubscribeTransport()
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
    unsubscribeTransport = transport.subscribe(finish)
    if (settled) return
    timeout.unref?.()
    try {
      sftp.readdir(remotePath, (error, entries) => {
        if (settled) return
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
