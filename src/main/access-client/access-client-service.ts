import { parseAccessClientArgv } from './argv-parser'
import { AccessSessionResolver } from './access-session-resolver'
import { createBridgeDiagnostics, extractBridgeLaunchMetadata, type BridgeDiagnostics, type BridgeLaunchMetadata } from './bridge-diagnostics'
import { AccessClientLaunchFailure } from './launch-failure'

export type AccessClientSessionOpener = {
  openSsh(request: { host: string; hostname?: string; port: number; username: string; password?: string; title: string; columns: number; rows: number; profileId?: string }): Promise<unknown>
  openRaw(request: { host: string; hostname?: string; port: number; title: string; columns: number; rows: number; profileId?: string }): Promise<unknown>
}

export class AccessClientService {
  constructor(
    private readonly resolver: AccessSessionResolver,
    private readonly sessions: AccessClientSessionOpener,
    private readonly diagnostics: BridgeDiagnostics = createBridgeDiagnostics(),
  ) {}

  async openFromArgv(argv: readonly string[]): Promise<unknown> {
    return this.openInvocation(argv, extractBridgeLaunchMetadata(argv))
  }

  async tryOpenFromArgv(argv: readonly string[]): Promise<boolean> {
    const invocationIndex = argv.findIndex(argument => argument.startsWith('@') || argument === '-load' || argument === '-raw')
    if (invocationIndex < 0) return false
    await this.openInvocation([argv[0] ?? 'Terminal-Agent.exe', ...argv.slice(invocationIndex)], extractBridgeLaunchMetadata(argv))
    return true
  }

  private async openInvocation(argv: readonly string[], metadata: BridgeLaunchMetadata | undefined): Promise<unknown> {
    try {
      const invocation = parseAccessClientArgv(argv)
      await this.diagnostics.record(metadata, 'invocation-parsed', { kind: invocation.kind })
      const resolution = await this.resolver.resolve(invocation)
      await this.diagnostics.record(metadata, 'profile-validated', {
        protocol: resolution.connection.protocol,
        port: resolution.connection.port,
      })
      await this.diagnostics.record(metadata, 'transport-opening', { protocol: resolution.connection.protocol })
      const session = resolution.connection.protocol === 'raw'
        ? await this.sessions.openRaw({
            host: resolution.connection.host,
            ...(resolution.connection.hostname ? { hostname: resolution.connection.hostname } : {}),
            port: resolution.connection.port,
            title: resolution.connection.title,
            columns: resolution.connection.columns,
            rows: resolution.connection.rows,
            profileId: resolution.persistentProfile.name,
          })
        : await this.sessions.openSsh({
            host: resolution.connection.host,
            ...(resolution.connection.hostname ? { hostname: resolution.connection.hostname } : {}),
            port: resolution.connection.port,
            username: resolution.connection.username ?? '',
            password: resolution.connection.password,
            title: resolution.connection.title,
            columns: resolution.connection.columns,
            rows: resolution.connection.rows,
            profileId: resolution.persistentProfile.name,
          })
      await this.diagnostics.record(metadata, 'session-opened', {
        protocol: resolution.connection.protocol,
        sessionId: sessionId(session),
      })
      return session
    } catch (error) {
      const failure = error instanceof AccessClientLaunchFailure
        ? error
        : new AccessClientLaunchFailure('transport-connect-failed')
      await this.diagnostics.record(metadata, 'launch-failed', { category: failure.code })
      throw failure
    }
  }
}

function sessionId(value: unknown): string {
  if (!value || typeof value !== 'object' || typeof (value as { id?: unknown }).id !== 'string') return 'unknown'
  return (value as { id: string }).id
}
