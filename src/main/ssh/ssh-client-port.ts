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

/**
 * SFTP is optional because the raw AccessClient bridge is a TCP stream and
 * cannot provide a file-transfer subsystem.  Implementations must use a
 * separate SFTP channel so an active interactive shell is left untouched.
 */
export type SshFileTransfer = {
  uploadFile(
    localPath: string,
    remotePath: string,
    onProgress?: (progress: SshFileTransferProgress) => void,
  ): Promise<number>
  downloadFile(
    remotePath: string,
    localPath: string,
    onProgress?: (progress: SshFileTransferProgress) => void,
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
