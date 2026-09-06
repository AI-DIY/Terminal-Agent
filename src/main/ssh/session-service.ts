import type { SessionMode } from '../../shared/contracts'
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import { AccessClientLaunchFailure } from '../access-client/launch-failure'
import type { PrivateKeyInput } from './private-key-loader'
import type { SshClientPort, SshConnection, SshDirectoryEntry, SshFileTransferProgress, SshShell } from './ssh-client-port'
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

/** Result of an internal plan-command completion probe. */
export type SessionCommandCompletion = {
  /** True when the remote shell emitted the private completion probe. */
  completed: boolean
  /** True when the bounded wait elapsed before the probe was observed. */
  timedOut: boolean
}

export const DEFAULT_COMMAND_COMPLETION_TIMEOUT_MS = 5 * 60 * 1_000
const MAX_RETAINED_COMPLETION_PROBE_FILTERS = 16

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
  completionWaiters: Set<CommandCompletionWaiter>
}

type CommandCompletionWaiter = {
  token: string
  tail: string
  resolve: (result: SessionCommandCompletion) => void
  timer: ReturnType<typeof setTimeout>
  /** The caller may already have received a timeout while we hide a late probe. */
  resolved: boolean
}

/** Default tail returned when callers do not request a specific line count. */
export const DEFAULT_RECENT_SHELL_LINES = 200
/**
 * Upper bound for the in-memory terminal tail used by AI context requests.
 * This is a resource-safety limit, not a user-facing line-count limit: a
 * request may ask for any number of lines and receives as many as remain in
 * this bounded tail.
 */
export const MAX_RECENT_SHELL_CHARS = 2_000_000

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
    this.sessions.set(id, { connection, shell, decoder, summary, connectionType, supportsReadOnlyObservation, reconnectReference, recentOutput: '', completionWaiters: new Set(), ...(connectionIp ? { connectionIp } : {}) })
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
    this.publishWrite({ sessionId, data })
  }

  /**
   * Write one reviewed command and wait until the interactive shell has
   * finished it. Interactive SSH channels do not expose a portable exit
   * event, so a private `echo` probe is queued after the command. The probe
   * is consumed before terminal data reaches the renderer or history; callers
   * therefore see the original command and its real output only.
   */
  async writeAndWaitForCompletion(
    sessionId: string,
    command: string,
    timeoutMs = DEFAULT_COMMAND_COMPLETION_TIMEOUT_MS,
  ): Promise<SessionCommandCompletion> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('Unknown terminal session')
    if (!this.supportsCommandCompletion(sessionId)) {
      throw new Error('Command completion is unavailable for this terminal session')
    }
    const timeout = normalizeCompletionTimeout(timeoutMs)
    const token = `__TA_COMMAND_COMPLETE_${randomUUID().replaceAll('-', '')}__`
    let resolve!: (result: SessionCommandCompletion) => void
    const result = new Promise<SessionCommandCompletion>(resolveResult => { resolve = resolveResult })
    const waiter: CommandCompletionWaiter = {
      token,
      tail: '',
      resolve,
      timer: setTimeout(() => this.finishCompletionWaiter(sessionId, waiter, { completed: false, timedOut: true }), timeout),
      resolved: false,
    }
    waiter.timer.unref?.()
    session.completionWaiters.add(waiter)
    const commandInput = ensureTrailingLineEnding(command)
    // A trailing POSIX backslash, cmd caret, or PowerShell backtick would
    // otherwise join our private probe to the reviewed command. A blank line
    // terminates that incomplete input before the probe is sent.
    const completionSeparator = hasUnescapedTrailingLineContinuation(commandInput) ? '\n' : ''
    try {
      // `echo` is available in the POSIX, cmd, and PowerShell shells commonly
      // used behind direct SSH and AccessClient connections. It is sent in the
      // same PTY stream so the shell executes it only after the command.
      session.shell.write(`${commandInput}${completionSeparator}echo ${token}\n`)
      this.publishWrite({ sessionId, data: commandInput })
    } catch (error) {
      this.removeCompletionWaiter(session, waiter)
      throw error
    }
    return result
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

  async listDirectory(sessionId: string, remotePath: string): Promise<readonly SshDirectoryEntry[]> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('Unknown terminal session')
    if (!session.connection.fileTransfer?.listDirectory) throw new Error('当前 SSH 会话不支持 SFTP 文件传输。')
    return session.connection.fileTransfer.listDirectory(remotePath)
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

  recentLines(sessionId: string, limit = DEFAULT_RECENT_SHELL_LINES): string[] {
    const output = this.sessions.get(sessionId)?.recentOutput
    if (output === undefined) return []
    const lines = output.split(/\r?\n|\r/)
    if (lines.at(-1) === '') lines.pop()
    // The AI workspace setting intentionally has no artificial upper bound.
    // Keep the historical 200-line default for callers that omit `limit`, but
    // honour any explicit non-negative integer requested by the renderer.
    const boundedLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : DEFAULT_RECENT_SHELL_LINES
    return boundedLimit === 0 ? [] : lines.slice(-boundedLimit)
  }

  supportsReadOnlyObservation(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    return Boolean(session?.supportsReadOnlyObservation && session.connection.execute)
  }

  /**
   * Interactive SSH shells can be fenced with a private echo probe. Raw TCP
   * AccessClient sessions may speak an arbitrary protocol, so never inject
   * shell syntax into them.
   */
  supportsCommandCompletion(sessionId: string): boolean {
    const connectionType = this.sessions.get(sessionId)?.connectionType
    return connectionType === 'direct-ssh' || connectionType === 'access-client-ssh'
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
    for (const waiter of [...session.completionWaiters]) {
      this.finishCompletionWaiter(sessionId, waiter, { completed: false, timedOut: false })
    }
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
    if (!session) return
    let visible = data
    for (const waiter of [...session.completionWaiters]) {
      const consumed = consumeCompletionProbe(waiter, visible)
      visible = consumed.data
      if (consumed.completed) {
        this.finishCompletionWaiter(sessionId, waiter, { completed: true, timedOut: false })
      }
    }
    this.publishVisibleData(sessionId, visible)
  }

  private publishWrite(event: TerminalWriteEvent): void {
    for (const listener of this.writeListeners) listener(event)
  }

  private finishCompletionWaiter(sessionId: string, waiter: CommandCompletionWaiter, result: SessionCommandCompletion): void {
    const session = this.sessions.get(sessionId)
    if (!session?.completionWaiters.has(waiter)) return
    // A shell can emit the queued probe shortly after the bounded wait expires.
    // Keep a timed-out waiter as a filter so that private probe does not leak
    // into the terminal, recent-output context, or a later user turn. It is
    // removed as soon as the probe arrives (or the session closes).
    const retainAsLateProbeFilter = result.timedOut && !result.completed
    if (retainAsLateProbeFilter) clearTimeout(waiter.timer)
    else this.removeCompletionWaiter(session, waiter)
    // A timeout can leave a short suffix that was held while checking for a
    // split marker. Flush it as ordinary terminal output before resolving.
    if (waiter.tail) {
      const tail = stripCompletionProbeTail(waiter.tail, waiter.token)
      waiter.tail = ''
      this.publishVisibleData(sessionId, tail)
    }
    if (!waiter.resolved) {
      waiter.resolved = true
      waiter.resolve(result)
    }
    if (retainAsLateProbeFilter) this.trimRetainedCompletionProbeFilters(sessionId, session, waiter)
  }

  private removeCompletionWaiter(session: ActiveSession, waiter: CommandCompletionWaiter): void {
    session.completionWaiters.delete(waiter)
    clearTimeout(waiter.timer)
  }

  private trimRetainedCompletionProbeFilters(sessionId: string, session: ActiveSession, current: CommandCompletionWaiter): void {
    const retained = [...session.completionWaiters].filter(waiter => waiter.resolved && waiter !== current)
    while (retained.length >= MAX_RETAINED_COMPLETION_PROBE_FILTERS) {
      const oldest = retained.shift()!
      this.removeCompletionWaiter(session, oldest)
      if (oldest.tail) {
        const tail = stripCompletionProbeTail(oldest.tail, oldest.token)
        oldest.tail = ''
        this.publishVisibleData(sessionId, tail)
      }
    }
  }

  private publishVisibleData(sessionId: string, data: string): void {
    if (!data) return
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.recentOutput = appendRecentShellOutput(session.recentOutput, data)
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
  // Keep a finite character tail so a noisy/long-lived connection cannot grow
  // the main-process heap without bound.  The limit is deliberately expressed
  // in characters rather than logical lines: callers can request any line
  // count, up to whatever complete output remains in this safety buffer.
  const combined = `${previous}${data}`
  if (combined.length <= MAX_RECENT_SHELL_CHARS) return combined
  return combined.slice(-MAX_RECENT_SHELL_CHARS)
}

const COMPLETION_PROBE_TAIL_CHARS = 256
const ANSI_ESCAPE = String.fromCharCode(0x1b)

function normalizeCompletionTimeout(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(value)) : DEFAULT_COMMAND_COMPLETION_TIMEOUT_MS
}

function ensureTrailingLineEnding(command: string): string {
  const value = typeof command === 'string' ? command : String(command)
  return /(?:\r\n|\r|\n)$/.test(value) ? value : `${value}\n`
}

/**
 * Keep a small rolling suffix while looking for a completion token. Complete
 * ordinary output lines stream straight to the UI; only the current line is
 * retained so an echoed probe split across transport chunks can be removed.
 */
function consumeCompletionProbe(
  waiter: CommandCompletionWaiter,
  data: string,
): { data: string; completed: boolean } {
  const combined = `${waiter.tail}${data}`
  const markerIndex = completionTokenIndex(combined, waiter.token)
  if (markerIndex >= 0) {
    waiter.tail = ''
    return { data: stripCompletionProbeArtifacts(combined, waiter.token), completed: true }
  }
  // Keep a marker ending with a lone CR until the following transport chunk
  // tells us whether it is the first half of CRLF. Otherwise the marker can
  // be consumed with CR and leave an orphaned LF in terminal output.
  const pendingProbeLineStart = pendingCompletionProbeLineStart(combined, waiter.token)
  if (pendingProbeLineStart !== undefined) {
    waiter.tail = combined.slice(pendingProbeLineStart)
    return {
      data: stripEchoProbeLine(combined.slice(0, pendingProbeLineStart), waiter.token),
      completed: false,
    }
  }
  const lastLineBreak = Math.max(combined.lastIndexOf('\n'), combined.lastIndexOf('\r'))
  if (lastLineBreak >= 0) {
    const completedLines = combined.slice(0, lastLineBreak + 1)
    waiter.tail = combined.slice(lastLineBreak + 1)
    return {
      data: stripEchoProbeLine(completedLines, waiter.token),
      completed: false,
    }
  }
  if (combined.length <= COMPLETION_PROBE_TAIL_CHARS) {
    waiter.tail = combined
    return { data: '', completed: false }
  }
  const emitLength = combined.length - COMPLETION_PROBE_TAIL_CHARS
  waiter.tail = combined.slice(emitLength)
  return {
    data: stripEchoProbeLine(combined.slice(0, emitLength), waiter.token),
    completed: false,
  }
}

function completionTokenIndex(value: string, token: string): number {
  let from = 0
  while (true) {
    const index = value.indexOf(token, from)
    if (index < 0) return -1
    const lineEndCandidates = [value.indexOf('\n', index + token.length), value.indexOf('\r', index + token.length)].filter(item => item >= 0)
    // A token at a transport-chunk boundary may be split from its newline.
    // Keep it pending until the line terminator arrives.
    if (lineEndCandidates.length === 0) return -1
    const lineEnd = Math.min(...lineEndCandidates)
    if (value[lineEnd] === '\r' && lineEnd + 1 === value.length) return -1
    const after = stripAnsi(value.slice(index + token.length, lineEnd)).trim()
    // A command such as `printf result` can leave the cursor on its output
    // line. The probe's real echo then becomes `result<TOKEN>`, so a marker
    // must not require a blank prefix. Conversely, the PTY may echo the
    // *input* `echo <TOKEN>` first; that only proves the probe was typed, not
    // that the shell has completed it, and must be ignored here.
    if (!after && !isEchoProbeInput(value, index)) return index
    from = index + token.length
  }
}

function pendingCompletionProbeLineStart(value: string, token: string): number | undefined {
  let from = 0
  while (true) {
    const index = value.indexOf(token, from)
    if (index < 0) return undefined
    const lineEndCandidates = [value.indexOf('\n', index + token.length), value.indexOf('\r', index + token.length)].filter(item => item >= 0)
    const lineStart = Math.max(value.lastIndexOf('\n', index - 1), value.lastIndexOf('\r', index - 1)) + 1
    if (lineEndCandidates.length === 0) return lineStart
    const lineEnd = Math.min(...lineEndCandidates)
    if (value[lineEnd] === '\r' && lineEnd + 1 === value.length) return lineStart
    from = index + token.length
  }
}

function stripCompletionProbeArtifacts(value: string, token: string): string {
  const markerIndex = completionTokenIndex(value, token)
  if (markerIndex < 0) return stripEchoProbeLine(value, token)
  const lineEndCandidates = [value.indexOf('\n', markerIndex + token.length), value.indexOf('\r', markerIndex + token.length)].filter(item => item >= 0)
  const lineEnd = Math.min(...lineEndCandidates)
  const lineEndingLength = value[lineEnd] === '\r' && value[lineEnd + 1] === '\n' ? 2 : 1
  // Some terminals wrap output in CSI/OSC control sequences. Remove a control
  // sequence attached directly to the hidden token as well, otherwise an
  // orphaned escape can affect the next visible prompt.
  const prefix = stripTrailingTerminalControls(value.slice(0, markerIndex))
  return stripEchoProbeLine(`${prefix}${value.slice(lineEnd + lineEndingLength)}`, token)
}

function stripEchoProbeLine(value: string, token: string): string {
  // The PTY may echo the probe input after a command emitted a partial line.
  // Remove only the probe itself, never the line prefix: `printf result` must
  // remain visible and available to the follow-up analysis.
  const pattern = new RegExp(`echo[\\t ]+${escapeRegExp(token)}[^\\r\\n]*(?:\\r\\n|\\r|\\n|$)`, 'gi')
  return value.replace(pattern, '')
}

/** Hide a complete (or echoed) private probe while flushing a timed-out tail. */
function stripCompletionProbeTail(value: string, token: string): string {
  const withoutCompleteProbe = stripEchoProbeLine(value, token).replaceAll(token, '')
  const prefixLength = trailingTokenPrefixLength(withoutCompleteProbe, token)
  if (prefixLength === 0) return withoutCompleteProbe
  const beforeTokenPrefix = withoutCompleteProbe.slice(0, -prefixLength)
  // If a timeout lands between the echoed `echo ` input and the private token,
  // remove that incomplete input too while preserving any preceding command
  // output on the same terminal line.
  if (/echo[\t ]+$/i.test(stripAnsi(beforeTokenPrefix))) {
    return beforeTokenPrefix.replace(/echo[\t ]+$/i, '')
  }
  return beforeTokenPrefix
}

function trailingTokenPrefixLength(value: string, token: string): number {
  const maximum = Math.min(value.length, token.length - 1)
  for (let length = maximum; length > 0; length -= 1) {
    if (value.endsWith(token.slice(0, length))) return length
  }
  return 0
}

function isEchoProbeInput(value: string, tokenIndex: number): boolean {
  const lineStart = Math.max(value.lastIndexOf('\n', tokenIndex - 1), value.lastIndexOf('\r', tokenIndex - 1)) + 1
  return /echo[\t ]+$/i.test(stripAnsi(value.slice(lineStart, tokenIndex)))
}

function hasUnescapedTrailingLineContinuation(value: string): boolean {
  const withoutLineEnd = value.replace(/(?:\r\n|\r|\n)+$/, '')
  const continuation = withoutLineEnd.at(-1)
  if (continuation !== '\\' && continuation !== '^' && continuation !== '`') return false
  let count = 0
  for (let index = withoutLineEnd.length - 1; index >= 0 && withoutLineEnd[index] === continuation; index -= 1) count += 1
  return count % 2 === 1
}

function stripAnsi(value: string): string {
  return value
    .replace(new RegExp(`${ANSI_ESCAPE}\\[[0-?]*[ -/]*[@-~]`, 'g'), '')
    .replace(new RegExp(`${ANSI_ESCAPE}\\][^${ANSI_ESCAPE}\\x07]*(?:\\x07|${ANSI_ESCAPE}\\\\)`, 'g'), '')
}

function stripTrailingTerminalControls(value: string): string {
  const csi = `${ANSI_ESCAPE}\\[[0-?]*[ -/]*[@-~]`
  const osc = `${ANSI_ESCAPE}\\][^${ANSI_ESCAPE}\\x07]*(?:\\x07|${ANSI_ESCAPE}\\\\)`
  return value.replace(new RegExp(`(?:${csi}|${osc})+$`), '')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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
