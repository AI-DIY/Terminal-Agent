import { z } from 'zod'
import { AtomicJsonStore, type AtomicJsonStoreOptions } from '../persistence/atomic-json-store'
import { modelEndpointSchema, modelProfileKindSchema, modelProviderSchema, modelRoutingSchema } from '../../shared/validation'

const persistedModelProfileFields = {
  id: z.string().trim().min(1).max(128),
  name: z.string().trim().min(1).max(255),
  kind: modelProfileKindSchema,
  provider: modelProviderSchema,
  model: z.string().trim().min(1).max(255),
  endpoint: modelEndpointSchema,
  contextLimit: z.number().int().min(1_024).max(1_000_000).optional(),
  maxImages: z.number().int().min(1).max(128).optional(),
}

function validatePersistedModelProfile(
  profile: z.infer<ReturnType<typeof createCurrentModelProfileSchema>>,
  context: z.RefinementCtx,
): void {
  if (profile.kind === 'llm' && profile.contextLimit === undefined) {
    context.addIssue({ code: 'custom', path: ['contextLimit'], message: 'LLM contextLimit is required' })
  }
  if (profile.kind === 'llm' && profile.maxImages !== undefined) {
    context.addIssue({ code: 'custom', path: ['maxImages'], message: 'LLM profiles cannot define maxImages' })
  }
  if (profile.kind === 'vlm' && profile.maxImages === undefined) {
    context.addIssue({ code: 'custom', path: ['maxImages'], message: 'VLM maxImages is required' })
  }
  if (profile.kind === 'vlm' && profile.contextLimit !== undefined) {
    context.addIssue({ code: 'custom', path: ['contextLimit'], message: 'VLM profiles cannot define contextLimit' })
  }
  const pathname = new URL(profile.endpoint).pathname
  if (profile.provider === 'ollama' && !pathname.endsWith('/api/chat')) {
    context.addIssue({ code: 'custom', path: ['endpoint'], message: 'Ollama endpoint must target /api/chat' })
  }
  if (profile.provider !== 'ollama' && !pathname.endsWith('/chat/completions')) {
    context.addIssue({ code: 'custom', path: ['endpoint'], message: 'Endpoint must target OpenAI Chat Completions' })
  }
}

function createCurrentModelProfileSchema() {
  return z.object(persistedModelProfileFields).strict()
}

const persistedModelProfileSchema = createCurrentModelProfileSchema().superRefine(validatePersistedModelProfile)
const version1ModelProfileSchema = z.object({
  ...persistedModelProfileFields,
  apiKeyProfileId: z.string().trim().min(1).max(128).optional(),
}).strict().superRefine(validatePersistedModelProfile)

export type PersistedModelProfile = z.infer<typeof persistedModelProfileSchema>

const migrationReferenceSchema = z.object({
  sourceProfileId: z.string().trim().min(1).max(128),
  targetProfileId: z.string().trim().min(1).max(128),
}).strict()

const modelProfileDocumentFields = {
  activeLlmId: z.string().trim().min(1).max(128).nullable(),
  activeVlmId: z.string().trim().min(1).max(128).nullable(),
  // Older version-1 documents did not record an explicit no-route choice.
  // Missing values preserve automatic activation; only an explicit false opts out.
  autoActivateLlm: z.boolean().optional(),
  autoActivateVlm: z.boolean().optional(),
  routing: modelRoutingSchema,
}

function validateModelProfileDocument(
  document: { profiles: Array<{ id: string; kind: 'llm' | 'vlm' }>; activeLlmId: string | null; activeVlmId: string | null },
  context: z.RefinementCtx,
): void {
  const ids = new Set(document.profiles.map(profile => profile.id))
  if (document.activeLlmId && (!ids.has(document.activeLlmId) || document.profiles.find(profile => profile.id === document.activeLlmId)?.kind !== 'llm')) {
    context.addIssue({ code: 'custom', path: ['activeLlmId'], message: 'activeLlmId must reference an LLM profile' })
  }
  if (document.activeVlmId && (!ids.has(document.activeVlmId) || document.profiles.find(profile => profile.id === document.activeVlmId)?.kind !== 'vlm')) {
    context.addIssue({ code: 'custom', path: ['activeVlmId'], message: 'activeVlmId must reference a VLM profile' })
  }
  if (ids.size !== document.profiles.length) {
    context.addIssue({ code: 'custom', path: ['profiles'], message: 'profile IDs must be unique' })
  }
}

function validateVersion1ModelProfileDocument(
  document: {
    profiles: Array<{ id: string; kind: 'llm' | 'vlm'; apiKeyProfileId?: string }>
    activeLlmId: string | null
    activeVlmId: string | null
  },
  context: z.RefinementCtx,
): void {
  validateModelProfileDocument(document, context)
  const profilesById = new Map(document.profiles.map(profile => [profile.id, profile]))

  document.profiles.forEach((profile, index) => {
    if (!profile.apiKeyProfileId) return
    if (profile.kind !== 'vlm') {
      context.addIssue({
        code: 'custom',
        path: ['profiles', index, 'apiKeyProfileId'],
        message: 'apiKeyProfileId is only valid on VLM profiles',
      })
    }
    if (profilesById.get(profile.apiKeyProfileId)?.kind !== 'llm') {
      context.addIssue({
        code: 'custom',
        path: ['profiles', index, 'apiKeyProfileId'],
        message: 'apiKeyProfileId must reference an existing LLM profile',
      })
    }
  })
}

export const modelProfileDocumentSchema = z.object({
  version: z.literal(2),
  profiles: z.array(persistedModelProfileSchema).max(256),
  ...modelProfileDocumentFields,
  migrations: z.object({
    legacyModelSettings: z.literal(1).optional(),
    legacyModelProfileId: z.string().trim().min(1).max(128).optional(),
    apiKeyReferences: z.array(migrationReferenceSchema).max(256).optional(),
  }).strict(),
}).strict().superRefine(validateModelProfileDocument)

const version1ModelProfileDocumentSchema = z.object({
  version: z.literal(1),
  profiles: z.array(version1ModelProfileSchema).max(256),
  ...modelProfileDocumentFields,
  migrations: z.object({
    legacyModelSettings: z.literal(1).optional(),
    legacyModelProfileId: z.string().trim().min(1).max(128).optional(),
  }).strict(),
}).strict().superRefine(validateVersion1ModelProfileDocument)

export type ModelProfileDocument = z.infer<typeof modelProfileDocumentSchema>
export type ModelProfileRepositoryOptions = Pick<AtomicJsonStoreOptions, 'fileSystem' | 'createId' | 'now'>

export interface ModelProfileRepositoryPort {
  load(): Promise<ModelProfileDocument>
  save(document: ModelProfileDocument): Promise<void>
  update(change: (document: ModelProfileDocument) => ModelProfileDocument | Promise<ModelProfileDocument>): Promise<ModelProfileDocument>
}

export class ModelProfileRepository implements ModelProfileRepositoryPort {
  private readonly store: AtomicJsonStore<ModelProfileDocument>

  constructor(path: string, options: ModelProfileRepositoryOptions = {}) {
    this.store = new AtomicJsonStore(path, modelProfileDocumentSchema, emptyModelProfileDocument, {
      ...options,
      migrate: migrateModelProfileDocument,
    })
  }

  load(): Promise<ModelProfileDocument> {
    return this.store.load()
  }

  async save(document: ModelProfileDocument): Promise<void> {
    await this.store.update(() => modelProfileDocumentSchema.parse(document))
  }

  update(change: (document: ModelProfileDocument) => ModelProfileDocument | Promise<ModelProfileDocument>): Promise<ModelProfileDocument> {
    return this.store.update(change)
  }
}

export function emptyModelProfileDocument(): ModelProfileDocument {
  return {
    version: 2,
    profiles: [],
    activeLlmId: null,
    activeVlmId: null,
    autoActivateLlm: true,
    autoActivateVlm: true,
    routing: 'combined',
    migrations: {},
  }
}

function migrateModelProfileDocument(persisted: unknown): { value: unknown; changed: boolean } {
  if (!isRecord(persisted)) return { value: persisted, changed: false }
  if (persisted.version === 2) return { value: persisted, changed: false }
  if (persisted.version === 1) {
    const version1 = version1ModelProfileDocumentSchema.parse(persisted)
    const apiKeyReferences: Array<z.infer<typeof migrationReferenceSchema>> = []
    const profiles = version1.profiles.map(profile => {
      const { apiKeyProfileId, ...currentProfile } = profile
      if (apiKeyProfileId) {
        apiKeyReferences.push({ sourceProfileId: apiKeyProfileId, targetProfileId: profile.id })
      }
      return currentProfile
    })
    return {
      value: {
        ...version1,
        version: 2,
        profiles,
        migrations: {
          ...version1.migrations,
          ...(apiKeyReferences.length === 0 ? {} : { apiKeyReferences }),
        },
      },
      changed: true,
    }
  }

  // A model-profiles file was not used by the legacy single-model implementation.
  // Treat an accidental legacy-shaped file as an empty versioned document; the
  // service performs the actual settings.json/keychain migration exactly once.
  if ('endpoint' in persisted && 'model' in persisted) {
    return { value: emptyModelProfileDocument(), changed: true }
  }
  return { value: persisted, changed: false }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
