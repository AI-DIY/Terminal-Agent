import type { SessionMode } from '../../shared/contracts'
import { StringDecoder } from 'node:string_decoder'
import { AccessClientLaunchFailure } from '../access-client/launch-failure'
import type { PrivateKeyInput } from './private-key-loader'
import type { SshClientPort, SshConnection, SshShell } from './ssh-client-port'

export type DirectSessionRequest = {
  host: string
  port: number
  username: string
  auth: { kind: 'password'; password: string } | { kind: 'privateKey'; key: PrivateKeyInput }
}

export type ConnectedSession = {
  id: string
  hostname: string
  observedHostname?: string
  title?: string
  mode: SessionMode
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
}

export type RawSessionRequest = {
  host: string
  port: number
  title?: string
  columns?: number
  rows?: number
}

type PrivateKeyLoader = {
  load(input: PrivateKeyInput): Promise<string | Buffer>
}

type ActiveSession = {
  connection: SshConnection
  shell: SshShell
  decoder: StringDecoder
  summary: ConnectedSession
  supportsReadOnlyObservation: boolean
}

export class SessionService {
  private readonly sessions = new Map<string, ActiveSession>()
  private readonly dataListeners = new Set<(event: TerminalDataEvent) => void>()
  private readonly closedListeners = new Set<(event: TerminalClosedEvent) => void>()
  private readonly openedListeners = new Set<(session: ConnectedSession) => void>()
  private readonly updatedListeners = new Set<(session: ConnectedSession) => void>()
  private nextId = 1

  constructor(
    private readonly client: SshClientPort,
    private readonly privateKeyLoader: PrivateKeyLoader,
    private readonly rawClient?: SshClientPort,
  ) {}

  async connect(request: DirectSessionRequest): Promise<ConnectedSession> {
    return this.connectWithClient(this.client, await this.toSshOptions(request), { hostname: request.host }, true)
  }

  async connectAccessSsh(request: AccessSshSessionRequest): Promise<ConnectedSession> {
    return this.connectAccessClientWith(this.client, {
      host: request.host,
      port: request.port,
      username: request.username,
      ...(request.password !== undefined ? { password: request.password } : {}),
    }, {
      hostname: request.host,
      title: request.title,
      columns: request.columns,
      rows: request.rows,
    }, true)
  }

  async connectRaw(request: RawSessionRequest): Promise<ConnectedSession> {
    if (!this.rawClient) throw new Error('Raw terminal transport is unavailable')
    return this.connectAccessClientWith(this.rawClient, {
      host: request.host,
      port: request.port,
    }, {
      hostname: request.host,
      title: request.title,
      columns: request.columns,
      rows: request.rows,
    }, false)
  }

  private async connectWithClient(
    client: SshClientPort,
    options: { host: string; port: number; username?: string; password?: string; privateKey?: string | Buffer; passphrase?: string },
    sessionOptions: { hostname: string; title?: string; columns?: number; rows?: number },
    supportsReadOnlyObservation: boolean,
  ): Promise<ConnectedSession> {
    const connection = await client.connect(options)
    return this.openConnectedSession(connection, sessionOptions, supportsReadOnlyObservation)
  }

  private async connectAccessClientWith(
    client: SshClientPort,
    options: { host: string; port: number; username?: string; password?: string },
    sessionOptions: { hostname: string; title?: string; columns?: number; rows?: number },
    supportsReadOnlyObservation: boolean,
  ): Promise<ConnectedSession> {
    let connection: SshConnection
    try {
      connection = await client.connect(options)
    } catch {
      throw new AccessClientLaunchFailure('transport-connect-failed')
    }
    try {
      return await this.openConnectedSession(connection, sessionOptions, supportsReadOnlyObservation)
    } catch {
      throw new AccessClientLaunchFailure('terminal-open-failed')
    }
  }

  private async openConnectedSession(
    connection: SshConnection,
    sessionOptions: { hostname: string; title?: string; columns?: number; rows?: number },
    supportsReadOnlyObservation: boolean,
  ): Promise<ConnectedSession> {
    const id = `s${this.nextId++}`
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
    }
    this.sessions.set(id, { connection, shell, decoder, summary, supportsReadOnlyObservation })
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
    session.shell.close()
    this.finish(sessionId)
  }

  write(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error('Unknown terminal session')
    }
    session.shell.write(data)
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
    session.summary = { ...session.summary, observedHostname }
    for (const listener of this.updatedListeners) listener({ ...session.summary })
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
    return session.connection.execute(command)
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

  onUpdated(listener: (session: ConnectedSession) => void): () => void {
    this.updatedListeners.add(listener)
    return () => this.updatedListeners.delete(listener)
  }

  snapshot(): ConnectedSession[] {
    return [...this.sessions.values()].map(session => ({ ...session.summary }))
  }

  closeAll(): void {
    for (const sessionId of [...this.sessions.keys()]) {
      this.close(sessionId)
    }
  }

  private finish(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    this.publishData(sessionId, session.decoder.end())
    this.sessions.delete(sessionId)
    session.connection.close()
    const event = { sessionId }
    for (const listener of this.closedListeners) {
      listener(event)
    }
  }

  private publishData(sessionId: string, data: string): void {
    if (!data) return
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
