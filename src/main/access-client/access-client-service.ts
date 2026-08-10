import { parseAccessClientArgv } from './argv-parser'
import { AccessSessionResolver } from './access-session-resolver'

export type AccessClientSessionOpener = {
  openSsh(request: { host: string; port: number; username: string; password?: string; title: string; columns: number; rows: number }): Promise<unknown>
  openRaw(request: { host: string; port: number; title: string; columns: number; rows: number }): Promise<unknown>
}

export class AccessClientService {
  constructor(
    private readonly resolver: AccessSessionResolver,
    private readonly sessions: AccessClientSessionOpener,
  ) {}

  async openFromArgv(argv: readonly string[]): Promise<unknown> {
    const resolution = await this.resolver.resolve(parseAccessClientArgv(argv))
    if (resolution.connection.protocol === 'raw') {
      return this.sessions.openRaw({
        host: resolution.connection.host,
        port: resolution.connection.port,
        title: resolution.connection.title,
        columns: resolution.connection.columns,
        rows: resolution.connection.rows,
      })
    }
    return this.sessions.openSsh({
      host: resolution.connection.host,
      port: resolution.connection.port,
      username: resolution.connection.username ?? '',
      password: resolution.connection.password,
      title: resolution.connection.title,
      columns: resolution.connection.columns,
      rows: resolution.connection.rows,
    })
  }

  async tryOpenFromArgv(argv: readonly string[]): Promise<boolean> {
    const invocationIndex = argv.findIndex(argument => argument.startsWith('@') || argument === '-load' || argument === '-raw')
    if (invocationIndex < 0) return false
    await this.openFromArgv([argv[0] ?? 'Terminal-Agent.exe', ...argv.slice(invocationIndex)])
    return true
  }
}
