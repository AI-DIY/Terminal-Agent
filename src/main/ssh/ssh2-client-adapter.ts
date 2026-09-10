import { Client } from 'ssh2'
import type { ClientChannel, FileEntryWithStats, SFTPWrapper, TransferOptions } from 'ssh2'
import { StringDecoder } from 'node:string_decoder'
import { isIP } from 'node:net'
import { stat } from 'node:fs/promises'
import { FILE_TRANSFER_MAX_DIRECTORY_ENTRIES } from '../../shared/file-transfer-contracts'
import type { SshClientPort, SshConnectOptions, SshConnection, SshDirectoryEntry, SshShell } from './ssh-client-port'
import type { SshFileTransferProgress } from './ssh-client-port'
import { noOpSshConnectionDiagnostics, type SshConnectionDiagnosticFields, type SshConnectionDiagnostics } from './ssh-connection-diagnostics'

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
type SshDiagnosticRecord = (event: string, fields?: SshConnectionDiagnosticFields) => void
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
  constructor(private readonly diagnostics: SshConnectionDiagnostics = noOpSshConnectionDiagnostics) {}

  async connect(options: SshConnectOptions): Promise<SshConnection> {
    const client = new Client()
    const transport = createTransportLifecycle()
    const record = (event: string, fields: SshConnectionDiagnosticFields = {}): void => {
      recordSshDiagnostic(this.diagnostics, event, { host: options.host, port: options.port, ...fields })
    }
    let ready = false
    let connectSettled = false
    record('connection-opening')

    // ssh2 can emit a client-level error long after the initial ready event.
    // Keep this listener for the entire connection lifetime: EventEmitter
    // treats an error without a listener as an uncaught process exception.
    let rejectConnect: ((error: Error) => void) | undefined
    const onClientError = (error: unknown): void => {
      record('transport-error', { error: diagnosticError(error) })
      const failure = transport.fail(error)
      if (!ready && !connectSettled) {
        connectSettled = true
        rejectConnect?.(failure)
      }
    }
    const onClientClose = (): void => {
      record('transport-closed')
      const failure = transport.fail(new Error('SSH connection closed'))
      if (!ready && !connectSettled) {
        connectSettled = true
        rejectConnect?.(failure)
      }
    }
    const onClientEnd = (): void => {
      record('transport-ended')
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
          record('connection-ready')
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
      record('connection-open-failed', { error: diagnosticError(error) })
      // Avoid leaving a half-open ssh2 client behind when authentication or
      // socket setup fails before the connection becomes usable.
      try { client.end() } catch { /* The client may already be closed. */ }
      throw error
    }

    // A number of enterprise bastions allow an interactive PTY and SFTP but
    // are fragile when multiple SFTP subsystem requests are made at once on
    // the same SSH transport (for example initial listing + a quick refresh).
    // Serialize only SFTP work per connection.  It never serializes terminal
    // input or work on another SSH connection. Keep a single SFTP subsystem
    // alive for this transport instead of opening and immediately closing a
    // channel for every directory refresh, which some bastions interpret as a
    // transport failure.
    const sftpChannel = createReusableSftpChannel(transport, client, record)
    let fileTransferTail: Promise<void> = Promise.resolve()
    const queueFileTransfer = <T>(operationName: string, operation: () => Promise<T>): Promise<T> => {
      record('sftp-operation-queued', { operation: operationName })
      const run = async (): Promise<T> => {
        transport.assertOpen()
        record('sftp-operation-started', { operation: operationName })
        try {
          const result = await operation()
          record('sftp-operation-completed', { operation: operationName })
          return result
        } catch (error) {
          record('sftp-operation-failed', { operation: operationName, error: diagnosticError(error) })
          throw error
        }
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
      // The SFTP subsystem is multiplexed over the same SSH transport as the
      // interactive PTY and remains open across directory and file actions.
      fileTransfer: {
        listDirectory: remotePath => queueFileTransfer('directory-list', async () => listDirectory(transport, await sftpChannel.acquire(), remotePath, sftpChannel.releaseAfterFailure)),
        getWorkingDirectory: () => queueFileTransfer('working-directory', async () => getSftpWorkingDirectory(transport, await sftpChannel.acquire(), sftpChannel.releaseAfterFailure)),
        ensureDirectory: remotePath => queueFileTransfer('ensure-directory', async () => ensureSftpDirectory(transport, await sftpChannel.acquire(), remotePath, sftpChannel.releaseAfterFailure)),
        rename: (fromPath, toPath) => queueFileTransfer('rename', async () => renameSftpEntry(transport, await sftpChannel.acquire(), fromPath, toPath, sftpChannel.releaseAfterFailure)),
        removeFile: remotePath => queueFileTransfer('remove-file', async () => removeSftpFile(transport, await sftpChannel.acquire(), remotePath, sftpChannel.releaseAfterFailure)),
        removeDirectory: remotePath => queueFileTransfer('remove-directory', async () => removeSftpDirectory(transport, await sftpChannel.acquire(), remotePath, sftpChannel.releaseAfterFailure)),
        uploadFile: (localPath, remotePath, onProgress, signal) => queueFileTransfer('upload', async () => transferFile(transport, await sftpChannel.acquire(), 'upload', localPath, remotePath, onProgress, signal, sftpChannel.releaseAfterFailure)),
        downloadFile: (remotePath, localPath, onProgress, signal) => queueFileTransfer('download', async () => transferFile(transport, await sftpChannel.acquire(), 'download', remotePath, localPath, onProgress, signal, sftpChannel.releaseAfterFailure)),
      },
      close: () => {
        record('connection-close-requested')
        sftpChannel.close()
        transport.fail(new Error('SSH connection closed'))
        client.end()
      },
    }
  }
}

type TransferDirection = 'upload' | 'download'

/**
 * Run one ssh2 fastPut/fastGet operation on the reusable SFTP subsystem.
 * The callback is intentionally translated to byte counts before it leaves
 * this adapter; no ssh2 objects or credentials cross the process boundary.
 */
async function transferFile(
  transport: TransportLifecycle,
  sftp: SFTPWrapper,
  direction: TransferDirection,
  sourcePath: string,
  targetPath: string,
  onProgress?: (progress: SshFileTransferProgress) => void,
  signal?: AbortSignal,
  releaseAfterFailure?: (sftp: SFTPWrapper) => void,
): Promise<number> {
  transport.assertOpen()
  throwIfTransferAborted(signal)
  const uploadSize = direction === 'upload'
    ? await stat(sourcePath).then(result => result.size)
    : undefined
  transport.assertOpen()
  throwIfTransferAborted(signal)
  if (uploadSize !== undefined) onProgress?.({ transferredBytes: 0, totalBytes: uploadSize })
  else onProgress?.({ transferredBytes: 0 })

  let lastTransferred = 0
  let settled = false

  return await new Promise<number>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined
    let unsubscribeTransport = (): void => undefined
    let unsubscribeSftpError = (): void => undefined
    let unsubscribeSftpClose = (): void => undefined
    let unsubscribeSftpEnd = (): void => undefined
    let unsubscribeAbort = (): void => undefined
    const finish = (error?: Error | null): void => {
      if (settled) return
      settled = true
      unsubscribeTransport()
      unsubscribeSftpError()
      unsubscribeSftpClose()
      unsubscribeSftpEnd()
      unsubscribeAbort()
      if (timeout) clearTimeout(timeout)
      if (error) {
        releaseAfterFailure?.(sftp)
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
    const onSftpEnd = (): void => {
      if (!settled) finish(new Error('SFTP channel ended before transfer completed'))
    }
    unsubscribeSftpError = listenSftpEvent(sftp, 'error', onSftpError)
    unsubscribeSftpClose = listenSftpEvent(sftp, 'close', onSftpClose)
    unsubscribeSftpEnd = listenSftpEvent(sftp, 'end', onSftpEnd)
    unsubscribeTransport = transport.subscribe(finish)
    unsubscribeAbort = listenAbortSignal(signal, () => finish(createTransferAbortError()))
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

function createTransferAbortError(): Error {
  const error = new Error('文件传输已取消。')
  error.name = 'AbortError'
  return error
}

function throwIfTransferAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw createTransferAbortError()
}

function listenAbortSignal(signal: AbortSignal | undefined, listener: () => void): () => void {
  if (!signal) return () => undefined
  if (signal.aborted) {
    listener()
    return () => undefined
  }
  signal.addEventListener('abort', listener, { once: true })
  return () => signal.removeEventListener('abort', listener)
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

type ReusableSftpChannel = {
  acquire(): Promise<SFTPWrapper>
  releaseAfterFailure(sftp: SFTPWrapper): void
  close(): void
}

/**
 * One SFTP subsystem is multiplexed through the established SSH client. It is
 * deliberately separate from the interactive PTY, but it is not recreated
 * for every file-browser refresh. A failed channel is discarded so the next
 * serialized file action can negotiate a clean replacement without ending the
 * shell transport.
 */
function createReusableSftpChannel(
  transport: TransportLifecycle,
  client: Client,
  record: SshDiagnosticRecord,
): ReusableSftpChannel {
  let channel: SFTPWrapper | undefined
  let opening: Promise<SFTPWrapper> | undefined

  const discard = (
    sftp: SFTPWrapper,
    event: string,
    closeChannel: boolean,
    fields: SshConnectionDiagnosticFields = {},
  ): void => {
    if (channel !== sftp) return
    channel = undefined
    record(event, fields)
    if (closeChannel) {
      try { sftp.end() } catch { /* The failed channel may already be closed. */ }
    }
  }

  const acquire = (): Promise<SFTPWrapper> => {
    transport.assertOpen()
    if (channel) return Promise.resolve(channel)
    if (opening) return opening

    record('sftp-channel-opening')
    const pending = openSftp(transport, client).then(
      sftp => {
        channel = sftp
        listenSftpEvent(sftp, 'error', error => discard(sftp, 'sftp-channel-error', false, { error: diagnosticError(error) }))
        listenSftpEvent(sftp, 'close', () => discard(sftp, 'sftp-channel-closed', false))
        listenSftpEvent(sftp, 'end', () => discard(sftp, 'sftp-channel-ended', false))
        record('sftp-channel-ready')
        return sftp
      },
      error => {
        record('sftp-channel-open-failed', { error: diagnosticError(error) })
        throw error
      },
    )
    opening = pending
    void pending.then(
      () => { if (opening === pending) opening = undefined },
      () => { if (opening === pending) opening = undefined },
    )
    return pending
  }

  return {
    acquire,
    releaseAfterFailure: sftp => discard(sftp, 'sftp-channel-aborted', true),
    close: () => {
      const active = channel
      channel = undefined
      if (!active) return
      record('sftp-channel-close-requested')
      try { active.end() } catch { /* The channel may already be closed. */ }
    },
  }
}

type SftpOperationCallback<T> = (error?: Error | null, value?: T) => void

/**
 * Small SFTP metadata/mutation calls share the same lifecycle protection as a
 * directory listing.  A rejected operation discards only the auxiliary SFTP
 * channel; the interactive terminal stays attached to the SSH transport.
 */
async function runSftpOperation<T>(
  transport: TransportLifecycle,
  sftp: SFTPWrapper,
  operationLabel: string,
  operation: (finish: SftpOperationCallback<T>) => void,
  releaseAfterFailure?: (sftp: SFTPWrapper) => void,
): Promise<T> {
  transport.assertOpen()
  return await new Promise<T>((resolve, reject) => {
    let settled = false
    let unsubscribeTransport = (): void => undefined
    let unsubscribeSftpError = (): void => undefined
    let unsubscribeSftpClose = (): void => undefined
    let unsubscribeSftpEnd = (): void => undefined
    const timeout = setTimeout(() => finish(new Error(`SFTP ${operationLabel}超时，请检查远程服务是否启用 SFTP。`)), SFTP_CHANNEL_TIMEOUT_MS)
    const finish: SftpOperationCallback<T> = (error, value) => {
      if (settled) return
      settled = true
      unsubscribeTransport()
      unsubscribeSftpError()
      unsubscribeSftpClose()
      unsubscribeSftpEnd()
      clearTimeout(timeout)
      if (error) {
        releaseAfterFailure?.(sftp)
        reject(error instanceof Error ? error : new Error(String(error)))
        return
      }
      resolve(value as T)
    }
    const onError = (error: unknown): void => finish(error instanceof Error ? error : new Error(String(error)))
    const onClose = (): void => {
      if (!settled) finish(new Error(`SFTP channel closed before ${operationLabel} completed`))
    }
    const onEnd = (): void => {
      if (!settled) finish(new Error(`SFTP channel ended before ${operationLabel} completed`))
    }
    unsubscribeSftpError = listenSftpEvent(sftp, 'error', onError)
    unsubscribeSftpClose = listenSftpEvent(sftp, 'close', onClose)
    unsubscribeSftpEnd = listenSftpEvent(sftp, 'end', onEnd)
    unsubscribeTransport = transport.subscribe(error => finish(error))
    if (settled) return
    timeout.unref?.()
    try {
      operation(finish)
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

async function getSftpWorkingDirectory(
  transport: TransportLifecycle,
  sftp: SFTPWrapper,
  releaseAfterFailure?: (sftp: SFTPWrapper) => void,
): Promise<string> {
  return await runSftpOperation<string>(transport, sftp, '工作目录读取', finish => {
    sftp.realpath('.', (error, resolvedPath) => {
      if (error) {
        finish(error)
        return
      }
      if (typeof resolvedPath !== 'string' || !resolvedPath.trim() || resolvedPath.includes('\\') || containsControlCharacters(resolvedPath)) {
        finish(new Error('SFTP server returned an invalid working directory'))
        return
      }
      finish(undefined, resolvedPath)
    })
  }, releaseAfterFailure)
}

async function ensureSftpDirectory(
  transport: TransportLifecycle,
  sftp: SFTPWrapper,
  remotePath: string,
  releaseAfterFailure?: (sftp: SFTPWrapper) => void,
): Promise<void> {
  return await runSftpOperation<void>(transport, sftp, '目录创建', finish => {
    sftp.mkdir(remotePath, error => {
      if (!error) {
        finish(undefined)
        return
      }
      // mkdir has no portable "already exists" result. A successful listing
      // proves the path is an existing directory; any other failure preserves
      // the original creation error for the caller.
      sftp.readdir(remotePath, listingError => finish(listingError ? error : undefined))
    })
  }, releaseAfterFailure)
}

async function renameSftpEntry(
  transport: TransportLifecycle,
  sftp: SFTPWrapper,
  fromPath: string,
  toPath: string,
  releaseAfterFailure?: (sftp: SFTPWrapper) => void,
): Promise<void> {
  return await runSftpOperation<void>(transport, sftp, '重命名', finish => {
    sftp.rename(fromPath, toPath, error => finish(error))
  }, releaseAfterFailure)
}

async function removeSftpFile(
  transport: TransportLifecycle,
  sftp: SFTPWrapper,
  remotePath: string,
  releaseAfterFailure?: (sftp: SFTPWrapper) => void,
): Promise<void> {
  return await runSftpOperation<void>(transport, sftp, '文件删除', finish => {
    sftp.unlink(remotePath, error => finish(error))
  }, releaseAfterFailure)
}

async function removeSftpDirectory(
  transport: TransportLifecycle,
  sftp: SFTPWrapper,
  remotePath: string,
  releaseAfterFailure?: (sftp: SFTPWrapper) => void,
): Promise<void> {
  return await runSftpOperation<void>(transport, sftp, '目录删除', finish => {
    sftp.rmdir(remotePath, error => finish(error))
  }, releaseAfterFailure)
}

async function listDirectory(
  transport: TransportLifecycle,
  sftp: SFTPWrapper,
  remotePath: string,
  releaseAfterFailure?: (sftp: SFTPWrapper) => void,
): Promise<readonly SshDirectoryEntry[]> {
  transport.assertOpen()
  return await new Promise<readonly SshDirectoryEntry[]>((resolve, reject) => {
    let settled = false
    let unsubscribeTransport = (): void => undefined
    let unsubscribeSftpError = (): void => undefined
    let unsubscribeSftpClose = (): void => undefined
    let unsubscribeSftpEnd = (): void => undefined
    const timeout = setTimeout(() => finish(new Error('SFTP 目录读取超时，请检查远程服务是否启用 SFTP。')), SFTP_CHANNEL_TIMEOUT_MS)
    const finish = (error?: Error, entries?: readonly SshDirectoryEntry[]): void => {
      if (settled) return
      settled = true
      unsubscribeTransport()
      unsubscribeSftpError()
      unsubscribeSftpClose()
      unsubscribeSftpEnd()
      if (timeout) clearTimeout(timeout)
      if (error) {
        releaseAfterFailure?.(sftp)
        reject(error)
      }
      else resolve(entries ?? [])
    }

    const onError = (error: unknown): void => finish(error instanceof Error ? error : new Error(String(error)))
    const onClose = (): void => {
      if (!settled) finish(new Error('SFTP channel closed before directory listing completed'))
    }
    const onEnd = (): void => {
      if (!settled) finish(new Error('SFTP channel ended before directory listing completed'))
    }
    unsubscribeSftpError = listenSftpEvent(sftp, 'error', onError)
    unsubscribeSftpClose = listenSftpEvent(sftp, 'close', onClose)
    unsubscribeSftpEnd = listenSftpEvent(sftp, 'end', onEnd)
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
  event: 'error' | 'close' | 'end',
  listener: (...args: unknown[]) => void,
): () => void {
  const candidate = sftp as SFTPWrapper & {
    once?: (name: string, callback: (...args: unknown[]) => void) => unknown
    off?: (name: string, callback: (...args: unknown[]) => void) => unknown
    removeListener?: (name: string, callback: (...args: unknown[]) => void) => unknown
  }
  if (typeof candidate.once !== 'function') return () => undefined
  candidate.once(event, listener)
  return () => {
    if (typeof candidate.off === 'function') candidate.off(event, listener)
    else candidate.removeListener?.(event, listener)
  }
}

function recordSshDiagnostic(
  diagnostics: SshConnectionDiagnostics,
  event: string,
  fields: SshConnectionDiagnosticFields = {},
): void {
  try { diagnostics.record(event, fields) } catch { /* Diagnostics must never disrupt an SSH session. */ }
}

function diagnosticError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
