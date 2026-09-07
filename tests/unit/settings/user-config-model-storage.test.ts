import { describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ModelProfileRepository } from '../../../src/main/settings/model-profile-repository'
import { ModelProfileService } from '../../../src/main/settings/model-profile-service'
import { SsoConfigService, createDefaultSsoConfiguration } from '../../../src/main/settings/sso-config-service'

describe('shared .terminal-agent/user-config model storage', () => {
  it('keeps SSO and model profiles together and stores the API key as plain JSON', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-user-config-models-'))
    try {
      const path = join(directory, '.terminal-agent', 'user-config')
      const repository = new ModelProfileRepository(path, { userConfig: true })
      const secrets = {
        load: vi.fn(async () => null),
        save: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
      }
      const service = new ModelProfileService(repository, secrets, { plaintextApiKeys: true })
      const profile = await service.save({
        name: 'Primary',
        kind: 'llm',
        provider: 'openai',
        model: 'gpt-5',
        endpoint: 'https://api.openai.com/v1/chat/completions',
        contextLimit: 12_000,
        apiKey: 'sk-user-config-test',
      })

      expect(profile.hasApiKey).toBe(true)
      expect(secrets.save).not.toHaveBeenCalled()
      const sso = new SsoConfigService(path)
      await sso.save({ ...createDefaultSsoConfiguration(), enabled: false })
      const persisted = JSON.parse(await readFile(path, 'utf8')) as {
        sso: { enabled: boolean }
        models: { profiles: Array<{ apiKey?: string }> }
      }
      expect(persisted.sso.enabled).toBe(false)
      expect(persisted.models.profiles[0]?.apiKey).toBe('sk-user-config-test')

      const restored = new ModelProfileService(new ModelProfileRepository(path, { userConfig: true }), secrets, { plaintextApiKeys: true })
      await expect(restored.resolveRoute({ hasImages: false })).resolves.toMatchObject({ apiKey: 'sk-user-config-test' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('serializes concurrent SSO and model writes without dropping either section', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-user-config-concurrent-writes-'))
    try {
      const path = join(directory, '.terminal-agent', 'user-config')
      const sso = new SsoConfigService(path)
      const secrets = {
        load: vi.fn(async () => null),
        save: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
      }
      const models = new ModelProfileService(
        new ModelProfileRepository(path, { userConfig: true }),
        secrets,
        { plaintextApiKeys: true, createId: () => 'concurrent-profile' },
      )

      await sso.ensureInitialized()
      await Promise.all([
        sso.save({ ...createDefaultSsoConfiguration(), enabled: false }),
        models.save({
          name: 'Concurrent',
          kind: 'llm',
          provider: 'openai',
          model: 'gpt-5',
          endpoint: 'https://api.openai.com/v1/chat/completions',
          contextLimit: 12_000,
          apiKey: 'sk-concurrent-write-test',
        }),
      ])

      const persisted = JSON.parse(await readFile(path, 'utf8')) as {
        sso: { enabled: boolean }
        models: { profiles: Array<{ id: string; apiKey?: string }> }
      }
      expect(persisted.sso.enabled).toBe(false)
      expect(persisted.models.profiles).toEqual([
        expect.objectContaining({ id: 'concurrent-profile', apiKey: 'sk-concurrent-write-test' }),
      ])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('imports profiles and their legacy credentials from the previous userData file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-user-config-profile-migration-'))
    try {
      const path = join(directory, '.terminal-agent', 'user-config')
      const repository = new ModelProfileRepository(path, { userConfig: true })
      const secrets = {
        load: vi.fn(async (key: string) => key === 'model-profile.legacy.apiKey' ? 'legacy-key' : null),
        save: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
      }
      const legacyProfiles = {
        load: vi.fn(async () => ({
          version: 2 as const,
          profiles: [{
            id: 'legacy', name: 'Legacy', kind: 'llm' as const, provider: 'openai' as const,
            model: 'gpt-4o', endpoint: 'https://api.openai.com/v1/chat/completions', contextLimit: 8_000,
          }],
          activeLlmId: 'legacy', activeVlmId: null, routing: 'combined' as const, migrations: {},
        })),
      }
      const service = new ModelProfileService(repository, secrets, { legacyProfiles, plaintextApiKeys: true })
      await service.list('llm')
      expect(legacyProfiles.load).toHaveBeenCalledOnce()
      expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ models: { profiles: [{ id: 'legacy', apiKey: 'legacy-key' }] } })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('wraps a standalone version-1 model document before SSO and model reads', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-user-config-v1-wrap-'))
    try {
      const path = join(directory, '.terminal-agent', 'user-config')
      await mkdir(join(directory, '.terminal-agent'), { recursive: true })
      await writeFile(path, JSON.stringify({
        version: 1,
        profiles: [{
          id: 'legacy-v1', name: 'Legacy v1', kind: 'llm', provider: 'openai',
          model: 'gpt-4o', endpoint: 'https://api.openai.com/v1/chat/completions', contextLimit: 8_000,
        }],
        activeLlmId: 'legacy-v1', activeVlmId: null, routing: 'combined', migrations: {},
      }), 'utf8')

      // SSO initializes before the model service in the main process.  It must
      // preserve this document instead of treating it as a corrupt SSO file.
      const sso = new SsoConfigService(path)
      await expect(sso.ensureInitialized()).resolves.toEqual(createDefaultSsoConfiguration())
      await expect(sso.get()).resolves.toEqual(createDefaultSsoConfiguration())

      const models = await new ModelProfileRepository(path, { userConfig: true }).load()
      expect(models).toMatchObject({ version: 2, activeLlmId: 'legacy-v1', profiles: [{ id: 'legacy-v1' }] })
      const persisted = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
      expect(persisted).not.toHaveProperty('profiles')
      expect(persisted).toMatchObject({ version: 1, models: { version: 2, activeLlmId: 'legacy-v1' } })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('strips an embedded legacy API key when importing into protected storage', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-user-config-protected-import-'))
    try {
      const path = join(directory, '.terminal-agent', 'user-config')
      const repository = new ModelProfileRepository(path, { userConfig: true })
      const secrets = {
        load: vi.fn(async (key: string) => key === 'model-profile.embedded.apiKey' ? 'protected-key' : null),
        save: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
      }
      const legacyProfiles = {
        load: vi.fn(async () => ({
          version: 2 as const,
          profiles: [{
            id: 'embedded', name: 'Embedded', kind: 'llm' as const, provider: 'openai' as const,
            model: 'gpt-4o', endpoint: 'https://api.openai.com/v1/chat/completions', contextLimit: 8_000,
            apiKey: 'legacy-plaintext-key',
          }],
          activeLlmId: 'embedded', activeVlmId: null, routing: 'combined' as const, migrations: {},
        })),
      }
      const service = new ModelProfileService(repository, secrets, { legacyProfiles, plaintextApiKeys: false })

      await expect(service.list('llm')).resolves.toEqual([
        expect.objectContaining({ id: 'embedded', hasApiKey: true, active: true }),
      ])
      const persisted = JSON.parse(await readFile(path, 'utf8')) as {
        models: { profiles: Array<Record<string, unknown>> }
      }
      expect(persisted.models.profiles[0]).not.toHaveProperty('apiKey')
      // An existing protected destination credential is retained and is not
      // overwritten by the embedded legacy field.
      expect(secrets.save).not.toHaveBeenCalled()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
