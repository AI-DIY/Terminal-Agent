import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SsoConfigService, createDefaultSsoConfiguration, getSsoConfigPath } from '../../../src/main/settings/sso-config-service'

describe('SsoConfigService', () => {
  it('uses the .ta/user-config path and creates an enabled default document', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sso-config-'))
    const path = join(root, '.ta', 'user-config')
    expect(getSsoConfigPath(root)).toBe(path)
    const service = new SsoConfigService(path)
    await expect(service.ensureInitialized()).resolves.toEqual(createDefaultSsoConfiguration())
    await expect(readFile(path, 'utf8')).resolves.toContain('"version":1')
  })

  it('preserves an existing draft during initialization and trims saves', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sso-config-'))
    const service = new SsoConfigService(join(root, '.ta', 'user-config'))
    await service.ensureInitialized()
    const draft = await service.save({ enabled: true, loginPageUrl: ' https://login.example ', platformUrlMatcher: { mode: 'exact', value: '' }, userInfoUrlMatcher: { mode: 'exact', value: '' }, employeeIdField: '', nameField: '' })
    await service.ensureInitialized()
    expect(await service.get()).toEqual(draft)
    expect(draft.loginPageUrl).toBe('https://login.example')
  })

  it('classifies complete and incomplete configurations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sso-config-'))
    const service = new SsoConfigService(join(root, '.ta', 'user-config'))
    const incomplete = await service.save(createDefaultSsoConfiguration())
    expect(service.isComplete(incomplete)).toBe(false)
    const complete = await service.save({ enabled: true, loginPageUrl: 'https://login.example', platformUrlMatcher: { mode: 'exact', value: 'https://platform.example/home' }, userInfoUrlMatcher: { mode: 'regex', value: '^https://platform\\.example/api/userinfo$' }, employeeIdField: 'data.employeeId', nameField: '$.data.name' })
    expect(service.isComplete(complete)).toBe(true)
  })
})
