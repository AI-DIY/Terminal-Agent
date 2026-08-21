import { readFile } from 'node:fs/promises'
import { hostMemoryCurrentServicesSchema, hostMemoryLegacyRecordSchema, hostMemoryRecordSchema, type HostMemoryLegacyFacts, type HostMemoryLegacyRecord } from '../../shared/contracts'
import { containsSensitiveHostMemoryData } from '../../shared/host-memory-safety'
import type { HostFacts } from '../observation/observation-schema'
import { createAtomicFileWriter, type AtomicFileWriterOptions } from '../persistence/atomic-file-writer'
import { normalizeHostname } from './host-facts-service'

const maxHostFactRecords = 2_000
const maxHostFactsDocumentBytes = 8 * 1024 * 1024

export type HostFactsRepository = {
  load(hostname: string): Promise<HostFacts | null>
  list(): Promise<HostFacts[]>
  save(facts: HostFacts): Promise<void>
  remove(hostname: string): Promise<void>
}

type HostFactsDocument = { version: 3; records: HostFacts[] }

export class FileHostFactsRepository implements HostFactsRepository {
  private readonly factsByHostname = new Map<string, HostFacts>()
  private loaded = false
  private initialization: Promise<void> | undefined
  private writeQueue: Promise<void> = Promise.resolve()
  private readonly writeAtomically: (path: string, value: unknown) => Promise<void>

  constructor(private readonly path: string, options: AtomicFileWriterOptions = {}) {
    this.writeAtomically = createAtomicFileWriter(options)
  }

  async load(hostname: string): Promise<HostFacts | null> {
    await this.ensureLoaded()
    const facts = this.factsByHostname.get(normalizeHostname(hostname))
    return facts ? cloneFacts(facts) : null
  }

  async list(): Promise<HostFacts[]> {
    await this.ensureLoaded()
    return [...this.factsByHostname.values()].sort((left, right) => left.hostname.localeCompare(right.hostname)).map(cloneFacts)
  }

  async save(facts: HostFacts): Promise<void> {
    await this.ensureLoaded()
    const projected = projectFacts(facts)
    await this.enqueue(async () => {
      const next = cloneFactsMap(this.factsByHostname)
      next.set(projected.hostname, projected)
      await this.persist(next)
      replaceFacts(this.factsByHostname, next)
    })
  }

  async remove(hostname: string): Promise<void> {
    await this.ensureLoaded()
    const normalized = normalizeHostname(hostname)
    await this.enqueue(async () => {
      const next = cloneFactsMap(this.factsByHostname)
      next.delete(normalized)
      await this.persist(next)
      replaceFacts(this.factsByHostname, next)
    })
  }

  private async enqueue(action: () => Promise<void>): Promise<void> {
    const write = this.writeQueue.then(action)
    this.writeQueue = write.catch(() => undefined)
    return write
  }

  private async persist(records = this.factsByHostname): Promise<void> {
    if (records.size > maxHostFactRecords) throw new Error('Invalid host facts store')
    const document: HostFactsDocument = { version: 3, records: [...records.values()].sort((a, b) => a.hostname.localeCompare(b.hostname)).map(cloneFacts) }
    if (Buffer.byteLength(JSON.stringify(document), 'utf8') > maxHostFactsDocumentBytes) throw new Error('Invalid host facts store')
    await this.writeAtomically(this.path, document)
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    const initialization = this.initialization ?? this.initialize()
    this.initialization = initialization
    try {
      await initialization
    } catch (error) {
      if (this.initialization === initialization) this.initialization = undefined
      throw error
    }
  }

  private async initialize(): Promise<void> {
    if (this.loaded) return
    try {
      const source = await readFile(this.path, 'utf8')
      if (Buffer.byteLength(source, 'utf8') > maxHostFactsDocumentBytes) throw new Error('Invalid host facts store')
      const parsed: unknown = JSON.parse(source)
      const records = parseDocument(parsed)
      const next = new Map<string, HostFacts>()
      for (const facts of records) {
        if (next.has(facts.hostname)) throw new Error('Invalid host facts store')
        next.set(facts.hostname, facts)
      }
      if (!isVersion3Document(parsed)) await this.persist(next)
      replaceFacts(this.factsByHostname, next)
      this.loaded = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { this.loaded = true; return }
      if ((error as Error).message === 'Host facts require a hostname, not an IP address') throw error
      if ((error as Error).message === 'Host facts contain sensitive data') throw error
      if ((error as Error).message === 'Invalid host facts store') throw error
      throw new Error('Invalid host facts store', { cause: error })
    }
  }
}

function replaceFacts(target: Map<string, HostFacts>, source: ReadonlyMap<string, HostFacts>): void {
  target.clear()
  for (const [hostname, facts] of source) target.set(hostname, cloneFacts(facts))
}

function cloneFactsMap(records: ReadonlyMap<string, HostFacts>): Map<string, HostFacts> {
  return new Map([...records].map(([hostname, facts]) => [hostname, cloneFacts(facts)]))
}

function isVersion3Document(value: unknown): value is HostFactsDocument {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && (value as { version?: unknown }).version === 3)
}

function parseDocument(value: unknown): HostFacts[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid host facts store')
  const candidate = value as Record<string, unknown>
  if (candidate.version === 3) {
    assertOnlyKeys(candidate, ['version', 'records'])
    if (!Array.isArray(candidate.records) || candidate.records.length > maxHostFactRecords) throw new Error('Invalid host facts store')
    return candidate.records.map(projectFacts)
  }
  if (candidate.version === 2) {
    assertOnlyKeys(candidate, ['version', 'records'])
    if (!Array.isArray(candidate.records) || candidate.records.length > maxHostFactRecords) throw new Error('Invalid host facts store')
    return candidate.records.map(migrateLegacyFacts)
  }
  const entries = Object.entries(candidate)
  if (entries.length > maxHostFactRecords) throw new Error('Invalid host facts store')
  return entries.map(([hostname, facts]) => {
    const migrated = migrateLegacyFacts(facts)
    if (migrated.hostname !== normalizeHostname(hostname)) throw new Error('Invalid host facts store')
    return migrated
  })
}

function assertOnlyKeys(candidate: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed)
  if (Object.keys(candidate).some(key => !allowedKeys.has(key))) throw new Error('Invalid host facts store')
}

function projectFacts(value: unknown): HostFacts {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid host facts store')
  if (containsSensitiveHostMemoryData(value)) throw new Error('Host facts contain sensitive data')
  const candidate = value as Record<string, unknown>
  const parsed = hostMemoryRecordSchema.safeParse({ ...candidate, hostname: normalizeHostname(requiredText(candidate.hostname)) })
  if (!parsed.success) throw new Error('Invalid host facts store', { cause: parsed.error })
  return cloneFacts(parsed.data)
}

function migrateLegacyFacts(value: unknown): HostFacts {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid host facts store')
  if (containsSensitiveHostMemoryData(value)) throw new Error('Host facts contain sensitive data')
  const candidate = value as Record<string, unknown>
  const allowedKeys = new Set(['hostname', 'observedAt', 'software', 'processes', 'installLocations', 'services', 'logLocations', 'configurationHashes'])
  if (Object.keys(candidate).some(key => !allowedKeys.has(key))) throw new Error('Invalid host facts store')
  const legacy = hostMemoryLegacyRecordSchema.safeParse({
    software: candidate.software,
    processes: candidate.processes,
    installLocations: candidate.installLocations,
    services: candidate.services,
    logLocations: candidate.logLocations,
    configurationHashes: candidate.configurationHashes,
  })
  if (!legacy.success) throw new Error('Invalid host facts store', { cause: legacy.error })
  const legacyFacts = compactLegacyFacts(legacy.data)
  const services = projectCurrentServices(legacy.data.services)
  const facts: HostFacts = {
    hostname: normalizeHostname(requiredText(candidate.hostname)),
    observedAt: requiredText(candidate.observedAt),
    ...(services ? { services } : {}),
    ...(legacyFacts ? { legacyFacts } : {}),
  }
  const parsed = hostMemoryRecordSchema.safeParse(facts)
  if (!parsed.success) throw new Error('Invalid host facts store', { cause: parsed.error })
  return cloneFacts(parsed.data)
}

function projectCurrentServices(services: Readonly<Record<string, string>>): HostFacts['services'] | undefined {
  const projected: Record<string, string> = {}
  for (const [name, status] of Object.entries(services)) {
    if (hostMemoryCurrentServicesSchema.safeParse({ [name]: status }).success) projected[name] = status
  }
  return Object.keys(projected).length ? projected : undefined
}

function compactLegacyFacts(value: HostMemoryLegacyRecord): HostMemoryLegacyFacts | undefined {
  const compact = {
    ...(Object.keys(value.software).length ? { software: { ...value.software } } : {}),
    ...(value.processes.length ? { processes: value.processes.map(process => ({ ...process })) } : {}),
    ...(Object.keys(value.installLocations).length ? { installLocations: { ...value.installLocations } } : {}),
    ...(Object.keys(value.services).length ? { services: { ...value.services } } : {}),
    ...(value.logLocations.length ? { logLocations: [...value.logLocations] } : {}),
    ...(Object.keys(value.configurationHashes).length ? { configurationHashes: { ...value.configurationHashes } } : {}),
  }
  return Object.keys(compact).length ? compact : undefined
}

function requiredText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Invalid host facts store')
  return value.trim()
}

export function cloneFacts(facts: HostFacts): HostFacts {
  return {
    hostname: facts.hostname,
    observedAt: facts.observedAt,
    ...(facts.connectionIp ? { connectionIp: facts.connectionIp } : {}),
    ...(facts.operatingSystem ? { operatingSystem: { ...facts.operatingSystem } } : {}),
    ...(facts.cpu ? { cpu: { ...facts.cpu } } : {}),
    ...(facts.memory ? { memory: { ...facts.memory } } : {}),
    ...(facts.disks ? { disks: facts.disks.map(disk => ({ ...disk })) } : {}),
    ...(facts.networkInterfaces ? { networkInterfaces: facts.networkInterfaces.map(item => ({ ...item, addresses: [...item.addresses] })) } : {}),
    ...(facts.processes ? { processes: facts.processes.map(process => ({ ...process })) } : {}),
    ...(facts.currentUser ? { currentUser: facts.currentUser } : {}),
    ...(facts.workingDirectory ? { workingDirectory: facts.workingDirectory } : {}),
    ...(facts.services ? { services: { ...facts.services } } : {}),
    ...(facts.legacyFacts ? { legacyFacts: cloneLegacyFacts(facts.legacyFacts) } : {}),
  }
}

function cloneLegacyFacts(facts: HostMemoryLegacyFacts): HostMemoryLegacyFacts {
  return {
    ...(facts.software ? { software: { ...facts.software } } : {}),
    ...(facts.processes ? { processes: facts.processes.map(process => ({ ...process })) } : {}),
    ...(facts.installLocations ? { installLocations: { ...facts.installLocations } } : {}),
    ...(facts.services ? { services: { ...facts.services } } : {}),
    ...(facts.logLocations ? { logLocations: [...facts.logLocations] } : {}),
    ...(facts.configurationHashes ? { configurationHashes: { ...facts.configurationHashes } } : {}),
  }
}
