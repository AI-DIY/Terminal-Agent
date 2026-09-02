import type { SessionMode } from '../../shared/contracts'
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import { AccessClientLaunchFailure } from '../access-client/launch-failure'
import type { PrivateKeyInput } from './private-key-loader'
import type { SshClientPort, SshConnection, SshFileTransferProgress, SshShell } from './ssh-client-port'
import { MainProcessReconnectDescriptorStore } from './direct-session-repository'
import { normalizeSafeHostMemoryConnectionIp } from '../../shared/host-memory-safety'

export type DirectSessionRequest = {
  host: string
  port: number
  username: string
  auth: { kind: 'password'; password: string } | { kind: 'privateKey'; key: PrivateKeyInput }
  profileId?: string
}

export type ConnectedSession = {
  id: string
  hostname: string
  /**
   * Hostname reported by the connected remote system, when read-only
   * observation has completed. The connection hostname remains the stable
   * route/target value for backwards compatibility.
   */
  observedHostname?: string
  title?: string
  mode: SessionMode
  chatId?: string
}

export type SessionConnectionType = 'direct-ssh' | 'access-client-ssh' | 'access-client-raw'
export type HistoryConnectedSession = ConnectedSession & {
  connectionType: SessionConnectionType
  reconnectReference: string
}

export type TerminalDataEvent = {
  sessionId: string
  data: string
}

export type TerminalClosedEvent = {
  sessionId: string
}

export type AccessSshSessionRequest = {
  host: string
  port: number
  username: string
  password?: string
  title: string
  columns: number
  rows: number
  profileId?: string
}

export type RawSessionRequest = {
  host: string
  port: number
  title?: string
  columns?: number
  rows?: number
  profileId?: string
}

type PrivateKeyLoader = {
  load(input: PrivateKeyInput): Promise<string | Buffer>
}

type ActiveSession = {
  connection: SshConnection
  shell: SshShell
  decoder: StringDecoder
  summary: ConnectedSession
  connectionType: SessionConnectionType
  supportsReadOnlyObservation: boolean
  reconnectReference: string
  connectionIp?: string
  recentOutput: string
}

export const MAX_RECENT_SHELL_LINES = 200

export type TerminalWriteEvent = TerminalDataEvent

type SessionServiceOptions = {
  createId?: () => string
  reconnectDescriptors?: MainProcessReconnectDescriptorStore<MainProcessSessionDescriptor>
}

type MainProcessSessionDescriptor =
  | { kind: 'direct'; request: DirectSessionRequest }
  | { kind: 'access-ssh'; request: AccessSshSessionRequest }
  | { kind: 'access-raw'; request: RawSessionRequest }

export class SessionService {
  private readonly observedHostnames = new Map<string, string>()
  private readonly sessions = new Map<string, ActiveSession>()
  private readonly dataListeners = new Set<(event: TerminalDataEvent) => void>()
  private readonly writeListeners = new Set<(event: TerminalWriteEvent) => void>()
  private readonly closedListeners = new Set<(event: TerminalClosedEvent) => void>()
  private readonly openedListeners = new Set<(session: ConnectedSession) => void>()
  private readonly historyOpenedListeners = new Set<(session: HistoryConnectedSession) => void>()
  private readonly updatedListeners = new Set<(session: ConnectedSession) => void>()
  private readonly createId: () => string
  private readonly reconnectDescriptors: MainProcessReconnectDescriptorStore<MainProcessSessionDescriptor>

  constructor(
    private readonly client: SshClientPort,
    private readonly privateKeyLoader: PrivateKeyLoader,
    private readonly rawClient?: SshClientPort,
    options: SessionServiceOptions = {},
  ) {
    this.createId = options.createId ?? randomUUID
    this.reconnectDescriptors = options.reconnectDescriptors ?? new MainProcessReconnectDescriptorStore()
  }

  async connect(request: DirectSessionRequest): Promise<ConnectedSession> {
    return this.connectDescriptor({ kind: 'direct', request: cloneDirectSessionRequest(request) })
  }

  async connectAccessSsh(request: AccessSshSessionRequest): Promise<ConnectedSession> {
    return this.connectDescriptor({ kind: 'access-ssh', request: { ...request } })
  }

  async connectRaw(request: RawSessionRequest): Promise<ConnectedSession> {
    return this.connectDescriptor({ kind: 'access-raw', request: { ...request } })
  }

  async duplicate(sessionId: string, chatId?: string): Promise<ConnectedSession> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('Shell 复制不可用。')
    return this.reconnect(session.reconnectReference, chatId)
  }

  async reconnect(reconnectReference: string, chatId?: string): Promise<ConnectedSession> {
    const descriptor = this.reconnectDescriptors.resolve(reconnectReference)
    if (!descriptor) throw new Error('Shell 历史重连不可用。')
    return this.connectDescriptor(descriptor, chatId)
  }

  canReconnect(reconnectReference: string): boolean {
    return this.reconnectDescriptors.has(reconnectReference)
  }

  private async connectDescriptor(
    descriptor: MainProcessSessionDescriptor,
    chatId?: string,
  ): Promise<ConnectedSession> {
    const reconnectReference = this.reconnectDescriptors.register(descriptor)
    try {
      if (descriptor.kind === 'direct') {
        return await this.connectWithClient(
          this.client,
          await this.toSshOptions(descriptor.request),
          { hostname: descriptor.request.host },
          true,
          'direct-ssh',
          reconnectReference,
          chatId,
        )
      }
      if (descriptor.kind === 'access-ssh') {
        const request = descriptor.request
        return await this.connectAccessClientWith(this.client, {
          host: request.host,
          port: request.port,
          username: request.username,
          ...(request.password !== undefined ? { password: request.password } : {}),
        }, {
          hostname: request.host,
          title: request.title,
          columns: request.columns,
          rows: request.rows,
        }, true, 'access-client-ssh', reconnectReference, chatId)
      }
      if (!this.rawClient) throw new Error('Raw terminal transport is unavailable')
      const request = descriptor.request
      return await this.connectAccessClientWith(this.rawClient, {
        host: request.host,
        port: request.port,
      }, {
        hostname: request.host,
        title: request.title,
        columns: request.columns,
        rows: request.rows,
      }, false, 'access-client-raw', reconnectReference, chatId)
    } catch (error) {
      this.reconnectDescriptors.remove(reconnectReference)
      throw error
    }
  }

  private async connectWithClient(
    client: SshClientPort,
    options: { host: string; port: number; username?: string; password?: string; privateKey?: string | Buffer; passphrase?: string },
    sessionOptions: { hostname: string; title?: string; columns?: number; rows?: number },
    supportsReadOnlyObservation: boolean,
    connectionType: SessionConnectionType,
    reconnectReference: string,
    chatId?: string,
  ): Promise<ConnectedSession> {
    const connection = await client.connect(options)
    return this.openConnectedSession(connection, sessionOptions, supportsReadOnlyObservation, connectionType, reconnectReference, chatId)
  }

  private async connectAccessClientWith(
    client: SshClientPort,
    options: { host: string; port: number; username?: string; password?: string },
    sessionOptions: { hostname: string; title?: string; columns?: number; rows?: number },
    supportsReadOnlyObservation: boolean,
    connectionType: SessionConnectionType,
    reconnectReference: string,
    chatId?: string,
  ): Promise<ConnectedSession> {
    let connection: SshConnection
    try {
      connection = await client.connect(options)
    } catch {
      throw new AccessClientLaunchFailure('transport-connect-failed')
    }
    try {
      return await this.openConnectedSession(connection, sessionOptions, supportsReadOnlyObservation, connectionType, reconnectReference, chatId)
    } catch {
      throw new AccessClientLaunchFailure('terminal-open-failed')
    }
  }

  private async openConnectedSession(
    connection: SshConnection,
    sessionOptions: { hostname: string; title?: string; columns?: number; rows?: number },
    supportsReadOnlyObservation: boolean,
    connectionType: SessionConnectionType,
    reconnectReference: string,
    chatId?: string,
  ): Promise<ConnectedSession> {
    const id = this.createId()
    const decoder = new StringDecoder('utf8')
    const columns = sessionOptions.columns ?? 80
    const rows = sessionOptions.rows ?? 24
    let shell: SshShell
    try {
      shell = await connection.openShell(columns, rows)
    } catch (error) {
      connection.close()
      throw error
    }
    shell.onData(data => {
      this.publishData(id, decoder.write(data))
    })
    shell.onClose(() => this.finish(id))
    const summary: ConnectedSession = {
      id,
      hostname: sessionOptions.hostname,
      ...(sessionOptions.title ? { title: sessionOptions.title } : {}),
      mode: 'copilot',
      ...(chatId ? { chatId } : {}),
    }
    const connectionIp = safeConnectionIp(connection.remoteAddress)
    this.sessions.set(id, { connection, shell, decoder, summary, connectionType, supportsReadOnlyObservation, reconnectReference, recentOutput: '', ...(connectionIp ? { connectionIp } : {}) })
    const historySession: HistoryConnectedSession = { ...summary, connectionType, reconnectReference }
    for (const listener of this.historyOpenedListeners) {
      listener(historySession)
    }
    for (const listener of this.openedListeners) {
      listener(summary)
    }

    return summary
  }

  close(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error('Unknown terminal session')
    }
    try {
      session.shell.close()
    } finally {
      this.finish(sessionId)
    }
  }

  write(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error('Unknown terminal session')
    }
    session.shell.write(data)
    const event = { sessionId, data }
    for (const listener of this.writeListeners) listener(event)
  }

  resize(sessionId: string, columns: number, rows: number): void {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error('Unknown terminal session')
    }
    session.shell.resize(columns, rows)
  }

  setMode(sessionId: string, mode: SessionMode): void {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error('Unknown terminal session')
    }
    session.summary = { ...session.summary, mode }
    for (const listener of this.updatedListeners) {
      listener({ ...session.summary })
    }
  }

  setObservedHostname(sessionId: string, hostname: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('Unknown terminal session')
    const observedHostname = hostname.trim()
    if (!observedHostname || observedHostname === session.summary.observedHostname) return
    this.observedHostnames.set(sessionId, observedHostname)
    session.summary = { ...session.summary, observedHostname }
    for (const listener of this.updatedListeners) {
      listener({ ...session.summary })
    }
  }

  observedHostname(sessionId: string): string | undefined { return this.observedHostnames.get(sessionId) }

  clearObservedHostname(sessionId: string): void {
    this.observedHostnames.delete(sessionId)
    const session = this.sessions.get(sessionId)
    if (!session?.summary.observedHostname) return
    const summary = { ...session.summary }
    delete summary.observedHostname
    session.summary = summary
    for (const listener of this.updatedListeners) {
      listener({ ...session.summary })
    }
  }

  connectionIp(sessionId: string): string | undefined { return this.sessions.get(sessionId)?.connectionIp }

  supportsFileTransfer(sessionId: string): boolean {
    return Boolean(this.sessions.get(sessionId)?.connection.fileTransfer)
  }

  async uploadFile(
    sessionId: string,
    localPath: string,
    remotePath: string,
    onProgress?: (progress: SshFileTransferProgress) => void,
  ): Promise<number> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('Unknown terminal session')
    if (!session.connection.fileTransfer) throw new Error('当前 SSH 会话不支持 SFTP 文件传输。')
    return session.connection.fileTransfer.uploadFile(localPath, remotePath, onProgress)
  }

  async downloadFile(
    sessionId: string,
    remotePath: string,
    localPath: string,
    onProgress?: (progress: SshFileTransferProgress) => void,
  ): Promise<number> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('Unknown terminal session')
    if (!session.connection.fileTransfer) throw new Error('当前 SSH 会话不支持 SFTP 文件传输。')
    return session.connection.fileTransfer.downloadFile(remotePath, localPath, onProgress)
  }

  recentLines(sessionId: string, limit = MAX_RECENT_SHELL_LINES): string[] {
    const output = this.sessions.get(sessionId)?.recentOutput
    if (output === undefined) return []
    const lines = output.split(/\r?\n|\r/)
    if (lines.at(-1) === '') lines.pop()
    const boundedLimit = Math.max(0, Math.min(MAX_RECENT_SHELL_LINES, Math.floor(limit)))
    return boundedLimit === 0 ? [] : lines.slice(-boundedLimit)
  }

  supportsReadOnlyObservation(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    return Boolean(session?.supportsReadOnlyObservation && session.connection.execute)
  }

  async executeReadOnly(sessionId: string, command: string): Promise<string> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('Unknown terminal session')
    if (!session.supportsReadOnlyObservation || !session.connection.execute) {
      throw new Error('Read-only observation is unavailable for this terminal session')
    }
    return session.connection.execute(command, 256 * 1024)
  }

  onData(listener: (event: TerminalDataEvent) => void): () => void {
    this.dataListeners.add(listener)
    return () => this.dataListeners.delete(listener)
  }

  onClosed(listener: (event: TerminalClosedEvent) => void): () => void {
    this.closedListeners.add(listener)
    return () => this.closedListeners.delete(listener)
  }

  onOpened(listener: (session: ConnectedSession) => void): () => void {
    this.openedListeners.add(listener)
    return () => this.openedListeners.delete(listener)
  }

  onWrite(listener: (event: TerminalWriteEvent) => void): () => void {
    this.writeListeners.add(listener)
    return () => this.writeListeners.delete(listener)
  }

  onHistoryOpened(listener: (session: HistoryConnectedSession) => void): () => void {
    this.historyOpenedListeners.add(listener)
    return () => this.historyOpenedListeners.delete(listener)
  }

  onUpdated(listener: (session: ConnectedSession) => void): () => void {
    this.updatedListeners.add(listener)
    return () => this.updatedListeners.delete(listener)
  }

  snapshot(): ConnectedSession[] {
    return [...this.sessions.values()].map(session => ({ ...session.summary }))
  }

  closeAll(): void {
    let firstFailure: unknown
    let failed = false
    for (const sessionId of [...this.sessions.keys()]) {
      try {
        this.close(sessionId)
      } catch (error) {
        if (!failed) firstFailure = error
        failed = true
      }
    }
    this.reconnectDescriptors.clear()
    if (failed) throw firstFailure
  }

  revokeDirectProfile(profileId: string): void {
    this.reconnectDescriptors.revokeWhere(descriptor => descriptor.kind === 'direct' && descriptor.request.profileId === profileId)
  }

  revokeAccessProfile(profileId: string): void {
    this.reconnectDescriptors.revokeWhere(descriptor => (
      (descriptor.kind === 'access-ssh' || descriptor.kind === 'access-raw')
      && descriptor.request.profileId === profileId
    ))
  }

  private finish(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    this.publishData(sessionId, session.decoder.end())
    this.sessions.delete(sessionId)
    this.observedHostnames.delete(sessionId)
    this.reconnectDescriptors.markClosed(session.reconnectReference)
    const event = { sessionId }
    try {
      session.connection.close()
    } finally {
      for (const listener of this.closedListeners) {
        listener(event)
      }
    }
  }

  private publishData(sessionId: string, data: string): void {
    if (!data) return
    const session = this.sessions.get(sessionId)
    if (session) session.recentOutput = appendRecentShellOutput(session.recentOutput, data)
    const event = { sessionId, data }
    for (const listener of this.dataListeners) {
      listener(event)
    }
  }

  private async toSshOptions(request: DirectSessionRequest) {
    const common = { host: request.host, port: request.port, username: request.username }
    if (request.auth.kind === 'password') {
      return { ...common, password: request.auth.password }
    }

    const privateKey = await this.privateKeyLoader.load(request.auth.key)
    return { ...common, privateKey, passphrase: request.auth.key.passphrase }
  }
}

function appendRecentShellOutput(previous: string, data: string): string {
  const combined = `${previous}${data}`
  const lines = combined.split(/\r\n|\r|\n/)
  const keepCount = MAX_RECENT_SHELL_LINES + (/(?:\r\n|\r|\n)$/.test(combined) ? 1 : 0)
  return lines.length <= keepCount ? combined : lines.slice(-keepCount).join('\n')
}

function safeConnectionIp(value: string | undefined): string | undefined {
  try { return value ? normalizeSafeHostMemoryConnectionIp(value) : undefined } catch { return undefined }
}

function cloneDirectSessionRequest(request: DirectSessionRequest): DirectSessionRequest {
  if (request.auth.kind === 'password') {
    return { ...request, auth: { kind: 'password', password: request.auth.password } }
  }
  const content = request.auth.key.content
  return {
    ...request,
    auth: {
      kind: 'privateKey',
      key: {
        ...request.auth.key,
        ...(typeof content === 'string' ? { content } : { content: Buffer.from(content) }),
      },
    },
  }
}
