import { reactive } from 'vue'
import type { ModelProfileKind, ModelRouting, RendererModelProfile, RendererModelProfileInput } from '../../../shared/contracts'

export type ModelProfilesApi = {
  list(kind?: ModelProfileKind): Promise<RendererModelProfile[]>
  save(input: RendererModelProfileInput): Promise<RendererModelProfile>
  test(input: RendererModelProfileInput): Promise<{ model: string }>
  activate(id: string): Promise<RendererModelProfile>
  delete(id: string, options?: { replacementId?: string | null; allowNoActive?: boolean }): Promise<void>
  getRouting(): Promise<ModelRouting>
  setRouting(routing: ModelRouting): Promise<ModelRouting>
  importApiKey(profileId: string): Promise<{ status: 'imported' | 'cancelled'; hasApiKey: boolean }>
}

export type ProfileDraft = RendererModelProfileInput & {
  id?: string
  apiKey?: never
  apiKeyPlaceholder: string
}

export function createProfileDraft(profile?: RendererModelProfile): ProfileDraft {
  const kind = profile?.kind ?? 'llm'
  return {
    ...(profile ? {
      id: profile.id,
      name: profile.name,
      kind: profile.kind,
      provider: profile.provider,
      model: profile.model,
      endpoint: profile.endpoint,
      contextLimit: profile.contextLimit,
      maxImages: profile.maxImages,
      apiKeyProfileId: profile.apiKeyProfileId,
    } : {
      name: '',
      kind,
      provider: 'ollama' as const,
      model: '',
      endpoint: 'http://127.0.0.1:11434/api/chat',
      contextLimit: kind === 'llm' ? 12000 : undefined,
      maxImages: kind === 'vlm' ? 4 : undefined,
    }),
    apiKeyPlaceholder: profile?.hasApiKey ? '已配置密钥，不会回填' : '未配置密钥。请使用导入密钥。',
  } as ProfileDraft
}

export function profileDraftInput(draft: ProfileDraft): RendererModelProfileInput {
  const input = { ...draft } as RendererModelProfileInput & Record<string, unknown>
  delete input.id
  delete input.apiKeyPlaceholder
  return input
}

export function createModelProfilesStore(api: ModelProfilesApi) {
  const state = reactive({
    kind: 'llm' as ModelProfileKind,
    profiles: [] as RendererModelProfile[],
    profilesByKind: { llm: [] as RendererModelProfile[], vlm: [] as RendererModelProfile[] },
    activeProfileIds: { llm: null as string | null, vlm: null as string | null },
    routing: 'combined' as ModelRouting,
    loading: false,
    error: '',
  })
  const loadRevisions: Record<ModelProfileKind, number> = { llm: 0, vlm: 0 }
  let routingRevision = 0

  async function load(kind = state.kind): Promise<void> {
    const revision = ++loadRevisions[kind]
    const routeRevision = routingRevision
    state.loading = true
    state.error = ''
    try {
      const [profiles, routing] = await Promise.all([api.list(kind), api.getRouting()])
      if (revision === loadRevisions[kind]) {
        state.kind = kind
        state.profiles = profiles
        state.profilesByKind[kind] = profiles
        state.activeProfileIds[kind] = profiles.find(profile => profile.active)?.id ?? null
      }
      if (routeRevision === routingRevision) state.routing = routing
    } catch (error) {
      if (revision === loadRevisions[kind]) state.error = error instanceof Error ? error.message : '无法读取模型配置。'
    } finally {
      if (revision === loadRevisions[kind]) state.loading = false
    }
  }

  async function loadAll(): Promise<void> {
    await Promise.all([load('llm'), load('vlm')])
  }

  async function save(input: RendererModelProfileInput): Promise<RendererModelProfile> {
    const saved = await api.save(input)
    await load(input.kind)
    return saved
  }

  async function test(input: RendererModelProfileInput): Promise<{ model: string }> {
    return api.test(input)
  }

  async function activate(id: string): Promise<void> {
    const activated = await api.activate(id)
    const kind = activated.kind
    await load(kind)
  }

  async function remove(id: string, options?: { replacementId?: string | null; allowNoActive?: boolean }): Promise<void> {
    const kind = state.profilesByKind.llm.some(profile => profile.id === id) ? 'llm' : state.profilesByKind.vlm.some(profile => profile.id === id) ? 'vlm' : state.kind
    await api.delete(id, options)
    await load(kind)
  }

  async function setRouting(routing: ModelRouting): Promise<void> {
    const revision = ++routingRevision
    const next = await api.setRouting(routing)
    if (revision === routingRevision) state.routing = next
  }

  async function importApiKey(profileId: string): Promise<void> {
    const result = await api.importApiKey(profileId)
    if (result.status === 'imported') {
      const kind = state.profilesByKind.llm.some(profile => profile.id === profileId) ? 'llm' : state.profilesByKind.vlm.some(profile => profile.id === profileId) ? 'vlm' : state.kind
      await load(kind)
    }
  }

  function profilesForKind(kind: ModelProfileKind): RendererModelProfile[] {
    return state.profilesByKind[kind]
  }

  return { state, load, loadAll, profilesForKind, save, test, activate, remove, setRouting, importApiKey }
}

let sharedStore: ReturnType<typeof createModelProfilesStore> | undefined
export function getModelProfilesStore(): ReturnType<typeof createModelProfilesStore> {
  sharedStore ??= createModelProfilesStore(window.terminalAgent.settings.models)
  return sharedStore
}
