import type { AccessClientInvocation } from './argv-parser'
import { type SavedSessionProfile, type SavedSessionStore } from './saved-session-repository'
import { type TemporarySessionProfile } from './temp-session-reader'

export type AccessConnection = {
  host: string
  port: number
  username?: string
  protocol: 'ssh' | 'raw'
  password?: string
  columns: number
  rows: number
  title: string
}

export type AccessSessionResolution = {
  connection: AccessConnection
  persistentProfile: SavedSessionProfile
}

export class AccessSessionResolver {
  constructor(
    private readonly savedSessions: SavedSessionStore,
    private readonly loadTemporary: (path: string) => Promise<TemporarySessionProfile>,
  ) {}

  async resolve(invocation: AccessClientInvocation): Promise<AccessSessionResolution> {
    if (invocation.kind === 'saved-session') {
      const profile = await this.savedSessions.load(invocation.name)
      return { connection: connectionFromProfile(profile), persistentProfile: profile }
    }
    if (invocation.kind === 'temporary-session') {
      const profile = await this.loadTemporary(invocation.path)
      const persistentProfile: SavedSessionProfile = { ...profile, name: profile.title }
      return {
        connection: { ...connectionFromProfile(profile), ...(invocation.password ? { password: invocation.password } : {}) },
        persistentProfile,
      }
    }
    const persistentProfile: SavedSessionProfile = {
      name: `raw:${invocation.port}`,
      host: '127.0.0.1',
      port: invocation.port,
      username: '',
      protocol: 'raw',
      title: `Raw ${invocation.port}`,
      columns: 80,
      rows: 24,
    }
    return { connection: connectionFromProfile(persistentProfile), persistentProfile }
  }
}

function connectionFromProfile(profile: TemporarySessionProfile): AccessConnection {
  return {
    host: profile.protocol === 'raw' && !profile.host ? '127.0.0.1' : profile.host,
    port: profile.port,
    ...(profile.username ? { username: profile.username } : {}),
    protocol: profile.protocol,
    columns: profile.columns,
    rows: profile.rows,
    title: profile.title,
  }
}
