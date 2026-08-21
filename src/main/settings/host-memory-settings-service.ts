import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { hostMemorySettingsSchema, type HostMemoryScopes, type HostMemorySettings } from '../../shared/contracts'
import type { HostFacts } from '../observation/observation-schema'
import { normalizeHostname } from '../facts/host-facts-service'
import { normalizeSafeHostMemoryConnectionLabel } from '../../shared/host-memory-safety'
import { createAtomicFileWriter, type AtomicFileWriterOptions } from '../persistence/atomic-file-writer'

type HostMemoryDocument = { version: 3; settings: HostMemorySettings; acknowledgedConnections: string[]; pendingConnectionConsents: string[]; pendingConnectionConsentRevisions: Record<string, number>; connectionHosts: Record<string, string>; revokedHosts: string[]; revokedHostConnections: Record<string, string[]>; hostRevocationRevisions: Record<string, number>; connectionRevocationRevisions: Record<string, number>; authorizationRevision: number }
export type HostMemoryAuthorizationUndo = { token: string }
type HostMemoryAuthorizationSnapshot = { acknowledgedConnections: string[]; pendingConnectionConsents: string[]; pendingConnectionConsentRevisions: Record<string, number>; connectionHosts: Record<string, string> }
type HostMemoryUndoState = { hostname: string; epoch: number; hadTombstone: boolean; previousHostRevocationRevision?: number; revokedConnectionLabels: string[]; snapshot: HostMemoryAuthorizationSnapshot }
const defaults: HostMemorySettings = { enabled: false, scopes: { identity: true, hardware: true, processes: true, runtime: true } }
const disabledScopes: HostMemoryScopes = { identity: false, hardware: false, processes: false, runtime: false }
const legacyScopesSchema = z.object({
  software: z.boolean(),
  processes: z.boolean(),
  services: z.boolean(),
  configuration: z.boolean(),
}).strict()
const legacySettingsSchema = z.object({ enabled: z.boolean(), scopes: legacyScopesSchema }).strict()
const connectionHostsSchema = z.record(z.string(), z.string()).optional()
const revokedHostsSchema = z.array(z.string()).optional()
const revokedHostConnectionsSchema = z.record(z.string(), z.array(z.string())).optional()
const authorizationRevisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const authorizationRevisionsSchema = z.record(z.string(), authorizationRevisionSchema).optional()
const hostMemoryVersion1DocumentSchema = z.object({
  version: z.literal(1),
  settings: legacySettingsSchema,
  acknowledgedHosts: z.array(z.string()),
  connectionHosts: connectionHostsSchema,
  revokedHosts: revokedHostsSchema,
  revokedHostConnections: revokedHostConnectionsSchema,
}).strict()
const hostMemoryVersion2DocumentSchema = z.object({
  version: z.literal(2),
  settings: legacySettingsSchema,
  acknowledgedConnections: z.array(z.string()),
  connectionHosts: connectionHostsSchema,
  revokedHosts: revokedHostsSchema,
  revokedHostConnections: revokedHostConnectionsSchema,
}).strict()
const hostMemoryVersion3DocumentSchema = z.object({
  version: z.literal(3),
  settings: hostMemorySettingsSchema,
  acknowledgedConnections: z.array(z.string()),
  pendingConnectionConsents: z.array(z.string()).optional(),
  connectionHosts: connectionHostsSchema,
  revokedHosts: revokedHostsSchema,
  revokedHostConnections: revokedHostConnectionsSchema,
  pendingConnectionConsentRevisions: authorizationRevisionsSchema,
  hostRevocationRevisions: authorizationRevisionsSchema,
  connectionRevocationRevisions: authorizationRevisionsSchema,
  authorizationRevision: authorizationRevisionSchema.optional(),
}).strict()

export class HostMemorySettingsService {
  private loaded = false
  private initialization: Promise<void> | undefined
  private document: HostMemoryDocument = { version: 3, settings: cloneSettings(defaults), acknowledgedConnections: [], pendingConnectionConsents: [], pendingConnectionConsentRevisions: {}, connectionHosts: {}, revokedHosts: [], revokedHostConnections: {}, hostRevocationRevisions: {}, connectionRevocationRevisions: {}, authorizationRevision: 0 }
  private writeQueue: Promise<void> = Promise.resolve()
  private readonly undoSnapshots = new Map<string, HostMemoryUndoState>()
  private readonly hostRevocationEpochs = new Map<string, number>()
  private readonly writeAtomically: (path: string, value: unknown) => Promise<void>

  constructor(private readonly path: string, options: AtomicFileWriterOptions = {}) {
    this.writeAtomically = createAtomicFileWriter(options)
  }

  async load(): Promise<HostMemorySettings> { await this.ensureLoaded(); return cloneSettings(this.document.settings) }
  async save(settings: HostMemorySettings): Promise<HostMemorySettings> { await this.ensureLoaded(); const parsed = hostMemorySettingsSchema.parse(settings); await this.enqueue(async () => { const next = cloneDocument(this.document); next.settings = cloneSettings(parsed); await this.persist(next); this.document = next }); return cloneSettings(parsed) }
  async isAcknowledged(hostIdentity: string): Promise<boolean> { return this.isConnectionAcknowledged(normalizeHostname(hostIdentity)) }
  async acknowledge(hostIdentity: string): Promise<void> { return this.acknowledgeConnection(normalizeHostname(hostIdentity)) }
  async isConnectionAcknowledged(label: string): Promise<boolean> {
    await this.ensureLoaded()
    const normalized = normalizeSafeHostMemoryConnectionLabel(label)
    if (!this.document.acknowledgedConnections.includes(normalized)) return false
    if (!this.document.pendingConnectionConsents.includes(normalized)) return this.requiredConsentRevision(normalized) === 0
    return this.pendingConsentRevision(normalized) >= this.requiredConsentRevision(normalized)
  }
  connectionConsentRevision(): number {
    if (!this.loaded) throw new Error('Host memory settings must be loaded before issuing consent')
    return this.document.authorizationRevision
  }
  async acknowledgeConnection(label: string, issuedAtRevision?: number): Promise<void> {
    await this.ensureLoaded()
    const normalized = normalizeSafeHostMemoryConnectionLabel(label)
    const consentRevision = issuedAtRevision ?? this.document.authorizationRevision
    authorizationRevisionSchema.parse(consentRevision)
    await this.enqueue(async () => {
      if (consentRevision > this.document.authorizationRevision) throw new Error('Invalid host memory consent revision')
      if (consentRevision < this.requiredConsentRevision(normalized)) return
      const added = !this.document.acknowledgedConnections.includes(normalized)
      const pending = !this.document.pendingConnectionConsents.includes(normalized)
      const previousRevision = this.document.pendingConnectionConsentRevisions[normalized]
      const revisionChanged = previousRevision === undefined || consentRevision > previousRevision
      if (added || pending || revisionChanged) {
        const next = cloneDocument(this.document)
        if (added) next.acknowledgedConnections.push(normalized)
        next.acknowledgedConnections.sort()
        if (pending) next.pendingConnectionConsents.push(normalized)
        next.pendingConnectionConsents.sort()
        if (revisionChanged) next.pendingConnectionConsentRevisions[normalized] = consentRevision
        await this.persist(next)
        this.document = next
      }
    })
  }
  async revokeConnection(label: string): Promise<void> {
    await this.ensureLoaded()
    const normalized = normalizeSafeHostMemoryConnectionLabel(label)
    await this.enqueue(async () => {
      const revision = this.document.authorizationRevision + 1
      if (!Number.isSafeInteger(revision)) throw new Error('Host memory authorization revision exhausted')
      const next = cloneDocument(this.document)
      next.authorizationRevision = revision
      next.connectionRevocationRevisions[normalized] = revision
      next.acknowledgedConnections = next.acknowledgedConnections.filter(item => item !== normalized)
      next.pendingConnectionConsents = next.pendingConnectionConsents.filter(item => item !== normalized)
      delete next.pendingConnectionConsentRevisions[normalized]
      delete next.connectionHosts[normalized]
      await this.persist(next)
      this.document = next
    })
  }
  async associateConnection(label: string, hostname: string, canPersist?: () => boolean | Promise<boolean>): Promise<void> {
    await this.ensureLoaded()
    const normalizedLabel = normalizeSafeHostMemoryConnectionLabel(label)
    const normalizedHostname = normalizeHostname(hostname)
    await this.enqueue(async () => {
      if (canPersist && !await canPersist()) return
      if (this.document.revokedHosts.includes(normalizedHostname) || this.document.revokedHostConnections[normalizedHostname]?.includes(normalizedLabel)) return
      const requiredConsentRevision = this.requiredConsentRevision(normalizedLabel, normalizedHostname)
      const hasFreshConsent = this.document.pendingConnectionConsents.includes(normalizedLabel)
        && (this.document.pendingConnectionConsentRevisions[normalizedLabel] ?? 0) >= requiredConsentRevision
      if (requiredConsentRevision > 0 && !hasFreshConsent) return
      if (this.document.connectionHosts[normalizedLabel] === normalizedHostname) return
      const next = cloneDocument(this.document)
      next.connectionHosts[normalizedLabel] = normalizedHostname
      next.pendingConnectionConsents = next.pendingConnectionConsents.filter(item => item !== normalizedLabel)
      delete next.pendingConnectionConsentRevisions[normalizedLabel]
      delete next.connectionRevocationRevisions[normalizedLabel]
      await this.persist(next)
      this.document = next
    })
  }
  async authorizeConnectionBinding(label: string, hostname: string): Promise<boolean> {
    await this.ensureLoaded()
    const normalizedLabel = normalizeSafeHostMemoryConnectionLabel(label)
    const normalizedHostname = normalizeHostname(hostname)
    let authorized = false
    await this.enqueue(async () => {
      if (!this.document.acknowledgedConnections.includes(normalizedLabel)) return
      const mappedHostname = this.document.connectionHosts[normalizedLabel]
      if (mappedHostname && mappedHostname !== normalizedHostname) return
      const hostRevoked = this.document.revokedHosts.includes(normalizedHostname)
      const labelRevoked = this.document.revokedHostConnections[normalizedHostname]?.includes(normalizedLabel) ?? false
      const hasAnyLabelTombstone = Object.values(this.document.revokedHostConnections).some(labels => labels.includes(normalizedLabel))
      const requiredConsentRevision = this.requiredConsentRevision(normalizedLabel, normalizedHostname)
      const hasFreshConsent = this.document.pendingConnectionConsents.includes(normalizedLabel)
        && (this.document.pendingConnectionConsentRevisions[normalizedLabel] ?? 0) >= requiredConsentRevision
      if ((hostRevoked || hasAnyLabelTombstone) && !hasFreshConsent) return
      if (requiredConsentRevision > 0 && !hasFreshConsent) return
      if (mappedHostname === normalizedHostname && !hostRevoked && !labelRevoked && !hasAnyLabelTombstone && !Object.hasOwn(this.document.connectionRevocationRevisions, normalizedLabel)) { authorized = true; return }
      const next = cloneDocument(this.document)
      next.connectionHosts[normalizedLabel] = normalizedHostname
      next.pendingConnectionConsents = next.pendingConnectionConsents.filter(item => item !== normalizedLabel)
      delete next.pendingConnectionConsentRevisions[normalizedLabel]
      delete next.connectionRevocationRevisions[normalizedLabel]
      if (hostRevoked) {
        next.revokedHosts = next.revokedHosts.filter(host => host !== normalizedHostname)
        delete next.hostRevocationRevisions[normalizedHostname]
      }
      for (const [hostname, labels] of Object.entries(next.revokedHostConnections)) {
        const remaining = labels.filter(item => item !== normalizedLabel)
        if (remaining.length) next.revokedHostConnections[hostname] = remaining
        else delete next.revokedHostConnections[hostname]
      }
      if (!next.revokedHosts.includes(normalizedHostname) && !Object.hasOwn(next.revokedHostConnections, normalizedHostname)) {
        delete next.hostRevocationRevisions[normalizedHostname]
      }
      await this.persist(next)
      this.document = next
      authorized = true
    })
    return authorized
  }
  async revokeHost(hostname: string, connectionLabels: readonly string[] = [], pendingConnectionLabels: readonly string[] = []): Promise<HostMemoryAuthorizationUndo> {
    await this.ensureLoaded()
    const normalizedHostname = normalizeHostname(hostname)
    const normalizedLabels = connectionLabels.map(label => normalizeSafeHostMemoryConnectionLabel(label))
    const normalizedPendingLabels = pendingConnectionLabels.map(label => normalizeSafeHostMemoryConnectionLabel(label))
    const undo = { token: randomUUID() }
    await this.enqueue(async () => {
      const epoch = (this.hostRevocationEpochs.get(normalizedHostname) ?? 0) + 1
      const next = cloneDocument(this.document)
      const authorizationRevision = this.document.authorizationRevision + 1
      if (!Number.isSafeInteger(authorizationRevision)) throw new Error('Host memory authorization revision exhausted')
      const previousRevokedConnectionLabels = [...(this.document.revokedHostConnections[normalizedHostname] ?? [])]
      const previousHostRevocationRevision = this.document.hostRevocationRevisions[normalizedHostname]
      const labels = new Set(Object.entries(this.document.connectionHosts).filter(([, value]) => value === normalizedHostname).map(([label]) => label))
      if (this.document.acknowledgedConnections.includes(normalizedHostname)) labels.add(normalizedHostname)
      const pendingLabels = new Set<string>()
      for (const label of normalizedLabels) {
        const mappedHostname = this.document.connectionHosts[label]
        if (mappedHostname === normalizedHostname || label === normalizedHostname) labels.add(label)
        else if (!mappedHostname) pendingLabels.add(label)
      }
      for (const label of normalizedPendingLabels) {
        const mappedHostname = this.document.connectionHosts[label]
        if (mappedHostname === normalizedHostname || !mappedHostname && this.document.acknowledgedConnections.includes(label)) labels.add(label)
        else if (!mappedHostname) pendingLabels.add(label)
      }
      const snapshot = captureAuthorization(this.document, labels)
      const hadTombstone = this.document.revokedHosts.includes(normalizedHostname)
      if (!next.revokedHosts.includes(normalizedHostname)) next.revokedHosts.push(normalizedHostname)
      next.authorizationRevision = authorizationRevision
      next.hostRevocationRevisions[normalizedHostname] = authorizationRevision
      const revokedLabels = new Set([...
        labels,
        ...pendingLabels,
      ])
      if (revokedLabels.size) next.revokedHostConnections[normalizedHostname] = [...new Set([...(next.revokedHostConnections[normalizedHostname] ?? []), ...revokedLabels])].sort()
      next.acknowledgedConnections = next.acknowledgedConnections.filter(label => !labels.has(label))
      for (const label of labels) delete next.connectionHosts[label]
      next.pendingConnectionConsents = next.pendingConnectionConsents.filter(label => !revokedLabels.has(label))
      for (const label of revokedLabels) delete next.pendingConnectionConsentRevisions[label]
      await this.persist(next)
      this.document = next
      this.hostRevocationEpochs.set(normalizedHostname, epoch)
      this.undoSnapshots.set(undo.token, { hostname: normalizedHostname, epoch, hadTombstone, previousHostRevocationRevision, revokedConnectionLabels: previousRevokedConnectionLabels, snapshot })
    })
    return undo
  }
  async restoreHostAuthorization(undo: HostMemoryAuthorizationUndo): Promise<void> {
    await this.ensureLoaded()
    const previous = this.undoSnapshots.get(undo.token)
    if (!previous) throw new Error('Invalid host memory authorization undo')
    await this.enqueue(async () => {
      if ((this.hostRevocationEpochs.get(previous.hostname) ?? 0) !== previous.epoch) {
        this.undoSnapshots.delete(undo.token)
        return
      }
      const current = cloneDocument(this.document)
      const acknowledgedConnections = new Set(current.acknowledgedConnections)
      for (const label of previous.snapshot.acknowledgedConnections) acknowledgedConnections.add(label)
      const pendingConnectionConsents = new Set(current.pendingConnectionConsents)
      for (const label of previous.snapshot.pendingConnectionConsents) pendingConnectionConsents.add(label)
      const pendingConnectionConsentRevisions = { ...current.pendingConnectionConsentRevisions }
      for (const [label, revision] of Object.entries(previous.snapshot.pendingConnectionConsentRevisions)) {
        pendingConnectionConsentRevisions[label] = Math.max(pendingConnectionConsentRevisions[label] ?? 0, revision)
      }
      const connectionHosts = { ...current.connectionHosts }
      for (const [label, hostname] of Object.entries(previous.snapshot.connectionHosts)) {
        if (!(label in connectionHosts)) connectionHosts[label] = hostname
      }
      const revokedHosts = previous.hadTombstone ? current.revokedHosts : current.revokedHosts.filter(host => host !== previous.hostname)
      const revokedHostConnections = { ...current.revokedHostConnections }
      const hostRevocationRevisions = { ...current.hostRevocationRevisions }
      if (previous.previousHostRevocationRevision === undefined) delete hostRevocationRevisions[previous.hostname]
      else hostRevocationRevisions[previous.hostname] = previous.previousHostRevocationRevision
      if (previous.revokedConnectionLabels.length) revokedHostConnections[previous.hostname] = [...previous.revokedConnectionLabels]
      else delete revokedHostConnections[previous.hostname]
      const next = { ...current, acknowledgedConnections: [...acknowledgedConnections].sort(), pendingConnectionConsents: [...pendingConnectionConsents].sort(), pendingConnectionConsentRevisions, connectionHosts, revokedHosts, revokedHostConnections, hostRevocationRevisions }
      await this.persist(next)
      this.document = next
      this.undoSnapshots.delete(undo.token)
    })
  }
  async canCollect(): Promise<boolean> { await this.ensureLoaded(); return this.document.settings.enabled && Object.values(this.document.settings.scopes).some(Boolean) }
  async canObserve(hostIdentity: string): Promise<boolean> { return await this.canCollect() && await this.isConnectionAcknowledged(hostIdentity) }
  async canObserveHost(connectionLabel: string, hostname: string, allowUnmapped = false): Promise<boolean> {
    if (!await this.canCollect()) return false
    await this.ensureLoaded()
    const normalizedLabel = normalizeSafeHostMemoryConnectionLabel(connectionLabel)
    const normalizedHostname = normalizeHostname(hostname)
    if (this.document.revokedHosts.includes(normalizedHostname) || this.document.revokedHostConnections[normalizedHostname]?.includes(normalizedLabel)) return false
    if (!this.document.acknowledgedConnections.includes(normalizedLabel)) return false
    const mappedHostname = this.document.connectionHosts[normalizedLabel]
    return mappedHostname ? mappedHostname === normalizedHostname : allowUnmapped || normalizedLabel === normalizedHostname
  }
  async shouldDisclose(hostIdentity: string): Promise<boolean> { return await this.canCollect() && !await this.isConnectionAcknowledged(hostIdentity) }
  async collectionScopes(): Promise<HostMemoryScopes> { await this.ensureLoaded(); return { ...this.document.settings.scopes } }
  async filterFacts(facts: HostFacts): Promise<HostFacts> {
    await this.ensureLoaded()
    const scopes = this.document.settings.scopes
    return {
      hostname: normalizeHostname(facts.hostname),
      observedAt: facts.observedAt,
      ...(scopes.identity && facts.connectionIp ? { connectionIp: facts.connectionIp } : {}),
      ...(scopes.identity && facts.operatingSystem ? { operatingSystem: { ...facts.operatingSystem } } : {}),
      ...(scopes.hardware && facts.cpu ? { cpu: { ...facts.cpu } } : {}),
      ...(scopes.hardware && facts.memory ? { memory: { ...facts.memory } } : {}),
      ...(scopes.hardware && facts.disks ? { disks: facts.disks.map(disk => ({ ...disk })) } : {}),
      ...(scopes.hardware && facts.networkInterfaces ? { networkInterfaces: facts.networkInterfaces.map(item => ({ ...item, addresses: [...item.addresses] })) } : {}),
      ...(scopes.processes && facts.processes ? { processes: facts.processes.map(process => ({ ...process })) } : {}),
      ...(scopes.runtime && facts.currentUser ? { currentUser: facts.currentUser } : {}),
      ...(scopes.runtime && facts.workingDirectory ? { workingDirectory: facts.workingDirectory } : {}),
      ...(scopes.runtime && facts.services ? { services: { ...facts.services } } : {}),
    }
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

  private pendingConsentRevision(label: string): number { return this.document.pendingConnectionConsentRevisions[label] ?? 0 }
  private requiredConsentRevision(label: string, hostname?: string): number {
    const revisions = [this.document.connectionRevocationRevisions[label] ?? 0]
    if (hostname) revisions.push(this.document.hostRevocationRevisions[hostname] ?? 0)
    for (const [revokedHostname, labels] of Object.entries(this.document.revokedHostConnections)) {
      if (labels.includes(label)) revisions.push(this.document.hostRevocationRevisions[revokedHostname] ?? 0)
    }
    return Math.max(...revisions)
  }

  private async initialize(): Promise<void> {
    if (this.loaded) return
    try {
      const candidate: unknown = JSON.parse(await readFile(this.path, 'utf8'))
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('Invalid host memory settings')
      const value = candidate as Record<string, unknown>
      const legacy = value.version === 1
      const previousVersion = value.version === 2
      const currentVersion = value.version === 3
      if (legacy) hostMemoryVersion1DocumentSchema.parse(value)
      else if (previousVersion) hostMemoryVersion2DocumentSchema.parse(value)
      else if (currentVersion) hostMemoryVersion3DocumentSchema.parse(value)
      else throw new Error('Invalid host memory settings')
      const allowedKeys = legacy
        ? ['version', 'settings', 'acknowledgedHosts', 'connectionHosts', 'revokedHosts', 'revokedHostConnections']
        : ['version', 'settings', 'acknowledgedConnections', 'connectionHosts', 'revokedHosts', 'revokedHostConnections', ...(currentVersion ? ['pendingConnectionConsents', 'pendingConnectionConsentRevisions', 'hostRevocationRevisions', 'connectionRevocationRevisions', 'authorizationRevision'] : [])]
      if (Object.keys(value).some(key => !allowedKeys.includes(key))) throw new Error('Invalid host memory settings')
      const labels = legacy ? value.acknowledgedHosts : value.acknowledgedConnections
      if ((!legacy && !previousVersion && !currentVersion) || !Array.isArray(labels)) throw new Error('Invalid host memory settings')
      const rawMapping = value.connectionHosts
      const connectionHosts: Record<string, string> = {}
      if (rawMapping !== undefined) {
        if (!rawMapping || typeof rawMapping !== 'object' || Array.isArray(rawMapping)) throw new Error('Invalid host memory settings')
        for (const [label, hostname] of Object.entries(rawMapping as Record<string, unknown>)) {
          if (typeof hostname !== 'string') throw new Error('Invalid host memory settings')
          const normalizedLabel = normalizeSafeHostMemoryConnectionLabel(label)
          if (Object.hasOwn(connectionHosts, normalizedLabel)) throw new Error('Invalid host memory settings')
          connectionHosts[normalizedLabel] = normalizeHostname(hostname)
        }
      }
      const rawRevokedHosts = value.revokedHosts
      if (rawRevokedHosts !== undefined && !Array.isArray(rawRevokedHosts)) throw new Error('Invalid host memory settings')
      const revokedHosts = (rawRevokedHosts ?? []).map((item: unknown) => {
        if (typeof item !== 'string') throw new Error('Invalid host memory settings')
        return normalizeHostname(item)
      })
      const rawRevokedConnections = value.revokedHostConnections
      const revokedHostConnections: Record<string, string[]> = {}
      if (rawRevokedConnections !== undefined) {
        if (!rawRevokedConnections || typeof rawRevokedConnections !== 'object' || Array.isArray(rawRevokedConnections)) throw new Error('Invalid host memory settings')
        for (const [hostname, rawLabels] of Object.entries(rawRevokedConnections as Record<string, unknown>)) {
          if (!Array.isArray(rawLabels) || rawLabels.some(label => typeof label !== 'string')) throw new Error('Invalid host memory settings')
          const normalizedHostname = normalizeHostname(hostname)
          if (Object.hasOwn(revokedHostConnections, normalizedHostname)) throw new Error('Invalid host memory settings')
          revokedHostConnections[normalizedHostname] = [...new Set((rawLabels as string[]).map(label => normalizeSafeHostMemoryConnectionLabel(label)))].sort()
        }
      }
      const rawPendingConsents = value.pendingConnectionConsents
      if (rawPendingConsents !== undefined && (!Array.isArray(rawPendingConsents) || rawPendingConsents.some(label => typeof label !== 'string'))) throw new Error('Invalid host memory settings')
      const pendingConnectionConsents = [...new Set((rawPendingConsents ?? []).map(label => normalizeSafeHostMemoryConnectionLabel(label as string)))].sort()
      const rawAuthorizationRevision = value.authorizationRevision
      const hasPersistedTombstones = revokedHosts.length > 0 || Object.keys(revokedHostConnections).length > 0 || Object.keys((value.connectionRevocationRevisions as Record<string, unknown> | undefined) ?? {}).length > 0
      const authorizationRevision = rawAuthorizationRevision === undefined
        ? hasPersistedTombstones ? 1 : 0
        : authorizationRevisionSchema.parse(rawAuthorizationRevision)
      const pendingConnectionConsentRevisions = normalizeAuthorizationRevisions(value.pendingConnectionConsentRevisions, normalizeSafeHostMemoryConnectionLabel, authorizationRevision)
      const hostRevocationRevisions = normalizeAuthorizationRevisions(value.hostRevocationRevisions, normalizeHostname, authorizationRevision)
      const connectionRevocationRevisions = normalizeAuthorizationRevisions(value.connectionRevocationRevisions, normalizeSafeHostMemoryConnectionLabel, authorizationRevision)
      for (const label of pendingConnectionConsents) {
        if (pendingConnectionConsentRevisions[label] === undefined) pendingConnectionConsentRevisions[label] = 0
      }
      if (Object.keys(pendingConnectionConsentRevisions).some(label => !pendingConnectionConsents.includes(label))) throw new Error('Invalid host memory settings')
      for (const hostname of revokedHosts) {
        if (hostRevocationRevisions[hostname] === undefined) hostRevocationRevisions[hostname] = authorizationRevision
      }
      for (const hostname of Object.keys(revokedHostConnections)) {
        if (hostRevocationRevisions[hostname] === undefined) hostRevocationRevisions[hostname] = authorizationRevision
      }
      if (Object.keys(hostRevocationRevisions).some(hostname => !revokedHosts.includes(hostname) && !Object.hasOwn(revokedHostConnections, hostname))) throw new Error('Invalid host memory settings')
      let acknowledgedConnections = labels.map(item => { if (typeof item !== 'string') throw new Error('Invalid host memory settings'); return legacy ? normalizeHostname(item) : normalizeSafeHostMemoryConnectionLabel(item) })
      const requiresConsentStateMigration = rawPendingConsents === undefined
      const requiresAuthorizationRevisionMigration = currentVersion && (rawAuthorizationRevision === undefined || value.pendingConnectionConsentRevisions === undefined || value.hostRevocationRevisions === undefined || value.connectionRevocationRevisions === undefined)
      if (requiresConsentStateMigration && revokedHosts.length) {
        acknowledgedConnections = acknowledgedConnections.filter(label => connectionHosts[label] || Object.values(revokedHostConnections).some(revokedLabels => revokedLabels.includes(label)))
      }
      const next: HostMemoryDocument = {
        version: 3,
        settings: legacy || previousVersion ? parseLegacySettings(value.settings) : hostMemorySettingsSchema.parse(value.settings),
        acknowledgedConnections,
        pendingConnectionConsents,
        pendingConnectionConsentRevisions,
        connectionHosts,
        revokedHosts: [...new Set(revokedHosts)].sort(),
        revokedHostConnections,
        hostRevocationRevisions,
        connectionRevocationRevisions,
        authorizationRevision,
      }
      next.acknowledgedConnections = [...new Set(next.acknowledgedConnections)].sort()
      if (!currentVersion || requiresConsentStateMigration || requiresAuthorizationRevisionMigration) await this.persist(next)
      this.document = next
      this.loaded = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { this.loaded = true; return }
      throw new Error('Invalid host memory settings', { cause: error })
    }
  }
  private async enqueue(action: () => Promise<void>): Promise<void> { const write = this.writeQueue.then(action); this.writeQueue = write.catch(() => undefined); return write }
  private async persist(document = this.document): Promise<void> { await this.writeAtomically(this.path, document) }
}
function cloneSettings(settings: HostMemorySettings): HostMemorySettings { return { enabled: settings.enabled, scopes: { ...settings.scopes } } }
function cloneDocument(document: HostMemoryDocument): HostMemoryDocument {
  return {
    version: 3,
    settings: cloneSettings(document.settings),
    acknowledgedConnections: [...document.acknowledgedConnections],
    pendingConnectionConsents: [...document.pendingConnectionConsents],
    pendingConnectionConsentRevisions: { ...document.pendingConnectionConsentRevisions },
    connectionHosts: { ...document.connectionHosts },
    revokedHosts: [...document.revokedHosts],
    revokedHostConnections: Object.fromEntries(Object.entries(document.revokedHostConnections).map(([hostname, labels]) => [hostname, [...labels]])),
    hostRevocationRevisions: { ...document.hostRevocationRevisions },
    connectionRevocationRevisions: { ...document.connectionRevocationRevisions },
    authorizationRevision: document.authorizationRevision,
  }
}

function parseLegacySettings(value: unknown): HostMemorySettings {
  const settings = legacySettingsSchema.parse(value)
  return { enabled: settings.enabled, scopes: { ...disabledScopes } }
}
function normalizeAuthorizationRevisions(value: unknown, normalizeKey: (value: string) => string, maximum: number): Record<string, number> {
  if (value === undefined) return {}
  const parsed = authorizationRevisionsSchema.unwrap().parse(value)
  const revisions: Record<string, number> = {}
  for (const [key, revision] of Object.entries(parsed)) {
    const normalized = normalizeKey(key)
    if (Object.hasOwn(revisions, normalized) || revision > maximum) throw new Error('Invalid host memory authorization revision')
    revisions[normalized] = revision
  }
  return revisions
}
function captureAuthorization(document: HostMemoryDocument, labels: ReadonlySet<string>): HostMemoryAuthorizationSnapshot {
  const acknowledgedConnections = document.acknowledgedConnections.filter(label => labels.has(label))
  const pendingConnectionConsents = document.pendingConnectionConsents.filter(label => labels.has(label))
  const pendingConnectionConsentRevisions: Record<string, number> = {}
  for (const label of pendingConnectionConsents) {
    const revision = document.pendingConnectionConsentRevisions[label]
    if (revision !== undefined) pendingConnectionConsentRevisions[label] = revision
  }
  const connectionHosts: Record<string, string> = {}
  for (const label of labels) {
    const hostname = document.connectionHosts[label]
    if (hostname) connectionHosts[label] = hostname
  }
  return { acknowledgedConnections, pendingConnectionConsents, pendingConnectionConsentRevisions, connectionHosts }
}
