import { link, mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AtomicJsonStoreFileSystem } from '../../../src/main/persistence/atomic-json-store'
import { SsoConfigService, createDefaultSsoConfiguration, getLegacySsoConfigPath, getSsoConfigPath } from '../../../src/main/settings/sso-config-service'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sso-config-'))
  temporaryDirectories.push(root)
  return root
}

describe('SsoConfigService', () => {
  it('uses the .terminal-agent/user-config path and creates an enabled default document', async () => {
    const root = await createRoot()
    const path = join(root, '.terminal-agent', 'user-config')
    expect(getSsoConfigPath(root)).toBe(path)
    expect(getLegacySsoConfigPath(root)).toBe(join(root, '.ta', 'user-config'))
    const service = new SsoConfigService(path)
    await expect(service.ensureInitialized()).resolves.toEqual(createDefaultSsoConfiguration())
    await expect(readFile(path, 'utf8')).resolves.toContain('"version":1')
  })

  it('migrates a legacy .ta file into the canonical path without modifying the source', async () => {
    const root = await createRoot()
    const path = join(root, '.terminal-agent', 'user-config')
    const legacyPath = join(root, '.ta', 'user-config')
    const legacy = {
      version: 1,
      sso: { ...createDefaultSsoConfiguration(), enabled: false },
      models: { preserved: true },
      futureSetting: { keep: 'yes' },
    }
    await mkdir(dirname(legacyPath), { recursive: true })
    await writeFile(legacyPath, JSON.stringify(legacy), 'utf8')

    const service = new SsoConfigService(path, { legacyPath })
    await expect(service.ensureInitialized()).resolves.toEqual(legacy.sso)
    await expect(readFile(path, 'utf8')).resolves.toBe(JSON.stringify(legacy))
    await expect(readFile(legacyPath, 'utf8')).resolves.toBe(JSON.stringify(legacy))
  })

  it('prefers an existing canonical file and never overwrites it with legacy data', async () => {
    const root = await createRoot()
    const path = join(root, '.terminal-agent', 'user-config')
    const legacyPath = join(root, '.ta', 'user-config')
    const canonical = { version: 1, sso: { ...createDefaultSsoConfiguration(), enabled: false }, future: 'canonical' }
    const legacy = { version: 1, sso: { ...createDefaultSsoConfiguration(), enabled: true }, future: 'legacy' }
    await mkdir(dirname(path), { recursive: true })
    await mkdir(dirname(legacyPath), { recursive: true })
    await writeFile(path, JSON.stringify(canonical), 'utf8')
    await writeFile(legacyPath, JSON.stringify(legacy), 'utf8')

    const service = new SsoConfigService(path, { legacyPath })
    await expect(service.ensureInitialized()).resolves.toEqual(canonical.sso)
    await expect(readFile(path, 'utf8')).resolves.toBe(JSON.stringify(canonical))
    await expect(readFile(legacyPath, 'utf8')).resolves.toBe(JSON.stringify(legacy))
  })

  it('retains unknown top-level fields when SSO updates only its own section', async () => {
    const root = await createRoot()
    const path = join(root, '.terminal-agent', 'user-config')
    const future = { enabled: false, nested: { flag: true } }
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify({ version: 1, sso: createDefaultSsoConfiguration(), future }), 'utf8')
    const service = new SsoConfigService(path)
    await service.save({ ...createDefaultSsoConfiguration(), enabled: false })
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ future })
  })

  it('preserves an existing draft during initialization and trims saves', async () => {
    const root = await createRoot()
    const service = new SsoConfigService(join(root, '.terminal-agent', 'user-config'))
    await service.ensureInitialized()
    const draft = await service.save({ enabled: true, loginPageUrl: ' https://login.example ', platformUrlMatcher: { mode: 'exact', value: '' }, userInfoUrlMatcher: { mode: 'exact', value: '' }, employeeIdField: '', nameField: '' })
    await service.ensureInitialized()
    expect(await service.get()).toEqual(draft)
    expect(draft.loginPageUrl).toBe('https://login.example')
  })

  it('classifies complete and incomplete configurations', async () => {
    const root = await createRoot()
    const service = new SsoConfigService(join(root, '.terminal-agent', 'user-config'))
    const incomplete = await service.save(createDefaultSsoConfiguration())
    expect(service.isComplete(incomplete)).toBe(false)
    const complete = await service.save({ enabled: true, loginPageUrl: 'https://login.example', platformUrlMatcher: { mode: 'exact', value: 'https://platform.example/home' }, userInfoUrlMatcher: { mode: 'regex', value: '^https://platform\\.example/api/userinfo$' }, employeeIdField: 'data.employeeId', nameField: '$.data.name' })
    expect(service.isComplete(complete)).toBe(true)
  })

  it('leaves a competing creator document untouched when initialization loses the create race', async () => {
    const root = await createRoot()
    const path = join(root, '.terminal-agent', 'user-config')
    const competing = {
      version: 1,
      sso: { ...createDefaultSsoConfiguration(), enabled: false },
    }
    let raced = false
    const fileSystem: AtomicJsonStoreFileSystem = {
      mkdir,
      readFile,
      async openExclusive(file) {
        const handle = await open(file, 'wx')
        return { writeFile: (data, options) => handle.writeFile(data, options), close: () => handle.close() }
      },
      rename,
      rm,
      link: async (source, destination) => {
        if (destination === path && !raced) {
          raced = true
          await mkdir(dirname(path), { recursive: true })
          await writeFile(path, JSON.stringify(competing), 'utf8')
          const error = Object.assign(new Error('exists'), { code: 'EEXIST' })
          throw error
        }
        await link(source, destination)
      },
    }
    const service = new SsoConfigService(path, { fileSystem })

    await expect(service.ensureInitialized()).resolves.toEqual(competing.sso)
    await expect(readFile(path, 'utf8')).resolves.toBe(JSON.stringify(competing))
  })

  it('backs up corrupt content and never replaces it during initialization', async () => {
    const root = await createRoot()
    const path = join(root, '.terminal-agent', 'user-config')
    await mkdir(dirname(path), { recursive: true })
    const corrupt = '{ not valid json'
    await writeFile(path, corrupt, 'utf8')
    const service = new SsoConfigService(path)

    await expect(service.ensureInitialized()).rejects.toThrow('AtomicJsonStore could not read valid JSON data')
    await expect(readFile(path, 'utf8')).resolves.toBe(corrupt)
    const files = await readdir(dirname(path))
    expect(files.filter(file => file.endsWith('.corrupt'))).toHaveLength(1)
  })

  it('does not enter recovery for a same-message initialization read failure', async () => {
    const root = await createRoot()
    const path = join(root, '.terminal-agent', 'user-config')
    const failure = new Error('AtomicJsonStore could not read valid JSON data')
    const fileSystem: AtomicJsonStoreFileSystem = {
      mkdir,
      readFile: async () => { throw failure },
      openExclusive: async () => { throw new Error('openExclusive must not be called') },
      link: async () => { throw new Error('link must not be called') },
      rename: async () => { throw new Error('rename must not be called') },
      rm: async () => { throw new Error('rm must not be called') },
    }
    const service = new SsoConfigService(path, { fileSystem })

    await expect(service.ensureInitialized()).rejects.toBe(failure)
    await expect(service.get()).rejects.toBe(failure)
  })

  it('requires an explicit save to replace corrupt content after preserving its diagnostic backup', async () => {
    const root = await createRoot()
    const path = join(root, '.terminal-agent', 'user-config')
    await mkdir(dirname(path), { recursive: true })
    const corrupt = '{ corrupt configuration bytes'
    await writeFile(path, corrupt, 'utf8')
    const service = new SsoConfigService(path)

    await expect(service.ensureInitialized()).rejects.toThrow('AtomicJsonStore could not read valid JSON data')
    await expect(service.get()).resolves.toEqual(createDefaultSsoConfiguration())
    const saved = await service.save({
      ...createDefaultSsoConfiguration(),
      enabled: false,
    })

    expect(saved.enabled).toBe(false)
    await expect(readFile(path, 'utf8')).resolves.toContain('"enabled":false')
    const backup = (await readdir(dirname(path))).find(file => file.endsWith('.corrupt'))
    expect(backup).toBeTruthy()
    await expect(readFile(join(dirname(path), backup!), 'utf8')).resolves.toBe(corrupt)
  })

  it('does not expose a partial default while another initializer is publishing', async () => {
    const root = await createRoot()
    const path = join(root, '.terminal-agent', 'user-config')
    let firstLinkStarted!: () => void
    const firstLink = new Promise<void>(resolve => { firstLinkStarted = resolve })
    let releaseFirstLink!: () => void
    const firstLinkRelease = new Promise<void>(resolve => { releaseFirstLink = resolve })
    let linkCalls = 0
    const realFs: AtomicJsonStoreFileSystem = {
      mkdir,
      readFile,
      openExclusive: async file => {
        const handle = await open(file, 'wx')
        return { writeFile: (data, options) => handle.writeFile(data, options), close: () => handle.close() }
      },
      rename,
      rm,
      link: async (source, destination) => {
        linkCalls += 1
        if (linkCalls === 1) {
          firstLinkStarted()
          await firstLinkRelease
        }
        await import('node:fs/promises').then(fs => fs.link(source, destination))
      },
    }
    const first = new SsoConfigService(path, { fileSystem: realFs }).ensureInitialized()
    await firstLink
    const second = new SsoConfigService(path, { fileSystem: realFs }).ensureInitialized()
    const secondResult = await second
    releaseFirstLink()
    const firstResult = await first

    expect(firstResult).toEqual(createDefaultSsoConfiguration())
    expect(secondResult).toEqual(createDefaultSsoConfiguration())
    expect(linkCalls).toBe(2)
    expect((await readdir(dirname(path))).filter(file => file.endsWith('.corrupt'))).toHaveLength(0)
    await expect(readFile(path, 'utf8')).resolves.toContain('"version":1')
  })

  it('retries a colliding init temp name without deleting another writer temp', async () => {
    const root = await createRoot()
    const path = join(root, '.terminal-agent', 'user-config')
    const firstId = '11111111-1111-4111-8111-111111111111'
    const secondId = '22222222-2222-4222-8222-222222222222'
    const collidingPath = `${path}.init-${firstId}`
    await mkdir(dirname(path), { recursive: true })
    await writeFile(collidingPath, 'another writer temp', 'utf8')
    const ids = [firstId, secondId]
    const service = new SsoConfigService(path, { createId: () => ids.shift() ?? secondId })

    await expect(service.ensureInitialized()).resolves.toEqual(createDefaultSsoConfiguration())
    await expect(readFile(collidingPath, 'utf8')).resolves.toBe('another writer temp')
    await expect(readFile(path, 'utf8')).resolves.toContain('"version":1')
  })

  it('does not fail after publication when init temp cleanup fails', async () => {
    const root = await createRoot()
    const path = join(root, '.terminal-agent', 'user-config')
    let published = false
    const service = new SsoConfigService(path, {
      fileSystem: {
        mkdir,
        readFile,
        openExclusive: async file => {
          const handle = await open(file, 'wx')
          return { writeFile: (data, options) => handle.writeFile(data, options), close: () => handle.close() }
        },
        link: async (source, destination) => {
          await link(source, destination)
          published = true
        },
        rename,
        rm: async (file, options) => {
          if (published && file.includes('.init-')) throw new Error('injected cleanup failure')
          await rm(file, options)
        },
      },
    })

    await expect(service.ensureInitialized()).resolves.toEqual(createDefaultSsoConfiguration())
    await expect(readFile(path, 'utf8')).resolves.toContain('"version":1')
  })
})
