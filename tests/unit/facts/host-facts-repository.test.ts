import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileHostFactsRepository } from '../../../src/main/facts/host-facts-repository'

describe('FileHostFactsRepository', () => {
  it('persists structured facts atomically under the normalized hostname only', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-facts-'))
    const path = join(directory, 'facts.json')
    try {
      const repository = new FileHostFactsRepository(path)
      await repository.save(facts('API-PROD'))

      await expect(repository.load('api-prod')).resolves.toMatchObject({ hostname: 'api-prod', software: { nginx: '1.25' } })
      const persisted = await readFile(path, 'utf8')
      expect(JSON.parse(persisted)).toHaveProperty('api-prod')
      expect(persisted).not.toContain('127.0.0.1')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects an IP literal as a host-facts storage key', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-facts-'))
    try {
      const repository = new FileHostFactsRepository(join(directory, 'facts.json'))

      await expect(repository.save(facts('127.0.0.1'))).rejects.toThrow('hostname, not an IP address')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('persists only the host-facts whitelist when an observation has extra fields', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-facts-'))
    const path = join(directory, 'facts.json')
    try {
      const repository = new FileHostFactsRepository(path)
      await repository.save({
        ...facts('api-prod'),
        routeIp: '10.0.0.12',
        rawTerminalHistory: 'password=never-persist',
      } as ReturnType<typeof facts>)

      const persisted = JSON.parse(await readFile(path, 'utf8')) as Record<string, Record<string, unknown>>
      expect(persisted['api-prod']).toEqual(facts('api-prod'))
      expect(JSON.stringify(persisted)).not.toContain('10.0.0.12')
      expect(JSON.stringify(persisted)).not.toContain('password=never-persist')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects malformed persisted facts instead of returning untrusted data', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-facts-'))
    const path = join(directory, 'facts.json')
    try {
      await writeFile(path, JSON.stringify({ 'api-prod': { hostname: 'api-prod', software: 'not-a-record' } }), 'utf8')

      await expect(new FileHostFactsRepository(path).load('api-prod')).rejects.toThrow('Invalid host facts store')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('serializes simultaneous saves without losing host records', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-facts-'))
    const path = join(directory, 'facts.json')
    try {
      const repository = new FileHostFactsRepository(path)
      await Promise.all([repository.save(facts('api-prod')), repository.save(facts('web-prod'))])

      const persisted = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
      expect(Object.keys(persisted).sort()).toEqual(['api-prod', 'web-prod'])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

function facts(hostname: string) {
  return {
    hostname,
    observedAt: '2026-08-09T00:00:00.000Z',
    software: { nginx: '1.25' },
    processes: [{ name: 'nginx', status: 'Ssl' }],
    installLocations: { nginx: '/usr/sbin/nginx' },
    services: { 'nginx.service': 'active running' },
    logLocations: ['/var/log/nginx/access.log'],
    configurationHashes: { '/etc/nginx/nginx.conf': 'abc123' },
  }
}
