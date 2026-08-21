import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileHostFactsRepository } from '../../../src/main/facts/host-facts-repository'
import { HostFactsService } from '../../../src/main/facts/host-facts-service'

describe('FileHostFactsRepository', () => {
  it('persists structured facts atomically under the normalized hostname only', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-facts-'))
    const path = join(directory, 'facts.json')
    try {
      const repository = new FileHostFactsRepository(path)
      await repository.save(facts('API-PROD'))

      await expect(repository.load('api-prod')).resolves.toMatchObject({ hostname: 'api-prod', operatingSystem: { name: 'Linux', version: '6.1.0' } })
      const persisted = await readFile(path, 'utf8')
      expect(JSON.parse(persisted)).toEqual(expect.objectContaining({ version: 3, records: [expect.objectContaining({ hostname: 'api-prod' })] }))
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

  it('rejects observation fields outside the strict host-facts whitelist', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-facts-'))
    const path = join(directory, 'facts.json')
    try {
      const repository = new FileHostFactsRepository(path)
      await expect(repository.save({
        ...facts('api-prod'),
        routeIp: '10.0.0.12',
      } as never)).rejects.toThrow('Invalid host facts store')
      await expect(repository.save({
        ...facts('api-prod'),
        rawTerminalHistory: 'password=never-persist',
      } as never)).rejects.toThrow('sensitive data')
      await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects AccessClient temporary-session paths and sensitive values', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-facts-'))
    try {
      const repository = new FileHostFactsRepository(join(directory, 'facts.json'))

      await expect(repository.save({ ...facts('api-prod'), workingDirectory: '/var/tmp/access-client-session.ini' })).rejects.toThrow('sensitive data')
      await expect(repository.save({ ...facts('api-prod'), processes: [{ name: 'nginx', pid: 42, workingDirectory: '/tmp/session.ini' }] })).rejects.toThrow('sensitive data')
      await expect(repository.save({ ...facts('api-prod'), operatingSystem: { name: 'token=secret-value' } })).rejects.toThrow('sensitive data')
      await expect(repository.save({ ...facts('api-prod'), configurationHashes: { '/etc/hosts': 'a'.repeat(64) } } as never)).rejects.toThrow('Invalid host facts store')
      await expect(repository.save({ ...facts('api-prod'), software: { DATABASE_URL: '1.25' } } as never)).rejects.toThrow('sensitive data')
      await expect(repository.save({ ...facts('api-prod'), operatingSystem: { name: 'postgres://user:pass@db/app' } })).rejects.toThrow('sensitive data')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects every synthetic bare credential format before repository persistence', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-facts-bare-credentials-'))
    const path = join(directory, 'facts.json')
    try {
      const repository = new FileHostFactsRepository(path)
      for (const value of syntheticBareCredentials) {
        await expect(repository.save({ ...facts('api-prod'), operatingSystem: { name: 'Linux', version: value } })).rejects.toThrow('sensitive data')
      }
      await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(repository.list()).resolves.toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects malformed persisted facts instead of returning untrusted data', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-facts-'))
    const path = join(directory, 'facts.json')
    try {
      await writeFile(path, JSON.stringify({ version: 3, records: [{ hostname: 'api-prod', observedAt: '2026-08-09T00:00:00.000Z', processes: 'not-a-record' }] }), 'utf8')

      await expect(new FileHostFactsRepository(path).load('api-prod')).rejects.toThrow('Invalid host facts store')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects unknown fields on the current versioned document envelope', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-facts-'))
    const path = join(directory, 'facts.json')
    try {
      await new FileHostFactsRepository(path).save(facts('api-prod'))
      const document = JSON.parse(await readFile(path, 'utf8'))
      await writeFile(path, JSON.stringify({ ...document, apiKey: 'never-accept' }), 'utf8')

      await expect(new FileHostFactsRepository(path).load('api-prod')).rejects.toThrow('Invalid host facts store')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('migrates a bounded safe legacy configuration path outside the former allowlist', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-facts-'))
    const path = join(directory, 'facts.json')
    try {
      await writeFile(path, JSON.stringify({ version: 2, records: [{ ...legacyFacts('api-prod'), configurationHashes: { '/etc/app.conf': 'a'.repeat(64) } }] }), 'utf8')

      await expect(new FileHostFactsRepository(path).load('api-prod')).resolves.toMatchObject({
        legacyFacts: { configurationHashes: { '/etc/app.conf': 'a'.repeat(64) } },
      })
      expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ version: 3 })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects unsafe or malformed version 2 legacy facts without rewriting their source bytes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-facts-legacy-rejections-'))
    try {
      const records = [
        { software: { app: 'v1.25\nnot-a-version' } },
        { software: { app: 'DATABASE_URL=synthetic-environment-value' } },
        { installLocations: { app: '/tmp/legacy-app' } },
        { logLocations: ['/home/deploy/.ssh/id_rsa'] },
        { configurationHashes: { '/etc/app.conf': 'not-a-sha256' } },
        { processes: [{ name: 'app', status: 'Ssl', rawOutput: 'unstructured' }] },
        { unknownLegacyField: 'unexpected' },
        { software: Object.fromEntries(Array.from({ length: 2_001 }, (_item, index) => [`app-${index}`, 'v1.25'])) },
      ] as const
      for (const [index, unsafe] of records.entries()) {
        const path = join(directory, `facts-${index}.json`)
        const source = JSON.stringify({ version: 2, records: [{ ...legacyFacts('api-prod'), ...unsafe }] })
        await writeFile(path, source, 'utf8')

        await expect(new FileHostFactsRepository(path).list()).rejects.toThrow(/sensitive data|Invalid host facts store/)
        expect(await readFile(path, 'utf8')).toBe(source)
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects persisted environment-style credential URIs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-facts-'))
    const path = join(directory, 'facts.json')
    try {
      await writeFile(path, JSON.stringify({ version: 2, records: [{ ...facts('api-prod'), software: { nginx: 'postgres://user:pass@db/app' } }] }), 'utf8')

      await expect(new FileHostFactsRepository(path).load('api-prod')).rejects.toThrow('sensitive data')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects unsanitized terminal-output keys in dynamic legacy facts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-facts-dynamic-output-'))
    try {
      for (const key of ['rawOutput', 'terminalOutput', 'stdout', 'stderr', 'commandOutput', 'terminalHistory']) {
        const path = join(directory, `${key}.json`)
        const source = JSON.stringify({ version: 2, records: [{ ...legacyFacts('api-prod'), software: { [key]: 'synthetic terminal output' } }] })
        await writeFile(path, source, 'utf8')
        await expect(new FileHostFactsRepository(path).list()).rejects.toThrow(/sensitive data|Invalid host facts store/)
        expect(await readFile(path, 'utf8')).toBe(source)
      }
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('rejects oversized versioned facts envelopes without rewriting source bytes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'facts-record-count-limit-'))
    try {
      for (const version of [2, 3] as const) {
        const path = join(directory, `facts-${version}.json`)
        const source = JSON.stringify({ version, records: Array.from({ length: 2_001 }, (_item, index) => version === 2
          ? legacyFacts(`host-${index}`)
          : { hostname: `host-${index}`, observedAt: '2026-08-18T00:00:00.000Z' }) })
        await writeFile(path, source, 'utf8')
        await expect(new FileHostFactsRepository(path).list()).rejects.toThrow('Invalid host facts store')
        expect(await readFile(path, 'utf8')).toBe(source)
      }
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('rejects a source document over the byte budget without rewriting it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'facts-document-byte-limit-'))
    const path = join(directory, 'facts.json')
    try {
      const source = JSON.stringify({ version: 3, records: [] }) + ' '.repeat(8 * 1024 * 1024 + 1)
      await writeFile(path, source, 'utf8')
      await expect(new FileHostFactsRepository(path).list()).rejects.toThrow('Invalid host facts store')
      expect(await readFile(path, 'utf8')).toBe(source)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('serializes simultaneous saves without losing host records', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-facts-'))
    const path = join(directory, 'facts.json')
    try {
      const repository = new FileHostFactsRepository(path)
      await Promise.all([repository.save(facts('api-prod')), repository.save(facts('web-prod'))])

      const persisted = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
      expect((persisted.records as Array<{ hostname: string }>).map(record => record.hostname)).toEqual(['api-prod', 'web-prod'])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('shares first-load migration with concurrent saves so an older snapshot cannot overwrite either save', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-facts-save-initialization-'))
    const path = join(directory, 'facts.json')
    const deferred = deferredFirstMigrationRename()
    let operations: Promise<unknown>[] = []
    try {
      await writeFile(path, JSON.stringify({ version: 2, records: [legacyFacts('api-prod')] }))
      const repository = new FileHostFactsRepository(path, { fileSystem: { rename: deferred.rename } })
      const first = repository.save(facts('web-prod'))
      operations = [first]
      await deferred.started
      const second = repository.save(facts('db-prod'))
      operations.push(second)

      await deferred.releaseAfterConcurrencyWindow()
      await Promise.all(operations)

      expect(deferred.renamedWhileBlocked()).toBe(false)
      expect(deferred.renameCount()).toBe(3)
      expect((await new FileHostFactsRepository(path).list()).map(record => record.hostname)).toEqual(['api-prod', 'db-prod', 'web-prod'])
    } finally {
      deferred.release()
      await Promise.allSettled(operations)
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('shares first-load migration with concurrent removals so an older snapshot cannot restore either host', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-facts-remove-initialization-'))
    const path = join(directory, 'facts.json')
    const deferred = deferredFirstMigrationRename()
    let operations: Promise<unknown>[] = []
    try {
      await writeFile(path, JSON.stringify({ version: 2, records: [legacyFacts('api-prod'), legacyFacts('web-prod')] }))
      const repository = new FileHostFactsRepository(path, { fileSystem: { rename: deferred.rename } })
      const first = repository.remove('api-prod')
      operations = [first]
      await deferred.started
      const second = repository.remove('web-prod')
      operations.push(second)

      await deferred.releaseAfterConcurrencyWindow()
      await Promise.all(operations)

      expect(deferred.renamedWhileBlocked()).toBe(false)
      expect(deferred.renameCount()).toBe(3)
      await expect(new FileHostFactsRepository(path).list()).resolves.toEqual([])
    } finally {
      deferred.release()
      await Promise.allSettled(operations)
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('keeps save and remove memory state aligned with disk and cleans temporary files after rename failures', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-facts-failure-'))
    const path = join(directory, 'facts.json')
    try {
      const initial = new FileHostFactsRepository(path)
      await initial.save(facts('api-prod'))
      let failRename = true
      const repository = new FileHostFactsRepository(path, {
        fileSystem: {
          rename: async (source: string, destination: string) => {
            if (failRename) throw new Error('injected rename failure')
            await rename(source, destination)
          },
        },
      })

      await expect(repository.save(facts('web-prod'))).rejects.toThrow('injected rename failure')
      expect((await repository.list()).map(record => record.hostname)).toEqual(['api-prod'])
      expect((await new FileHostFactsRepository(path).list()).map(record => record.hostname)).toEqual(['api-prod'])
      expect(await temporaryFiles(directory)).toEqual([])

      await expect(repository.remove('api-prod')).rejects.toThrow('injected rename failure')
      expect((await repository.list()).map(record => record.hostname)).toEqual(['api-prod'])
      expect((await new FileHostFactsRepository(path).list()).map(record => record.hostname)).toEqual(['api-prod'])
      expect(await temporaryFiles(directory)).toEqual([])

      failRename = false
      await repository.remove('api-prod')
      expect(await repository.list()).toEqual([])
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('keeps ordinary update and remove state aligned with disk after temporary write failures', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-facts-write-failure-'))
    const path = join(directory, 'facts.json')
    try {
      await new FileHostFactsRepository(path).save(facts('api-prod'))
      const repository = new FileHostFactsRepository(path, {
        fileSystem: {
          writeFile: async (temporaryPath: string, data: string) => {
            await writeFile(temporaryPath, data, 'utf8')
            throw new Error('injected write failure')
          },
        },
      })
      const service = new HostFactsService(repository)
      const updated = { ...facts('api-prod'), observedAt: '2026-08-18T01:00:00.000Z', currentUser: 'deployuser' }

      await expect(service.update('api-prod', updated)).rejects.toThrow('injected write failure')
      expect(await service.snapshot('api-prod')).toMatchObject({ observedAt: '2026-08-09T00:00:00.000Z', currentUser: 'root' })
      expect(await new FileHostFactsRepository(path).load('api-prod')).toMatchObject({ observedAt: '2026-08-09T00:00:00.000Z', currentUser: 'root' })
      expect(await temporaryFiles(directory)).toEqual([])

      await expect(service.remove('api-prod')).rejects.toThrow('injected write failure')
      expect(await service.snapshot('api-prod')).toMatchObject({ hostname: 'api-prod' })
      expect(await new FileHostFactsRepository(path).load('api-prod')).toMatchObject({ hostname: 'api-prod' })
      expect(await temporaryFiles(directory)).toEqual([])
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('retries migration after an injected write failure and leaves no temporary fact data', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-facts-migration-failure-'))
    const path = join(directory, 'facts.json')
    try {
      await writeFile(path, JSON.stringify({ 'api-prod': legacyFacts('api-prod') }))
      let failWrite = true
      const repository = new FileHostFactsRepository(path, {
        fileSystem: {
          writeFile: async (temporaryPath: string, data: string) => {
            await writeFile(temporaryPath, data, 'utf8')
            if (failWrite) throw new Error('injected write failure')
          },
        },
      })

      await expect(repository.list()).rejects.toThrow('Invalid host facts store')
      await expect(repository.list()).rejects.toThrow('Invalid host facts store')
      expect(JSON.parse(await readFile(path, 'utf8'))).not.toHaveProperty('version')
      expect(await temporaryFiles(directory)).toEqual([])

      failWrite = false
      await expect(repository.list()).resolves.toHaveLength(1)
      expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ version: 3 })
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})

function facts(hostname: string) {
  return {
    hostname,
    observedAt: '2026-08-09T00:00:00.000Z',
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

function legacyFacts(hostname: string) {
  return {
    hostname,
    observedAt: '2026-08-09T00:00:00.000Z',
    software: { nginx: '1.25' },
    processes: [{ name: 'nginx', status: 'Ssl' }],
    installLocations: { nginx: '/usr/sbin/nginx' },
    services: { 'nginx.service': 'active running' },
    logLocations: ['/var/log/nginx/error.log'],
    configurationHashes: { '/etc/nginx/nginx.conf': 'a'.repeat(64) },
  }
}

async function temporaryFiles(directory: string): Promise<string[]> { return (await readdir(directory)).filter(name => name.endsWith('.tmp')) }

const syntheticBareCredentials = [
  'sk-proj-' + '0'.repeat(32),
  'ghp_' + '0'.repeat(36),
  'github_pat_' + '0'.repeat(82),
  ...['gho_', 'ghu_', 'ghs_', 'ghr_'].map(prefix => prefix + '0'.repeat(36)),
  ...['AKIA', 'ASIA'].map(prefix => prefix + '0'.repeat(16)),
  'glpat-' + '0'.repeat(20),
  'npm_' + '0'.repeat(36),
  'xoxb-' + '0'.repeat(10) + '-' + '0'.repeat(10) + '-' + '0'.repeat(12),
  'sk_live_' + '0'.repeat(24),
  'rk_live_' + '0'.repeat(24),
  'dckr_pat_' + '0'.repeat(36),
  'aws-secret-access-key=' + 'A'.repeat(40),
  'A'.repeat(40),
  'eyJzeW50aGV0aWMiOiJ0ZXN0In0.eyJub25mdW5jdGlvbmFsIjp0cnVlfQ.invalidsignature',
  'Bearer synthetic-nonfunctional-value-00000000',
]

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
