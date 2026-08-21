import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { HostMemorySettingsService } from '../../../src/main/settings/host-memory-settings-service'

describe('HostMemorySettingsService', () => {
  for (const version of [1, 2] as const) {
    const nestedCases = [
      ['extra settings property', (settings: ReturnType<typeof legacySettings>) => ({ ...settings, displayMode: 'compact' })],
      ['unknown scope', (settings: ReturnType<typeof legacySettings>) => ({ ...settings, scopes: { ...settings.scopes, identity: true } })],
      ['nested password', (settings: ReturnType<typeof legacySettings>) => ({ ...settings, password: 'synthetic-nonfunctional-password' })],
      ['nested apiKey', (settings: ReturnType<typeof legacySettings>) => ({ ...settings, apiKey: 'sk-proj-00000000000000000000000000000000' })],
      ['nested raw output', (settings: ReturnType<typeof legacySettings>) => ({ ...settings, diagnostics: { rawOutput: 'synthetic-nonfunctional-output' } })],
    ] as const

    for (const [name, mutate] of nestedCases) {
      it(`rejects version ${version} ${name} without rewriting the legacy file`, async () => {
        const directory = await mkdtemp(join(tmpdir(), `host-memory-v${version}-strict-`))
        const path = join(directory, 'settings.json')
        try {
          const source = JSON.stringify(legacyDocument(version, mutate(legacySettings())))
          await writeFile(path, source)

          await expect(new HostMemorySettingsService(path).load()).rejects.toThrow('Invalid host memory settings')
          expect(await readFile(path, 'utf8')).toBe(source)
        } finally {
          await rm(directory, { recursive: true, force: true })
        }
      })
    }
  }

  it('requires enablement, a scope, and per-host acknowledgement before observation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'host-memory-'))
    try {
      const service = new HostMemorySettingsService(join(directory, 'settings.json'))
      expect(await service.canObserve('api-prod')).toBe(false)
      expect(await service.canCollect()).toBe(false)
      await service.save({ enabled: true, scopes: { identity: true, hardware: false, processes: false, runtime: false } })
      expect(await service.canCollect()).toBe(true)
      expect(await service.canObserve('api-prod')).toBe(false)
      await service.acknowledge('API-PROD')
      expect(await service.canObserve('api-prod')).toBe(true)
      expect(await service.filterFacts(facts('api-prod'))).toEqual({
        hostname: 'api-prod',
        observedAt: '2026-08-17T00:00:00.000Z',
        connectionIp: '192.0.2.10',
        operatingSystem: { name: 'Linux', version: '6.1.0' },
      })
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('does not treat an IP address as an acknowledgeable host identity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'host-memory-'))
    try { await expect(new HostMemorySettingsService(join(directory, 'settings.json')).acknowledge('10.0.0.12')).rejects.toThrow('hostname, not an IP address') } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('does not permit collection when every scope is disabled', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'host-memory-'))
    try {
      const service = new HostMemorySettingsService(join(directory, 'settings.json'))
      await service.save({ enabled: true, scopes: { identity: false, hardware: false, processes: false, runtime: false } })
      expect(await service.canCollect()).toBe(false)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('rejects unsafe acknowledgement identities without persisting them', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'host-memory-'))
    try {
      const path = join(directory, 'settings.json')
      const service = new HostMemorySettingsService(path)
      for (const identity of ['api-prod\npassword=secret', 'token-prod', 'C:\\Users\\ops\\AppData\\Local\\Temp\\access-client.ini', 'bad host', 'web..prod']) {
        await expect(service.acknowledge(identity)).rejects.toThrow()
      }
      expect(await service.isAcknowledged('api-prod')).toBe(false)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('rejects an unsafe acknowledged host loaded from settings storage', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'host-memory-'))
    try {
      const path = join(directory, 'settings.json')
      await writeFile(path, JSON.stringify({ version: 1, settings: { enabled: true, scopes: { software: true, processes: false, services: false, configuration: false } }, acknowledgedHosts: ['api-prod\npassword=secret'] }))
      await expect(new HostMemorySettingsService(path).load()).rejects.toThrow('Invalid host memory settings')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('rejects non-string acknowledged hosts loaded from settings storage', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'host-memory-'))
    try {
      const path = join(directory, 'settings.json')
      await writeFile(path, JSON.stringify({ version: 1, settings: { enabled: true, scopes: { software: true, processes: false, services: false, configuration: false } }, acknowledgedHosts: [true] }))
      await expect(new HostMemorySettingsService(path).load()).rejects.toThrow('Invalid host memory settings')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('rejects unknown fields on the current versioned settings envelope', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'host-memory-'))
    const path = join(directory, 'settings.json')
    try {
      await new HostMemorySettingsService(path).save({ enabled: true, scopes: { identity: true, hardware: false, processes: false, runtime: false } })
      const document = JSON.parse(await readFile(path, 'utf8'))
      await writeFile(path, JSON.stringify({ ...document, apiKey: 'never-accept' }))

      await expect(new HostMemorySettingsService(path).load()).rejects.toThrow('Invalid host memory settings')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects authorization map keys that collide after normalization', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'host-memory-'))
    const path = join(directory, 'settings.json')
    try {
      await new HostMemorySettingsService(path).save({ enabled: true, scopes: { identity: true, hardware: false, processes: false, runtime: false } })
      const document = JSON.parse(await readFile(path, 'utf8'))
      const collisions = [
        { connectionHosts: { 'API-PROD': 'web-prod', 'api-prod': 'db-prod' } },
        { revokedHostConnections: { 'API-PROD': ['192.0.2.10'], 'api-prod': ['192.0.2.11'] } },
      ]

      for (const collision of collisions) {
        await writeFile(path, JSON.stringify({ ...document, ...collision }))
        await expect(new HostMemorySettingsService(path).load()).rejects.toThrow('Invalid host memory settings')
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('normalizes legitimate hostname and FQDN identities', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'host-memory-'))
    try {
      const service = new HostMemorySettingsService(join(directory, 'settings.json'))
      await service.acknowledge('API-PROD.EXAMPLE.COM.')
      expect(await service.isAcknowledged('api-prod.example.com')).toBe(true)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('persists stable connection-label acknowledgement and migrates version 1', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'host-memory-'))
    try {
      const path = join(directory, 'settings.json')
      await writeFile(path, JSON.stringify({ version: 1, settings: { enabled: true, scopes: { software: true, processes: false, services: false, configuration: false } }, acknowledgedHosts: ['API-PROD'] }))
      const service = new HostMemorySettingsService(path)
      expect(await service.isConnectionAcknowledged('api-prod')).toBe(true)
      await service.acknowledgeConnection('192.0.2.10')
      expect(await service.isConnectionAcknowledged('192.0.2.10')).toBe(true)
      const stored = JSON.parse(await readFile(path, 'utf8'))
      expect(stored).toMatchObject({
        version: 3,
        settings: { enabled: true, scopes: { identity: false, hardware: false, processes: false, runtime: false } },
        acknowledgedConnections: ['192.0.2.10', 'api-prod'],
      })
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('revokes a connection acknowledgement without deleting host-memory settings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'host-memory-'))
    try {
      const service = new HostMemorySettingsService(join(directory, 'settings.json'))
      await service.save({ enabled: true, scopes: { identity: true, hardware: false, processes: false, runtime: false } })
      await service.acknowledgeConnection('192.0.2.10')
      expect(await service.isConnectionAcknowledged('192.0.2.10')).toBe(true)

      await service.revokeConnection('192.0.2.10')

      expect(await service.isConnectionAcknowledged('192.0.2.10')).toBe(false)
      expect(await service.load()).toEqual({ enabled: true, scopes: { identity: true, hardware: false, processes: false, runtime: false } })
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('revokes persisted connection labels mapped to a cleared hostname', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'host-memory-'))
    try {
      const service = new HostMemorySettingsService(join(directory, 'settings.json'))
      await service.save({ enabled: true, scopes: { identity: true, hardware: false, processes: false, runtime: false } })
      await service.acknowledgeConnection('192.0.2.10')
      await service.associateConnection('192.0.2.10', 'api-prod')

      await service.revokeHost('api-prod')

      expect(await service.isConnectionAcknowledged('192.0.2.10')).toBe(false)
      expect(await service.isConnectionAcknowledged('other-prod')).toBe(false)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('requires the acknowledged connection to remain mapped to the target host', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'host-memory-'))
    try {
      const service = new HostMemorySettingsService(join(directory, 'settings.json'))
      await service.save({ enabled: true, scopes: { identity: true, hardware: false, processes: false, runtime: false } })
      await service.acknowledgeConnection('192.0.2.10')

      expect(await service.canObserveHost('192.0.2.10', 'api-prod')).toBe(false)
      expect(await service.canObserveHost('192.0.2.10', 'api-prod', true)).toBe(true)
      await service.associateConnection('192.0.2.10', 'api-prod')
      expect(await service.canObserveHost('192.0.2.10', 'api-prod')).toBe(true)
      expect(await service.canObserveHost('192.0.2.10', 'other-prod')).toBe(false)

      await service.revokeHost('api-prod')
      expect(await service.canObserveHost('192.0.2.10', 'api-prod')).toBe(false)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('keeps a revoked host tombstone from authorizing an unmapped acknowledged connection', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'host-memory-'))
    try {
      const path = join(directory, 'settings.json')
      const service = new HostMemorySettingsService(path)
      await service.save({ enabled: true, scopes: { identity: true, hardware: false, processes: false, runtime: false } })
      await service.acknowledgeConnection('192.0.2.10')

      await service.revokeHost('api-prod')

      expect(await service.canObserveHost('192.0.2.10', 'api-prod', true)).toBe(false)
      const reloaded = new HostMemorySettingsService(path)
      expect(await reloaded.canObserveHost('192.0.2.10', 'api-prod', true)).toBe(false)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('binds an acknowledged unmapped connection to exactly one discovered hostname', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'host-memory-'))
    try {
      const service = new HostMemorySettingsService(join(directory, 'settings.json'))
      await service.save({ enabled: true, scopes: { identity: true, hardware: false, processes: false, runtime: false } })
      await service.acknowledgeConnection('192.0.2.10')

      expect(await service.authorizeConnectionBinding('192.0.2.10', 'api-prod')).toBe(true)
      expect(await service.canObserveHost('192.0.2.10', 'api-prod')).toBe(true)
      expect(await service.authorizeConnectionBinding('192.0.2.10', 'other-prod')).toBe(false)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('keeps a pending label tombstone from revoking an unrelated host mapping', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'host-memory-'))
    try {
      const service = new HostMemorySettingsService(join(directory, 'settings.json'))
      await service.save({ enabled: true, scopes: { identity: true, hardware: false, processes: false, runtime: false } })
      await service.acknowledgeConnection('192.0.2.10')
      await service.associateConnection('192.0.2.10', 'other-prod')

      await service.revokeHost('api-prod', [], ['192.0.2.10'])

      expect(await service.canObserveHost('192.0.2.10', 'other-prod')).toBe(true)
      expect(await service.canObserveHost('192.0.2.10', 'api-prod', true)).toBe(false)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('reclassifies a pending label after an earlier queued binding assigns another host', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'host-memory-'))
    try {
      const path = join(directory, 'settings.json')
      const service = new HostMemorySettingsService(path)
      await service.save({ enabled: true, scopes: { identity: true, hardware: false, processes: false, runtime: false } })
      await service.acknowledgeConnection('192.0.2.20')
      let releaseQueue!: () => void
      let queueEntered = false
      const blocker = service.associateConnection('192.0.2.30', 'queue-host', async () => {
        queueEntered = true
        await new Promise<void>(resolve => { releaseQueue = resolve })
        return true
      })
      await vi.waitFor(() => expect(queueEntered).toBe(true))
      const binding = service.authorizeConnectionBinding('192.0.2.20', 'other-prod')
      await Promise.resolve()
      const revocation = service.revokeHost('api-prod', [], ['192.0.2.20'])

      releaseQueue()
      const [, authorized] = await Promise.all([blocker, binding, revocation])

      expect(authorized).toBe(true)
      expect(await service.isConnectionAcknowledged('192.0.2.20')).toBe(true)
      expect(await service.canObserveHost('192.0.2.20', 'other-prod')).toBe(true)
      expect(await service.shouldDisclose('192.0.2.20')).toBe(false)
      const stored = JSON.parse(await readFile(path, 'utf8'))
      expect(stored.revokedHostConnections['api-prod'] ?? []).not.toContain('192.0.2.20')

      const reloaded = new HostMemorySettingsService(path)
      expect(await reloaded.isConnectionAcknowledged('192.0.2.20')).toBe(true)
      expect(await reloaded.canObserveHost('192.0.2.20', 'other-prod')).toBe(true)
      expect(await reloaded.shouldDisclose('192.0.2.20')).toBe(false)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('revokes only the explicitly supplied pending unmapped connection label', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'host-memory-'))
    try {
      const service = new HostMemorySettingsService(join(directory, 'settings.json'))
      await service.save({ enabled: true, scopes: { identity: true, hardware: false, processes: false, runtime: false } })
      await service.acknowledgeConnection('192.0.2.10')
      await service.acknowledgeConnection('192.0.2.20')

      await service.revokeHost('api-prod', [], ['192.0.2.10'])

      expect(await service.isConnectionAcknowledged('192.0.2.10')).toBe(false)
      expect(await service.isConnectionAcknowledged('192.0.2.20')).toBe(true)
      expect(await service.authorizeConnectionBinding('192.0.2.20', 'other-prod')).toBe(true)
      expect(await service.canObserveHost('192.0.2.20', 'other-prod')).toBe(true)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('does not revoke a supplied label already bound to another host', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'host-memory-'))
    try {
      const service = new HostMemorySettingsService(join(directory, 'settings.json'))
      await service.save({ enabled: true, scopes: { identity: true, hardware: false, processes: false, runtime: false } })
      await service.acknowledgeConnection('192.0.2.10')
      await service.associateConnection('192.0.2.10', 'other-prod')

      await service.revokeHost('api-prod', ['192.0.2.10'])

      expect(await service.canObserveHost('192.0.2.10', 'other-prod')).toBe(true)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('does not let consent for one revoked connection clear another unmapped connection tombstone', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'host-memory-'))
    try {
      const service = new HostMemorySettingsService(join(directory, 'settings.json'))
      await service.save({ enabled: true, scopes: { identity: true, hardware: false, processes: false, runtime: false } })
      await service.acknowledgeConnection('192.0.2.10')
      await service.associateConnection('192.0.2.10', 'api-prod')
      await service.acknowledgeConnection('192.0.2.20')

      await service.revokeHost('api-prod')
      await service.acknowledgeConnection('192.0.2.10')

      expect(await service.canObserveHost('192.0.2.20', 'api-prod', true)).toBe(false)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('reauthorizes each of two revoked connection labels with its own fresh consent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'host-memory-'))
    try {
      const path = join(directory, 'settings.json')
      const service = new HostMemorySettingsService(path)
      await service.save({ enabled: true, scopes: { identity: true, hardware: false, processes: false, runtime: false } })
      await service.acknowledgeConnection('192.0.2.10')
      await service.authorizeConnectionBinding('192.0.2.10', 'api-prod')
      await service.acknowledgeConnection('192.0.2.20')
      await service.authorizeConnectionBinding('192.0.2.20', 'api-prod')
      await service.revokeHost('api-prod')

      await service.acknowledgeConnection('192.0.2.10')
      expect(await service.authorizeConnectionBinding('192.0.2.10', 'api-prod')).toBe(true)
      expect(await service.canObserveHost('192.0.2.10', 'api-prod')).toBe(true)
      const afterFirstBinding = JSON.parse(await readFile(path, 'utf8'))
      expect(afterFirstBinding.revokedHostConnections['api-prod']).toEqual(['192.0.2.20'])

      await service.acknowledgeConnection('192.0.2.20')
      expect(await service.authorizeConnectionBinding('192.0.2.20', 'api-prod')).toBe(true)

      expect(await service.canObserveHost('192.0.2.20', 'api-prod')).toBe(true)
      const reloaded = new HostMemorySettingsService(path)
      expect(await reloaded.canObserveHost('192.0.2.10', 'api-prod')).toBe(true)
      expect(await reloaded.canObserveHost('192.0.2.20', 'api-prod')).toBe(true)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('repairs an existing host mapping with a per-connection tombstone after fresh consent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'host-memory-'))
    try {
      const path = join(directory, 'settings.json')
      await writeFile(path, JSON.stringify({
        version: 2,
        settings: { enabled: true, scopes: { software: true, processes: false, services: false, configuration: false } },
        acknowledgedConnections: ['192.0.2.20'],
        connectionHosts: { '192.0.2.20': 'api-prod' },
        revokedHosts: [],
        revokedHostConnections: { 'api-prod': ['192.0.2.20'] },
      }))
      const service = new HostMemorySettingsService(path)

      await service.save({ enabled: true, scopes: { identity: true, hardware: false, processes: false, runtime: false } })
      await service.acknowledgeConnection('192.0.2.20')
      expect(await service.authorizeConnectionBinding('192.0.2.20', 'api-prod')).toBe(true)

      expect(await service.canObserveHost('192.0.2.20', 'api-prod')).toBe(true)
      const stored = JSON.parse(await readFile(path, 'utf8'))
      expect(stored.revokedHostConnections['api-prod'] ?? []).not.toContain('192.0.2.20')
      const reloaded = new HostMemorySettingsService(path)
      expect(await reloaded.canObserveHost('192.0.2.20', 'api-prod')).toBe(true)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('requires fresh consent and atomic binding to reauthorize a persisted no-label tombstone', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'host-memory-'))
    try {
      const path = join(directory, 'settings.json')
      const service = new HostMemorySettingsService(path)
      await service.save({ enabled: true, scopes: { identity: true, hardware: false, processes: false, runtime: false } })
      await service.revokeHost('api-prod')
      await service.revokeHost('other-prod')

      const reloaded = new HostMemorySettingsService(path)
      expect(await reloaded.authorizeConnectionBinding('192.0.2.10', 'api-prod')).toBe(false)
      expect(await reloaded.canObserveHost('192.0.2.10', 'api-prod', true)).toBe(false)

      await reloaded.acknowledgeConnection('192.0.2.10')
      await reloaded.acknowledgeConnection('192.0.2.20')
      expect(await reloaded.canObserveHost('192.0.2.10', 'api-prod', true)).toBe(false)
      expect(await reloaded.authorizeConnectionBinding('192.0.2.10', 'api-prod')).toBe(true)

      expect(await reloaded.canObserveHost('192.0.2.10', 'api-prod')).toBe(true)
      expect(await reloaded.canObserveHost('192.0.2.20', 'other-prod', true)).toBe(false)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('persists fresh consent across reload until the acknowledged label is atomically bound', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'host-memory-'))
    try {
      const path = join(directory, 'settings.json')
      const service = new HostMemorySettingsService(path)
      await service.save({ enabled: true, scopes: { identity: true, hardware: false, processes: false, runtime: false } })
      await service.revokeHost('api-prod')

      await service.acknowledgeConnection('192.0.2.10')

      const afterAcknowledgement = new HostMemorySettingsService(path)
      expect(await afterAcknowledgement.isConnectionAcknowledged('192.0.2.10')).toBe(true)
      expect(await afterAcknowledgement.shouldDisclose('192.0.2.10')).toBe(false)
      expect(await afterAcknowledgement.authorizeConnectionBinding('192.0.2.10', 'api-prod')).toBe(true)
      expect(await afterAcknowledgement.canObserveHost('192.0.2.10', 'api-prod')).toBe(true)

      const afterBinding = new HostMemorySettingsService(path)
      expect(await afterBinding.isConnectionAcknowledged('192.0.2.10')).toBe(true)
      expect(await afterBinding.shouldDisclose('192.0.2.10')).toBe(false)
      expect(await afterBinding.canObserveHost('192.0.2.10', 'api-prod')).toBe(true)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('reauthorizes two cleared connections independently without clearing a third label tombstone', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'host-memory-'))
    try {
      const path = join(directory, 'settings.json')
      const service = new HostMemorySettingsService(path)
      await service.save({ enabled: true, scopes: { identity: true, hardware: false, processes: false, runtime: false } })
      for (const label of ['192.0.2.10', '192.0.2.20']) {
        await service.acknowledgeConnection(label)
        await service.authorizeConnectionBinding(label, 'api-prod')
      }
      await service.acknowledgeConnection('192.0.2.30')
      await service.revokeHost('api-prod', [], ['192.0.2.30'])

      for (const label of ['192.0.2.10', '192.0.2.20', '192.0.2.30']) {
        expect(await service.isConnectionAcknowledged(label)).toBe(false)
        expect(await service.shouldDisclose(label)).toBe(true)
        expect(await service.canObserveHost(label, 'api-prod', true)).toBe(false)
      }

      await service.acknowledgeConnection('192.0.2.10')
      expect(await service.isConnectionAcknowledged('192.0.2.10')).toBe(true)
      expect(await service.shouldDisclose('192.0.2.10')).toBe(false)
      expect(await service.authorizeConnectionBinding('192.0.2.10', 'api-prod')).toBe(true)
      expect(await service.canObserveHost('192.0.2.10', 'api-prod')).toBe(true)
      for (const label of ['192.0.2.20', '192.0.2.30']) {
        expect(await service.isConnectionAcknowledged(label)).toBe(false)
        expect(await service.shouldDisclose(label)).toBe(true)
        expect(await service.canObserveHost(label, 'api-prod', true)).toBe(false)
      }

      await service.acknowledgeConnection('192.0.2.20')
      expect(await service.authorizeConnectionBinding('192.0.2.20', 'api-prod')).toBe(true)
      expect(await service.canObserveHost('192.0.2.20', 'api-prod')).toBe(true)
      expect(await service.isConnectionAcknowledged('192.0.2.30')).toBe(false)
      expect(await service.shouldDisclose('192.0.2.30')).toBe(true)

      const reloaded = new HostMemorySettingsService(path)
      expect(await reloaded.canObserveHost('192.0.2.10', 'api-prod')).toBe(true)
      expect(await reloaded.canObserveHost('192.0.2.20', 'api-prod')).toBe(true)
      expect(await reloaded.isConnectionAcknowledged('192.0.2.30')).toBe(false)
      expect(await reloaded.shouldDisclose('192.0.2.30')).toBe(true)
      expect(await reloaded.canObserveHost('192.0.2.30', 'api-prod', true)).toBe(false)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('binds a pending label to its actual other host across reloads without clearing a third tombstone', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'host-memory-'))
    try {
      const path = join(directory, 'settings.json')
      const service = new HostMemorySettingsService(path)
      await service.save({ enabled: true, scopes: { identity: true, hardware: false, processes: false, runtime: false } })
      for (const label of ['192.0.2.10', '192.0.2.20']) {
        await service.acknowledgeConnection(label)
        await service.authorizeConnectionBinding(label, 'api-prod')
      }
      await service.acknowledgeConnection('192.0.2.30')
      await service.revokeHost('api-prod', [], ['192.0.2.30'])

      await service.acknowledgeConnection('192.0.2.10')
      expect(await service.authorizeConnectionBinding('192.0.2.10', 'other-prod')).toBe(true)

      const afterOtherBinding = new HostMemorySettingsService(path)
      expect(await afterOtherBinding.canObserveHost('192.0.2.10', 'other-prod')).toBe(true)
      expect(await afterOtherBinding.canObserveHost('192.0.2.20', 'api-prod', true)).toBe(false)
      expect(await afterOtherBinding.canObserveHost('192.0.2.30', 'api-prod', true)).toBe(false)

      await afterOtherBinding.acknowledgeConnection('192.0.2.20')
      expect(await afterOtherBinding.authorizeConnectionBinding('192.0.2.20', 'api-prod')).toBe(true)

      const reloaded = new HostMemorySettingsService(path)
      expect(await reloaded.canObserveHost('192.0.2.10', 'other-prod')).toBe(true)
      expect(await reloaded.canObserveHost('192.0.2.20', 'api-prod')).toBe(true)
      expect(await reloaded.isConnectionAcknowledged('192.0.2.30')).toBe(false)
      expect(await reloaded.canObserveHost('192.0.2.30', 'api-prod', true)).toBe(false)
      const stored = JSON.parse(await readFile(path, 'utf8'))
      expect(stored.revokedHosts).not.toContain('api-prod')
      expect(stored.revokedHostConnections['api-prod']).toEqual(['192.0.2.30'])
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('does not let an older same-host undo restore a newer revocation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'host-memory-'))
    try {
      const service = new HostMemorySettingsService(join(directory, 'settings.json'))
      await service.save({ enabled: true, scopes: { identity: true, hardware: false, processes: false, runtime: false } })
      await service.acknowledgeConnection('192.0.2.10')
      await service.associateConnection('192.0.2.10', 'api-prod')

      const first = service.revokeHost('api-prod')
      const second = service.revokeHost('api-prod')
      const [firstUndo] = await Promise.all([first, second])

      await service.restoreHostAuthorization(firstUndo)

      expect(await service.canObserveHost('192.0.2.10', 'api-prod', true)).toBe(false)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('consumes an obsolete undo token after a newer same-host revocation wins', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'host-memory-'))
    try {
      const service = new HostMemorySettingsService(join(directory, 'settings.json'))
      await service.save({ enabled: true, scopes: { identity: true, hardware: false, processes: false, runtime: false } })
      await service.acknowledgeConnection('192.0.2.10')
      await service.associateConnection('192.0.2.10', 'api-prod')

      const obsoleteUndo = await service.revokeHost('api-prod')
      await service.revokeHost('api-prod')
      await service.restoreHostAuthorization(obsoleteUndo)

      await expect(service.restoreHostAuthorization(obsoleteUndo)).rejects.toThrow('Invalid host memory authorization undo')
      expect(await service.canObserveHost('192.0.2.10', 'api-prod', true)).toBe(false)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('does not persist a connection mapping after its observation generation is revoked', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'host-memory-'))
    try {
      const service = new HostMemorySettingsService(join(directory, 'settings.json'))
      await service.save({ enabled: true, scopes: { identity: true, hardware: false, processes: false, runtime: false } })
      await service.acknowledgeConnection('192.0.2.10')
      let active = true
      active = false
      await service.associateConnection('192.0.2.10', 'api-prod', () => active)

      expect(await service.canObserveHost('192.0.2.10', 'api-prod')).toBe(false)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('revokes explicitly supplied in-flight connection labels in the same settings transaction', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'host-memory-'))
    try {
      const service = new HostMemorySettingsService(join(directory, 'settings.json'))
      await service.save({ enabled: true, scopes: { identity: true, hardware: false, processes: false, runtime: false } })
      await service.acknowledgeConnection('192.0.2.10')

      await service.revokeHost('api-prod', ['192.0.2.10'])

      expect(await service.isConnectionAcknowledged('192.0.2.10')).toBe(false)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('restores authorization from an opaque undo token without exposing its document', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'host-memory-'))
    try {
      const service = new HostMemorySettingsService(join(directory, 'settings.json'))
      await service.save({ enabled: true, scopes: { identity: true, hardware: false, processes: false, runtime: false } })
      await service.acknowledgeConnection('192.0.2.10')
      await service.associateConnection('192.0.2.10', 'api-prod')

      const undo = await service.revokeHost('api-prod')
      expect(Object.keys(undo)).toEqual(['token'])
      expect(await service.canObserveHost('192.0.2.10', 'api-prod')).toBe(false)

      await service.restoreHostAuthorization(undo)

      expect(await service.canObserveHost('192.0.2.10', 'api-prod')).toBe(true)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('restores the exact earlier connection tombstones without retaining labels from the latest revoke', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'host-memory-'))
    try {
      const path = join(directory, 'settings.json')
      const service = new HostMemorySettingsService(path)
      await service.save({ enabled: true, scopes: { identity: true, hardware: false, processes: false, runtime: false } })
      await service.acknowledgeConnection('192.0.2.10')
      await service.associateConnection('192.0.2.10', 'api-prod')
      await service.revokeHost('api-prod', [], ['192.0.2.30'])

      const undo = await service.revokeHost('api-prod', [], ['192.0.2.40'])
      await service.restoreHostAuthorization(undo)

      const stored = JSON.parse(await readFile(path, 'utf8'))
      expect(stored.revokedHostConnections['api-prod']).toEqual(['192.0.2.10', '192.0.2.30'])
      expect(stored.revokedHostConnections['api-prod']).not.toContain('192.0.2.40')
      expect(stored.revokedHosts).toContain('api-prod')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('restores only the revoked host authorization and retains changes for other hosts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'host-memory-'))
    try {
      const service = new HostMemorySettingsService(join(directory, 'settings.json'))
      await service.save({ enabled: true, scopes: { identity: true, hardware: false, processes: false, runtime: false } })
      await service.acknowledgeConnection('192.0.2.10')
      await service.associateConnection('192.0.2.10', 'api-prod')
      const undo = await service.revokeHost('api-prod')
      await service.acknowledgeConnection('192.0.2.20')
      await service.associateConnection('192.0.2.20', 'other-prod')

      await service.restoreHostAuthorization(undo)

      expect(await service.canObserveHost('192.0.2.10', 'api-prod')).toBe(true)
      expect(await service.canObserveHost('192.0.2.20', 'other-prod')).toBe(true)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('keeps save, acknowledgement, binding, revocation, and restore consistent when rename fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'host-memory-failure-'))
    try {
      const path = join(directory, 'settings.json')
      const initial = new HostMemorySettingsService(path)
      await initial.save({ enabled: true, scopes: { identity: true, hardware: false, processes: false, runtime: false } })
      let failRename = false
      const service = new HostMemorySettingsService(path, {
        fileSystem: {
          rename: async (source: string, destination: string) => {
            if (failRename) throw new Error('injected rename failure')
            await rename(source, destination)
          },
        },
      })
      await service.load()

      failRename = true
      await expect(service.save({ enabled: false, scopes: { identity: false, hardware: false, processes: false, runtime: false } })).rejects.toThrow('injected rename failure')
      expect(await service.load()).toMatchObject({ enabled: true })
      expect(await new HostMemorySettingsService(path).load()).toMatchObject({ enabled: true })
      expect(await temporaryFiles(directory)).toEqual([])

      await expect(service.acknowledgeConnection('192.0.2.10')).rejects.toThrow('injected rename failure')
      expect(await service.isConnectionAcknowledged('192.0.2.10')).toBe(false)
      expect(await new HostMemorySettingsService(path).isConnectionAcknowledged('192.0.2.10')).toBe(false)
      expect(await temporaryFiles(directory)).toEqual([])

      failRename = false
      await service.acknowledgeConnection('192.0.2.10')
      await service.authorizeConnectionBinding('192.0.2.10', 'api-prod')
      failRename = true
      await expect(service.revokeHost('api-prod')).rejects.toThrow('injected rename failure')
      expect(await service.canObserveHost('192.0.2.10', 'api-prod')).toBe(true)
      expect(await new HostMemorySettingsService(path).canObserveHost('192.0.2.10', 'api-prod')).toBe(true)
      expect(await temporaryFiles(directory)).toEqual([])

      failRename = false
      const undo = await service.revokeHost('api-prod')
      failRename = true
      await expect(service.restoreHostAuthorization(undo)).rejects.toThrow('injected rename failure')
      expect(await service.canObserveHost('192.0.2.10', 'api-prod', true)).toBe(false)
      expect(await new HostMemorySettingsService(path).canObserveHost('192.0.2.10', 'api-prod', true)).toBe(false)
      expect(await temporaryFiles(directory)).toEqual([])

      failRename = false
      await service.acknowledgeConnection('192.0.2.20')
      await service.revokeHost('other-prod')
      await service.acknowledgeConnection('192.0.2.20')
      failRename = true
      await expect(service.authorizeConnectionBinding('192.0.2.20', 'other-prod')).rejects.toThrow('injected rename failure')
      expect(await service.canObserveHost('192.0.2.20', 'other-prod')).toBe(false)
      expect(await new HostMemorySettingsService(path).canObserveHost('192.0.2.20', 'other-prod')).toBe(false)
      expect(await temporaryFiles(directory)).toEqual([])
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('shares first-load migration with concurrent acknowledgements', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'host-memory-acknowledge-initialization-'))
    const path = join(directory, 'settings.json')
    const deferred = deferredFirstMigrationRename()
    let operations: Promise<unknown>[] = []
    try {
      await writeFile(path, JSON.stringify(legacyDocument(1, legacySettings())))
      const service = new HostMemorySettingsService(path, { fileSystem: { rename: deferred.rename } })
      const first = service.acknowledgeConnection('192.0.2.10')
      operations = [first]
      await deferred.started
      const second = service.acknowledgeConnection('192.0.2.20')
      operations.push(second)

      await deferred.releaseAfterConcurrencyWindow()
      await Promise.all(operations)

      expect(deferred.renamedWhileBlocked()).toBe(false)
      expect(deferred.renameCount()).toBe(3)
      const reloaded = new HostMemorySettingsService(path)
      await expect(reloaded.isConnectionAcknowledged('192.0.2.10')).resolves.toBe(true)
      await expect(reloaded.isConnectionAcknowledged('192.0.2.20')).resolves.toBe(true)
    } finally {
      deferred.release()
      await Promise.allSettled(operations)
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('shares first-load migration with concurrent connection bindings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'host-memory-bind-initialization-'))
    const path = join(directory, 'settings.json')
    const deferred = deferredFirstMigrationRename()
    let operations: Promise<unknown>[] = []
    try {
      await writeFile(path, JSON.stringify({
        version: 2,
        settings: legacySettings(),
        acknowledgedConnections: ['192.0.2.10', '192.0.2.20'],
      }))
      const service = new HostMemorySettingsService(path, { fileSystem: { rename: deferred.rename } })
      const first = service.authorizeConnectionBinding('192.0.2.10', 'api-prod')
      operations = [first]
      await deferred.started
      const second = service.authorizeConnectionBinding('192.0.2.20', 'web-prod')
      operations.push(second)

      await deferred.releaseAfterConcurrencyWindow()
      await expect(Promise.all(operations)).resolves.toEqual([true, true])

      expect(deferred.renamedWhileBlocked()).toBe(false)
      expect(deferred.renameCount()).toBe(3)
      const stored = JSON.parse(await readFile(path, 'utf8'))
      expect(stored.connectionHosts).toEqual({ '192.0.2.10': 'api-prod', '192.0.2.20': 'web-prod' })
      const reloaded = new HostMemorySettingsService(path)
      await reloaded.save({ enabled: true, scopes: { identity: true, hardware: false, processes: false, runtime: false } })
      await expect(reloaded.canObserveHost('192.0.2.10', 'api-prod')).resolves.toBe(true)
      await expect(reloaded.canObserveHost('192.0.2.20', 'web-prod')).resolves.toBe(true)
    } finally {
      deferred.release()
      await Promise.allSettled(operations)
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('shares first-load migration with concurrent host revocations', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'host-memory-revoke-initialization-'))
    const path = join(directory, 'settings.json')
    const deferred = deferredFirstMigrationRename()
    let operations: Promise<unknown>[] = []
    try {
      await writeFile(path, JSON.stringify({
        version: 2,
        settings: legacySettings(),
        acknowledgedConnections: ['192.0.2.10', '192.0.2.20'],
        connectionHosts: { '192.0.2.10': 'api-prod', '192.0.2.20': 'web-prod' },
      }))
      const service = new HostMemorySettingsService(path, { fileSystem: { rename: deferred.rename } })
      const first = service.revokeHost('api-prod')
      operations = [first]
      await deferred.started
      const second = service.revokeHost('web-prod')
      operations.push(second)

      await deferred.releaseAfterConcurrencyWindow()
      await Promise.all(operations)

      expect(deferred.renamedWhileBlocked()).toBe(false)
      expect(deferred.renameCount()).toBe(3)
      const stored = JSON.parse(await readFile(path, 'utf8'))
      expect(stored.revokedHosts).toEqual(['api-prod', 'web-prod'])
      expect(stored.connectionHosts).toEqual({})
      expect(stored.acknowledgedConnections).toEqual([])
    } finally {
      deferred.release()
      await Promise.allSettled(operations)
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('keeps an ordinary settings save aligned with disk when the temporary write fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'host-memory-write-failure-'))
    try {
      const path = join(directory, 'settings.json')
      await new HostMemorySettingsService(path).save({ enabled: true, scopes: { identity: true, hardware: false, processes: false, runtime: false } })
      const service = new HostMemorySettingsService(path, {
        fileSystem: {
          writeFile: async (temporaryPath: string, data: string) => {
            await writeFile(temporaryPath, data, 'utf8')
            throw new Error('injected write failure')
          },
        },
      })
      await service.load()

      await expect(service.save({ enabled: false, scopes: { identity: false, hardware: false, processes: false, runtime: false } })).rejects.toThrow('injected write failure')

      expect(await service.load()).toEqual({ enabled: true, scopes: { identity: true, hardware: false, processes: false, runtime: false } })
      expect(await new HostMemorySettingsService(path).load()).toEqual({ enabled: true, scopes: { identity: true, hardware: false, processes: false, runtime: false } })
      expect(await temporaryFiles(directory)).toEqual([])
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('does not treat late pending consent as acknowledged after a host tombstone persists', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'host-memory-host-revision-consent-'))
    try {
      const path = join(directory, 'settings.json')
      const service = new HostMemorySettingsService(path)
      await service.save({ enabled: true, scopes: { identity: true, hardware: false, processes: false, runtime: false } })
      const issuedAtRevision = service.connectionConsentRevision()
      await service.revokeHost('api-prod', [], ['192.0.2.10'])
      await service.acknowledgeConnection('192.0.2.10', issuedAtRevision)

      await expect(service.isConnectionAcknowledged('192.0.2.10')).resolves.toBe(false)
      await expect(service.authorizeConnectionBinding('192.0.2.10', 'api-prod')).resolves.toBe(false)
      const reloaded = new HostMemorySettingsService(path)
      await expect(reloaded.isConnectionAcknowledged('192.0.2.10')).resolves.toBe(false)
      await expect(reloaded.authorizeConnectionBinding('192.0.2.10', 'api-prod')).resolves.toBe(false)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('does not resurrect a revoked connection after a stale acknowledgement is queued', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'host-memory-connection-revision-consent-'))
    try {
      const path = join(directory, 'settings.json')
      const service = new HostMemorySettingsService(path)
      await service.save({ enabled: true, scopes: { identity: true, hardware: false, processes: false, runtime: false } })
      const issuedAtRevision = service.connectionConsentRevision()
      await service.revokeConnection('192.0.2.10')
      await service.acknowledgeConnection('192.0.2.10', issuedAtRevision)

      await expect(service.isConnectionAcknowledged('192.0.2.10')).resolves.toBe(false)
      const reloaded = new HostMemorySettingsService(path)
      await expect(reloaded.isConnectionAcknowledged('192.0.2.10')).resolves.toBe(false)
      const stored = JSON.parse(await readFile(path, 'utf8'))
      expect(stored.acknowledgedConnections).not.toContain('192.0.2.10')
      expect(stored.pendingConnectionConsents).not.toContain('192.0.2.10')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('does not let the legacy association path clear a connection tombstone without fresh consent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'host-memory-associate-tombstone-'))
    try {
      const path = join(directory, 'settings.json')
      const service = new HostMemorySettingsService(path)
      await service.save({ enabled: true, scopes: { identity: true, hardware: false, processes: false, runtime: false } })
      const issuedAtRevision = service.connectionConsentRevision()
      await service.revokeConnection('192.0.2.10')
      await service.acknowledgeConnection('192.0.2.10', issuedAtRevision)
      await service.associateConnection('192.0.2.10', 'api-prod')

      expect(await service.isConnectionAcknowledged('192.0.2.10')).toBe(false)
      expect(await service.canObserveHost('192.0.2.10', 'api-prod', true)).toBe(false)
      const stored = JSON.parse(await readFile(path, 'utf8'))
      expect(stored.connectionRevocationRevisions['192.0.2.10']).toBeGreaterThan(0)
      expect(stored.connectionHosts['192.0.2.10']).toBeUndefined()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('retries settings migration after write and rename failures without retaining migrated memory state', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'host-memory-migration-failure-'))
    try {
      const path = join(directory, 'settings.json')
      await writeFile(path, JSON.stringify({ version: 1, settings: { enabled: true, scopes: { software: true, processes: false, services: false, configuration: false } }, acknowledgedHosts: ['api-prod'] }))
      let failWrite = true
      const service = new HostMemorySettingsService(path, {
        fileSystem: {
          writeFile: async (temporaryPath: string, data: string) => {
            await writeFile(temporaryPath, data, 'utf8')
            if (failWrite) throw new Error('injected write failure')
          },
        },
      })

      await expect(service.load()).rejects.toThrow('Invalid host memory settings')
      await expect(service.load()).rejects.toThrow('Invalid host memory settings')
      expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ version: 1 })
      expect(await temporaryFiles(directory)).toEqual([])

      failWrite = false
      await expect(service.load()).resolves.toEqual({ enabled: true, scopes: { identity: false, hardware: false, processes: false, runtime: false } })
      expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ version: 3 })
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})

function facts(hostname: string) {
  return {
    hostname,
    observedAt: '2026-08-17T00:00:00.000Z',
    connectionIp: '192.0.2.10',
    operatingSystem: { name: 'Linux', version: '6.1.0' },
    cpu: { model: 'Example CPU', architecture: 'x86_64', logicalCores: 8 },
    memory: { totalBytes: 8_589_934_592 },
    disks: [{ name: 'sda', totalBytes: 128_000_000_000 }],
    networkInterfaces: [{ name: 'eth0', addresses: ['192.0.2.10'] }],
    processes: [{ name: 'nginx', pid: 42, workingDirectory: '/usr/sbin' }],
    currentUser: 'root',
    workingDirectory: '/srv/apps/api',
    services: { 'nginx.service': 'active running' },
  }
}
async function temporaryFiles(directory: string): Promise<string[]> { return (await readdir(directory)).filter(name => name.endsWith('.tmp')) }

function legacySettings() {
  return { enabled: true, scopes: { software: true, processes: false, services: false, configuration: false } }
}

function legacyDocument(version: 1 | 2, settings: unknown) {
  return version === 1
    ? { version, settings, acknowledgedHosts: ['api-prod'] }
    : { version, settings, acknowledgedConnections: ['api-prod'] }
}

function deferredFirstMigrationRename() {
  let release!: () => void
  let markStarted!: () => void
  let markConcurrentRename!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { markStarted = resolve })
  const concurrentRename = new Promise<void>(resolve => { markConcurrentRename = resolve })
  let count = 0
  let blocked = true
  let concurrent = false
  return {
    started,
    release,
    rename: async (source: string, destination: string) => {
      count += 1
      if (count === 1) {
        markStarted()
        await gate
        blocked = false
      } else if (blocked) {
        concurrent = true
        markConcurrentRename()
      }
      await rename(source, destination)
    },
    releaseAfterConcurrencyWindow: async () => {
      let timeout: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        concurrentRename,
        new Promise<void>(resolve => { timeout = setTimeout(resolve, 100) }),
      ])
      if (timeout) clearTimeout(timeout)
      release()
    },
    renamedWhileBlocked: () => concurrent,
    renameCount: () => count,
  }
}
