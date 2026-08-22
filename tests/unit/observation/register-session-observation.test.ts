import { mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { registerSessionObservation } from '../../../src/main/observation/register-session-observation'
import { linuxProcessCommand, linuxServiceCommand } from '../../../src/main/observation/observation-runner'
import type { HostFacts } from '../../../src/main/observation/observation-schema'
import { HostMemorySettingsService } from '../../../src/main/settings/host-memory-settings-service'
import { hostMemoryCommandsForScopes } from '../../../src/shared/host-memory-commands'

describe('registerSessionObservation', () => {
  it('does not create a disclosure after close wins a deferred collection gate', async () => {
    let resolveGate!: (value: boolean) => void
    const sessions = createSessions(true)
    const renderer = { send: vi.fn() }
    const registration = registerSessionObservation(sessions, { observe: vi.fn() }, createMemory({ canCollect: vi.fn(() => new Promise<boolean>(resolve => { resolveGate = resolve })) }), renderer)
    sessions.openedListener?.({ id: 's1', hostname: '192.0.2.10', mode: 'copilot' })
    sessions.closedListener?.({ sessionId: 's1' })
    resolveGate(true)
    await new Promise(resolve => setImmediate(resolve))
    expect(renderer.send).not.toHaveBeenCalled()
    expect(registration.pending()).toEqual([])
  })

  it('does not create a disclosure after dispose wins a deferred collection gate', async () => {
    let resolveGate!: (value: boolean) => void
    const sessions = createSessions(true)
    const renderer = { send: vi.fn() }
    const registration = registerSessionObservation(sessions, { observe: vi.fn() }, createMemory({ canCollect: vi.fn(() => new Promise<boolean>(resolve => { resolveGate = resolve })) }), renderer)
    sessions.openedListener?.({ id: 's1', hostname: '192.0.2.10', mode: 'copilot' })
    registration()
    resolveGate(true)
    await new Promise(resolve => setImmediate(resolve))
    expect(renderer.send).not.toHaveBeenCalled()
    expect(registration.pending()).toEqual([])
  })

  it('lets an unresolved session finish hostname attribution without observing a host revoked in flight', async () => {
    let resolveAcknowledged!: (value: boolean) => void
    const sessions = createSessions(true)
    const revokeHost = vi.fn().mockResolvedValue(undefined)
    const memory = createMemory({
      isConnectionAcknowledged: vi.fn()
        .mockImplementationOnce(() => new Promise<boolean>(resolve => { resolveAcknowledged = resolve }))
        .mockResolvedValue(true),
      revokeHost,
    })
    const registration = registerSessionObservation(sessions, { observe: vi.fn() }, memory)

    sessions.openedListener?.({ id: 's1', hostname: '192.0.2.10', mode: 'copilot' })
    await vi.waitFor(() => expect(memory.isConnectionAcknowledged).toHaveBeenCalledOnce())
    await registration.revokeHost('api-prod')
    resolveAcknowledged(true)
    await new Promise(resolve => setImmediate(resolve))

    expect(sessions.executeReadOnly).toHaveBeenCalledTimes(1)
    expect(sessions.executeReadOnly).toHaveBeenCalledWith('s1', 'hostname')
    expect(revokeHost).toHaveBeenCalledWith('api-prod', [])
    registration()
  })

  it('rechecks the connection-label lease immediately before the hostname command', async () => {
    const sessions = createSessions(true)
    const memory = createMemory({
      isConnectionAcknowledged: vi.fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false),
    })
    const registration = registerSessionObservation(sessions, { observe: vi.fn() }, memory)

    sessions.openedListener?.({ id: 's1', hostname: '192.0.2.10', mode: 'copilot' })
    await vi.waitFor(() => expect(memory.isConnectionAcknowledged).toHaveBeenCalledTimes(2))

    expect(sessions.executeReadOnly).not.toHaveBeenCalled()
    registration()
  })

  it('does not execute a scoped command when revocation wins while collection scopes are deferred', async () => {
    let resolveScopes!: (value: { identity: boolean; hardware: boolean; processes: boolean; runtime: boolean }) => void
    const sessions = createSessions(true)
    const facts = { observe: vi.fn() }
    const memory = createMemory({
      isConnectionAcknowledged: vi.fn().mockResolvedValue(true),
      collectionScopes: vi.fn(() => new Promise(resolve => { resolveScopes = resolve })),
      revokeHost: vi.fn().mockResolvedValue(undefined),
    })
    const registration = registerSessionObservation(sessions, facts, memory)

    sessions.openedListener?.({ id: 's1', hostname: '192.0.2.10', mode: 'copilot' })
    await vi.waitFor(() => expect(memory.collectionScopes).toHaveBeenCalledOnce())
    await registration.revokeHost('api-prod')
    resolveScopes({ identity: true, hardware: true, processes: true, runtime: true })
    await new Promise(resolve => setImmediate(resolve))

    expect(sessions.executeReadOnly.mock.calls).toEqual([['s1', 'hostname']])
    expect(facts.observe).not.toHaveBeenCalled()
    expect(sessions.setObservedHostname).not.toHaveBeenCalled()
    registration()
  })

  it('does not begin a facts write when revocation wins while fact filtering is deferred', async () => {
    let resolveFilter!: (value: HostFacts) => void
    const sessions = createSessions(true)
    const facts = { observe: vi.fn() }
    const memory = createMemory({
      isConnectionAcknowledged: vi.fn().mockResolvedValue(true),
      filterFacts: vi.fn(() => new Promise<HostFacts>(resolve => { resolveFilter = resolve })),
      revokeHost: vi.fn().mockResolvedValue(undefined),
    })
    const registration = registerSessionObservation(sessions, facts, memory)

    sessions.openedListener?.({ id: 's1', hostname: '192.0.2.10', mode: 'copilot' })
    await vi.waitFor(() => expect(memory.filterFacts).toHaveBeenCalledOnce())
    await registration.revokeHost('api-prod')
    resolveFilter({ hostname: 'api-prod', observedAt: '2026-08-18T00:00:00.000Z' })
    await new Promise(resolve => setImmediate(resolve))

    expect(facts.observe).not.toHaveBeenCalled()
    expect(sessions.setObservedHostname).not.toHaveBeenCalled()
    registration()
  })

  it('does not publish the observed hostname when revocation wins while the facts write is deferred', async () => {
    let resolveWrite!: () => void
    const write = new Promise<void>(resolve => { resolveWrite = resolve })
    const sessions = createSessions(true)
    const facts = { observe: vi.fn(async () => { await write }) }
    const memory = createMemory({
      isConnectionAcknowledged: vi.fn().mockResolvedValue(true),
      revokeHost: vi.fn().mockResolvedValue(undefined),
    })
    const registration = registerSessionObservation(sessions, facts, memory)

    sessions.openedListener?.({ id: 's1', hostname: '192.0.2.10', mode: 'copilot' })
    await vi.waitFor(() => expect(facts.observe).toHaveBeenCalledOnce())
    await registration.revokeHost('api-prod')
    resolveWrite()
    await new Promise(resolve => setImmediate(resolve))

    expect(facts.observe).toHaveBeenCalledOnce()
    expect(sessions.setObservedHostname).not.toHaveBeenCalled()
    registration()
  })

  it('does not persist facts after the session closes while filtering', async () => {
    let resolveFilter!: (value: HostFacts) => void
    const sessions = createSessions(true)
    const facts = { observe: vi.fn().mockResolvedValue({ record: { hostname: 'api-prod' } }) }
    const memory = createMemory({
      isConnectionAcknowledged: vi.fn().mockResolvedValue(true),
      filterFacts: vi.fn(() => new Promise<HostFacts>(resolve => { resolveFilter = resolve })),
    })
    const registration = registerSessionObservation(sessions, facts, memory)

    sessions.openedListener?.({ id: 's1', hostname: 'api-prod', mode: 'copilot' })
    await vi.waitFor(() => expect(memory.filterFacts).toHaveBeenCalledOnce())
    sessions.closedListener?.({ sessionId: 's1' })
    resolveFilter({ hostname: 'api-prod', observedAt: '2026-08-18T00:00:00.000Z' })
    await new Promise(resolve => setImmediate(resolve))

    expect(facts.observe).not.toHaveBeenCalled()
    registration()
  })

  it('replays pending disclosures and invalidates them when their session closes', async () => {
    const sessions = createSessions(true)
    const renderer = { send: vi.fn() }
    const registration = registerSessionObservation(sessions, { observe: vi.fn() }, createMemory(), renderer)
    sessions.openedListener?.({ id: 's1', hostname: '192.0.2.10', mode: 'copilot' })
    await vi.waitFor(() => expect(registration.pending()).toHaveLength(1))
    const pending = registration.pending()[0]!
    sessions.closedListener?.({ sessionId: 's1' })
    expect(registration.pending()).toEqual([])
    expect(renderer.send).toHaveBeenCalledWith('host-memory:invalidation', { token: pending.token })
  })

  it('invalidates an expired disclosure so renderer state can remove it', async () => {
    vi.useFakeTimers()
    try {
      const sessions = createSessions(true)
      const renderer = { send: vi.fn() }
      const registration = registerSessionObservation(sessions, { observe: vi.fn() }, createMemory(), renderer)
      sessions.openedListener?.({ id: 's1', hostname: '192.0.2.10', mode: 'copilot' })
      await vi.advanceTimersByTimeAsync(0)
      const pending = registration.pending()[0]!
      await vi.advanceTimersByTimeAsync(5 * 60 * 1_000)
      expect(registration.pending()).toEqual([])
      expect(renderer.send).toHaveBeenCalledWith('host-memory:invalidation', { token: pending.token })
    } finally { vi.useRealTimers() }
  })

  it('uses one disclosure for concurrent sessions sharing a stable connection label', async () => {
    const sessions = createSessions(true)
    const facts = { observe: vi.fn(async (value: HostFacts) => value) }
    const memory = createMemory()
    const renderer = { send: vi.fn() }
    const registration = registerSessionObservation(sessions, facts, memory, renderer)
    sessions.openedListener?.({ id: 's1', hostname: '192.0.2.10', mode: 'copilot' })
    sessions.openedListener?.({ id: 's2', hostname: '192.0.2.10', mode: 'copilot' })
    await vi.waitFor(() => expect(renderer.send).toHaveBeenCalledTimes(1))
    await registration.acknowledge(renderer.send.mock.calls[0]![1].token)
    expect(memory.acknowledgeConnection).toHaveBeenCalledWith('192.0.2.10')
    await vi.waitFor(() => expect(sessions.executeReadOnly.mock.calls.filter(([, command]) => command === 'hostname')).toHaveLength(2))
    await vi.waitFor(() => expect(facts.observe).toHaveBeenCalledTimes(2))
  })

  it('starts observation without disclosure for a previously acknowledged connection label', async () => {
    const sessions = createSessions(true)
    const facts = { observe: vi.fn(async (value: HostFacts) => value) }
    const memory = createMemory({ isConnectionAcknowledged: vi.fn().mockResolvedValue(true) })
    const renderer = { send: vi.fn() }
    registerSessionObservation(sessions, facts, memory, renderer)
    sessions.openedListener?.({ id: 's1', hostname: '192.0.2.10', mode: 'copilot' })
    await vi.waitFor(() => expect(facts.observe).toHaveBeenCalledOnce())
    expect(renderer.send).not.toHaveBeenCalled()
  })

  it('continues disclosure acknowledgement through binding and reopen across real service reloads', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'host-memory-observation-'))
    try {
      const path = join(directory, 'settings.json')
      const firstMemory = new HostMemorySettingsService(path)
      await firstMemory.save({ enabled: true, scopes: { identity: true, hardware: false, processes: false, runtime: false } })
      await firstMemory.revokeHost('api-prod')
      const firstSessions = createSessions(true)
      firstSessions.executeReadOnly.mockRejectedValue(new Error('observation unavailable before binding'))
      const firstRenderer = { send: vi.fn() }
      const firstRegistration = registerSessionObservation(firstSessions, { observe: vi.fn() }, firstMemory, firstRenderer)

      firstSessions.openedListener?.({ id: 's1', hostname: '192.0.2.10', mode: 'copilot' })
      await vi.waitFor(() => expect(firstRenderer.send).toHaveBeenCalledWith('host-memory:disclosure', expect.any(Object)))
      await firstRegistration.acknowledge(firstRenderer.send.mock.calls[0]![1].token)
      firstRegistration()

      const secondMemory = new HostMemorySettingsService(path)
      const secondSessions = createSessions(true)
      const secondFacts = { observe: vi.fn(async (value: HostFacts) => value) }
      const secondRenderer = { send: vi.fn() }
      const secondRegistration = registerSessionObservation(secondSessions, secondFacts, secondMemory, secondRenderer)
      secondSessions.openedListener?.({ id: 's2', hostname: '192.0.2.10', mode: 'copilot' })

      await vi.waitFor(() => expect(secondFacts.observe).toHaveBeenCalledOnce())
      expect(secondRenderer.send).not.toHaveBeenCalled()
      expect(await secondMemory.canObserveHost('192.0.2.10', 'api-prod')).toBe(true)
      secondRegistration()

      const reopenedMemory = new HostMemorySettingsService(path)
      const reopenedSessions = createSessions(true)
      const reopenedFacts = { observe: vi.fn(async (value: HostFacts) => value) }
      const reopenedRenderer = { send: vi.fn() }
      const reopenedRegistration = registerSessionObservation(reopenedSessions, reopenedFacts, reopenedMemory, reopenedRenderer)
      reopenedSessions.openedListener?.({ id: 's3', hostname: '192.0.2.10', mode: 'copilot' })

      await vi.waitFor(() => expect(reopenedFacts.observe).toHaveBeenCalledOnce())
      expect(reopenedRenderer.send).not.toHaveBeenCalled()
      reopenedRegistration()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('revokes host authorization and clears the observed mapping so a reopened connection discloses again', async () => {
    const sessions = createSessions(true)
    const facts = { observe: vi.fn(async (value: HostFacts) => value) }
    let acknowledged = true
    const memory = createMemory({
      isConnectionAcknowledged: vi.fn(async () => acknowledged),
      acknowledgeConnection: vi.fn(async () => { acknowledged = true }),
      revokeConnection: vi.fn(async () => { acknowledged = false }),
    })
    const renderer = { send: vi.fn() }
    const registration = registerSessionObservation(sessions, facts, memory, renderer)

    sessions.openedListener?.({ id: 's1', hostname: '192.0.2.10', mode: 'copilot' })
    await vi.waitFor(() => expect(facts.observe).toHaveBeenCalledOnce())
    await registration.revokeHost('api-prod')

    expect(memory.revokeConnection).toHaveBeenCalledWith('192.0.2.10')
    expect(sessions.clearObservedHostname).toHaveBeenCalledWith('s1')

    sessions.openedListener?.({ id: 's2', hostname: '192.0.2.10', mode: 'copilot' })
    await vi.waitFor(() => expect(renderer.send).toHaveBeenCalledOnce())
    expect(renderer.send.mock.calls[0]![1]).toMatchObject({ hostIdentity: '192.0.2.10' })
    await registration.acknowledge(renderer.send.mock.calls[0]![1].token)
    await vi.waitFor(() => expect(facts.observe).toHaveBeenCalledTimes(2))
    registration()
  })

  it('coalesces concurrent acknowledgement attempts for the same disclosure token', async () => {
    let releaseAcknowledgement!: () => void
    const acknowledgement = new Promise<void>(resolve => { releaseAcknowledgement = resolve })
    const sessions = createSessions(true)
    const memory = createMemory({ acknowledgeConnection: vi.fn(async () => { await acknowledgement }) })
    const renderer = { send: vi.fn() }
    const registration = registerSessionObservation(sessions, { observe: vi.fn() }, memory, renderer)

    sessions.openedListener?.({ id: 's1', hostname: '192.0.2.10', mode: 'copilot' })
    await vi.waitFor(() => expect(renderer.send).toHaveBeenCalledOnce())
    const token = renderer.send.mock.calls[0]![1].token
    const first = registration.acknowledge(token)
    const second = registration.acknowledge(token)
    await vi.waitFor(() => expect(memory.acknowledgeConnection).toHaveBeenCalledOnce())

    releaseAcknowledgement()
    await Promise.all([first, second])

    expect(memory.acknowledgeConnection).toHaveBeenCalledTimes(1)
    registration()
  })

  it('invalidates a blocked acknowledgement when its host is revoked before consent persistence finishes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'host-memory-acknowledgement-race-'))
    try {
      const path = join(directory, 'settings.json')
      const initial = new HostMemorySettingsService(path)
      await initial.save({ enabled: true, scopes: { identity: true, hardware: false, processes: false, runtime: false } })
      await initial.acknowledgeConnection('192.0.2.10')
      await initial.authorizeConnectionBinding('192.0.2.10', 'api-prod')

      let releaseAcknowledgement!: () => void
      let markAcknowledgementStarted!: () => void
      const acknowledgementStarted = new Promise<void>(resolve => { markAcknowledgementStarted = resolve })
      const acknowledgementGate = new Promise<void>(resolve => { releaseAcknowledgement = resolve })
      let blockNextRename = true
      const memory = new HostMemorySettingsService(path, {
        fileSystem: {
          rename: async (source: string, destination: string) => {
            if (blockNextRename) {
              blockNextRename = false
              markAcknowledgementStarted()
              await acknowledgementGate
            }
            await rename(source, destination)
          },
        },
      })
      const sessions = createSessions(true)
      const facts = { observe: vi.fn() }
      const renderer = { send: vi.fn() }
      const registration = registerSessionObservation(sessions, facts, memory, renderer)

      sessions.openedListener?.({ id: 's1', hostname: 'api-prod', mode: 'copilot' })
      await vi.waitFor(() => expect(renderer.send).toHaveBeenCalledWith('host-memory:disclosure', expect.any(Object)))
      const firstDisclosure = renderer.send.mock.calls[0]![1]
      const acknowledgement = registration.acknowledge(firstDisclosure.token)
      await acknowledgementStarted

      const revocation = registration.revokeHost('api-prod')
      await vi.waitFor(() => expect(renderer.send).toHaveBeenCalledWith('host-memory:invalidation', { token: firstDisclosure.token }))
      releaseAcknowledgement()
      await Promise.all([acknowledgement, revocation])
      await new Promise(resolve => setImmediate(resolve))

      const stored = JSON.parse(await readFile(path, 'utf8'))
      expect(stored.connectionHosts).not.toHaveProperty('api-prod')
      expect(stored.acknowledgedConnections).not.toContain('api-prod')
      expect(stored.revokedHostConnections['api-prod']).toContain('api-prod')
      expect(sessions.executeReadOnly).not.toHaveBeenCalled()
      expect(facts.observe).not.toHaveBeenCalled()
      expect(sessions.setObservedHostname).not.toHaveBeenCalled()

      sessions.openedListener?.({ id: 's2', hostname: 'api-prod', mode: 'copilot' })
      await vi.waitFor(() => expect(renderer.send.mock.calls.filter(([channel]) => channel === 'host-memory:disclosure')).toHaveLength(2))
      const disclosures = renderer.send.mock.calls.filter(([channel]) => channel === 'host-memory:disclosure')
      expect(disclosures).toHaveLength(2)
      expect(disclosures[1]![1].token).not.toBe(firstDisclosure.token)
      registration()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('keeps pre-revocation consent stale when clear persists before a delayed acknowledgement', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'host-memory-late-acknowledgement-'))
    try {
      const path = join(directory, 'settings.json')
      const memory = new HostMemorySettingsService(path)
      await memory.save({ enabled: true, scopes: { identity: true, hardware: false, processes: false, runtime: false } })
      await memory.acknowledgeConnection('192.0.2.10')
      await memory.authorizeConnectionBinding('192.0.2.10', 'api-prod')

      let releaseCollection!: () => void
      let markCollectionStarted!: () => void
      const collectionStarted = new Promise<void>(resolve => { markCollectionStarted = resolve })
      const collectionGate = new Promise<void>(resolve => { releaseCollection = resolve })
      const canCollect = memory.canCollect.bind(memory)
      let collectionChecks = 0
      vi.spyOn(memory, 'canCollect').mockImplementation(async () => {
        collectionChecks += 1
        if (collectionChecks === 2) {
          markCollectionStarted()
          await collectionGate
        }
        return canCollect()
      })

      const sessions = createSessions(true)
      const facts = { observe: vi.fn() }
      const renderer = { send: vi.fn() }
      const registration = registerSessionObservation(sessions, facts, memory, renderer)
      sessions.openedListener?.({ id: 's1', hostname: '192.0.2.20', mode: 'copilot' })
      await vi.waitFor(() => expect(renderer.send).toHaveBeenCalledWith('host-memory:disclosure', expect.any(Object)))
      const staleDisclosure = renderer.send.mock.calls[0]![1]

      const acknowledgement = registration.acknowledge(staleDisclosure.token)
      await collectionStarted
      await memory.revokeHost('api-prod')
      releaseCollection()
      await acknowledgement

      await vi.waitFor(() => expect(renderer.send.mock.calls.filter(([channel]) => channel === 'host-memory:disclosure')).toHaveLength(2))
      expect(facts.observe).not.toHaveBeenCalled()
      expect(sessions.setObservedHostname).not.toHaveBeenCalled()
      registration()

      const reloaded = new HostMemorySettingsService(path)
      const reopenedSessions = createSessions(true)
      const reopenedFacts = { observe: vi.fn() }
      const reopenedRenderer = { send: vi.fn() }
      const reopenedRegistration = registerSessionObservation(reopenedSessions, reopenedFacts, reloaded, reopenedRenderer)
      reopenedSessions.openedListener?.({ id: 's2', hostname: '192.0.2.20', mode: 'copilot' })

      await vi.waitFor(() => expect(reopenedRenderer.send).toHaveBeenCalledWith('host-memory:disclosure', expect.any(Object)))
      expect(reopenedFacts.observe).not.toHaveBeenCalled()
      expect(await reloaded.canObserveHost('192.0.2.20', 'api-prod')).toBe(false)
      const stored = JSON.parse(await readFile(path, 'utf8'))
      expect(stored.connectionHosts).not.toHaveProperty('192.0.2.20')
      expect(stored.revokedHosts).toContain('api-prod')
      reopenedRegistration()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('requires fresh disclosure after a real host revoke wins before delayed acknowledgement', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'host-memory-register-host-revision-'))
    try {
      const path = join(directory, 'settings.json')
      const memory = new HostMemorySettingsService(path)
      await memory.save({ enabled: true, scopes: { identity: true, hardware: false, processes: false, runtime: false } })
      const sessions = createSessions(true)
      const facts = { observe: vi.fn() }
      const renderer = { send: vi.fn() }
      const registration = registerSessionObservation(sessions, facts, memory, renderer)
      sessions.openedListener?.({ id: 's1', hostname: '192.0.2.10', mode: 'copilot' })
      await vi.waitFor(() => expect(renderer.send).toHaveBeenCalledWith('host-memory:disclosure', expect.any(Object)))
      const disclosure = renderer.send.mock.calls[0]![1]
      const revision = memory.connectionConsentRevision()
      await memory.revokeHost('api-prod', [], ['192.0.2.10'])
      await memory.acknowledgeConnection('192.0.2.10', revision)
      await registration.acknowledge(disclosure.token)
      expect(facts.observe).not.toHaveBeenCalled()
      registration()

      const reloaded = new HostMemorySettingsService(path)
      const reopenedSessions = createSessions(true)
      const reopenedFacts = { observe: vi.fn() }
      const reopenedRenderer = { send: vi.fn() }
      const reopenedRegistration = registerSessionObservation(reopenedSessions, reopenedFacts, reloaded, reopenedRenderer)
      reopenedSessions.openedListener?.({ id: 's2', hostname: '192.0.2.10', mode: 'copilot' })
      await vi.waitFor(() => expect(reopenedRenderer.send).toHaveBeenCalledWith('host-memory:disclosure', expect.any(Object)))
      expect(reopenedSessions.executeReadOnly).not.toHaveBeenCalledWith('s2', 'hostname')
      expect(reopenedFacts.observe).not.toHaveBeenCalled()
      reopenedRegistration()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('requires fresh disclosure after a real connection revoke wins a deferred acknowledgement', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'host-memory-register-connection-revision-'))
    try {
      const path = join(directory, 'settings.json')
      const memory = new HostMemorySettingsService(path)
      await memory.save({ enabled: true, scopes: { identity: true, hardware: false, processes: false, runtime: false } })
      let releaseCollection!: () => void
      let markCollectionStarted!: () => void
      const collectionStarted = new Promise<void>(resolve => { markCollectionStarted = resolve })
      const collectionGate = new Promise<void>(resolve => { releaseCollection = resolve })
      const canCollect = memory.canCollect.bind(memory)
      let collectionChecks = 0
      vi.spyOn(memory, 'canCollect').mockImplementation(async () => {
        collectionChecks += 1
        if (collectionChecks === 2) { markCollectionStarted(); await collectionGate }
        return canCollect()
      })
      const sessions = createSessions(true)
      const facts = { observe: vi.fn() }
      const renderer = { send: vi.fn() }
      const registration = registerSessionObservation(sessions, facts, memory, renderer)
      sessions.openedListener?.({ id: 's1', hostname: '192.0.2.10', mode: 'copilot' })
      await vi.waitFor(() => expect(renderer.send).toHaveBeenCalledWith('host-memory:disclosure', expect.any(Object)))
      const acknowledgement = registration.acknowledge(renderer.send.mock.calls[0]![1].token)
      await collectionStarted
      await memory.revokeConnection('192.0.2.10')
      releaseCollection()
      await acknowledgement
      expect(facts.observe).not.toHaveBeenCalled()
      registration()

      const reloaded = new HostMemorySettingsService(path)
      const reopenedSessions = createSessions(true)
      const reopenedFacts = { observe: vi.fn() }
      const reopenedRenderer = { send: vi.fn() }
      const reopenedRegistration = registerSessionObservation(reopenedSessions, reopenedFacts, reloaded, reopenedRenderer)
      reopenedSessions.openedListener?.({ id: 's2', hostname: '192.0.2.10', mode: 'copilot' })
      await vi.waitFor(() => expect(reopenedRenderer.send).toHaveBeenCalledWith('host-memory:disclosure', expect.any(Object)))
      expect(reopenedSessions.executeReadOnly).not.toHaveBeenCalledWith('s2', 'hostname')
      expect(reopenedFacts.observe).not.toHaveBeenCalled()
      reopenedRegistration()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('does not restore a revoked host mapping when observation finishes after revocation', async () => {
    let releaseFacts!: () => void
    const sessions = createSessions(true)
    const facts = {
      observe: vi.fn(() => new Promise<void>(resolve => { releaseFacts = resolve })),
    }
    const memory = {
      ...createMemory({
        isConnectionAcknowledged: vi.fn().mockResolvedValue(true),
        associateConnection: vi.fn().mockResolvedValue(undefined),
      }),
      revokeHost: vi.fn().mockResolvedValue(undefined),
    }
    const registration = registerSessionObservation(sessions, facts, memory)

    sessions.openedListener?.({ id: 's1', hostname: '192.0.2.10', mode: 'copilot' })
    await vi.waitFor(() => expect(facts.observe).toHaveBeenCalledOnce())
    await registration.revokeHost('api-prod')
    expect(memory.revokeHost).toHaveBeenCalledWith('api-prod', ['192.0.2.10'])
    releaseFacts()
    await new Promise(resolve => setImmediate(resolve))

    expect(memory.associateConnection).not.toHaveBeenCalled()
    expect(sessions.setObservedHostname).not.toHaveBeenCalled()
    registration()
  })

  it('does not continue remote observation when host revocation wins a pending hostname command', async () => {
    let releaseHostname!: (value: string) => void
    const sessions = createSessions(true)
    sessions.executeReadOnly.mockImplementation((_sessionId: string, command: string) => command === 'hostname'
      ? new Promise<string>(resolve => { releaseHostname = resolve })
      : Promise.resolve(commandOutput(command)))
    const facts = { observe: vi.fn().mockResolvedValue(undefined) }
    const acknowledged = { value: true }
    const memory = createMemory({
      isConnectionAcknowledged: vi.fn(async () => acknowledged.value),
      revokeConnection: vi.fn(async () => { acknowledged.value = false }),
      associateConnection: vi.fn().mockResolvedValue(undefined),
    })
    const registration = registerSessionObservation(sessions, facts, memory)

    sessions.openedListener?.({ id: 's1', hostname: '192.0.2.10', mode: 'copilot' })
    await vi.waitFor(() => expect(sessions.executeReadOnly).toHaveBeenCalledWith('s1', 'hostname'))
    await registration.revokeHost('api-prod')
    releaseHostname('api-prod\n')
    await new Promise(resolve => setImmediate(resolve))

    expect(sessions.executeReadOnly).toHaveBeenCalledTimes(1)
    expect(facts.observe).not.toHaveBeenCalled()
    expect(memory.associateConnection).not.toHaveBeenCalled()
    expect(sessions.setObservedHostname).not.toHaveBeenCalled()
    registration()
  })

  it('keeps an unrelated pending disclosure live when another observed host is cleared', async () => {
    const sessions = createSessions(true)
    sessions.executeReadOnly.mockImplementation((sessionId: string, command: string) => Promise.resolve(
      command === 'hostname' ? `${sessionId === 's1' ? 'api-prod' : 'web-prod'}\n` : commandOutput(command),
    ))
    const acknowledged = new Set(['192.0.2.10'])
    const facts = { observe: vi.fn() }
    const revokeHost = vi.fn().mockResolvedValue(undefined)
    const memory = createMemory({
      isConnectionAcknowledged: vi.fn(async (label: string) => acknowledged.has(label)),
      acknowledgeConnection: vi.fn(async (label: string) => { acknowledged.add(label) }),
      revokeHost,
      canObserveHost: vi.fn().mockResolvedValue(true),
    })
    const renderer = { send: vi.fn() }
    const registration = registerSessionObservation(sessions, facts, memory, renderer)

    sessions.openedListener?.({ id: 's1', hostname: '192.0.2.10', mode: 'copilot' })
    await vi.waitFor(() => expect(facts.observe).toHaveBeenCalledOnce())
    sessions.openedListener?.({ id: 's2', hostname: '192.0.2.20', mode: 'copilot' })
    await vi.waitFor(() => expect(registration.pending()).toHaveLength(1))
    const webDisclosure = registration.pending()[0]!

    await registration.revokeHost('api-prod')
    expect(registration.pending()).toEqual([webDisclosure])
    expect(revokeHost).toHaveBeenCalledWith('api-prod', ['192.0.2.10'])
    expect(sessions.clearObservedHostname).toHaveBeenCalledWith('s1')
    expect(sessions.clearObservedHostname).not.toHaveBeenCalledWith('s2')

    await registration.acknowledge(webDisclosure.token)
    await vi.waitFor(() => expect(facts.observe).toHaveBeenCalledTimes(2))
    expect(sessions.setObservedHostname).toHaveBeenCalledWith('s2', 'web-prod')
    registration()
  })

  it('uses a strict mapped-host check for every collection command after one-time hostname binding', async () => {
    const sessions = createSessions(true)
    const facts = { observe: vi.fn().mockResolvedValue({ record: { hostname: 'api-prod' } }) }
    const memory = createMemory({ canObserveHost: vi.fn().mockResolvedValue(true) })
    const renderer = { send: vi.fn() }
    const registration = registerSessionObservation(sessions, facts, memory, renderer)

    sessions.openedListener?.({ id: 's1', hostname: '192.0.2.10', mode: 'copilot' })
    await vi.waitFor(() => expect(renderer.send).toHaveBeenCalledOnce())
    await registration.acknowledge(renderer.send.mock.calls[0]![1].token)
    await vi.waitFor(() => expect(facts.observe).toHaveBeenCalledOnce())

    expect(memory.canObserveHost).toHaveBeenCalledWith('192.0.2.10', 'api-prod', false)
    registration()
  })

  it('stops before collection when the strict host gate revokes after the one-time binding check', async () => {
    const sessions = createSessions(true)
    const facts = { observe: vi.fn().mockResolvedValue({ record: { hostname: 'api-prod' } }) }
    const memory = createMemory({
      canObserveHost: vi.fn(async (_label: string, _hostname: string, allowUnmapped = false) => allowUnmapped),
    })
    const renderer = { send: vi.fn() }
    const registration = registerSessionObservation(sessions, facts, memory, renderer)

    sessions.openedListener?.({ id: 's1', hostname: '192.0.2.10', mode: 'copilot' })
    await vi.waitFor(() => expect(renderer.send).toHaveBeenCalledOnce())
    await registration.acknowledge(renderer.send.mock.calls[0]![1].token)
    await new Promise(resolve => setImmediate(resolve))

    expect(sessions.executeReadOnly.mock.calls).toEqual([['s1', 'hostname']])
    expect(facts.observe).not.toHaveBeenCalled()
    expect(sessions.setObservedHostname).not.toHaveBeenCalled()
    registration()
  })

  it('does not run observation without the host memory consent gate', async () => {
    const sessions = createSessions(true)
    const facts = { observe: vi.fn().mockResolvedValue({ record: { hostname: 'api-prod' } }) }
    registerSessionObservation(sessions, facts)

    sessions.openedListener?.({ id: 's1', hostname: '10.0.0.12', mode: 'copilot' })
    await new Promise(resolve => setImmediate(resolve))

    expect(sessions.executeReadOnly).not.toHaveBeenCalled()
    expect(sessions.setObservedHostname).not.toHaveBeenCalled()
    expect(facts.observe).not.toHaveBeenCalled()
  })

  it('returns an unavailable registration without subscribing to sessions when the host memory gate is missing', async () => {
    const sessions = createSessions(true)
    const facts = { observe: vi.fn() }
    const registration = registerSessionObservation(sessions, facts)

    expect(sessions.onOpened).not.toHaveBeenCalled()
    await expect(registration.acknowledge('invalid')).rejects.toThrow('Invalid host memory consent')
    await expect(registration.dismiss('invalid')).resolves.toBeUndefined()
  })

  it('does not read a remote hostname when collection is disabled before discovery', async () => {
    const sessions = createSessions(true)
    const facts = { observe: vi.fn() }
    const memory = createMemory({ canCollect: vi.fn().mockResolvedValue(false) })
    registerSessionObservation(sessions, facts, memory)

    sessions.openedListener?.({ id: 's1', hostname: '10.0.0.12', mode: 'copilot' })
    await new Promise(resolve => setImmediate(resolve))

    expect(memory.canCollect).toHaveBeenCalledOnce()
    expect(sessions.executeReadOnly).not.toHaveBeenCalled()
    expect(memory.shouldDisclose).not.toHaveBeenCalled()
    expect(facts.observe).not.toHaveBeenCalled()
  })

  it('discloses an unconfirmed IP session before executing any remote command', async () => {
    const sessions = createSessions(true)
    const facts = { observe: vi.fn().mockResolvedValue({ record: { hostname: 'api-prod' } }) }
    const memory = { shouldDisclose: vi.fn().mockResolvedValue(true), canObserve: vi.fn().mockResolvedValue(false), canCollect: vi.fn().mockResolvedValue(true), acknowledge: vi.fn(), collectionScopes: vi.fn().mockResolvedValue({ identity: true, hardware: true, processes: true, runtime: true }), filterFacts: vi.fn() }
    const renderer = { send: vi.fn() }
    const registration = registerSessionObservation(sessions, facts, memory, renderer)

    sessions.openedListener?.({ id: 's1', hostname: '10.0.0.12', mode: 'copilot' })
    await vi.waitFor(() => expect(renderer.send).toHaveBeenCalledOnce())
    const [, disclosure] = renderer.send.mock.calls[0]!
    expect(disclosure).toMatchObject({ hostIdentity: '10.0.0.12' })
    expect(JSON.stringify(disclosure)).not.toContain('api-prod')
    expect(disclosure.token).toMatch(/^[A-Za-z0-9_-]{32,}$/)
    expect(facts.observe).not.toHaveBeenCalled()
    expect(sessions.setObservedHostname).not.toHaveBeenCalled()
    expect(sessions.executeReadOnly).not.toHaveBeenCalled()
    registration()
  })

  it('drops unsafe remote hostname output before disclosure, session DTOs, or observation', async () => {
    const sessions = createSessions(true)
    sessions.executeReadOnly.mockImplementation((_sessionId: string, command: string) => Promise.resolve(command === 'hostname' ? 'api-prod\npassword=secret\n' : commandOutput(command)))
    const facts = { observe: vi.fn().mockResolvedValue({ record: { hostname: 'api-prod' } }) }
    const memory = { shouldDisclose: vi.fn().mockResolvedValue(true), canObserve: vi.fn().mockResolvedValue(true), canCollect: vi.fn().mockResolvedValue(true), acknowledge: vi.fn(), collectionScopes: vi.fn(), filterFacts: vi.fn() }
    const renderer = { send: vi.fn() }
    const registration = registerSessionObservation(sessions, facts, memory, renderer)

    sessions.openedListener?.({ id: 's1', hostname: '10.0.0.12', mode: 'copilot' })
    await vi.waitFor(() => expect(renderer.send).toHaveBeenCalledOnce())
    const [, disclosure] = renderer.send.mock.calls[0]!
    await registration.acknowledge(disclosure.token)
    await new Promise(resolve => setImmediate(resolve))
    expect(renderer.send).toHaveBeenCalledOnce()
    expect(sessions.setObservedHostname).not.toHaveBeenCalled()
    expect(facts.observe).not.toHaveBeenCalled()
    expect(memory.acknowledge).not.toHaveBeenCalled()
    expect(sessions.executeReadOnly).toHaveBeenCalledWith('s1', 'hostname')
  })

  it('validates and persists the hostname after acknowledgement before observing the session', async () => {
    const sessions = createSessions(true)
    const facts = { observe: vi.fn().mockResolvedValue({ record: { hostname: 'api-prod' } }) }
    const memory = {
      shouldDisclose: vi.fn().mockResolvedValue(true),
      canObserve: vi.fn().mockResolvedValue(true),
      canCollect: vi.fn().mockResolvedValue(true),
      acknowledge: vi.fn().mockResolvedValue(undefined),
      acknowledgeConnection: vi.fn().mockResolvedValue(undefined),
      collectionScopes: vi.fn().mockResolvedValue({ identity: true, hardware: true, processes: true, runtime: true }),
      filterFacts: vi.fn(async (value: HostFacts): Promise<HostFacts> => value),
    }
    const renderer = { send: vi.fn() }
    const registration = registerSessionObservation(sessions, facts, memory, renderer)
    const events: string[] = []
    facts.observe.mockImplementation(async () => { events.push('facts') })
    sessions.setObservedHostname.mockImplementation(() => { events.push('observed') })

    sessions.openedListener?.({ id: 's1', hostname: '10.0.0.12', mode: 'copilot' })
    await vi.waitFor(() => expect(renderer.send).toHaveBeenCalledOnce())
    expect(facts.observe).not.toHaveBeenCalled()
    expect(sessions.setObservedHostname).not.toHaveBeenCalled()
    expect(sessions.executeReadOnly).not.toHaveBeenCalled()

    const [, disclosure] = renderer.send.mock.calls[0]!
    await registration.acknowledge(disclosure.token)

    await vi.waitFor(() => expect(facts.observe).toHaveBeenCalledOnce())
    expect(memory.acknowledgeConnection).toHaveBeenCalledWith('10.0.0.12')
    expect(sessions.setObservedHostname).toHaveBeenCalledTimes(1)
    expect(sessions.setObservedHostname).toHaveBeenCalledWith('s1', 'api-prod')
    expect(events).toEqual(['facts', 'observed'])
    expect(sessions.executeReadOnly.mock.calls[0]).toEqual(['s1', 'hostname'])
    expect(sessions.executeReadOnly.mock.calls.flat()).toContain(linuxProcessCommand)
    expect(memory.filterFacts).toHaveBeenCalledOnce()
    registration()
  })

  it('does not persist facts when memory is disabled after identity discovery', async () => {
    const sessions = createSessions(true)
    const facts = { observe: vi.fn().mockResolvedValue({ record: { hostname: 'api-prod' } }) }
    const memory = createMemory({ canCollect: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValue(false) })
    const renderer = { send: vi.fn() }
    const registration = registerSessionObservation(sessions, facts, memory, renderer)

    sessions.openedListener?.({ id: 's1', hostname: '10.0.0.12', mode: 'copilot' })
    await vi.waitFor(() => expect(renderer.send).toHaveBeenCalledOnce())
    await registration.acknowledge(renderer.send.mock.calls[0]![1].token)
    await vi.waitFor(() => expect(memory.canCollect).toHaveBeenCalledTimes(4))
    expect(facts.observe).not.toHaveBeenCalled()
  })

  it('executes only the enabled scope commands after acknowledgement', async () => {
    const sessions = createSessions(true)
    const facts = { observe: vi.fn().mockResolvedValue({ record: { hostname: 'api-prod' } }) }
    const memory = {
      shouldDisclose: vi.fn().mockResolvedValue(false),
      canObserve: vi.fn().mockResolvedValue(true),
      canCollect: vi.fn().mockResolvedValue(true),
      acknowledge: vi.fn(),
      collectionScopes: vi.fn().mockResolvedValue({ identity: false, hardware: false, processes: false, runtime: true }),
      filterFacts: vi.fn(async (value: HostFacts): Promise<HostFacts> => value),
    }
    const renderer = { send: vi.fn() }
    const registration = registerSessionObservation(sessions, facts, memory, renderer)

    sessions.openedListener?.({ id: 's1', hostname: 'api-prod', mode: 'copilot' })
    await vi.waitFor(() => expect(renderer.send).toHaveBeenCalledOnce())
    await registration.acknowledge(renderer.send.mock.calls[0]![1].token)
    await vi.waitFor(() => expect(facts.observe).toHaveBeenCalledOnce())

    const scopes = { identity: false, hardware: false, processes: false, runtime: true }
    const commands = sessions.executeReadOnly.mock.calls.map(([, command]) => command)
    expect(commands).toEqual(hostMemoryCommandsForScopes(scopes).map(item => item.command))
  })

  it('keeps concurrent disclosures separate and releases dismissed pending state', async () => {
    const sessions = createSessions(true)
    sessions.executeReadOnly.mockImplementation((sessionId: string, command: string) => Promise.resolve(
      command === 'hostname' ? `${sessionId === 's1' ? 'api-one' : sessionId === 's2' ? 'api-two' : 'api-three'}\n` : commandOutput(command),
    ))
    const facts = { observe: vi.fn().mockResolvedValue({ record: { hostname: 'api-one' } }) }
    const memory = {
      shouldDisclose: vi.fn().mockResolvedValue(true), canObserve: vi.fn().mockResolvedValue(true), canCollect: vi.fn().mockResolvedValue(true), acknowledge: vi.fn().mockResolvedValue(undefined),
      acknowledgeConnection: vi.fn().mockResolvedValue(undefined),
      collectionScopes: vi.fn().mockResolvedValue({ identity: false, hardware: false, processes: false, runtime: false }), filterFacts: vi.fn(async (value: HostFacts): Promise<HostFacts> => value),
    }
    const renderer = { send: vi.fn() }
    const registration = registerSessionObservation(sessions, facts, memory, renderer)

    sessions.openedListener?.({ id: 's1', hostname: '10.0.0.1', mode: 'copilot' })
    sessions.openedListener?.({ id: 's2', hostname: '10.0.0.2', mode: 'copilot' })
    await vi.waitFor(() => expect(renderer.send).toHaveBeenCalledTimes(2))
    const first = renderer.send.mock.calls[0]![1]
    const second = renderer.send.mock.calls[1]![1]
    expect(first.hostIdentity).toBe('10.0.0.1')
    expect(second.hostIdentity).toBe('10.0.0.2')

    await registration.acknowledge(first.token)
    await expect(registration.acknowledge(first.token)).rejects.toThrow('Invalid host memory consent')
    await registration.dismiss(second.token)
    sessions.openedListener?.({ id: 's3', hostname: '10.0.0.3', mode: 'copilot' })

    await vi.waitFor(() => expect(renderer.send).toHaveBeenCalledTimes(3))
    expect(memory.acknowledgeConnection).toHaveBeenCalledWith('10.0.0.1')
    expect(memory.acknowledgeConnection).not.toHaveBeenCalledWith('10.0.0.2')
    expect(renderer.send.mock.calls[2]![1]).toMatchObject({ hostIdentity: '10.0.0.3' })
    registration()
  })

  it('does not observe a Raw TCP session', async () => {
    const sessions = createSessions(false)
    const facts = { observe: vi.fn().mockResolvedValue({ record: { hostname: 'api-prod' } }) }
    registerSessionObservation(sessions, facts)

    sessions.openedListener?.({ id: 's1', hostname: '127.0.0.1', mode: 'copilot' })
    await new Promise(resolve => setImmediate(resolve))

    expect(sessions.executeReadOnly).not.toHaveBeenCalled()
    expect(facts.observe).not.toHaveBeenCalled()
  })

  it('keeps a persisted acknowledgement successful when resumed observation fails', async () => {
    const sessions = createSessions(true)
    sessions.executeReadOnly.mockRejectedValue(new Error('exec unavailable'))
    const facts = { observe: vi.fn().mockResolvedValue({ record: { hostname: 'api-prod' } }) }
    const memory = createMemory()
    const renderer = { send: vi.fn() }
    const registration = registerSessionObservation(sessions, facts, memory, renderer)

    expect(() => sessions.openedListener?.({ id: 's1', hostname: 'server-a', mode: 'copilot' })).not.toThrow()
    await vi.waitFor(() => expect(renderer.send).toHaveBeenCalledOnce())
    await expect(registration.acknowledge(renderer.send.mock.calls[0]![1].token)).resolves.toBeUndefined()
    await new Promise(resolve => setImmediate(resolve))

    expect(memory.acknowledgeConnection).toHaveBeenCalledOnce()
    expect(facts.observe).not.toHaveBeenCalled()
    registration()
  })

  it('rejects unknown, stale, and replayed dismiss tokens', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    try {
      const sessions = createSessions(true)
      const facts = { observe: vi.fn() }
      const memory = createMemory({ shouldDisclose: vi.fn().mockResolvedValue(true) })
      const renderer = { send: vi.fn() }
      const registration = registerSessionObservation(sessions, facts, memory, renderer)

      await expect(registration.dismiss('a'.repeat(43))).rejects.toThrow('Invalid host memory consent')
      sessions.openedListener?.({ id: 's1', hostname: '10.0.0.12', mode: 'copilot' })
      await vi.waitFor(() => expect(renderer.send).toHaveBeenCalledOnce())
      const [, disclosure] = renderer.send.mock.calls[0]!
      await registration.dismiss(disclosure.token)
      await expect(registration.dismiss(disclosure.token)).rejects.toThrow('Invalid host memory consent')

      sessions.openedListener?.({ id: 's2', hostname: '10.0.0.13', mode: 'copilot' })
      await vi.waitFor(() => expect(renderer.send).toHaveBeenCalledTimes(2))
      const [, staleDisclosure] = renderer.send.mock.calls[1]!
      now.mockReturnValue(1_000 + 5 * 60 * 1_000)
      await expect(registration.dismiss(staleDisclosure.token)).rejects.toThrow('Invalid host memory consent')
      registration()
    } finally {
      now.mockRestore()
    }
  })
})

function createMemory(overrides: Record<string, unknown> = {}) {
  let acknowledged = false
  return {
    shouldDisclose: vi.fn().mockResolvedValue(false),
    canObserve: vi.fn().mockResolvedValue(true),
    canCollect: vi.fn().mockResolvedValue(true),
    acknowledge: vi.fn().mockResolvedValue(undefined),
    acknowledgeConnection: vi.fn(async () => { acknowledged = true }),
    revokeConnection: vi.fn(async () => { acknowledged = false }),
    associateConnection: vi.fn().mockResolvedValue(undefined),
    canObserveHost: vi.fn().mockResolvedValue(true),
    isConnectionAcknowledged: vi.fn(async () => acknowledged),
    collectionScopes: vi.fn().mockResolvedValue({ identity: true, hardware: true, processes: true, runtime: true }),
    filterFacts: vi.fn(async (value: HostFacts): Promise<HostFacts> => value),
    ...overrides,
  }
}

function createSessions(supportsObservation: boolean) {
  let openedListener: ((session: { id: string; hostname: string; mode: 'copilot' }) => void) | undefined
  let closedListener: ((event: { sessionId: string }) => void) | undefined
  const executeReadOnly = vi.fn((_sessionId: string, command: string) => Promise.resolve(commandOutput(command)))
  return {
    onOpened: vi.fn((listener: typeof openedListener) => {
      openedListener = listener
      return vi.fn()
    }),
    onClosed: vi.fn((listener: typeof closedListener) => { closedListener = listener; return vi.fn() }),
    supportsReadOnlyObservation: vi.fn(() => supportsObservation),
    setObservedHostname: vi.fn(),
    clearObservedHostname: vi.fn(),
    executeReadOnly,
    get openedListener() { return openedListener },
    get closedListener() { return closedListener },
  }
}

function commandOutput(command: string): string {
  if (command === 'hostname') return 'api-prod\n'
  if (command === linuxProcessCommand) return '42\tnginx\t/usr/sbin\n'
  if (command === linuxServiceCommand) {
    return 'nginx.service loaded active running nginx\n'
  }
  return ''
}
