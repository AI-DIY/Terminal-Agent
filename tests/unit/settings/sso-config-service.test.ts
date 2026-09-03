import { mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AtomicJsonStoreFileSystem } from '../../../src/main/persistence/atomic-json-store'
import { SsoConfigService, createDefaultSsoConfiguration, getSsoConfigPath } from '../../../src/main/settings/sso-config-service'

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
  it('uses the .ta/user-config path and creates an enabled default document', async () => {
    const root = await createRoot()
    const path = join(root, '.ta', 'user-config')
    expect(getSsoConfigPath(root)).toBe(path)
    const service = new SsoConfigService(path)
    await expect(service.ensureInitialized()).resolves.toEqual(createDefaultSsoConfiguration())
    await expect(readFile(path, 'utf8')).resolves.toContain('"version":1')
  })

  it('preserves an existing draft during initialization and trims saves', async () => {
    const root = await createRoot()
    const service = new SsoConfigService(join(root, '.ta', 'user-config'))
    await service.ensureInitialized()
    const draft = await service.save({ enabled: true, loginPageUrl: ' https://login.example ', platformUrlMatcher: { mode: 'exact', value: '' }, userInfoUrlMatcher: { mode: 'exact', value: '' }, employeeIdField: '', nameField: '' })
    await service.ensureInitialized()
    expect(await service.get()).toEqual(draft)
    expect(draft.loginPageUrl).toBe('https://login.example')
  })

  it('classifies complete and incomplete configurations', async () => {
    const root = await createRoot()
    const service = new SsoConfigService(join(root, '.ta', 'user-config'))
    const incomplete = await service.save(createDefaultSsoConfiguration())
    expect(service.isComplete(incomplete)).toBe(false)
    const complete = await service.save({ enabled: true, loginPageUrl: 'https://login.example', platformUrlMatcher: { mode: 'exact', value: 'https://platform.example/home' }, userInfoUrlMatcher: { mode: 'regex', value: '^https://platform\\.example/api/userinfo$' }, employeeIdField: 'data.employeeId', nameField: '$.data.name' })
    expect(service.isComplete(complete)).toBe(true)
  })

  it('leaves a competing creator document untouched when initialization loses the create race', async () => {
    const root = await createRoot()
    const path = join(root, '.ta', 'user-config')
    const competing = {
      version: 1,
      sso: { ...createDefaultSsoConfiguration(), enabled: false },
    }
    let raced = false
    const fileSystem: AtomicJsonStoreFileSystem = {
      mkdir,
      readFile,
      async openExclusive(file) {
        if (file === path && !raced) {
          raced = true
          await mkdir(dirname(path), { recursive: true })
          await writeFile(path, JSON.stringify(competing), 'utf8')
          const error = Object.assign(new Error('exists'), { code: 'EEXIST' })
          throw error
        }
        const handle = await open(file, 'wx')
        return { writeFile: (data, options) => handle.writeFile(data, options), close: () => handle.close() }
      },
      rename,
      rm,
    }
    const service = new SsoConfigService(path, { fileSystem })

    await expect(service.ensureInitialized()).resolves.toEqual(competing.sso)
    await expect(readFile(path, 'utf8')).resolves.toBe(JSON.stringify(competing))
  })

  it('backs up corrupt content and never replaces it during initialization', async () => {
    const root = await createRoot()
    const path = join(root, '.ta', 'user-config')
    await mkdir(dirname(path), { recursive: true })
    const corrupt = '{ not valid json'
    await writeFile(path, corrupt, 'utf8')
    const service = new SsoConfigService(path)

    await expect(service.ensureInitialized()).rejects.toThrow('AtomicJsonStore could not read valid JSON data')
    await expect(readFile(path, 'utf8')).resolves.toBe(corrupt)
    const files = await readdir(dirname(path))
    expect(files.filter(file => file.endsWith('.corrupt'))).toHaveLength(1)
  })
})
