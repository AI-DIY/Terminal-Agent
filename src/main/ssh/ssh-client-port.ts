export type SshConnectOptions = {
  host: string
  port: number
  username?: string
  password?: string
  privateKey?: string | Buffer
  passphrase?: string
}

export type SshShell = {
  write(data: string): void
  resize(columns: number, rows: number): void
  close(): void
  onData(listener: (data: Buffer) => void): void
  onClose(listener: () => void): void
}

export type SshFileTransferProgress = {
  transferredBytes: number
  totalBytes?: number
}

export type SshDirectoryEntryKind = 'file' | 'directory' | 'symlink' | 'other'

export type SshDirectoryEntry = {
  name: string
  kind: SshDirectoryEntryKind
  size: number
  modifiedAt?: string
  mode?: number
  uid?: number
  gid?: number
}

/**
 * SFTP is optional because the raw AccessClient bridge is a TCP stream and
 * cannot provide a file-transfer subsystem.  Implementations must use a
 * separate SFTP channel so an active interactive shell is left untouched.
 */
export type SshFileTransfer = {
  /** Optional for older/custom transports that only implement file copies. */
  listDirectory?(remotePath: string): Promise<readonly SshDirectoryEntry[]>
  /** The SFTP subsystem's own current directory; never inferred from PTY output. */
  getWorkingDirectory?(): Promise<string>
  /** Idempotently create one remote directory, including an already-existing target. */
  ensureDirectory?(remotePath: string): Promise<void>
  rename?(fromPath: string, toPath: string): Promise<void>
  removeFile?(remotePath: string): Promise<void>
  removeDirectory?(remotePath: string): Promise<void>
  uploadFile(
    localPath: string,
    remotePath: string,
    onProgress?: (progress: SshFileTransferProgress) => void,
    signal?: AbortSignal,
  ): Promise<number>
  downloadFile(
    remotePath: string,
    localPath: string,
    onProgress?: (progress: SshFileTransferProgress) => void,
    signal?: AbortSignal,
  ): Promise<number>
}

export type SshConnection = {
  remoteAddress?: string
  openShell(columns: number, rows: number): Promise<SshShell>
  execute?(command: string, maxOutputBytes?: number): Promise<string>
  fileTransfer?: SshFileTransfer
  close(): void
}

export interface SshClientPort {
  connect(options: SshConnectOptions): Promise<SshConnection>
}
