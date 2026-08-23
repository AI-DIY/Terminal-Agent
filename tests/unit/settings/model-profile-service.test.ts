import { describe, expect, it, vi } from 'vitest'
import { ModelProfileService } from '../../../src/main/settings/model-profile-service'
import type { ModelProfileDocument } from '../../../src/main/settings/model-profile-repository'

const endpoint = 'https://api.openai.com/v1/chat/completions'

function createService(initialDocument: ModelProfileDocument = { version: 2, profiles: [], activeLlmId: null, activeVlmId: null, routing: 'combined', migrations: {} }) {
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

function referencedVlmDocument(): ModelProfileDocument {
  return {
    version: 2,
    profiles: [
      { id: 'shared-llm', kind: 'llm', name: 'Shared LLM', provider: 'openai', model: 'gpt-5', endpoint, contextLimit: 8_000 },
      { id: 'vision', kind: 'vlm', name: 'Vision', provider: 'openai', model: 'gpt-vision', endpoint, maxImages: 4 },
    ],
    activeLlmId: 'shared-llm',
    activeVlmId: 'vision',
    routing: 'combined',
    migrations: {
      apiKeyReferences: [{ sourceProfileId: 'shared-llm', targetProfileId: 'vision' }],
    },
  }
}

describe('ModelProfileService', () => {
  it('does not brick profile operations or move an orphaned legacy key when legacy settings are absent', async () => {
    const initialDocument: ModelProfileDocument = {
      version: 2,
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
      version: 2,
      profiles: [{ id: 'existing', kind: 'llm', name: 'existing', provider: 'openai', model: 'gpt-5', endpoint, contextLimit: 8_000 }],
      activeLlmId: null, activeVlmId: null, routing: 'combined', migrations: { legacyModelSettings: 1 },
    })

    await expect(service.save({ id: 'existing', kind: 'llm', name: 'existing', provider: 'openai', model: 'gpt-5', endpoint, contextLimit: 8_000, apiKey: value })).rejects.toThrow()
    expect(secrets.save).not.toHaveBeenCalled()
  })

  it('copies a pending shared key into VLM-owned storage without removing the LLM key', async () => {
    const { service, secrets, getDocument } = createService(referencedVlmDocument())
    const protectedKeys = new Map([['model-profile.shared-llm.apiKey', 'shared-secret']])
    secrets.load.mockImplementation(async (key: string) => protectedKeys.get(key) ?? null)
    secrets.save.mockImplementation(async (key: string, value: string) => { protectedKeys.set(key, value) })

    await expect(service.list('vlm')).resolves.toEqual([
      expect.objectContaining({ id: 'vision', active: true, hasApiKey: true }),
    ])

    expect(secrets.save).toHaveBeenCalledWith('model-profile.vision.apiKey', 'shared-secret')
    expect(protectedKeys.get('model-profile.shared-llm.apiKey')).toBe('shared-secret')
    expect(protectedKeys.get('model-profile.vision.apiKey')).toBe('shared-secret')
    expect(getDocument().migrations).not.toHaveProperty('apiKeyReferences')
  })

  it('does not overwrite a VLM key that already exists while clearing pending metadata', async () => {
    const { service, secrets, getDocument } = createService(referencedVlmDocument())
    const protectedKeys = new Map([
      ['model-profile.shared-llm.apiKey', 'shared-secret'],
      ['model-profile.vision.apiKey', 'vision-secret'],
    ])
    secrets.load.mockImplementation(async (key: string) => protectedKeys.get(key) ?? null)

    await expect(service.list('vlm')).resolves.toEqual([
      expect.objectContaining({ id: 'vision', active: true, hasApiKey: true }),
    ])

    expect(secrets.save).not.toHaveBeenCalled()
    expect(protectedKeys.get('model-profile.vision.apiKey')).toBe('vision-secret')
    expect(getDocument().migrations).not.toHaveProperty('apiKeyReferences')
  })

  it('deactivates an active non-Ollama VLM when its pending source key is missing', async () => {
    const { service, secrets, getDocument } = createService(referencedVlmDocument())

    await expect(service.list('vlm')).resolves.toEqual([
      expect.objectContaining({ id: 'vision', active: false, hasApiKey: false }),
    ])

    expect(secrets.save).not.toHaveBeenCalled()
    expect(getDocument()).toMatchObject({ activeVlmId: null, autoActivateVlm: false })
    expect(getDocument().migrations).not.toHaveProperty('apiKeyReferences')
  })

  it('rejects invalid pending source material without removing it and deactivates the VLM', async () => {
    const { service, secrets, getDocument } = createService(referencedVlmDocument())
    const privateKey = '-----BEGIN PRIVATE KEY-----\nmaterial\n-----END PRIVATE KEY-----'
    const protectedKeys = new Map([['model-profile.shared-llm.apiKey', privateKey]])
    secrets.load.mockImplementation(async (key: string) => protectedKeys.get(key) ?? null)

    await expect(service.list('vlm')).resolves.toEqual([
      expect.objectContaining({ id: 'vision', active: false, hasApiKey: false }),
    ])

    expect(secrets.save).not.toHaveBeenCalled()
    expect(secrets.remove).not.toHaveBeenCalled()
    expect(protectedKeys.get('model-profile.shared-llm.apiKey')).toBe(privateKey)
    expect(getDocument()).toMatchObject({ activeVlmId: null, autoActivateVlm: false })
    expect(getDocument().migrations).not.toHaveProperty('apiKeyReferences')
  })

  it('keeps a copied target key when metadata persistence fails and retries without rewriting it', async () => {
    const { service, repository, secrets, getDocument } = createService(referencedVlmDocument())
    const protectedKeys = new Map([['model-profile.shared-llm.apiKey', 'shared-secret']])
    secrets.load.mockImplementation(async (key: string) => protectedKeys.get(key) ?? null)
    secrets.save.mockImplementation(async (key: string, value: string) => { protectedKeys.set(key, value) })
    repository.save.mockRejectedValueOnce(new Error('disk unavailable'))

    await expect(service.list('vlm')).rejects.toThrow('disk unavailable')
    expect(protectedKeys.get('model-profile.vision.apiKey')).toBe('shared-secret')
    expect(getDocument().migrations.apiKeyReferences).toHaveLength(1)

    const retryingService = new ModelProfileService(repository, secrets)
    await expect(retryingService.list('vlm')).resolves.toEqual([
      expect.objectContaining({ id: 'vision', active: true, hasApiKey: true }),
    ])
    expect(secrets.save).toHaveBeenCalledTimes(1)
    expect(getDocument().migrations).not.toHaveProperty('apiKeyReferences')
  })

  it('retains pending metadata and retries when copying the target key fails', async () => {
    const { service, secrets, getDocument } = createService(referencedVlmDocument())
    const protectedKeys = new Map([['model-profile.shared-llm.apiKey', 'shared-secret']])
    secrets.load.mockImplementation(async (key: string) => protectedKeys.get(key) ?? null)
    secrets.save
      .mockRejectedValueOnce(new Error('secret store unavailable'))
      .mockImplementation(async (key: string, value: string) => { protectedKeys.set(key, value) })

    await expect(service.list('vlm')).rejects.toThrow('secret store unavailable')
    expect(getDocument().migrations.apiKeyReferences).toHaveLength(1)

    await expect(service.list('vlm')).resolves.toEqual([
      expect.objectContaining({ id: 'vision', active: true, hasApiKey: true }),
    ])
    expect(secrets.save).toHaveBeenCalledTimes(2)
    expect(getDocument().migrations).not.toHaveProperty('apiKeyReferences')
  })

  it('processes valid pending references but retains malformed entries with a diagnostic error', async () => {
    const document = referencedVlmDocument()
    const malformedReference = { sourceProfileId: 'shared-llm', targetProfileId: 'shared-llm' }
    document.migrations.apiKeyReferences = [
      ...document.migrations.apiKeyReferences ?? [],
      malformedReference,
    ]
    const { service, repository, secrets, getDocument } = createService(document)
    const protectedKeys = new Map([['model-profile.shared-llm.apiKey', 'shared-secret']])
    secrets.load.mockImplementation(async (key: string) => protectedKeys.get(key) ?? null)
    secrets.save.mockImplementation(async (key: string, value: string) => { protectedKeys.set(key, value) })

    await expect(service.list()).rejects.toThrow('targetProfileId must reference a VLM profile')

    expect(protectedKeys.get('model-profile.vision.apiKey')).toBe('shared-secret')
    expect(getDocument().migrations.apiKeyReferences).toEqual([malformedReference])
    expect(repository.save).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['a missing source', []],
    ['a VLM source', [{ id: 'source-vlm', kind: 'vlm' as const, name: 'Source', provider: 'openai' as const, model: 'source-vision', endpoint, maxImages: 4 }]],
  ])('retains pending metadata with %s and reports a diagnostic error', async (_label, sourceProfiles) => {
    const reference = { sourceProfileId: 'source-vlm', targetProfileId: 'vision' }
    const { service, repository, secrets, getDocument } = createService({
      version: 2,
      profiles: [
        ...sourceProfiles,
        { id: 'vision', kind: 'vlm', name: 'Vision', provider: 'openai', model: 'gpt-vision', endpoint, maxImages: 4 },
      ],
      activeLlmId: null, activeVlmId: 'vision', routing: 'combined',
      migrations: { apiKeyReferences: [reference] },
    })

    await expect(service.list()).rejects.toThrow('sourceProfileId must reference an LLM profile')

    expect(getDocument().migrations.apiKeyReferences).toEqual([reference])
    expect(getDocument().activeVlmId).toBe('vision')
    expect(secrets.save).not.toHaveBeenCalled()
    expect(repository.save).toHaveBeenCalledTimes(1)
  })

  it('completes duplicate valid pending references without rewriting the target key', async () => {
    const document = referencedVlmDocument()
    const reference = { sourceProfileId: 'shared-llm', targetProfileId: 'vision' }
    document.migrations.apiKeyReferences = [reference, reference]
    const { service, secrets, getDocument } = createService(document)
    const protectedKeys = new Map([['model-profile.shared-llm.apiKey', 'shared-secret']])
    secrets.load.mockImplementation(async (key: string) => protectedKeys.get(key) ?? null)
    secrets.save.mockImplementation(async (key: string, value: string) => { protectedKeys.set(key, value) })

    await expect(service.list('vlm')).resolves.toEqual([
      expect.objectContaining({ id: 'vision', active: true, hasApiKey: true }),
    ])

    expect(secrets.save).toHaveBeenCalledTimes(1)
    expect(getDocument().migrations).not.toHaveProperty('apiKeyReferences')
  })

  it('keeps a VLM active when a later valid reference supplies its key', async () => {
    const document = referencedVlmDocument()
    document.profiles.splice(1, 0, {
      id: 'empty-llm', kind: 'llm', name: 'Empty LLM', provider: 'openai', model: 'gpt-5-mini', endpoint, contextLimit: 8_000,
    })
    document.migrations.apiKeyReferences = [
      { sourceProfileId: 'empty-llm', targetProfileId: 'vision' },
      { sourceProfileId: 'shared-llm', targetProfileId: 'vision' },
    ]
    const { service, secrets, getDocument } = createService(document)
    const protectedKeys = new Map([['model-profile.shared-llm.apiKey', 'shared-secret']])
    secrets.load.mockImplementation(async (key: string) => protectedKeys.get(key) ?? null)
    secrets.save.mockImplementation(async (key: string, value: string) => { protectedKeys.set(key, value) })

    await expect(service.list('vlm')).resolves.toEqual([
      expect.objectContaining({ id: 'vision', active: true, hasApiKey: true }),
    ])

    expect(secrets.save).toHaveBeenCalledTimes(1)
    expect(getDocument()).toMatchObject({ activeVlmId: 'vision' })
    expect(getDocument().migrations).not.toHaveProperty('apiKeyReferences')
  })

  it('clears an active OpenAI profile key and disables automatic activation', async () => {
    const { service, secrets, getDocument } = createService({
      version: 2,
      profiles: [{ id: 'active', kind: 'llm', name: 'Active', provider: 'openai', model: 'gpt-5', endpoint, contextLimit: 8_000 }],
      activeLlmId: 'active', activeVlmId: null, routing: 'combined', migrations: {},
    })
    const protectedKeys = new Map([['model-profile.active.apiKey', 'active-secret']])
    secrets.load.mockImplementation(async (key: string) => protectedKeys.get(key) ?? null)
    secrets.remove.mockImplementation(async (key: string) => { protectedKeys.delete(key) })

    await expect(service.clearApiKey('active')).resolves.toMatchObject({
      id: 'active', active: false, hasApiKey: false,
    })

    expect(protectedKeys.has('model-profile.active.apiKey')).toBe(false)
    expect(getDocument()).toMatchObject({ activeLlmId: null, autoActivateLlm: false })
    expect(secrets.load).not.toHaveBeenCalled()
  })

  it('restores active state when clearing a key fails in protected storage', async () => {
    const { service, repository, secrets, getDocument } = createService({
      version: 2,
      profiles: [{ id: 'active', kind: 'llm', name: 'Active', provider: 'openai', model: 'gpt-5', endpoint, contextLimit: 8_000 }],
      activeLlmId: 'active', activeVlmId: null, routing: 'combined', migrations: {},
    })
    const removeError = new Error('secret store unavailable')
    secrets.remove.mockRejectedValueOnce(removeError)

    await expect(service.clearApiKey('active')).rejects.toBe(removeError)

    expect(getDocument()).toMatchObject({ activeLlmId: 'active' })
    expect(repository.save).toHaveBeenCalledTimes(2)
  })

  it('reports both key removal and document restoration failures when clearing an active key', async () => {
    const { service, repository, secrets, getDocument } = createService({
      version: 2,
      profiles: [{ id: 'active', kind: 'llm', name: 'Active', provider: 'openai', model: 'gpt-5', endpoint, contextLimit: 8_000 }],
      activeLlmId: 'active', activeVlmId: null, routing: 'combined', migrations: {},
    })
    const removeError = new Error('secret store unavailable')
    const restoreError = new Error('document restore unavailable')
    const defaultSave = repository.save.getMockImplementation() as (next: ModelProfileDocument) => Promise<void>
    repository.save
      .mockImplementationOnce(defaultSave)
      .mockRejectedValueOnce(restoreError)
    secrets.remove.mockRejectedValueOnce(removeError)

    let caught: unknown
    try {
      await service.clearApiKey('active')
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(AggregateError)
    expect((caught as AggregateError).errors).toEqual([removeError, restoreError])
    expect((caught as Error).message).toContain('state may be inconsistent')
    expect(getDocument()).toMatchObject({ activeLlmId: null, autoActivateLlm: false })
    expect(repository.save).toHaveBeenCalledTimes(2)
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
    const persistenceError = new Error('disk unavailable')
    repository.save.mockRejectedValueOnce(persistenceError)

    await expect(service.save({
      kind: 'llm', name: 'new', provider: 'openai', model: 'gpt-5', endpoint, contextLimit: 8_000, apiKey: 'new-secret',
    })).rejects.toBe(persistenceError)

    expect([...protectedKeys.keys()]).toEqual([])
    expect(getDocument().profiles).toEqual([])
  })

  it('reports both profile persistence and new-key cleanup failures', async () => {
    const { service, repository, secrets } = createService()
    const persistenceError = new Error('disk unavailable')
    const rollbackError = new Error('secret cleanup unavailable')
    repository.save.mockRejectedValueOnce(persistenceError)
    secrets.remove.mockRejectedValueOnce(rollbackError)

    let caught: unknown
    try {
      await service.save({
        kind: 'llm', name: 'new', provider: 'openai', model: 'gpt-5', endpoint, contextLimit: 8_000, apiKey: 'new-secret',
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(AggregateError)
    expect((caught as AggregateError).errors).toEqual([persistenceError, rollbackError])
    expect((caught as Error).message).toContain('state may be inconsistent')
  })

  it('restores an existing direct key when saving its profile update fails', async () => {
    const { service, repository, secrets, getDocument } = createService({
      version: 2,
      profiles: [{ id: 'existing', kind: 'llm', name: 'existing', provider: 'openai', model: 'gpt-5', endpoint, contextLimit: 8_000 }],
      activeLlmId: null, activeVlmId: null, routing: 'combined', migrations: {},
    })
    const protectedKeys = new Map([['model-profile.existing.apiKey', 'old-secret']])
    secrets.load.mockImplementation(async (key: string) => protectedKeys.get(key) ?? null)
    secrets.save.mockImplementation(async (key: string, value: string) => { protectedKeys.set(key, value) })
    secrets.remove.mockImplementation(async (key: string) => { protectedKeys.delete(key) })
    const persistenceError = new Error('disk unavailable')
    repository.save.mockRejectedValueOnce(persistenceError)

    await expect(service.save({ id: 'existing', kind: 'llm', name: 'existing', provider: 'openai', model: 'gpt-5', endpoint, contextLimit: 8_000, apiKey: 'new-secret' })).rejects.toBe(persistenceError)

    expect(protectedKeys.get('model-profile.existing.apiKey')).toBe('old-secret')
    expect(getDocument().activeLlmId).toBeNull()
  })

  it('reports both activation persistence and previous-key restoration failures', async () => {
    const { service, repository, secrets } = createService({
      version: 2,
      profiles: [{ id: 'existing', kind: 'llm', name: 'existing', provider: 'openai', model: 'gpt-5', endpoint, contextLimit: 8_000 }],
      activeLlmId: null, activeVlmId: null, routing: 'combined', migrations: {},
    })
    const persistenceError = new Error('disk unavailable')
    const rollbackError = new Error('secret restore unavailable')
    secrets.load.mockResolvedValue('old-secret')
    secrets.save
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(rollbackError)
    repository.save.mockRejectedValueOnce(persistenceError)

    let caught: unknown
    try {
      await service.save({ id: 'existing', kind: 'llm', name: 'existing', provider: 'openai', model: 'gpt-5', endpoint, contextLimit: 8_000, apiKey: 'new-secret' })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(AggregateError)
    expect((caught as AggregateError).errors).toEqual([persistenceError, rollbackError])
    expect((caught as Error).message).toContain('state may be inconsistent')
  })

  it('serializes routed reads behind an in-flight profile save', async () => {
    const harness = createService({
      version: 2,
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
      version: 2,
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
      version: 2,
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
      version: 2,
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

  it('preserves an explicit no-route choice across later profile saves and direct API-key saves', async () => {
    const { service, secrets, getDocument } = createService({
      version: 2,
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

    await expect(service.save({ id: 'later-llm', kind: 'llm', name: 'Later LLM', provider: 'openai', model: 'gpt-5', endpoint, contextLimit: 8_000, apiKey: 'later-llm-key' })).resolves.toMatchObject({ active: false })
    await expect(service.save({ id: 'later-vlm', kind: 'vlm', name: 'Later VLM', provider: 'openai', model: 'gpt-vision', endpoint, maxImages: 4, apiKey: 'later-vlm-key' })).resolves.toMatchObject({ active: false })
    await expect(service.save({
      kind: 'llm', name: 'Replacement LLM', provider: 'ollama', model: 'qwen3',
      endpoint: 'http://127.0.0.1:11434/api/chat', contextLimit: 8_000,
    })).resolves.toMatchObject({ active: false })
    expect(getDocument()).toMatchObject({ activeLlmId: null, activeVlmId: null })
  })

  it('requires a replacement before deleting an active profile when alternatives exist', async () => {
    const { service, repository } = createService()
    repository.load.mockResolvedValue({
      version: 2,
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
      version: 2,
      profiles: [{ id: 'active', kind: 'llm', name: 'active', provider: 'ollama', model: 'qwen', endpoint: 'http://127.0.0.1:11434/api/chat', contextLimit: 8_000 }],
      activeLlmId: 'active', activeVlmId: null, routing: 'combined', migrations: {},
    })

    await expect(service.delete('active', { replacementId: null })).rejects.toThrow('explicit')
    expect(getDocument()).toMatchObject({ activeLlmId: 'active' })

    await expect(service.delete('active', { replacementId: null, allowNoActive: true })).resolves.toBeUndefined()
    expect(getDocument()).toMatchObject({ activeLlmId: null, autoActivateLlm: false })
  })

  it('rejects an active replacement profile that is unavailable without an API key', async () => {
    const { service, repository, secrets } = createService({
      version: 2,
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
      version: 2,
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
      version: 2,
      profiles: [{ id: 'active', kind: 'llm', name: 'active', provider: 'ollama', model: 'qwen', endpoint: 'http://127.0.0.1:11434/api/chat', contextLimit: 8_000 }],
      activeLlmId: 'active', activeVlmId: null, routing: 'combined', migrations: {},
    })
    const removeError = new Error('secret store unavailable')
    secrets.remove.mockRejectedValueOnce(removeError)

    await expect(service.delete('active', { allowNoActive: true })).rejects.toBe(removeError)

    expect(getDocument().activeLlmId).toBe('active')
    expect(getDocument().profiles).toEqual([expect.objectContaining({ id: 'active' })])
    expect(repository.save).toHaveBeenCalledTimes(2)
  })

  it('reports both protected-key cleanup and profile restoration failures when deleting', async () => {
    const { service, repository, secrets, getDocument } = createService({
      version: 2,
      profiles: [{ id: 'active', kind: 'llm', name: 'active', provider: 'ollama', model: 'qwen', endpoint: 'http://127.0.0.1:11434/api/chat', contextLimit: 8_000 }],
      activeLlmId: 'active', activeVlmId: null, routing: 'combined', migrations: {},
    })
    const removeError = new Error('secret store unavailable')
    const restoreError = new Error('document restore unavailable')
    const defaultSave = repository.save.getMockImplementation() as (next: ModelProfileDocument) => Promise<void>
    repository.save
      .mockImplementationOnce(defaultSave)
      .mockRejectedValueOnce(restoreError)
    secrets.remove.mockRejectedValueOnce(removeError)

    let caught: unknown
    try {
      await service.delete('active', { allowNoActive: true })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(AggregateError)
    expect((caught as AggregateError).errors).toEqual([removeError, restoreError])
    expect((caught as Error).message).toContain('state may be inconsistent')
    expect(getDocument()).toMatchObject({ activeLlmId: null, autoActivateLlm: false, profiles: [] })
    expect(repository.save).toHaveBeenCalledTimes(2)
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
      version: 2,
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
      version: 2,
      profiles: [
        { id: 'llm', kind: 'llm', name: 'llm', provider: 'ollama', model: 'qwen', endpoint: 'http://127.0.0.1:11434/api/chat', contextLimit: 8_000 },
        { id: 'vlm', kind: 'vlm', name: 'vlm', provider: 'ollama', model: 'llava', endpoint: 'http://127.0.0.1:11434/api/chat', maxImages: 4 },
      ],
      activeLlmId: 'llm', activeVlmId: 'vlm', routing: 'vision-only', migrations: {},
    })
    await expect(service.resolveRoute({ hasImages: false })).resolves.toMatchObject({ id: 'vlm' })
  })
})
