import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileHostFactsRepository } from '../../../src/main/facts/host-facts-repository'
import { HostFactsService } from '../../../src/main/facts/host-facts-service'

describe('host facts version 3 migration', () => {
  it('preserves bounded generic legacy facts through migration, observation, edit, and reload', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'facts-lossless-migration-'))
    const path = join(directory, 'facts.json')
    const preserved = {
      software: { app: 'v1.25', tokenizers: '0.20.3' },
      processes: [{ name: 'app', status: 'Ssl' }],
      installLocations: { app: '/home/deploy/bin/app' },
      services: { 'app.service': 'active running' },
      logLocations: ['/opt/app/log/app.log'],
      configurationHashes: { '/etc/app.conf': 'a'.repeat(64) },
    }
    try {
      await writeFile(path, JSON.stringify({
        version: 2,
        records: [{ hostname: 'api-prod', observedAt: '2026-08-17T00:00:00.000Z', ...preserved }],
      }))
      const service = new HostFactsService(new FileHostFactsRepository(path))

      const migrated = await service.snapshot('api-prod')
      expect(migrated?.legacyFacts).toEqual(preserved)

      await service.observe({
        hostname: 'api-prod',
        observedAt: '2026-08-18T00:00:00.000Z',
        operatingSystem: { name: 'Linux', version: '6.1.0' },
      })
      const observed = await service.snapshot('api-prod')
      expect(observed?.legacyFacts).toEqual(preserved)
      expect(observed).not.toBeNull()

      await service.update('api-prod', { ...observed!, currentUser: 'deploy' })
      const reloaded = await new HostFactsService(new FileHostFactsRepository(path)).snapshot('api-prod')
      expect(reloaded).toMatchObject({ currentUser: 'deploy', legacyFacts: preserved })
      expect(JSON.parse(await readFile(path, 'utf8')).records[0].legacyFacts).toEqual(preserved)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('migrates every safe version 2 field without inventing current process identity facts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'facts-v3-'))
    const path = join(directory, 'facts.json')
    try {
      await writeFile(path, JSON.stringify({ version: 2, records: [facts('api-prod')] }))
      const [record] = await new FileHostFactsRepository(path).list()

      expect(record).toEqual({
        hostname: 'api-prod',
        observedAt: '2026-08-17T00:00:00.000Z',
        services: { 'nginx.service': 'active running' },
        legacyFacts: {
          software: { nginx: '1.25' },
          processes: [{ name: 'nginx', status: 'Ssl' }],
          installLocations: { nginx: '/usr/sbin/nginx' },
          services: { 'nginx.service': 'active running' },
          logLocations: ['/var/log/nginx/error.log'],
          configurationHashes: { '/etc/nginx/nginx.conf': 'a'.repeat(64) },
        },
      })
      expect(record).not.toHaveProperty('connectionIp')
      expect(record).not.toHaveProperty('operatingSystem')
      expect(record).not.toHaveProperty('cpu')
      expect(record).not.toHaveProperty('memory')
      expect(record).not.toHaveProperty('processes')
      expect(record).not.toHaveProperty('software')
      expect(record).not.toHaveProperty('installLocations')
      expect(record).not.toHaveProperty('logLocations')
      expect(record).not.toHaveProperty('configurationHashes')
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 3, records: [record] })
      expect(await new FileHostFactsRepository(path).load('api-prod')).toEqual(record)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('migrates legacy hostname keys to version 3 records and returns cloned DTOs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'facts-v2-'))
    const path = join(directory, 'facts.json')
    try {
      await writeFile(path, JSON.stringify({ 'API-PROD': facts('API-PROD') }))
      const repository = new FileHostFactsRepository(path)
      const records = await repository.list()
      records[0]!.services!['nginx.service'] = 'failed failed'
      records[0]!.legacyFacts!.software!.nginx = 'mutated'
      expect((await repository.load('api-prod'))?.services?.['nginx.service']).toBe('active running')
      expect((await repository.load('api-prod'))?.legacyFacts?.software?.nginx).toBe('1.25')
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 3, records: [expect.objectContaining({ hostname: 'api-prod' })] })
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('migrates a legacy host whose valid hostname is version', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'facts-version-host-'))
    const path = join(directory, 'facts.json')
    try {
      await writeFile(path, JSON.stringify({ version: facts('version') }))

      await expect(new FileHostFactsRepository(path).load('version')).resolves.toMatchObject({ hostname: 'version' })
      expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ version: 3, records: [{ hostname: 'version' }] })
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('rejects normalized duplicate host identities instead of dropping a record', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'facts-duplicate-host-'))
    const path = join(directory, 'facts.json')
    try {
      await writeFile(path, JSON.stringify({ 'API-PROD': facts('API-PROD'), 'api-prod': facts('api-prod') }))

      await expect(new FileHostFactsRepository(path).list()).rejects.toThrow('Invalid host facts store')
      expect(JSON.parse(await readFile(path, 'utf8'))).not.toHaveProperty('records')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('omits the v3 services category when no legacy service entry maps safely', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'facts-v3-empty-services-'))
    const path = join(directory, 'facts.json')
    try {
      await writeFile(path, JSON.stringify({ version: 2, records: [{ ...facts('api-prod'), services: {} }] }))

      const [record] = await new FileHostFactsRepository(path).list()

      expect(record).toMatchObject({
        hostname: 'api-prod',
        observedAt: '2026-08-17T00:00:00.000Z',
        legacyFacts: {
          software: { nginx: '1.25' },
          processes: [{ name: 'nginx', status: 'Ssl' }],
          installLocations: { nginx: '/usr/sbin/nginx' },
          logLocations: ['/var/log/nginx/error.log'],
          configurationHashes: { '/etc/nginx/nginx.conf': 'a'.repeat(64) },
        },
      })
      expect(record).not.toHaveProperty('services')
      expect(record.legacyFacts).not.toHaveProperty('services')
      expect(JSON.parse(await readFile(path, 'utf8')).records[0]).not.toHaveProperty('services')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  it('rejects sensitive field names and values before persistence', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'facts-sensitive-'))
    try {
      const repository = new FileHostFactsRepository(join(directory, 'facts.json'))
      await expect(repository.save({ ...facts('api-prod'), software: { password: 'secret' } } as never)).rejects.toThrow('sensitive')
      await expect(repository.save({ ...facts('api-prod'), services: { app: 'token=secret' } } as never)).rejects.toThrow('sensitive')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('rejects a bare synthetic credential during migration without changing the source bytes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'facts-bare-credential-migration-'))
    const path = join(directory, 'facts.json')
    try {
      const source = JSON.stringify({
        version: 2,
        records: [{ ...facts('api-prod'), software: { app: `1.25-${'sk-proj-' + '0'.repeat(32)}` } }],
      })
      await writeFile(path, source)

      await expect(new FileHostFactsRepository(path).list()).rejects.toThrow('sensitive data')
      expect(await readFile(path, 'utf8')).toBe(source)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
function facts(hostname: string) {
  return {
    hostname,
    observedAt: '2026-08-17T00:00:00.000Z',
    software: { nginx: '1.25' },
    processes: [{ name: 'nginx', status: 'Ssl' }],
    installLocations: { nginx: '/usr/sbin/nginx' },
    services: { 'nginx.service': 'active running' },
    logLocations: ['/var/log/nginx/error.log'],
    configurationHashes: { '/etc/nginx/nginx.conf': 'a'.repeat(64) },
  }
}
