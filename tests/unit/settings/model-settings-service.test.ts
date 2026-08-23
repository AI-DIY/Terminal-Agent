import { describe, expect, it, vi } from 'vitest'
import { ModelProfileService } from '../../../src/main/settings/model-profile-service'
import type { ModelProfileDocument } from '../../../src/main/settings/model-profile-repository'
import { ModelSettingsService } from '../../../src/main/settings/model-settings-service'

const endpoint = 'https://api.openai.com/v1/chat/completions'

describe('ModelSettingsService', () => {
  it('stores the API key through the secret store, never the settings repository', async () => {
    const settings = { save: vi.fn(), load: vi.fn().mockResolvedValue(null) }
    const secrets = { save: vi.fn(), load: vi.fn().mockResolvedValue(null) }
    const service = new ModelSettingsService(settings, secrets)

    await service.save({ endpoint, model: 'gpt-5', apiKey: 'sk-test', contextLimit: 12_000 })

    expect(settings.save).toHaveBeenCalledWith({ endpoint, model: 'gpt-5', contextLimit: 12_000 })
    expect(secrets.save).toHaveBeenCalledWith('model.apiKey', 'sk-test')
  })

  it('rejects endpoints that are not OpenAI Chat Completions endpoints', async () => {
    const settings = { save: vi.fn(), load: vi.fn().mockResolvedValue(null) }
    const secrets = { save: vi.fn(), load: vi.fn().mockResolvedValue(null) }
    const service = new ModelSettingsService(settings, secrets)

    await expect(service.save({
      endpoint: 'https://api.openai.com/v1/responses',
      model: 'gpt-5',
      apiKey: 'sk-test',
      contextLimit: 12_000,
    })).rejects.toThrow('Endpoint must target OpenAI Chat Completions')

    expect(settings.save).not.toHaveBeenCalled()
    expect(secrets.save).not.toHaveBeenCalled()
  })

  it.each([
    ['recognizable PEM private-key material', '-----BEGIN PRIVATE KEY-----'],
    ['an over-limit UTF-8 key', '密'.repeat(2_049)],
  ])('rejects %s from the legacy save path before protected storage', async (_label, apiKey) => {
    const settings = { save: vi.fn(), load: vi.fn().mockResolvedValue(null) }
    const secrets = { save: vi.fn(), load: vi.fn().mockResolvedValue(null) }
    const service = new ModelSettingsService(settings, secrets)

    await expect(service.save({ endpoint, model: 'gpt-5', apiKey, contextLimit: 12_000 })).rejects.toThrow()

    expect(settings.save).not.toHaveBeenCalled()
    expect(secrets.save).not.toHaveBeenCalled()
  })

  it.each([
    ['recognizable PEM private-key material', '-----BEGIN PRIVATE KEY-----'],
    ['an over-limit UTF-8 key', '密'.repeat(2_049)],
  ])('rejects %s from the legacy connection-test path before use', async (_label, apiKey) => {
    const settings = { save: vi.fn(), load: vi.fn().mockResolvedValue(null) }
    const secrets = { save: vi.fn(), load: vi.fn().mockResolvedValue(null) }
    const service = new ModelSettingsService(settings, secrets)

    await expect(service.prepareForConnectionTest({ endpoint, model: 'gpt-5', apiKey, contextLimit: 12_000 })).rejects.toThrow()

    expect(settings.save).not.toHaveBeenCalled()
    expect(secrets.save).not.toHaveBeenCalled()
  })

  it('returns no API key to the renderer and can retain an existing protected key on update', async () => {
    const settings = { save: vi.fn(), load: vi.fn().mockResolvedValue({ endpoint, model: 'gpt-5', contextLimit: 12_000 }) }
    const secrets = { save: vi.fn(), load: vi.fn().mockResolvedValue('sk-existing') }
    const service = new ModelSettingsService(settings, secrets)

    await expect(service.loadForRenderer()).resolves.toEqual({ endpoint, model: 'gpt-5', contextLimit: 12_000, hasApiKey: true })
    await service.saveFromRenderer({ endpoint, model: 'gpt-5-mini', contextLimit: 8_000 })

    expect(secrets.save).toHaveBeenCalledWith('model.apiKey', 'sk-existing')
    expect(settings.save).toHaveBeenCalledWith({ endpoint, model: 'gpt-5-mini', contextLimit: 8_000 })
  })

  it('prepares the current renderer input for a connection test without persisting it', async () => {
    const settings = { save: vi.fn(), load: vi.fn().mockResolvedValue({ endpoint, model: 'gpt-5', contextLimit: 12_000 }) }
    const secrets = { save: vi.fn(), load: vi.fn().mockResolvedValue('sk-existing') }
    const service = new ModelSettingsService(settings, secrets)

    await expect(service.prepareForConnectionTest({ endpoint, model: 'compatible-model', contextLimit: 8_000 }))
      .resolves.toEqual({ endpoint, model: 'compatible-model', contextLimit: 8_000, apiKey: 'sk-existing' })

    expect(settings.save).not.toHaveBeenCalled()
    expect(secrets.save).not.toHaveBeenCalled()
  })

  it('uses a direct legacy API key through the profile adapter without exposing it to the renderer', async () => {
    let document: ModelProfileDocument = {
      version: 2, profiles: [], activeLlmId: null, activeVlmId: null, routing: 'combined', migrations: {},
    }
    const protectedKeys = new Map<string, string>()
    const profiles = new ModelProfileService(
      {
        load: vi.fn().mockImplementation(async () => document),
        save: vi.fn().mockImplementation(async (next: ModelProfileDocument) => { document = next }),
      },
      {
        load: vi.fn().mockImplementation(async (key: string) => protectedKeys.get(key) ?? null),
        save: vi.fn().mockImplementation(async (key: string, value: string) => { protectedKeys.set(key, value) }),
        remove: vi.fn().mockImplementation(async (key: string) => { protectedKeys.delete(key) }),
      },
      { createId: () => 'legacy-profile' },
    )
    const service = new ModelSettingsService(profiles)
    const legacyInput = { endpoint, model: 'gpt-5', contextLimit: 8_000, apiKey: 'legacy-direct-key' }

    await expect(service.prepareForConnectionTest(legacyInput)).resolves.toMatchObject(legacyInput)
    await service.saveFromRenderer(legacyInput)

    expect(document.profiles).toEqual([expect.objectContaining({ id: 'legacy-profile', model: 'gpt-5' })])
    expect(JSON.stringify(document)).not.toContain('legacy-direct-key')
    expect(protectedKeys.get('model-profile.legacy-profile.apiKey')).toBe('legacy-direct-key')
    await expect(service.loadForRenderer()).resolves.toEqual({ endpoint, model: 'gpt-5', contextLimit: 8_000, hasApiKey: true })
  })

  it.each([
    ['recognizable PEM private-key material', '-----BEGIN PRIVATE KEY-----'],
    ['an over-limit UTF-8 key', '密'.repeat(2_049)],
  ])('rejects %s from the legacy profile adapter before protected storage', async (_label, apiKey) => {
    let document: ModelProfileDocument = {
      version: 2, profiles: [], activeLlmId: null, activeVlmId: null, routing: 'combined', migrations: {},
    }
    const secrets = {
      load: vi.fn().mockResolvedValue(null),
      save: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    }
    const profiles = new ModelProfileService(
      {
        load: vi.fn().mockImplementation(async () => document),
        save: vi.fn().mockImplementation(async (next: ModelProfileDocument) => { document = next }),
      },
      secrets,
    )
    const service = new ModelSettingsService(profiles)

    const input = { endpoint, model: 'gpt-5', contextLimit: 8_000, apiKey }
    await expect(service.prepareForConnectionTest(input)).rejects.toThrow()
    await expect(service.saveFromRenderer(input)).rejects.toThrow()
    expect(secrets.save).not.toHaveBeenCalled()
    expect(document.profiles).toEqual([])
  })
})
