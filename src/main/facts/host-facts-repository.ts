import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { HostFacts, HostProcess } from '../observation/observation-schema'
import { normalizeHostname } from './host-facts-service'

export type HostFactsRepository = {
  load(hostname: string): Promise<HostFacts | null>
  save(facts: HostFacts): Promise<void>
}

export class FileHostFactsRepository implements HostFactsRepository {
  private readonly factsByHostname = new Map<string, HostFacts>()
  private loaded = false
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(private readonly path: string) {}

  async load(hostname: string): Promise<HostFacts | null> {
    await this.ensureLoaded()
    const facts = this.factsByHostname.get(normalizeHostname(hostname))
    return facts ? cloneFacts(facts) : null
  }

  async save(facts: HostFacts): Promise<void> {
    await this.ensureLoaded()
    const write = this.writeQueue.then(async () => {
      const projected = projectFacts(facts)
      this.factsByHostname.set(projected.hostname, projected)
      await mkdir(dirname(this.path), { recursive: true })
      const temporaryPath = `${this.path}.${randomUUID()}.tmp`
      await writeFile(temporaryPath, JSON.stringify(Object.fromEntries(this.factsByHostname)), 'utf8')
      await rename(temporaryPath, this.path)
    })
    this.writeQueue = write.catch(() => undefined)
    return write
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, 'utf8'))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid host facts store')
      for (const [hostname, value] of Object.entries(parsed as Record<string, unknown>)) {
        const normalizedHostname = normalizeHostname(hostname)
        const facts = projectFacts(value)
        if (facts.hostname !== normalizedHostname) throw new Error('Invalid host facts store')
        this.factsByHostname.set(normalizedHostname, facts)
      }
      this.loaded = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.loaded = true
        return
      }
      if ((error as Error).message === 'Host facts require a hostname, not an IP address') throw error
      if ((error as Error).message === 'Invalid host facts store') throw error
      throw new Error('Invalid host facts store', { cause: error })
    }
  }
}

function projectFacts(value: unknown): HostFacts {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid host facts store')
  const facts = value as Record<string, unknown>
  const hostname = normalizeHostname(requiredText(facts.hostname))
  const observedAt = requiredText(facts.observedAt)
  const software = stringRecord(facts.software)
  const processes = hostProcesses(facts.processes)
  const installLocations = stringRecord(facts.installLocations)
  const services = stringRecord(facts.services)
  const logLocations = stringList(facts.logLocations)
  const configurationHashes = stringRecord(facts.configurationHashes)
  return {
    hostname,
    observedAt,
    software,
    processes,
    installLocations,
    services,
    logLocations,
    configurationHashes,
  }
}

function requiredText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Invalid host facts store')
  return value.trim()
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid host facts store')
  const record: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!key || typeof entry !== 'string') throw new Error('Invalid host facts store')
    record[key] = entry
  }
  return record
}

function hostProcesses(value: unknown): HostProcess[] {
  if (!Array.isArray(value)) throw new Error('Invalid host facts store')
  return value.map(process => {
    if (!process || typeof process !== 'object' || Array.isArray(process)) throw new Error('Invalid host facts store')
    const candidate = process as Record<string, unknown>
    return { name: requiredText(candidate.name), status: requiredText(candidate.status) }
  })
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) throw new Error('Invalid host facts store')
  return [...value]
}

function cloneFacts(facts: HostFacts): HostFacts {
  return {
    ...facts,
    software: { ...facts.software },
    processes: facts.processes.map(process => ({ ...process })),
    installLocations: { ...facts.installLocations },
    services: { ...facts.services },
    logLocations: [...facts.logLocations],
    configurationHashes: { ...facts.configurationHashes },
  }
}
