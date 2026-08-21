import type { HostMemoryLegacyFacts, HostMemoryRecord } from '../../shared/contracts'
import { containsSensitiveHostMemoryData, normalizeSafeHostMemoryIdentity } from '../../shared/host-memory-safety'
import type { HostFacts } from '../observation/observation-schema'
import type { HostFactsRepository } from './host-facts-repository'

export type HostFactsMergeResult = { record: HostFacts; changed: string[] }

export class HostFactsService {
  private readonly hostTails = new Map<string, Promise<void>>()

  constructor(private readonly repository: HostFactsRepository) {}

  async observe(incoming: HostFacts, canPersist: () => boolean | Promise<boolean> = () => true): Promise<HostFactsMergeResult> {
    if (containsSensitiveHostMemoryData(incoming)) throw new Error('Host facts contain sensitive data')
    const hostname = normalizeHostname(incoming.hostname)
    return this.withHostLock(hostname, async () => {
      if (!await canPersist()) return { record: cloneFacts({ ...incoming, hostname }), changed: [] }
      const previous = await this.repository.load(hostname)
      const result = mergeHostFacts(previous, { ...incoming, hostname })
      if (!await canPersist()) return { record: cloneFacts(result.record), changed: [] }
      await this.repository.save(result.record)
      return { record: cloneFacts(result.record), changed: [...result.changed] }
    })
  }

  async snapshot(hostname: string): Promise<HostFacts | null> {
    const facts = await this.repository.load(normalizeHostname(hostname))
    if (!facts) return null
    assertSafeFacts(facts)
    return cloneFacts(facts)
  }
  async list(): Promise<HostMemoryRecord[]> {
    const records = await this.repository.list()
    for (const record of records) assertSafeFacts(record)
    return records.map(cloneFacts)
  }
  async update(hostname: string, record: HostMemoryRecord): Promise<HostMemoryRecord> {
    assertSafeFacts(record)
    const identity = normalizeHostname(hostname)
    return this.withHostLock(identity, async () => {
      const projected = cloneFacts({ ...record, hostname: normalizeHostname(record.hostname) })
      if (projected.hostname !== identity) throw new Error('Host memory record hostname identity cannot be changed')
      if (!await this.repository.load(identity)) throw new Error('Unknown host memory record')
      await this.repository.save(projected)
      return cloneFacts(projected)
    })
  }
  async restore(hostname: string, record: HostMemoryRecord): Promise<HostMemoryRecord> {
    assertSafeFacts(record)
    const identity = normalizeHostname(hostname)
    return this.withHostLock(identity, async () => {
      const projected = cloneFacts({ ...record, hostname: normalizeHostname(record.hostname) })
      if (projected.hostname !== identity) throw new Error('Host memory record hostname identity cannot be changed')
      await this.repository.save(projected)
      return cloneFacts(projected)
    })
  }
  async remove(hostname: string): Promise<void> {
    const identity = normalizeHostname(hostname)
    await this.withHostLock(identity, () => this.repository.remove(identity))
  }

  private async withHostLock<T>(hostname: string, action: () => Promise<T>): Promise<T> {
    const previous = this.hostTails.get(hostname) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>(resolve => { release = resolve })
    this.hostTails.set(hostname, current)
    await previous
    try {
      return await action()
    } finally {
      release()
      if (this.hostTails.get(hostname) === current) this.hostTails.delete(hostname)
    }
  }
}

export function mergeHostFacts(previous: HostFacts | null, incoming: HostFacts): HostFactsMergeResult {
  const normalizedIncoming = cloneFacts({ ...incoming, hostname: normalizeHostname(incoming.hostname) })
  if (!previous) return { record: normalizedIncoming, changed: ['initial'] }
  const before = cloneFacts({ ...previous, hostname: normalizeHostname(previous.hostname) })
  if (before.hostname !== normalizedIncoming.hostname) throw new Error('Host facts must be merged by the same hostname')
  const record = cloneFacts({ ...before, ...normalizedIncoming, hostname: before.hostname, observedAt: normalizedIncoming.observedAt })
  const changed = factFields.filter(field => !sameValues(before[field], record[field]))
  return { record, changed }
}

const factFields = ['connectionIp', 'operatingSystem', 'cpu', 'memory', 'disks', 'networkInterfaces', 'processes', 'currentUser', 'workingDirectory', 'services', 'legacyFacts'] as const

export function normalizeHostname(value: string): string { return normalizeSafeHostMemoryIdentity(value) }
function assertSafeFacts(facts: HostFacts): void { if (containsSensitiveHostMemoryData(facts)) throw new Error('Host facts contain sensitive data') }
function sameValues(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right) }
function cloneFacts(facts: HostFacts): HostFacts {
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
