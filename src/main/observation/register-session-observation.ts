import { randomBytes } from 'node:crypto'
import type { HostFactsService } from '../facts/host-facts-service'
import { normalizeHostname } from '../facts/host-facts-service'
import type { HostMemoryAuthorizationUndo, HostMemorySettingsService } from '../settings/host-memory-settings-service'
import { normalizeSafeHostMemoryConnectionLabel, normalizeSafeHostMemoryHostnameOutput } from '../../shared/host-memory-safety'
import type { HostMemoryDisclosure, HostMemoryScopes } from '../../shared/contracts'
import type { ConnectedSession, SessionService } from '../ssh/session-service'
import { ObservationRunner, linuxCpuModelCommand, linuxDiskCommand, linuxMemoryCommand, linuxNetworkCommand, linuxProcessCommand, linuxServiceCommand } from './observation-runner'

type SessionObservationSource = Pick<SessionService, 'executeReadOnly' | 'onOpened' | 'setObservedHostname' | 'clearObservedHostname' | 'supportsReadOnlyObservation'> & Partial<Pick<SessionService, 'onClosed' | 'connectionIp'>>
type HostFactsSink = { observe(facts: Parameters<HostFactsService['observe']>[0], canPersist?: () => boolean | Promise<boolean>): Promise<unknown> }
type HostMemoryGate = Pick<HostMemorySettingsService, 'canCollect' | 'collectionScopes' | 'filterFacts'> & Partial<Pick<HostMemorySettingsService, 'acknowledgeConnection' | 'connectionConsentRevision' | 'isConnectionAcknowledged' | 'associateConnection' | 'authorizeConnectionBinding' | 'revokeConnection' | 'revokeHost' | 'restoreHostAuthorization' | 'canObserveHost'>>
type DisclosureTarget = { send(channel: 'host-memory:disclosure' | 'host-memory:invalidation', payload: HostMemoryDisclosure | { token: string }): void }
export type SessionObservationRegistration = (() => void) & { acknowledge(token: string): Promise<void>; dismiss(token: string): Promise<void>; revokeHost(hostIdentity: string): Promise<HostMemoryAuthorizationUndo | undefined>; restoreHostAuthorization(undo: HostMemoryAuthorizationUndo): Promise<void>; pending(): HostMemoryDisclosure[] }
type PendingDisclosure = { token: string; label: string; consentRevision?: number; sessions: Map<string, ConnectedSession>; sessionGenerations: Map<string, number>; expiresAt: number; acknowledging?: Promise<void>; timeout: ReturnType<typeof setTimeout> }
const consentTtlMs = 5 * 60 * 1_000

export function registerSessionObservation(sessions: SessionObservationSource, facts: HostFactsSink, memory?: HostMemoryGate, renderer?: DisclosureTarget): SessionObservationRegistration {
  if (!memory) {
    const unavailable = (() => undefined) as SessionObservationRegistration
    unavailable.acknowledge = async () => { throw new Error('Invalid host memory consent') }
    unavailable.dismiss = async () => undefined
    unavailable.revokeHost = async () => { throw new Error('Invalid host memory consent') }
    unavailable.restoreHostAuthorization = async () => { throw new Error('Invalid host memory consent') }
    unavailable.pending = () => []
    return unavailable
  }
  const disclosures = new Map<string, PendingDisclosure>()
  const disclosureByLabel = new Map<string, PendingDisclosure>()
  const activeSessions = new Set<string>()
  const observedHostnames = new Map<string, string>()
  const inFlightHostnames = new Map<string, string>()
  const inFlightLabels = new Map<string, string>()
  const sessionLabels = new Map<string, string>()
  const sessionGenerations = new Map<string, number>()
  const hostRevocationEpochs = new Map<string, number>()
  const sessionRevocationEpochs = new Map<string, Map<string, number>>()
  let disposed = false
  const clear = (pending: PendingDisclosure, invalidate: boolean): void => {
    clearTimeout(pending.timeout); disclosures.delete(pending.token)
    if (disclosureByLabel.get(pending.label) === pending) disclosureByLabel.delete(pending.label)
    if (invalidate) renderer?.send('host-memory:invalidation', { token: pending.token })
  }
  const disclose = (label: string, session: ConnectedSession): void => {
    const existing = disclosureByLabel.get(label)
    if (existing) {
      existing.sessions.set(session.id, session)
      existing.sessionGenerations.set(session.id, sessionGenerations.get(session.id) ?? 0)
      return
    }
    const token = randomBytes(32).toString('base64url')
    const pending = { token, label, consentRevision: memory.connectionConsentRevision?.(), sessions: new Map([[session.id, session]]), sessionGenerations: new Map([[session.id, sessionGenerations.get(session.id) ?? 0]]), expiresAt: Date.now() + consentTtlMs } as PendingDisclosure
    pending.timeout = setTimeout(() => { if (disclosures.get(token) === pending) clear(pending, true) }, consentTtlMs); pending.timeout.unref?.()
    disclosures.set(token, pending); disclosureByLabel.set(label, pending)
    renderer?.send('host-memory:disclosure', { token, hostIdentity: label })
  }
  const observe = async (session: ConnectedSession): Promise<void> => {
    const generation = sessionGenerations.get(session.id) ?? 0
    const startedAtRevocationEpochs = sessionRevocationEpochs.get(session.id) ?? new Map<string, number>()
    const isActive = () => !disposed && activeSessions.has(session.id) && sessionGenerations.get(session.id) === generation
    const label = sessionLabels.get(session.id)
    if (label) inFlightLabels.set(session.id, label)
    try {
      const hostname = await continueObservation(sessions, facts, session, memory, isActive, observed => {
        if (isActive()) { inFlightHostnames.set(session.id, observed); inFlightLabels.delete(session.id) }
      }, discoveredHostname => (hostRevocationEpochs.get(discoveredHostname) ?? 0) > (startedAtRevocationEpochs.get(discoveredHostname) ?? 0), () => { if (label && isActive()) disclose(label, session) })
      if (hostname && isActive()) observedHostnames.set(session.id, hostname)
    } finally {
      inFlightHostnames.delete(session.id)
      inFlightLabels.delete(session.id)
    }
  }
  const unsubscribe = sessions.onOpened(session => {
    activeSessions.add(session.id)
    const generation = (sessionGenerations.get(session.id) ?? 0) + 1
    sessionGenerations.set(session.id, generation)
    sessionRevocationEpochs.set(session.id, new Map(hostRevocationEpochs))
    try {
      if (!sessions.supportsReadOnlyObservation(session.id)) return
      const label = safeLabel(session.hostname); if (!label) return
      sessionLabels.set(session.id, label)
      inFlightLabels.set(session.id, label)
      void (async () => {
        const isCurrent = () => !disposed && activeSessions.has(session.id) && sessionGenerations.get(session.id) === generation
        try {
          if (!await memory.canCollect() || !isCurrent()) return
          if (await memory.isConnectionAcknowledged?.(label)) {
            if (isCurrent()) await observe(session)
            return
          }
          if (isCurrent()) disclose(label, session)
        } finally {
          if (sessionGenerations.get(session.id) === generation && inFlightLabels.get(session.id) === label) inFlightLabels.delete(session.id)
        }
      })().catch(() => undefined)
    } catch { /* terminal remains available */ }
  })
  const unsubscribeClosed = sessions.onClosed?.(({ sessionId }) => {
    activeSessions.delete(sessionId)
    observedHostnames.delete(sessionId)
    inFlightHostnames.delete(sessionId)
    inFlightLabels.delete(sessionId)
    sessionGenerations.set(sessionId, (sessionGenerations.get(sessionId) ?? 0) + 1)
    sessionLabels.delete(sessionId)
    sessionRevocationEpochs.delete(sessionId)
    for (const pending of [...disclosures.values()]) {
      pending.sessions.delete(sessionId)
      pending.sessionGenerations.delete(sessionId)
      if (!pending.sessions.size) clear(pending, true)
    }
  })
  const registration = (() => { disposed = true; for (const sessionId of activeSessions) sessionGenerations.set(sessionId, (sessionGenerations.get(sessionId) ?? 0) + 1); activeSessions.clear(); observedHostnames.clear(); inFlightHostnames.clear(); inFlightLabels.clear(); sessionLabels.clear(); sessionRevocationEpochs.clear(); for (const pending of [...disclosures.values()]) clear(pending, true); unsubscribe(); unsubscribeClosed?.() }) as SessionObservationRegistration
  registration.pending = () => [...disclosures.values()].filter(item => item.expiresAt > Date.now()).map(item => ({ token: item.token, hostIdentity: item.label }))
  registration.acknowledge = async token => {
    if (disposed) throw new Error('Invalid host memory consent')
    const pending = disclosures.get(token)
    if (!pending || pending.expiresAt <= Date.now() || ![...pending.sessions.keys()].some(id => activeSessions.has(id))) { if (pending) clear(pending, true); throw new Error('Invalid host memory consent') }
    if (pending.acknowledging) return pending.acknowledging
    pending.acknowledging = (async () => {
      if (!await memory.canCollect() || disclosures.get(token) !== pending) { clear(pending, true); return }
      if (pending.consentRevision === undefined) await memory.acknowledgeConnection?.(pending.label)
      else await memory.acknowledgeConnection?.(pending.label, pending.consentRevision)
      const stillAcknowledged = memory.isConnectionAcknowledged ? await memory.isConnectionAcknowledged(pending.label) : true
      const queued = [...pending.sessions.values()].filter(session => activeSessions.has(session.id)
        && sessionGenerations.get(session.id) === pending.sessionGenerations.get(session.id))
      if (disclosures.get(token) !== pending || !stillAcknowledged || !queued.length) {
        if (disclosures.get(token) === pending) clear(pending, true)
        return
      }
      clear(pending, false)
      void Promise.all(queued.map(session => observe(session))).catch(() => undefined)
    })()
    try { await pending.acknowledging } catch (error) { pending.acknowledging = undefined; throw error }
  }
  registration.dismiss = async token => {
    if (disposed) throw new Error('Invalid host memory consent')
    const pending = disclosures.get(token)
    if (!pending || pending.expiresAt <= Date.now() || pending.acknowledging) { if (pending && !pending.acknowledging) clear(pending, true); throw new Error('Invalid host memory consent') }
    clear(pending, false)
  }
  registration.restoreHostAuthorization = async undo => {
    if (disposed || !memory.restoreHostAuthorization) throw new Error('Invalid host memory consent')
    await memory.restoreHostAuthorization(undo)
  }
  registration.revokeHost = async hostIdentity => {
    if (disposed) throw new Error('Invalid host memory consent')
    const hostname = normalizeHostname(hostIdentity)
    hostRevocationEpochs.set(hostname, (hostRevocationEpochs.get(hostname) ?? 0) + 1)
    const invalidated = new Set<string>()
    for (const [sessionId, observedHostname] of [...observedHostnames, ...inFlightHostnames]) {
      if (observedHostname !== hostname) continue
      invalidated.add(sessionId)
    }
    const labels = new Set<string>()
    const pendingLabels = new Set<string>()
    for (const pending of [...disclosures.values()]) {
      const associated = pending.label === hostname || [...pending.sessions.keys()].some(sessionId => invalidated.has(sessionId))
      if (!associated) continue
      pendingLabels.add(pending.label)
      for (const sessionId of pending.sessions.keys()) invalidated.add(sessionId)
      clear(pending, true)
    }
    for (const sessionId of invalidated) {
      sessionGenerations.set(sessionId, (sessionGenerations.get(sessionId) ?? 0) + 1)
      activeSessions.delete(sessionId)
      observedHostnames.delete(sessionId)
      inFlightHostnames.delete(sessionId)
      inFlightLabels.delete(sessionId)
      const label = sessionLabels.get(sessionId)
      if (label) labels.add(label)
      sessions.clearObservedHostname(sessionId)
    }
    if (memory.revokeHost) return pendingLabels.size ? memory.revokeHost(hostname, [...labels], [...pendingLabels]) : memory.revokeHost(hostname, [...labels])
    await Promise.all([...labels].map(label => memory.revokeConnection?.(label)))
    return undefined
  }
  return registration
}

async function continueObservation(sessions: SessionObservationSource, facts: HostFactsSink, session: ConnectedSession, memory: HostMemoryGate, isActive: () => boolean, onHostname?: (hostname: string) => void, hostRevokedSinceStart: (hostname: string) => boolean = () => false, onConsentRequired: () => void = () => undefined): Promise<string | undefined> {
  const label = safeLabel(session.hostname)
  const permitted = async (hostname?: string, allowUnmapped = false) => {
    if (!isActive() || !sessions.supportsReadOnlyObservation(session.id) || (hostname && hostRevokedSinceStart(hostname))) return false
    if (!await memory.canCollect() || !isActive() || !sessions.supportsReadOnlyObservation(session.id) || (hostname && hostRevokedSinceStart(hostname))) return false
    if (!hostname) {
      if (label && memory.isConnectionAcknowledged && !await memory.isConnectionAcknowledged(label)) return false
      return isActive() && sessions.supportsReadOnlyObservation(session.id)
    }
    if (!label || !memory.canObserveHost) return true
    const allowed = await memory.canObserveHost(label, hostname, allowUnmapped)
    return allowed && isActive() && sessions.supportsReadOnlyObservation(session.id) && !hostRevokedSinceStart(hostname)
  }
  if (!await permitted()) return undefined
  const hostname = safeHostname(await sessions.executeReadOnly(session.id, 'hostname'))
  if (!hostname || !await permitted()) return undefined
  onHostname?.(hostname)
  if (label && memory.authorizeConnectionBinding) {
    if (!await memory.authorizeConnectionBinding(label, hostname)) { if (isActive()) onConsentRequired(); return undefined }
    if (!await permitted(hostname)) return undefined
  } else if (!await permitted(hostname, true)) return undefined
  const runner = new ObservationRunner(command => sessions.executeReadOnly(session.id, command))
  const scopes = await memory.collectionScopes()
  if (!await permitted(hostname)) return undefined
  const observed = await runner.collectFacts('linux', { knownHostname: hostname, connectionIp: sessions.connectionIp?.(session.id), scopes, beforeCommand: async command => await permitted(hostname) && commandAllowed(command, scopes) })
  if (observed.hostname !== hostname || !await permitted(hostname)) return undefined
  const filtered = await memory.filterFacts(observed)
  if (!await permitted(hostname)) return undefined
  await facts.observe(filtered, async () => await permitted(hostname))
  if (!await permitted(hostname)) return undefined
  if (label && isActive() && !memory.authorizeConnectionBinding) await memory.associateConnection?.(label, hostname, isActive)
  if (!await permitted(hostname)) return undefined
  if (isActive()) sessions.setObservedHostname(session.id, hostname)
  return hostname
}
function commandAllowed(command: string, scopes: HostMemoryScopes): boolean {
  if (command === 'uname -s' || command === 'uname -r') return scopes.identity
  if ([linuxCpuModelCommand, 'uname -m', 'getconf _NPROCESSORS_ONLN', linuxMemoryCommand, linuxDiskCommand, linuxNetworkCommand].includes(command)) return scopes.hardware
  if (command === linuxProcessCommand) return scopes.processes
  return ['id -un', 'pwd -P', linuxServiceCommand].includes(command) && scopes.runtime
}
function safeHostname(value: string): string | null { try { return normalizeSafeHostMemoryHostnameOutput(value) } catch { return null } }
function safeLabel(value: string): string | null { try { return normalizeSafeHostMemoryConnectionLabel(value) } catch { return null } }
