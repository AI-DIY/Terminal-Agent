import { describe, expect, it, vi } from 'vitest'
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
})
