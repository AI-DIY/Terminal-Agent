import { describe, expect, it, vi } from 'vitest'
import { createModelProfilesStore, createProfileDraft, profileDraftInput } from '../../../src/renderer/src/stores/model-profiles'
import { createAsyncTestResultGuard } from '../../../src/renderer/src/components/settings/model-connection-test'
import type { RendererModelProfile } from '../../../src/shared/contracts'

const profile = (overrides: Partial<RendererModelProfile> = {}): RendererModelProfile => ({
  id: 'llm-1', name: 'Primary', kind: 'llm', provider: 'ollama', model: 'qwen', endpoint: 'http://127.0.0.1:11434/api/chat', contextLimit: 8_000, hasApiKey: false, active: true, ...overrides,
})

function createApi() {
  return {
    list: vi.fn().mockResolvedValue([profile()]),
    save: vi.fn().mockResolvedValue(profile()),
    test: vi.fn().mockResolvedValue({ model: 'qwen' }),
    activate: vi.fn().mockResolvedValue(profile()),
    delete: vi.fn().mockResolvedValue(undefined),
    getRouting: vi.fn().mockResolvedValue('combined' as const),
    setRouting: vi.fn().mockResolvedValue('combined' as const),
    clearApiKey: vi.fn().mockResolvedValue(profile({ hasApiKey: false, active: false })),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}

describe('model profile store', () => {
  it('rejects an older connection result after a newer test starts or the draft changes', () => {
    const guard = createAsyncTestResultGuard()
    const first = guard.begin(JSON.stringify({ model: 'old' }))
    const second = guard.begin(JSON.stringify({ model: 'new' }))

    expect(guard.isCurrent(first, JSON.stringify({ model: 'old' }))).toBe(false)
    expect(guard.isCurrent(second, JSON.stringify({ model: 'changed' }))).toBe(false)
    expect(guard.isCurrent(second, JSON.stringify({ model: 'new' }))).toBe(true)
    expect(guard.isLatest(first)).toBe(false)
    expect(guard.isLatest(second)).toBe(true)
  })

  it('loads profiles and routing without exposing an API key field', async () => {
    const api = createApi()
    const store = createModelProfilesStore(api)
    await store.load('llm')
    expect(store.state.profiles).toEqual([profile()])
    expect(JSON.stringify(store.state.profiles)).not.toContain('apiKey')
    expect(api.list).toHaveBeenCalledWith('llm')
  })

  it('ignores an older response after a newer load wins', async () => {
    const api = createApi()
    let releaseFirst!: (value: RendererModelProfile[]) => void
    api.list.mockImplementationOnce(() => new Promise(resolve => { releaseFirst = resolve }))
      .mockResolvedValueOnce([profile({ id: 'llm-2', name: 'Newer' })])
    const store = createModelProfilesStore(api)
    const first = store.load('llm')
    await store.load('llm')
    releaseFirst([profile({ id: 'llm-old', name: 'Old' })])
    await first
    expect(store.state.profiles[0]?.id).toBe('llm-2')
  })

  it('clears a protected key by profile id and reloads its kind', async () => {
    const api = createApi()
    const store = createModelProfilesStore(api)
    await store.load('llm')
    await expect(store.clearApiKey('llm-1')).resolves.toMatchObject({ id: 'llm-1', hasApiKey: false })
    expect(api.clearApiKey).toHaveBeenCalledWith('llm-1')
    expect(api.list).toHaveBeenLastCalledWith('llm')
  })

  it('relays an explicitly supplied temporary key without retaining it in reactive state', async () => {
    const api = createApi()
    const store = createModelProfilesStore(api)
    const input = { name: 'Primary', kind: 'llm' as const, provider: 'ollama' as const, model: 'qwen', endpoint: 'http://127.0.0.1:11434/api/chat', contextLimit: 8_000 }

    await expect(store.test({ ...input, apiKey: 'temporary-secret' })).resolves.toEqual({ model: 'qwen' })
    expect(api.test).toHaveBeenCalledWith({ ...input, apiKey: 'temporary-secret' })
    expect(JSON.stringify(store.state)).not.toMatch(/apiKey|secret|token/i)
  })

  it('refreshes the activated and deleted profile kinds after typed operations', async () => {
    const api = createApi()
    api.activate.mockResolvedValue(profile({ kind: 'vlm', id: 'vlm-1', contextLimit: undefined, maxImages: 4 }))
    const store = createModelProfilesStore(api)
    await store.load('vlm')

    await store.activate('vlm-1')
    await store.remove('vlm-1', { allowNoActive: true })

    expect(api.activate).toHaveBeenCalledWith('vlm-1')
    expect(api.delete).toHaveBeenCalledWith('vlm-1', { allowNoActive: true })
    expect(api.list).toHaveBeenLastCalledWith('vlm')
  })

  it('keeps independent active selections for LLM and VLM profiles', async () => {
    const api = createApi()
    api.list.mockImplementation(async (kind = 'llm') => [profile({ id: `${kind}-1`, kind, active: true })])
    const store = createModelProfilesStore(api)
    await store.loadAll()

    expect(store.state.activeProfileIds).toEqual({ llm: 'llm-1', vlm: 'vlm-1' })
    expect(store.state.profilesByKind.llm).toHaveLength(1)
    expect(store.state.profilesByKind.vlm).toHaveLength(1)
  })

  it('keeps each manager list stable when concurrent LLM and VLM loads resolve out of order', async () => {
    const api = createApi()
    const llm = deferred<RendererModelProfile[]>()
    const vlm = deferred<RendererModelProfile[]>()
    api.list.mockImplementation((kind = 'llm') => kind === 'llm' ? llm.promise : vlm.promise)
    const store = createModelProfilesStore(api)
    const load = store.loadAll()

    vlm.resolve([profile({ id: 'vlm-1', kind: 'vlm', contextLimit: undefined, maxImages: 4 })])
    llm.resolve([profile({ id: 'llm-1', kind: 'llm' })])
    await load

    expect(store.profilesForKind('llm').map(item => item.id)).toEqual(['llm-1'])
    expect(store.profilesForKind('vlm').map(item => item.id)).toEqual(['vlm-1'])
  })

  it('reloads the saved profile kind even if the visible manager changes while save is pending', async () => {
    const api = createApi()
    const savedProfile = deferred<RendererModelProfile>()
    api.save.mockReturnValueOnce(savedProfile.promise)
    api.list.mockImplementation(async (kind = 'llm') => [profile({ id: `${kind}-1`, kind })])
    const store = createModelProfilesStore(api)
    await store.load('llm')

    const save = store.save({ name: 'Vision', kind: 'vlm', provider: 'ollama', model: 'llava', endpoint: 'http://127.0.0.1:11434/api/chat', maxImages: 4 })
    await store.load('llm')
    savedProfile.resolve(profile({ id: 'vlm-1', name: 'Vision', kind: 'vlm', contextLimit: undefined, maxImages: 4 }))
    await save

    expect(api.list).toHaveBeenLastCalledWith('vlm')
  })

  it('creates a non-secret edit draft without key-reference fields', () => {
    const draft = createProfileDraft(profile({ hasApiKey: true }))
    expect(draft).not.toHaveProperty('apiKey')
    expect(draft).not.toHaveProperty(['apiKey', 'ProfileId'].join(''))
    expect(draft.apiKeyPlaceholder).toBe('\u5df2\u914d\u7f6e\u5bc6\u94a5\uff0c\u4e0d\u4f1a\u56de\u586b')
    expect(JSON.stringify(draft)).not.toContain('secret')
  })

  it('only attaches a trimmed temporary key when converting a draft to input', () => {
    const input = profileDraftInput(createProfileDraft(profile({ hasApiKey: true })), '  temporary-secret  ')

    expect(input).toMatchObject({
      name: 'Primary', kind: 'llm', provider: 'ollama', model: 'qwen', endpoint: 'http://127.0.0.1:11434/api/chat', contextLimit: 8_000,
    })
    expect(input).not.toHaveProperty('id')
    expect(input).not.toHaveProperty('apiKeyPlaceholder')
    expect(input).toHaveProperty('apiKey', 'temporary-secret')
    expect(input).not.toHaveProperty(['apiKey', 'ProfileId'].join(''))
  })
})
