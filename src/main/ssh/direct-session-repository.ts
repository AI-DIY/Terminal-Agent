import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export type DirectSessionAuth =
  | { kind: 'password'; password: string }
  | { kind: 'privateKey'; privateKeyPath: string; passphrase?: string }

export type DirectSessionProfile = {
  id: string
  name: string
  host: string
  port: number
  username: string
  auth: DirectSessionAuth
}

export type DirectSessionSummary = {
  id: string
  name: string
  host: string
  port: number
  username: string
  authKind: DirectSessionAuth['kind']
  privateKeyPath?: string
}

type StoredProfile = DirectSessionSummary

type SecretStore = {
  load(key: string): Promise<string | null>
  save(key: string, value: string): Promise<void>
  remove(key: string): Promise<void>
}

export class FileDirectSessionRepository {
  private readonly profiles = new Map<string, StoredProfile>()
  private loaded = false
  private loading: Promise<void> | undefined
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly path: string,
    private readonly secrets: SecretStore,
  ) {}

  async list(): Promise<DirectSessionSummary[]> {
    await this.ensureLoaded()
    return [...this.profiles.values()]
      .map(profile => ({ ...profile }))
      .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
  }

  async load(id: string): Promise<DirectSessionProfile> {
    await this.ensureLoaded()
    const profile = this.profiles.get(id)
    if (!profile) throw new Error(`Saved direct SSH session not found: ${id}`)
    if (profile.authKind === 'password') {
      const password = await this.secrets.load(secretKey(id, 'password'))
      if (password === null) throw new Error(`Saved direct SSH session credential is unavailable: ${id}`)
      return directPasswordProfile(profile, password)
    }

    const passphrase = await this.secrets.load(secretKey(id, 'passphrase'))
    return directPrivateKeyProfile(profile, passphrase)
  }

  async save(profile: DirectSessionProfile): Promise<void> {
    const stored = toStoredProfile(profile)
    const write = this.writeQueue.then(async () => {
      await this.ensureLoaded()
      if (profile.auth.kind === 'password') {
        await this.secrets.save(secretKey(profile.id, 'password'), profile.auth.password)
        await this.secrets.remove(secretKey(profile.id, 'passphrase'))
      } else {
        await this.secrets.remove(secretKey(profile.id, 'password'))
        if (profile.auth.passphrase) {
          await this.secrets.save(secretKey(profile.id, 'passphrase'), profile.auth.passphrase)
        } else {
          await this.secrets.remove(secretKey(profile.id, 'passphrase'))
        }
      }
      this.profiles.set(stored.id, stored)
      await this.writeToDisk()
    })
    this.writeQueue = write.catch(() => undefined)
    return write
  }

  async remove(id: string): Promise<void> {
    const write = this.writeQueue.then(async () => {
      await this.ensureLoaded()
      this.profiles.delete(id)
      await this.secrets.remove(secretKey(id, 'password'))
      await this.secrets.remove(secretKey(id, 'passphrase'))
      await this.writeToDisk()
    })
    this.writeQueue = write.catch(() => undefined)
    return write
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    if (this.loading) return this.loading
    this.loading = this.loadFromDisk()
    try {
      await this.loading
    } finally {
      this.loading = undefined
    }
  }

  private async loadFromDisk(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, 'utf8'))
      if (!Array.isArray(parsed)) throw new Error('Invalid direct SSH session store')
      for (const value of parsed) {
        const profile = projectStoredProfile(value)
        this.profiles.set(profile.id, profile)
      }
      this.loaded = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.loaded = true
        return
      }
      if ((error as Error).message === 'Invalid direct SSH session store') throw error
      throw new Error('Invalid direct SSH session store', { cause: error })
    }
  }

  private async writeToDisk(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`
    await writeFile(temporaryPath, JSON.stringify([...this.profiles.values()]), 'utf8')
    await rename(temporaryPath, this.path)
  }
}

function toStoredProfile(profile: DirectSessionProfile): StoredProfile {
  assertText(profile.id)
  assertText(profile.name)
  assertText(profile.host)
  assertText(profile.username)
  if (!isPort(profile.port)) throw new Error('Invalid direct SSH session')
  if (profile.auth.kind === 'password') return {
    id: profile.id, name: profile.name.trim(), host: profile.host.trim(), port: profile.port, username: profile.username.trim(), authKind: 'password',
  }
  assertText(profile.auth.privateKeyPath)
  return {
    id: profile.id, name: profile.name.trim(), host: profile.host.trim(), port: profile.port, username: profile.username.trim(),
    authKind: 'privateKey', privateKeyPath: profile.auth.privateKeyPath,
  }
}

function projectStoredProfile(value: unknown): StoredProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid direct SSH session store')
  const profile = value as Record<string, unknown>
  if (
    typeof profile.id !== 'string' || !profile.id.trim()
    || typeof profile.name !== 'string' || !profile.name.trim()
    || typeof profile.host !== 'string' || !profile.host.trim()
    || typeof profile.username !== 'string' || !profile.username.trim()
    || !isPort(profile.port)
    || (profile.authKind !== 'password' && profile.authKind !== 'privateKey')
    || (profile.authKind === 'privateKey' && (typeof profile.privateKeyPath !== 'string' || !profile.privateKeyPath.trim()))
  ) throw new Error('Invalid direct SSH session store')
  return {
    id: profile.id,
    name: profile.name,
    host: profile.host,
    port: profile.port,
    username: profile.username,
    authKind: profile.authKind,
    ...(profile.authKind === 'privateKey' ? { privateKeyPath: profile.privateKeyPath as string } : {}),
  }
}

function secretKey(id: string, kind: 'password' | 'passphrase'): string {
  return `direct-session:${id}:${kind}`
}

function directPasswordProfile(profile: StoredProfile, password: string): DirectSessionProfile {
  return {
    id: profile.id,
    name: profile.name,
    host: profile.host,
    port: profile.port,
    username: profile.username,
    auth: { kind: 'password', password },
  }
}

function directPrivateKeyProfile(profile: StoredProfile, passphrase: string | null): DirectSessionProfile {
  return {
    id: profile.id,
    name: profile.name,
    host: profile.host,
    port: profile.port,
    username: profile.username,
    auth: {
      kind: 'privateKey',
      privateKeyPath: profile.privateKeyPath!,
      ...(passphrase !== null ? { passphrase } : {}),
    },
  }
}

function assertText(value: string): void {
  if (!value.trim()) throw new Error('Invalid direct SSH session')
}

function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65_535
}
