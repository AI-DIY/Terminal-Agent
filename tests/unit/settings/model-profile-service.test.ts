import { describe, expect, it, vi } from 'vitest'
import { ModelProfileService } from '../../../src/main/settings/model-profile-service'
import type { ModelProfileDocument } from '../../../src/main/settings/model-profile-repository'

const endpoint = 'https://api.openai.com/v1/chat/completions'

function createService(initialDocument: ModelProfileDocument = { version: 1, profiles: [], activeLlmId: null, activeVlmId: null, routing: 'combined', migrations: {} }) {
  let document = initialDocument
  const repository = {
    load: vi.fn().mockImplementation(async () => document),
    save: vi.fn().mockImplementation(async (next: ModelProfileDocument) => { document = next }),
  }
  const secrets = {
    load: vi.fn().mockResolvedValue(null),
    save: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  }
  return { service: new ModelProfileService(repository, secrets), repository, secrets, getDocument: () => document }
}

describe('ModelProfileService', () => {
  it('does not brick profile operations or move an orphaned legacy key when legacy settings are absent', async () => {
    const initialDocument: ModelProfileDocument = {
      version: 1,
      profiles: [{ id: 'existing', kind: 'llm', name: 'existing', provider: 'openai', model: 'gpt-5', endpoint, contextLimit: 8_000 }],
      activeLlmId: 'existing', activeVlmId: null, routing: 'combined',
      migrations: { legacyModelSettings: 1 },
    }
    const repository = { load: vi.fn().mockResolvedValue(initialDocument), save: vi.fn() }
    const secrets = {
      load: vi.fn().mockImplementation(async (key: string) => key === 'model.apiKey' ? 'legacy-key' : null),
      save: vi.fn(), remove: vi.fn(),
    }
    const service = new ModelProfileService(repository, secrets, { legacySettings: { load: vi.fn().mockResolvedValue(null) } })

    await expect(service.list()).resolves.toMatchObject([{ id: 'existing', hasApiKey: false }])
    expect(secrets.save).not.toHaveBeenCalled()
    expect(secrets.remove).not.toHaveBeenCalled()
  })

  it.each([
    ['too long', 'x'.repeat(4097)],
    ['PEM private key', '-----BEGIN RSA PRIVATE KEY-----\nmaterial\n-----END RSA PRIVATE KEY-----'],
  ])('rejects %s in direct API-key saves', async (_label, value) => {
    const { service, secrets } = createService({
      version: 1,
      profiles: [{ id: 'existing', kind: 'llm', name: 'existing', provider: 'openai', model: 'gpt-5', endpoint, contextLimit: 8_000 }],
      activeLlmId: null, activeVlmId: null, routing: 'combined', migrations: { legacyModelSettings: 1 },
    })

    await expect(service.saveApiKey('existing', value)).rejects.toThrow()
    expect(secrets.save).not.toHaveBeenCalled()
  })

  it('keeps API keys in the secret store and omits them from renderer DTOs', async () => {
    const { service, repository, secrets } = createService()
    const profile = await service.save({
      kind: 'llm', name: 'Primary', provider: 'openai', model: 'gpt-5', endpoint,
      contextLimit: 12_000, apiKey: 'secret-key',
    })

    expect(profile).toMatchObject({ kind: 'llm', hasApiKey: true, active: true })
    expect(JSON.stringify(profile)).not.toContain('secret-key')
    expect(secrets.save).toHaveBeenCalledWith(`model-profile.${profile.id}.apiKey`, 'secret-key')
    expect(JSON.stringify(repository.save.mock.calls[0]?.[0])).not.toContain('secret-key')
  })

  it('removes a newly saved key when creating a profile cannot be persisted', async () => {
    const { service, repository, secrets, getDocument } = createService()
    const protectedKeys = new Map<string, string>()
    secrets.save.mockImplementation(async (key: string, value: string) => { protectedKeys.set(key, value) })
    secrets.remove.mockImplementation(async (key: string) => { protectedKeys.delete(key) })
    repository.save.mockRejectedValueOnce(new Error('disk unavailable'))

    await expect(service.save({
      kind: 'llm', name: 'new', provider: 'openai', model: 'gpt-5', endpoint, contextLimit: 8_000, apiKey: 'new-secret',
    })).rejects.toThrow('disk unavailable')

    expect([...protectedKeys.keys()]).toEqual([])
    expect(getDocument().profiles).toEqual([])
  })

  it('restores an existing direct key when saving its profile update fails', async () => {
    const { service, repository, secrets, getDocument } = createService({
      version: 1,
      profiles: [{ id: 'existing', kind: 'llm', name: 'existing', provider: 'openai', model: 'gpt-5', endpoint, contextLimit: 8_000 }],
      activeLlmId: null, activeVlmId: null, routing: 'combined', migrations: {},
    })
    const protectedKeys = new Map([['model-profile.existing.apiKey', 'old-secret']])
    secrets.load.mockImplementation(async (key: string) => protectedKeys.get(key) ?? null)
    secrets.save.mockImplementation(async (key: string, value: string) => { protectedKeys.set(key, value) })
    secrets.remove.mockImplementation(async (key: string) => { protectedKeys.delete(key) })
    repository.save.mockRejectedValueOnce(new Error('disk unavailable'))

    await expect(service.saveApiKey('existing', 'new-secret')).rejects.toThrow('disk unavailable')

    expect(protectedKeys.get('model-profile.existing.apiKey')).toBe('old-secret')
    expect(getDocument().activeLlmId).toBeNull()
  })

  it('serializes routed reads behind an in-flight profile save', async () => {
    const harness = createService({
      version: 1,
      profiles: [{ id: 'existing', kind: 'llm', name: 'existing', provider: 'openai', model: 'gpt-5', endpoint, contextLimit: 8_000 }],
      activeLlmId: 'existing', activeVlmId: null, routing: 'combined', migrations: {},
    })
    const protectedKeys = new Map([['model-profile.existing.apiKey', 'old-secret']])
    harness.secrets.load.mockImplementation(async (key: string) => protectedKeys.get(key) ?? null)
    harness.secrets.save.mockImplementation(async (key: string, value: string) => { protectedKeys.set(key, value) })
    harness.secrets.remove.mockImplementation(async (key: string) => { protectedKeys.delete(key) })
    const defaultSave = harness.repository.save.getMockImplementation() as (next: ModelProfileDocument) => Promise<void>
    let signalSaveStarted!: () => void
    let releaseSave!: () => void
    const saveStarted = new Promise<void>(resolve => { signalSaveStarted = resolve })
    const saveGate = new Promise<void>(resolve => { releaseSave = resolve })
    harness.repository.save.mockImplementationOnce(async next => {
      signalSaveStarted()
      await saveGate
      await defaultSave(next)
    })

    const savePromise = harness.service.save({
      id: 'existing', kind: 'llm', name: 'existing', provider: 'openai', model: 'gpt-5-updated', endpoint, contextLimit: 8_000, apiKey: 'new-secret',
    })
    await saveStarted

    const routePromise = harness.service.resolveRoute({ hasImages: false })
    let routeSettled = false
    void routePromise.then(() => { routeSettled = true }, () => { routeSettled = true })
    await Promise.resolve()
    expect(routeSettled).toBe(false)

    releaseSave()
    await savePromise
    await expect(routePromise).resolves.toMatchObject({ id: 'existing', model: 'gpt-5-updated', apiKey: 'new-secret' })
  })

  it('does not expose an in-flight key when profile persistence fails', async () => {
    const harness = createService({
      version: 1,
      profiles: [{ id: 'existing', kind: 'llm', name: 'existing', provider: 'openai', model: 'gpt-5', endpoint, contextLimit: 8_000 }],
      activeLlmId: 'existing', activeVlmId: null, routing: 'combined', migrations: {},
    })
    const protectedKeys = new Map([['model-profile.existing.apiKey', 'old-secret']])
    harness.secrets.load.mockImplementation(async (key: string) => protectedKeys.get(key) ?? null)
    harness.secrets.save.mockImplementation(async (key: string, value: string) => { protectedKeys.set(key, value) })
    harness.secrets.remove.mockImplementation(async (key: string) => { protectedKeys.delete(key) })
    let signalSaveStarted!: () => void
    let rejectSave!: (reason: Error) => void
    const saveStarted = new Promise<void>(resolve => { signalSaveStarted = resolve })
    const saveGate = new Promise<void>((_, reject) => { rejectSave = reject })
    harness.repository.save.mockImplementationOnce(async () => {
      signalSaveStarted()
      await saveGate
    })

    const savePromise = harness.service.save({
      id: 'existing', kind: 'llm', name: 'existing', provider: 'openai', model: 'gpt-5-updated', endpoint, contextLimit: 8_000, apiKey: 'new-secret',
    })
    await saveStarted
    const routePromise = harness.service.resolveRoute({ hasImages: false })
    rejectSave(new Error('disk unavailable'))

    await expect(savePromise).rejects.toThrow('disk unavailable')
    await expect(routePromise).resolves.toMatchObject({ id: 'existing', model: 'gpt-5', apiKey: 'old-secret' })
  })

  it('migrates the legacy model and protected key once into the first active LLM profile', async () => {
    const { repository, secrets } = createService()
    const legacySettings = { load: vi.fn().mockResolvedValue({ endpoint, model: 'legacy-model', contextLimit: 8_000 }) }
    const protectedKeys = new Map([['model.apiKey', 'legacy-secret']])
    secrets.load.mockImplementation(async (key: string) => protectedKeys.get(key) ?? null)
    secrets.save.mockImplementation(async (key: string, value: string) => { protectedKeys.set(key, value) })
    secrets.remove.mockImplementation(async (key: string) => { protectedKeys.delete(key) })
    const service = new ModelProfileService(repository, secrets, { legacySettings, createId: () => 'migrated-llm' })

    await expect(service.list('llm')).resolves.toEqual([expect.objectContaining({ id: 'migrated-llm', active: true, hasApiKey: true })])
    expect(secrets.save).toHaveBeenCalledWith('model-profile.migrated-llm.apiKey', 'legacy-secret')
    expect(secrets.remove).toHaveBeenCalledWith('model.apiKey')
    expect(repository.save).toHaveBeenCalledWith(expect.objectContaining({
      migrations: expect.objectContaining({ legacyModelSettings: 1 }),
    }))

    await service.list('llm')
    expect(legacySettings.load).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['a legacy PEM private key', '-----BEGIN PRIVATE KEY-----\nlegacy-material\n-----END PRIVATE KEY-----'],
    ['a legacy UTF-8 secret over the byte limit', '密'.repeat(2_049)],
  ])('does not activate or copy %s during legacy key migration', async (_label, legacyKey) => {
    const { repository, secrets, getDocument } = createService()
    const legacySettings = { load: vi.fn().mockResolvedValue({ endpoint, model: 'legacy-model', contextLimit: 8_000 }) }
    const protectedKeys = new Map([['model.apiKey', legacyKey]])
    secrets.load.mockImplementation(async (key: string) => protectedKeys.get(key) ?? null)
    secrets.save.mockImplementation(async (key: string, value: string) => { protectedKeys.set(key, value) })
    secrets.remove.mockImplementation(async (key: string) => { protectedKeys.delete(key) })
    const service = new ModelProfileService(repository, secrets, { legacySettings, createId: () => 'migrated-llm' })

    await expect(service.list('llm')).resolves.toEqual([expect.objectContaining({ id: 'migrated-llm', active: false, hasApiKey: false })])
    expect(protectedKeys.get('model-profile.migrated-llm.apiKey')).toBeUndefined()
    expect(protectedKeys.get('model.apiKey')).toBeUndefined()
    expect(secrets.save).not.toHaveBeenCalled()
    expect(getDocument().activeLlmId).toBeNull()
  })

  it('keeps the legacy key until the versioned migration document is saved and retries after a failed save', async () => {
    const { repository, secrets } = createService()
    const legacySettings = { load: vi.fn().mockResolvedValue({ endpoint, model: 'legacy-model', contextLimit: 8_000 }) }
    const protectedKeys = new Map([['model.apiKey', 'legacy-secret']])
    secrets.load.mockImplementation(async (key: string) => protectedKeys.get(key) ?? null)
    secrets.save.mockImplementation(async (key: string, value: string) => { protectedKeys.set(key, value) })
    secrets.remove.mockImplementation(async (key: string) => { protectedKeys.delete(key) })
    repository.save.mockRejectedValueOnce(new Error('disk unavailable'))
    const service = new ModelProfileService(repository, secrets, { legacySettings, createId: () => 'migrated-llm' })

    await expect(service.list('llm')).rejects.toThrow('disk unavailable')
    expect(protectedKeys.get('model.apiKey')).toBe('legacy-secret')
    expect(protectedKeys.get('model-profile.migrated-llm.apiKey')).toBeUndefined()

    await expect(service.list('llm')).resolves.toEqual([expect.objectContaining({ id: 'migrated-llm', active: true, hasApiKey: true })])
    expect(legacySettings.load).toHaveBeenCalledTimes(2)
    expect(protectedKeys.get('model.apiKey')).toBeUndefined()
  })

  it('keeps migration key writes after the document save and retries cleanly in a fresh service', async () => {
    const { repository, secrets, getDocument } = createService()
    const legacySettings = { load: vi.fn().mockResolvedValue({ endpoint, model: 'legacy-model', contextLimit: 8_000 }) }
    const protectedKeys = new Map([['model.apiKey', 'legacy-secret']])
    const createId = vi.fn()
      .mockReturnValueOnce('migration-attempt-one')
      .mockReturnValueOnce('migration-attempt-two')
    secrets.load.mockImplementation(async (key: string) => protectedKeys.get(key) ?? null)
    secrets.save.mockImplementation(async (key: string, value: string) => { protectedKeys.set(key, value) })
    secrets.remove.mockImplementation(async (key: string) => { protectedKeys.delete(key) })
    repository.save.mockRejectedValueOnce(new Error('disk unavailable'))
    const firstService = new ModelProfileService(repository, secrets, { legacySettings, createId })

    await expect(firstService.list('llm')).rejects.toThrow('disk unavailable')
    expect(secrets.save).not.toHaveBeenCalled()
    expect(protectedKeys.get('model.apiKey')).toBe('legacy-secret')

    const secondService = new ModelProfileService(repository, secrets, { legacySettings, createId })
    await expect(secondService.list('llm')).resolves.toEqual([
      expect.objectContaining({ id: 'migration-attempt-two', active: true, hasApiKey: true }),
    ])

    expect(createId).toHaveBeenCalledTimes(2)
    expect(getDocument().profiles).toEqual([expect.objectContaining({ id: 'migration-attempt-two' })])
    expect(getDocument().migrations).toMatchObject({ legacyModelSettings: 1, legacyModelProfileId: 'migration-attempt-two' })
    expect([...protectedKeys.keys()]).toEqual(['model-profile.migration-attempt-two.apiKey'])
  })

  it('retries deleting the legacy key when the migration marker already exists', async () => {
    const { repository, secrets } = createService()
    const legacySettings = { load: vi.fn().mockResolvedValue({ endpoint, model: 'legacy-model', contextLimit: 8_000 }) }
    const protectedKeys = new Map([['model.apiKey', 'legacy-secret']])
    secrets.load.mockImplementation(async (key: string) => protectedKeys.get(key) ?? null)
    secrets.save.mockImplementation(async (key: string, value: string) => { protectedKeys.set(key, value) })
    secrets.remove
      .mockImplementationOnce(async () => { throw new Error('keychain unavailable') })
      .mockImplementation(async (key: string) => { protectedKeys.delete(key) })
    const firstService = new ModelProfileService(repository, secrets, { legacySettings, createId: () => 'migrated-llm' })

    await expect(firstService.list('llm')).rejects.toThrow('keychain unavailable')
    expect(protectedKeys.get('model.apiKey')).toBe('legacy-secret')

    const secondService = new ModelProfileService(repository, secrets, { legacySettings, createId: () => 'unexpected-retry-id' })
    await expect(secondService.list('llm')).resolves.toMatchObject([
      expect.objectContaining({ id: 'migrated-llm', active: true, hasApiKey: true }),
    ])
    expect(secrets.remove).toHaveBeenCalledTimes(2)
    expect(protectedKeys.get('model.apiKey')).toBeUndefined()
    expect(legacySettings.load).toHaveBeenCalledTimes(1)
  })

  it('migrates the legacy key to the first persisted LLM when no active target exists', async () => {
    const firstProfile = { id: 'first-llm', kind: 'llm' as const, name: 'First', provider: 'openai' as const, model: 'gpt-5', endpoint, contextLimit: 8_000 }
    const secondProfile = { id: 'second-llm', kind: 'llm' as const, name: 'Second', provider: 'openai' as const, model: 'gpt-5-mini', endpoint, contextLimit: 8_000 }
    const harness = createService({
      version: 1,
      profiles: [firstProfile, secondProfile],
      activeLlmId: null, activeVlmId: null, routing: 'combined', migrations: {},
    })
    const legacySettings = { load: vi.fn().mockResolvedValue({ endpoint, model: 'legacy-model', contextLimit: 8_000 }) }
    const protectedKeys = new Map([['model.apiKey', 'legacy-secret']])
    harness.secrets.load.mockImplementation(async (key: string) => protectedKeys.get(key) ?? null)
    harness.secrets.save.mockImplementation(async (key: string, value: string) => { protectedKeys.set(key, value) })
    harness.secrets.remove.mockImplementation(async (key: string) => { protectedKeys.delete(key) })
    const migrationService = new ModelProfileService(harness.repository, harness.secrets, { legacySettings })

    await expect(migrationService.list('llm')).resolves.toEqual([
      expect.objectContaining({ id: 'first-llm', active: false, hasApiKey: true }),
      expect.objectContaining({ id: 'second-llm', active: false, hasApiKey: false }),
    ])
    expect(protectedKeys.get('model-profile.first-llm.apiKey')).toBe('legacy-secret')
    expect(protectedKeys.get('model.apiKey')).toBeUndefined()
    expect(harness.getDocument().activeLlmId).toBeNull()
  })

  it('does not auto-activate an OpenAI profile without a protected key, while keyless Ollama remains valid', async () => {
    const { service } = createService()

    const openai = await service.save({ kind: 'llm', name: 'OpenAI', provider: 'openai', model: 'gpt-5', endpoint, contextLimit: 12_000 })
    const ollama = await service.save({ kind: 'llm', name: 'Ollama', provider: 'ollama', model: 'qwen', endpoint: 'http://127.0.0.1:11434/api/chat', contextLimit: 8_000 })

    expect(openai.active).toBe(false)
    await expect(service.activate(openai.id)).rejects.toThrow('API key is required')
    expect(ollama.active).toBe(true)
  })

  it('allows one active profile per kind and keeps subsequent profiles inactive', async () => {
    const { service, repository } = createService()
    const first = await service.save({ kind: 'llm', name: 'one', provider: 'ollama', model: 'qwen', endpoint: 'http://127.0.0.1:11434/api/chat', contextLimit: 8_000 })
    repository.load.mockResolvedValue({
      version: 1,
      profiles: [{ id: first.id, kind: 'llm', name: 'one', provider: 'ollama', model: 'qwen', endpoint: 'http://127.0.0.1:11434/api/chat', contextLimit: 8_000 }],
      activeLlmId: first.id, activeVlmId: null, routing: 'combined', migrations: {},
    })
    const second = await service.save({ kind: 'llm', name: 'two', provider: 'llama-cpp', model: 'qwen2', endpoint: 'http://127.0.0.1:8080/v1/chat/completions', contextLimit: 8_000 })

    expect(second.active).toBe(false)
    expect(repository.save).toHaveBeenLastCalledWith(expect.objectContaining({ activeLlmId: first.id }))
  })

  it('does not activate a key-based provider until a current or existing key is available', async () => {
    const { service, repository, secrets } = createService()
    const profile = await service.save({ kind: 'llm', name: 'openai', provider: 'openai', model: 'gpt-5', endpoint, contextLimit: 8_000 })

    expect(profile.active).toBe(false)
    await expect(service.activate(profile.id)).rejects.toThrow('API key')
    expect(repository.save).toHaveBeenLastCalledWith(expect.objectContaining({ activeLlmId: null }))

    secrets.load.mockResolvedValue('existing-key')
    await expect(service.activate(profile.id)).resolves.toMatchObject({ id: profile.id, active: true })
  })

  it('allows a keyless Ollama profile to become the first active profile', async () => {
    const { service } = createService()
    await expect(service.save({ kind: 'llm', name: 'ollama', provider: 'ollama', model: 'qwen', endpoint: 'http://127.0.0.1:11434/api/chat', contextLimit: 8_000 }))
      .resolves.toMatchObject({ active: true, hasApiKey: false })
  })

  it('preserves an explicit no-route choice across later profile saves and API-key imports', async () => {
    const { service, secrets, getDocument } = createService({
      version: 1,
      profiles: [
        { id: 'primary-llm', kind: 'llm', name: 'Primary LLM', provider: 'ollama', model: 'qwen', endpoint: 'http://127.0.0.1:11434/api/chat', contextLimit: 8_000 },
        { id: 'later-llm', kind: 'llm', name: 'Later LLM', provider: 'openai', model: 'gpt-5', endpoint, contextLimit: 8_000 },
        { id: 'primary-vlm', kind: 'vlm', name: 'Primary VLM', provider: 'ollama', model: 'llava', endpoint: 'http://127.0.0.1:11434/api/chat', maxImages: 4 },
        { id: 'later-vlm', kind: 'vlm', name: 'Later VLM', provider: 'openai', model: 'gpt-vision', endpoint, maxImages: 4 },
      ],
      activeLlmId: 'primary-llm', activeVlmId: 'primary-vlm', routing: 'combined', migrations: {},
    })
    const protectedKeys = new Map<string, string>()
    secrets.load.mockImplementation(async (key: string) => protectedKeys.get(key) ?? null)
    secrets.save.mockImplementation(async (key: string, value: string) => { protectedKeys.set(key, value) })

    await service.delete('primary-llm', { allowNoActive: true })
    await service.delete('primary-vlm', { allowNoActive: true })
    expect(getDocument()).toMatchObject({
      activeLlmId: null,
      activeVlmId: null,
      autoActivateLlm: false,
      autoActivateVlm: false,
    })

    await expect(service.saveApiKey('later-llm', 'later-llm-key')).resolves.toMatchObject({ active: false })
    await expect(service.saveApiKey('later-vlm', 'later-vlm-key')).resolves.toMatchObject({ active: false })
    await expect(service.save({
      kind: 'llm', name: 'Replacement LLM', provider: 'ollama', model: 'qwen3',
      endpoint: 'http://127.0.0.1:11434/api/chat', contextLimit: 8_000,
    })).resolves.toMatchObject({ active: false })
    expect(getDocument()).toMatchObject({ activeLlmId: null, activeVlmId: null })
  })

  it('requires a replacement before deleting an active profile when alternatives exist', async () => {
    const { service, repository } = createService()
    repository.load.mockResolvedValue({
      version: 1,
      profiles: [
        { id: 'one', kind: 'llm', name: 'one', provider: 'ollama', model: 'qwen', endpoint: 'http://127.0.0.1:11434/api/chat', contextLimit: 8_000 },
        { id: 'two', kind: 'llm', name: 'two', provider: 'ollama', model: 'qwen2', endpoint: 'http://127.0.0.1:11434/api/chat', contextLimit: 8_000 },
      ],
      activeLlmId: 'one', activeVlmId: null, routing: 'combined', migrations: {},
    })

    await expect(service.delete('one')).rejects.toThrow('replacement')
    await service.delete('one', { replacementId: 'two' })
    expect(repository.save).toHaveBeenCalledWith(expect.objectContaining({ activeLlmId: 'two' }))
  })

  it('requires explicit no-route authorization before deleting an active profile without a replacement', async () => {
    const { service, getDocument } = createService({
      version: 1,
      profiles: [{ id: 'active', kind: 'llm', name: 'active', provider: 'ollama', model: 'qwen', endpoint: 'http://127.0.0.1:11434/api/chat', contextLimit: 8_000 }],
      activeLlmId: 'active', activeVlmId: null, routing: 'combined', migrations: {},
    })

    await expect(service.delete('active', { replacementId: null })).rejects.toThrow('explicit')
    expect(getDocument()).toMatchObject({ activeLlmId: 'active' })

    await expect(service.delete('active', { replacementId: null, allowNoActive: true })).resolves.toBeUndefined()
    expect(getDocument()).toMatchObject({ activeLlmId: null, autoActivateLlm: false })
  })

  it('rejects deleting an LLM profile while a VLM still references its API key', async () => {
    const { service, repository, secrets, getDocument } = createService({
      version: 1,
      profiles: [
        { id: 'llm', kind: 'llm', name: 'llm', provider: 'openai', model: 'gpt-5', endpoint, contextLimit: 8_000 },
        { id: 'vlm', kind: 'vlm', name: 'vlm', provider: 'openai', model: 'gpt-vision', endpoint, maxImages: 4, apiKeyProfileId: 'llm' },
      ],
      activeLlmId: 'llm', activeVlmId: 'vlm', routing: 'combined', migrations: {},
    })

    await expect(service.delete('llm', { allowNoActive: true })).rejects.toThrow('referenced')

    expect(secrets.remove).not.toHaveBeenCalled()
    expect(repository.save).not.toHaveBeenCalled()
    expect(getDocument().activeVlmId).toBe('vlm')
    expect(getDocument().profiles.find(profile => profile.id === 'vlm')).toMatchObject({ apiKeyProfileId: 'llm' })
  })

  it('rejects an active replacement profile that is unavailable without an API key', async () => {
    const { service, repository, secrets } = createService({
      version: 1,
      profiles: [
        { id: 'active', kind: 'llm', name: 'active', provider: 'ollama', model: 'qwen', endpoint: 'http://127.0.0.1:11434/api/chat', contextLimit: 8_000 },
        { id: 'unavailable', kind: 'llm', name: 'unavailable', provider: 'openai', model: 'gpt-5', endpoint, contextLimit: 8_000 },
      ],
      activeLlmId: 'active', activeVlmId: null, routing: 'combined', migrations: {},
    })

    await expect(service.delete('active', { replacementId: 'unavailable' })).rejects.toThrow('available')

    expect(secrets.remove).not.toHaveBeenCalled()
    expect(repository.save).not.toHaveBeenCalled()
  })

  it('keeps the active profile and protected key when deleting profile persistence fails', async () => {
    const { service, repository, secrets, getDocument } = createService({
      version: 1,
      profiles: [{ id: 'active', kind: 'llm', name: 'active', provider: 'ollama', model: 'qwen', endpoint: 'http://127.0.0.1:11434/api/chat', contextLimit: 8_000 }],
      activeLlmId: 'active', activeVlmId: null, routing: 'combined', migrations: {},
    })
    const protectedKeys = new Map([['model-profile.active.apiKey', 'active-secret']])
    secrets.remove.mockImplementation(async (key: string) => { protectedKeys.delete(key) })
    repository.save.mockRejectedValueOnce(new Error('disk unavailable'))

    await expect(service.delete('active', { allowNoActive: true })).rejects.toThrow('disk unavailable')

    expect(protectedKeys.get('model-profile.active.apiKey')).toBe('active-secret')
    expect(secrets.remove).not.toHaveBeenCalled()
    expect(getDocument().activeLlmId).toBe('active')
    expect(getDocument().profiles).toEqual([expect.objectContaining({ id: 'active' })])
  })

  it('restores the profile document when protected-key cleanup fails', async () => {
    const { service, repository, secrets, getDocument } = createService({
      version: 1,
      profiles: [{ id: 'active', kind: 'llm', name: 'active', provider: 'ollama', model: 'qwen', endpoint: 'http://127.0.0.1:11434/api/chat', contextLimit: 8_000 }],
      activeLlmId: 'active', activeVlmId: null, routing: 'combined', migrations: {},
    })
    secrets.remove.mockRejectedValueOnce(new Error('secret store unavailable'))

    await expect(service.delete('active', { allowNoActive: true })).rejects.toThrow('secret store unavailable')

    expect(getDocument().activeLlmId).toBe('active')
    expect(getDocument().profiles).toEqual([expect.objectContaining({ id: 'active' })])
    expect(repository.save).toHaveBeenCalledTimes(2)
  })

  it('clears a VLM API key reference when importing a direct protected key', async () => {
    const { service, secrets, getDocument } = createService({
      version: 1,
      profiles: [
        { id: 'llm', kind: 'llm', name: 'llm', provider: 'openai', model: 'gpt-5', endpoint, contextLimit: 8_000 },
        { id: 'vlm', kind: 'vlm', name: 'vlm', provider: 'openai', model: 'gpt-vision', endpoint, maxImages: 4, apiKeyProfileId: 'llm' },
      ],
      activeLlmId: null, activeVlmId: null, routing: 'combined', migrations: {},
    })
    const protectedKeys = new Map<string, string>()
    secrets.load.mockImplementation(async (key: string) => protectedKeys.get(key) ?? null)
    secrets.save.mockImplementation(async (key: string, value: string) => { protectedKeys.set(key, value) })

    const saved = await service.saveApiKey('vlm', 'vlm-direct-key')
    expect(saved).toMatchObject({
      id: 'vlm', active: true, hasApiKey: true,
    })
    expect(JSON.stringify(saved)).not.toContain('vlm-direct-key')
    const savedProfile = getDocument().profiles.find(profile => profile.id === 'vlm')

    expect(savedProfile).not.toHaveProperty('apiKeyProfileId')
    await expect(service.get('vlm')).resolves.toMatchObject({ id: 'vlm', active: true, hasApiKey: true })
  })

  it.each([
    ['URL user information', 'https://user:pass@example.com/v1/chat/completions'],
    ['sensitive API key query parameter', `${endpoint}?api_key=embedded-secret`],
    ['sensitive token query value', `${endpoint}?trace=token`],
    ['sensitive path segment', 'https://example.com/v1/api_key/chat/completions'],
    ['URL fragment', `${endpoint}#token`],
  ])('rejects %s in a model endpoint', async (_label, unsafeEndpoint) => {
    const { service } = createService()

    await expect(service.save({ kind: 'llm', name: 'unsafe', provider: 'openai', model: 'gpt-5', endpoint: unsafeEndpoint, contextLimit: 8_000 }))
      .rejects.toThrow()
  })

  it('routes combined requests to VLM only when images are present and vision-only requests to VLM always', async () => {
    const { service, repository } = createService()
    repository.load.mockResolvedValue({
      version: 1,
      profiles: [
        { id: 'llm', kind: 'llm', name: 'llm', provider: 'ollama', model: 'qwen', endpoint: 'http://127.0.0.1:11434/api/chat', contextLimit: 8_000 },
        { id: 'vlm', kind: 'vlm', name: 'vlm', provider: 'ollama', model: 'llava', endpoint: 'http://127.0.0.1:11434/api/chat', maxImages: 4 },
      ],
      activeLlmId: 'llm', activeVlmId: 'vlm', routing: 'combined', migrations: {},
    })

    await expect(service.resolveRoute({ hasImages: false })).resolves.toMatchObject({ id: 'llm' })
    await expect(service.resolveRoute({ hasImages: true })).resolves.toMatchObject({ id: 'vlm' })
    await service.setRouting('vision-only')
    repository.load.mockResolvedValue({
      version: 1,
      profiles: [
        { id: 'llm', kind: 'llm', name: 'llm', provider: 'ollama', model: 'qwen', endpoint: 'http://127.0.0.1:11434/api/chat', contextLimit: 8_000 },
        { id: 'vlm', kind: 'vlm', name: 'vlm', provider: 'ollama', model: 'llava', endpoint: 'http://127.0.0.1:11434/api/chat', maxImages: 4 },
      ],
      activeLlmId: 'llm', activeVlmId: 'vlm', routing: 'vision-only', migrations: {},
    })
    await expect(service.resolveRoute({ hasImages: false })).resolves.toMatchObject({ id: 'vlm' })
  })
})
