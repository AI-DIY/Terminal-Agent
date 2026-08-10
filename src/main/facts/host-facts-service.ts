import type { HostFacts } from '../observation/observation-schema'
import type { HostFactsRepository } from './host-facts-repository'

export type HostFactsMergeResult = {
  record: HostFacts
  changed: string[]
}

export class HostFactsService {
  constructor(private readonly repository: HostFactsRepository) {}

  async observe(incoming: HostFacts): Promise<HostFactsMergeResult> {
    const hostname = normalizeHostname(incoming.hostname)
    const previous = await this.repository.load(hostname)
    const result = mergeHostFacts(previous, { ...incoming, hostname })
    await this.repository.save(result.record)
    return result
  }

  async snapshot(hostname: string): Promise<HostFacts | null> {
    return this.repository.load(normalizeHostname(hostname))
  }
}

export function mergeHostFacts(previous: HostFacts | null, incoming: HostFacts): HostFactsMergeResult {
  const record = cloneFacts({ ...incoming, hostname: normalizeHostname(incoming.hostname) })
  if (!previous) return { record, changed: ['initial'] }

  const before = cloneFacts({ ...previous, hostname: normalizeHostname(previous.hostname) })
  if (before.hostname !== record.hostname) throw new Error('Host facts must be merged by the same hostname')

  return {
    record,
    changed: [
      ...changedRecordValues('software', before.software, record.software),
      ...changedProcessValues(before.processes, record.processes),
      ...changedRecordValues('installLocations', before.installLocations, record.installLocations),
      ...changedRecordValues('services', before.services, record.services),
      ...(sameValues(before.logLocations, record.logLocations) ? [] : ['logLocations']),
      ...changedRecordValues('configurationHashes', before.configurationHashes, record.configurationHashes),
    ],
  }
}

export function normalizeHostname(value: string): string {
  const hostname = value.trim().replace(/\.$/, '').toLowerCase()
  if (!hostname || isIpLiteral(hostname)) throw new Error('Host facts require a hostname, not an IP address')
  return hostname
}

function changedRecordValues(path: string, before: Record<string, string>, after: Record<string, string>): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .sort()
    .filter(key => before[key] !== after[key])
    .map(key => `${path}.${key}`)
}

function changedProcessValues(before: HostFacts['processes'], after: HostFacts['processes']): string[] {
  return sameValues(before, after) ? [] : ['processes']
}

function sameValues(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function cloneFacts(facts: HostFacts): HostFacts {
  return {
    hostname: facts.hostname,
    observedAt: facts.observedAt,
    software: { ...facts.software },
    processes: facts.processes.map(process => ({ ...process })),
    installLocations: { ...facts.installLocations },
    services: { ...facts.services },
    logLocations: [...facts.logLocations],
    configurationHashes: { ...facts.configurationHashes },
  }
}

function isIpLiteral(value: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value) || value.includes(':')
}
