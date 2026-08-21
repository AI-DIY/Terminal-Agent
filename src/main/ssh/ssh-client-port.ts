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

export type SshConnection = {
  remoteAddress?: string
  openShell(columns: number, rows: number): Promise<SshShell>
  execute?(command: string, maxOutputBytes?: number): Promise<string>
  close(): void
}

export interface SshClientPort {
  connect(options: SshConnectOptions): Promise<SshConnection>
}
