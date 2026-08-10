import { describe, expect, it, vi } from 'vitest'
import { HostFactsService, mergeHostFacts } from '../../../src/main/facts/host-facts-service'

describe('mergeHostFacts', () => {
  it('uses normalized hostname rather than route IP and changes only changed fields', () => {
    const result = mergeHostFacts(
      {
        hostname: 'API-PROD',
        observedAt: '2026-08-09T00:00:00.000Z',
        software: { nginx: '1.24' },
        processes: [{ name: 'nginx', status: 'running' }],
        installLocations: {},
        services: {},
        logLocations: [],
        configurationHashes: {},
      },
      {
        hostname: 'api-prod',
        observedAt: '2026-08-09T01:00:00.000Z',
        software: { nginx: '1.25' },
        processes: [{ name: 'nginx', status: 'running' }],
        installLocations: {},
        services: {},
        logLocations: [],
        configurationHashes: {},
      },
    )

    expect(result.record.hostname).toBe('api-prod')
    expect(result.changed).toEqual(['software.nginx'])
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
        software: { nginx: '1.24' },
        processes: [],
        installLocations: {},
        services: {},
        logLocations: [],
        configurationHashes: {},
      }),
      save: vi.fn().mockResolvedValue(undefined),
    }
    const service = new HostFactsService(repository)
    const observed = {
      hostname: 'API-PROD',
      observedAt: '2026-08-09T01:00:00.000Z',
      software: { nginx: '1.25' },
      processes: [],
      installLocations: {},
      services: {},
      logLocations: [],
      configurationHashes: {},
      rawOutput: 'password=never-persist',
    }

    await expect(service.observe(observed)).resolves.toMatchObject({ changed: ['software.nginx'] })
    expect(repository.load).toHaveBeenCalledWith('api-prod')
    expect(repository.save).toHaveBeenCalledWith(expect.objectContaining({ hostname: 'api-prod', software: { nginx: '1.25' } }))
    expect(repository.save.mock.calls[0][0]).not.toHaveProperty('rawOutput')
    await expect(service.snapshot('API-PROD')).resolves.toMatchObject({ hostname: 'api-prod' })
  })
})
