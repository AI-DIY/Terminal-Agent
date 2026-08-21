import { describe, expect, it, vi } from 'vitest'
import { HostFactsService, mergeHostFacts } from '../../../src/main/facts/host-facts-service'

describe('mergeHostFacts', () => {
  it('uses normalized hostname rather than route IP and changes only changed fields', () => {
    const result = mergeHostFacts(
      {
        hostname: 'API-PROD',
        observedAt: '2026-08-09T00:00:00.000Z',
        operatingSystem: { name: 'Linux', version: '6.1.0' },
        processes: [{ name: 'nginx', pid: 42 }],
        services: {},
      },
      {
        hostname: 'api-prod',
        observedAt: '2026-08-09T01:00:00.000Z',
        operatingSystem: { name: 'Linux', version: '6.2.0' },
        processes: [{ name: 'nginx', pid: 42 }],
        services: {},
      },
    )

    expect(result.record.hostname).toBe('api-prod')
    expect(result.changed).toEqual(['operatingSystem'])
    expect(result.record).not.toHaveProperty('routes')
    expect(JSON.stringify(result.record)).not.toContain('127.0.0.1')
  })
})

describe('HostFactsService', () => {
  it('merges observations by remote hostname and exposes only structured facts', async () => {
    const repository = {
      load: vi.fn().mockResolvedValue({
        hostname: 'api-prod',
        observedAt: '2026-08-09T00:00:00.000Z',
        operatingSystem: { name: 'Linux', version: '6.1.0' },
      }),
      save: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
      remove: vi.fn().mockResolvedValue(undefined),
    }
    const service = new HostFactsService(repository)
    const observed = {
      hostname: 'API-PROD',
      observedAt: '2026-08-09T01:00:00.000Z',
      operatingSystem: { name: 'Linux', version: '6.2.0' },
    }

    await expect(service.observe(observed)).resolves.toMatchObject({ changed: ['operatingSystem'] })
    expect(repository.load).toHaveBeenCalledWith('api-prod')
    expect(repository.save).toHaveBeenCalledWith(expect.objectContaining({ hostname: 'api-prod', operatingSystem: { name: 'Linux', version: '6.2.0' } }))
    await expect(service.observe({ ...observed, rawOutput: 'password=never-persist' } as never)).rejects.toThrow('sensitive data')
    await expect(service.snapshot('API-PROD')).resolves.toMatchObject({ hostname: 'api-prod' })
  })

  it('updates only an existing record under its original hostname identity', async () => {
    const repository = {
      load: vi.fn().mockImplementation(async (hostname: string) => hostname === 'api-prod' ? {
        hostname: 'api-prod', observedAt: '2026-08-09T00:00:00.000Z',
      } : null),
      save: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
      remove: vi.fn().mockResolvedValue(undefined),
    }
    const service = new HostFactsService(repository)
    const record = { hostname: 'api-prod', observedAt: '2026-08-09T01:00:00.000Z' }

    await expect(service.update('unknown-host', { ...record, hostname: 'unknown-host' })).rejects.toThrow('Unknown host memory record')
    await expect(service.update('api-prod', { ...record, hostname: 'renamed-host' })).rejects.toThrow('hostname identity')
    await expect(service.update('API-PROD', record)).resolves.toMatchObject({ hostname: 'api-prod' })
    expect(repository.save).toHaveBeenCalledWith(expect.objectContaining({ hostname: 'api-prod' }))
  })

  it('rejects a bare synthetic credential before update reaches the repository', async () => {
    const repository = {
      load: vi.fn().mockResolvedValue(emptyFacts('api-prod')),
      save: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
      remove: vi.fn().mockResolvedValue(undefined),
    }
    const service = new HostFactsService(repository)
    const unsafe = { ...emptyFacts('api-prod'), operatingSystem: { name: 'Linux', version: 'ghp_000000000000000000000000000000000000' } }

    await expect(service.update('api-prod', unsafe)).rejects.toThrow('sensitive data')
    expect(repository.load).not.toHaveBeenCalled()
    expect(repository.save).not.toHaveBeenCalled()
  })

  it('rejects every additional synthetic credential shape before service update persistence', async () => {
    const repository = {
      load: vi.fn().mockResolvedValue(emptyFacts('api-prod')),
      save: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
      remove: vi.fn().mockResolvedValue(undefined),
    }
    const service = new HostFactsService(repository)
    const values = [
      'glpat-' + '0'.repeat(20),
      'npm_' + '0'.repeat(36),
      'xoxb-' + '0'.repeat(10) + '-' + '0'.repeat(10) + '-' + '0'.repeat(12),
      'sk_live_' + '0'.repeat(24),
      'rk_live_' + '0'.repeat(24),
      'dckr_pat_' + '0'.repeat(36),
      'aws-secret-access-key=' + 'A'.repeat(40),
    ]
    for (const value of values) {
      await expect(service.update('api-prod', { ...emptyFacts('api-prod'), operatingSystem: { name: 'Linux', version: value } })).rejects.toThrow('sensitive data')
    }
    expect(repository.load).not.toHaveBeenCalled()
    expect(repository.save).not.toHaveBeenCalled()
  })

  it('rejects a bare synthetic credential returned through snapshots or lists', async () => {
    const unsafe = { ...emptyFacts('api-prod'), operatingSystem: { name: 'Linux', version: 'AKIA0000000000000000' } }
    const repository = {
      load: vi.fn().mockResolvedValue(unsafe),
      save: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([unsafe]),
      remove: vi.fn().mockResolvedValue(undefined),
    }
    const service = new HostFactsService(repository)

    await expect(service.snapshot('api-prod')).rejects.toThrow('sensitive data')
    await expect(service.list()).rejects.toThrow('sensitive data')
  })

  it('serializes observation writes and removal for the same hostname', async () => {
    let releaseSave!: () => void
    const saveGate = new Promise<void>(resolve => { releaseSave = resolve })
    const repository = {
      load: vi.fn().mockResolvedValue(null),
      save: vi.fn(async () => { await saveGate }),
      list: vi.fn().mockResolvedValue([]),
      remove: vi.fn().mockResolvedValue(undefined),
    }
    const service = new HostFactsService(repository)
    const incoming = { hostname: 'api-prod', observedAt: '2026-08-09T01:00:00.000Z' }

    const observing = service.observe(incoming)
    await vi.waitFor(() => expect(repository.save).toHaveBeenCalledOnce())
    const removing = service.remove('API-PROD')
    await new Promise(resolve => setImmediate(resolve))
    expect(repository.remove).not.toHaveBeenCalled()

    releaseSave()
    await observing
    await removing
    expect(repository.remove).toHaveBeenCalledWith('api-prod')
  })

  it('checks authorization inside the host lock after removal completes', async () => {
    const repository = { load: vi.fn().mockResolvedValue(null), save: vi.fn().mockResolvedValue(undefined), list: vi.fn().mockResolvedValue([]), remove: vi.fn().mockResolvedValue(undefined) }
    const service = new HostFactsService(repository)
    await service.remove('api-prod')
    const authorized = vi.fn().mockResolvedValue(false)
    await service.observe(emptyFacts('api-prod'), authorized)
    expect(authorized).toHaveBeenCalledOnce()
    expect(repository.save).not.toHaveBeenCalled()
  })

  it('rejects a late stale observation that enters only after removal has completed', async () => {
    const events: string[] = []
    const repository = {
      load: vi.fn(async () => { events.push('load'); return null }),
      save: vi.fn(async () => { events.push('save') }),
      list: vi.fn().mockResolvedValue([]),
      remove: vi.fn(async () => { events.push('remove') }),
    }
    const service = new HostFactsService(repository)
    let generation = 1

    await service.remove('API-PROD')
    generation += 1
    const observationGeneration = 1
    await service.observe(emptyFacts('api-prod'), () => observationGeneration === generation)

    expect(events).toEqual(['remove'])
    expect(repository.load).not.toHaveBeenCalled()
    expect(repository.save).not.toHaveBeenCalled()
  })

  it('keeps canonical-host serialization independent across different hostnames', async () => {
    let releaseApiSave!: () => void
    const apiSave = new Promise<void>(resolve => { releaseApiSave = resolve })
    const repository = {
      load: vi.fn().mockResolvedValue(null),
      save: vi.fn(async (record: { hostname: string }) => {
        if (record.hostname === 'api-prod') await apiSave
      }),
      list: vi.fn().mockResolvedValue([]),
      remove: vi.fn().mockResolvedValue(undefined),
    }
    const service = new HostFactsService(repository)

    const apiObservation = service.observe(emptyFacts('api-prod'))
    await vi.waitFor(() => expect(repository.save).toHaveBeenCalledWith(expect.objectContaining({ hostname: 'api-prod' })))
    const webObservation = service.observe(emptyFacts('web-prod'))

    await expect(webObservation).resolves.toMatchObject({ record: { hostname: 'web-prod' } })
    releaseApiSave()
    await apiObservation
  })

  it('retains a migrated legacy snapshot when a new four-category observation arrives', () => {
    const result = mergeHostFacts(
      {
        hostname: 'api-prod', observedAt: '2026-08-17T00:00:00.000Z',
        legacyFacts: {
          software: { nginx: '1.25' },
          processes: [{ name: 'nginx', status: 'Ssl' }],
          installLocations: { nginx: '/usr/sbin/nginx' },
          configurationHashes: { '/etc/nginx/nginx.conf': 'a'.repeat(64) },
        },
      },
      {
        hostname: 'api-prod', observedAt: '2026-08-18T00:00:00.000Z',
        processes: [{ name: 'nginx', pid: 42, workingDirectory: '/usr/sbin' }],
        currentUser: 'appuser', workingDirectory: '/',
      },
    )

    expect(result.record.legacyFacts).toEqual({
      software: { nginx: '1.25' },
      processes: [{ name: 'nginx', status: 'Ssl' }],
      installLocations: { nginx: '/usr/sbin/nginx' },
      configurationHashes: { '/etc/nginx/nginx.conf': 'a'.repeat(64) },
    })
    expect(result.record.processes).toEqual([{ name: 'nginx', pid: 42, workingDirectory: '/usr/sbin' }])
    expect(result.changed).toEqual(['processes', 'currentUser', 'workingDirectory'])
  })
})

function emptyFacts(hostname: string) {
  return { hostname, observedAt: '2026-08-18T00:00:00.000Z' }
}
