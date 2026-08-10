import type { TemporarySessionProfile } from './temp-session-reader'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

export type SavedSessionProfile = TemporarySessionProfile & {
  name: string
}

export type SavedSessionStore = {
  load(name: string): Promise<SavedSessionProfile>
  save(profile: SavedSessionProfile): Promise<void>
}

export class SavedSessionRepository implements SavedSessionStore {
  private readonly profiles = new Map<string, SavedSessionProfile>()

  constructor(profiles: readonly SavedSessionProfile[] = []) {
    for (const profile of profiles) {
      const sanitized = projectSavedSessionProfile(profile)
      this.profiles.set(sanitized.name, sanitized)
    }
  }

  async load(name: string): Promise<SavedSessionProfile> {
    const profile = this.profiles.get(name)
    if (!profile) throw new Error(`AccessClient session not found: ${name}`)
    return { ...profile }
  }

  async save(profile: SavedSessionProfile): Promise<void> {
    const sanitized = projectSavedSessionProfile(profile)
    this.profiles.set(sanitized.name, sanitized)
  }

  all(): SavedSessionProfile[] {
    return [...this.profiles.values()].map(profile => ({ ...profile }))
  }
}

export class FileSavedSessionRepository implements SavedSessionStore {
  private readonly memory = new SavedSessionRepository()
  private loaded = false
  private loading: Promise<void> | undefined
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(private readonly path: string) {}

  async load(name: string): Promise<SavedSessionProfile> {
    await this.ensureLoaded()
    return this.memory.load(name)
  }

  async save(profile: SavedSessionProfile): Promise<void> {
    const write = this.writeQueue.then(async () => {
      await this.ensureLoaded()
      await this.memory.save(profile)
      const temporaryPath = `${this.path}.${randomUUID()}.tmp`
      await writeFile(temporaryPath, JSON.stringify(this.memory.all()), 'utf8')
      await rename(temporaryPath, this.path)
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
      if (!Array.isArray(parsed)) throw new Error('Invalid saved AccessClient session store')
      const profiles = parsed.map(projectSavedSessionProfile)
      for (const profile of profiles) {
        await this.memory.save(profile)
      }
      this.loaded = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.loaded = true
        return
      }
      if ((error as Error).message === 'Invalid saved AccessClient session store') throw error
      throw new Error('Invalid saved AccessClient session store', { cause: error })
    }
  }
}

function projectSavedSessionProfile(value: unknown): SavedSessionProfile {
  if (!value || typeof value !== 'object') throw new Error('Invalid saved AccessClient session store')
  const profile = value as Record<string, unknown>
  const name = profile.name
  const host = profile.host
  const port = profile.port
  const username = profile.username
  const protocol = profile.protocol
  const title = profile.title
  const columns = profile.columns
  const rows = profile.rows
  const lineCodePage = profile.lineCodePage
  if (
    !hasText(name)
    || typeof host !== 'string'
    || !isPort(port)
    || typeof username !== 'string'
    || (protocol !== 'ssh' && protocol !== 'raw')
    || !hasText(title)
    || !isDimension(columns)
    || !isDimension(rows)
    || (lineCodePage !== undefined && !hasText(lineCodePage))
    || (protocol === 'ssh' && (!hasText(host) || !hasText(username)))
  ) {
    throw new Error('Invalid saved AccessClient session store')
  }
  return {
    name,
    host,
    port,
    username,
    protocol,
    title,
    columns,
    rows,
    ...(lineCodePage !== undefined ? { lineCodePage } : {}),
  }
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65_535
}

function isDimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 500
}
