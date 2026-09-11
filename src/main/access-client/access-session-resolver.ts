import type { AccessClientInvocation } from './argv-parser'
import { type SavedSessionProfile, type SavedSessionStore } from './saved-session-repository'
import { type TemporarySessionProfile } from './temp-session-reader'
import { hostHintFromTitle } from '../../shared/shell-display-label'

export type AccessConnection = {
  host: string
  /** The actual target identity when a bastion transports through a relay IP. */
  hostname?: string
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
  const host = profile.protocol === 'raw' && !profile.host ? '127.0.0.1' : profile.host
  const hostname = targetHostname(profile.host, profile.title)
  return {
    host,
    // Preserve the transport address for connection setup. Only provide a
    // separate identity when the profile exposes a target distinct from that
    // address, which is the normal AccessClient relay case.
    ...(hostname && !sameHostname(hostname, host) ? { hostname } : {}),
    port: profile.port,
    ...(profile.username ? { username: profile.username } : {}),
    protocol: profile.protocol,
    columns: profile.columns,
    rows: profile.rows,
    title: profile.title,
  }
}

function targetHostname(host: string, title: string): string | undefined {
  // AccessClient profiles often use one relay address (or 127.0.0.1) for every
  // target, so the logical destination has to come from the session label.
  // Only a conservative, explicitly host-like label counts: a saved profile
  // whose title is merely its own name must never shadow the real host.
  const fromTitle = normalizeHostname(hostHintFromTitle(title) ?? '')
  if (fromTitle && !sameHostname(fromTitle, host)) return fromTitle
  return normalizeHostname(host)
}

function normalizeHostname(value: string): string | undefined {
  const candidate = value.trim().replace(/^\[|\]$/g, '')
  if (!candidate || /\s/.test(candidate) || isIpLiteral(candidate)) return undefined
  return /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,253}[A-Za-z0-9])?$/.test(candidate)
    ? candidate.toLowerCase()
    : undefined
}

function sameHostname(left: string, right: string): boolean {
  return left.trim().replace(/\.$/, '').toLowerCase() === right.trim().replace(/\.$/, '').toLowerCase()
}

function isIpLiteral(value: string): boolean {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return value.split('.').every(part => Number(part) <= 255)
  return value.includes(':') && /^[0-9a-f:%]+$/i.test(value)
}
