import { reactive } from 'vue'
import type { ModelProfileKind, ModelRouting, RendererModelProfile, RendererModelProfileInput } from '../../../shared/contracts'

export type ModelProfilesApi = {
  list(kind?: ModelProfileKind): Promise<RendererModelProfile[]>
  save(input: RendererModelProfileInput): Promise<RendererModelProfile>
  test(input: RendererModelProfileInput): Promise<{ model: string }>
  activate(id: string): Promise<RendererModelProfile>
  delete(id: string, options?: { replacementId?: string | null; allowNoActive?: boolean }): Promise<void>
  clearApiKey(id: string): Promise<RendererModelProfile>
  getRouting(): Promise<ModelRouting>
  setRouting(routing: ModelRouting): Promise<ModelRouting>
}

export type ProfileDraft = Omit<RendererModelProfileInput, 'apiKey'>
export type ProfileEditorDraft = { editingId: string | null; form: ProfileDraft }

export function createProfileDraft(profile?: RendererModelProfile, defaultKind: ModelProfileKind = 'llm'): ProfileDraft {
  const kind = profile?.kind ?? defaultKind
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
    } : {
      name: '',
      kind,
      provider: 'ollama' as const,
      model: '',
      endpoint: 'http://127.0.0.1:11434/api/chat',
      contextLimit: kind === 'llm' ? 12000 : undefined,
      maxImages: kind === 'vlm' ? 4 : undefined,
    }),
  }
}

export function profileDraftInput(draft: ProfileDraft, apiKey = ''): RendererModelProfileInput {
  const input = { ...draft } as RendererModelProfileInput
  delete input.id
  const value = apiKey.trim()
  return value ? { ...input, apiKey: value } : input
}

function createProfileEditorDraft(kind: ModelProfileKind): ProfileEditorDraft {
  return { editingId: null, form: createProfileDraft(undefined, kind) }
}

export function createModelProfilesStore(api: ModelProfilesApi) {
  const state = reactive({
    kind: 'llm' as ModelProfileKind,
    profiles: [] as RendererModelProfile[],
    profilesByKind: { llm: [] as RendererModelProfile[], vlm: [] as RendererModelProfile[] },
    activeProfileIds: { llm: null as string | null, vlm: null as string | null },
    editorDrafts: {
      llm: createProfileEditorDraft('llm'),
      vlm: createProfileEditorDraft('vlm'),
    },
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

  async function clearApiKey(id: string): Promise<RendererModelProfile> {
    const cleared = await api.clearApiKey(id)
    reconcileProfile(cleared)
    await load(cleared.kind)
    return cleared
  }

  function reconcileProfile(profile: RendererModelProfile): void {
    const profiles = state.profilesByKind[profile.kind]
    const index = profiles.findIndex(candidate => candidate.id === profile.id)
    if (index === -1) return

    const nextProfiles = [...profiles]
    nextProfiles[index] = profile
    state.profilesByKind[profile.kind] = nextProfiles
    if (state.kind === profile.kind) state.profiles = nextProfiles
    if (profile.active) state.activeProfileIds[profile.kind] = profile.id
    else if (state.activeProfileIds[profile.kind] === profile.id) state.activeProfileIds[profile.kind] = null
  }

  function profilesForKind(kind: ModelProfileKind): RendererModelProfile[] {
    return state.profilesByKind[kind]
  }

  function editorDraftFor(kind: ModelProfileKind): ProfileEditorDraft {
    return state.editorDrafts[kind]
  }

  function replaceEditorDraft(kind: ModelProfileKind, form: ProfileDraft, editingId: string | null): void {
    const draft = state.editorDrafts[kind]
    const target = draft.form as unknown as Record<string, unknown>
    for (const key of Object.keys(target)) delete target[key]
    Object.assign(draft.form, form)
    draft.editingId = editingId
  }

  return { state, load, loadAll, profilesForKind, editorDraftFor, replaceEditorDraft, save, test, activate, remove, clearApiKey, setRouting }
}

let sharedStore: ReturnType<typeof createModelProfilesStore> | undefined
export function getModelProfilesStore(): ReturnType<typeof createModelProfilesStore> {
  sharedStore ??= createModelProfilesStore(window.terminalAgent.settings.models)
  return sharedStore
}
