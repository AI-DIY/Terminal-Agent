import { randomUUID } from 'node:crypto'
import type { RendererModelProfile } from '../../shared/contracts'
import {
  modelProfileInputSchema,
  modelProfileKindSchema,
  modelRoutingSchema,
  type ModelProfileInput,
  type ModelProfileKind,
  type ModelRouting,
  type ModelSettingsInput,
  type PersistedModelSettings,
} from '../../shared/validation'
import type { SecretStore } from './secret-store'
import { validateModelApiKey } from './model-api-key-validation'
import type { ModelProfileDocument, ModelProfileRepositoryPort, PersistedModelProfile } from './model-profile-repository'

export type ProtectedModelProfile = PersistedModelProfile & { apiKey: string | null }
export type RoutedModelSettings = ModelSettingsInput & { provider: PersistedModelProfile['provider']; profileId: string }

type LegacyModelSettingsSource = {
  load(): Promise<PersistedModelSettings | null>
}

type ModelProfileServiceOptions = {
  createId?: () => string
  legacySettings?: LegacyModelSettingsSource
}

export class ModelProfileService {
  private readonly createId: () => string
  private readonly legacySettings: LegacyModelSettingsSource | undefined
  private migrationChecked = false
  private mutationTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly repository: Pick<ModelProfileRepositoryPort, 'load' | 'save'>,
    private readonly secrets: Pick<SecretStore, 'load' | 'save' | 'remove'>,
    options: ModelProfileServiceOptions = {},
  ) {
    this.createId = options.createId ?? randomUUID
    this.legacySettings = options.legacySettings
  }

  async list(kind?: ModelProfileKind): Promise<RendererModelProfile[]> {
    return this.read(async document => {
      const profiles = kind ? document.profiles.filter(profile => profile.kind === modelProfileKindSchema.parse(kind)) : document.profiles
      return Promise.all(profiles.map(profile => this.toRendererProfile(profile, document)))
    })
  }

  async get(id: string): Promise<RendererModelProfile | null> {
    return this.read(async document => {
      const profile = document.profiles.find(candidate => candidate.id === id)
      return profile ? this.toRendererProfile(profile, document) : null
    })
  }

  async save(input: ModelProfileInput): Promise<RendererModelProfile> {
    await this.ensureLegacyMigration()
    return this.mutate(async () => {
      const parsed = modelProfileInputSchema.parse(input)
      const apiKey = parsed.apiKey === undefined ? undefined : validateModelApiKey(parsed.apiKey)
      const document = await this.loadDocumentInMutation()
      const current = parsed.id ? document.profiles.find(profile => profile.id === parsed.id) : undefined
      if (parsed.id && !current) throw new Error('Unknown model profile')
      if (current && current.kind !== parsed.kind) throw new Error('Model profile kind cannot change')

      const id = current?.id ?? this.createId()
      const apiKeyProfileId = apiKey ? undefined : parsed.apiKeyProfileId ?? current?.apiKeyProfileId
      if (apiKeyProfileId) this.requireLlmKeyProfile(document, apiKeyProfileId, id)

      const profile: PersistedModelProfile = {
        id,
        name: parsed.name,
        kind: parsed.kind,
        provider: parsed.provider,
        model: parsed.model,
        endpoint: parsed.endpoint,
        ...(parsed.contextLimit === undefined ? {} : { contextLimit: parsed.contextLimit }),
        ...(parsed.maxImages === undefined ? {} : { maxImages: parsed.maxImages }),
        ...(apiKeyProfileId ? { apiKeyProfileId } : {}),
      }
      const next: ModelProfileDocument = {
        ...document,
        profiles: [...document.profiles.filter(candidate => candidate.id !== id), profile],
      }
      const previousApiKey = apiKey ? await this.secrets.load(secretKey(id)) : null
      if (apiKey) await this.secrets.save(secretKey(id), apiKey)
      if (profile.kind === 'llm' && next.activeLlmId === null && next.autoActivateLlm !== false && await this.isValidForActivation(profile, next, apiKey)) next.activeLlmId = id
      if (profile.kind === 'vlm' && next.activeVlmId === null && next.autoActivateVlm !== false && await this.isValidForActivation(profile, next, apiKey)) next.activeVlmId = id

      try {
        await this.repository.save(next)
      } catch (error) {
        if (apiKey) await this.restoreSecret(secretKey(id), previousApiKey)
        throw error
      }
      return this.toRendererProfile(profile, next, apiKey)
    })
  }

  async activate(id: string): Promise<RendererModelProfile> {
    await this.ensureLegacyMigration()
    return this.mutate(async () => {
      const document = await this.loadDocumentInMutation()
      const profile = document.profiles.find(candidate => candidate.id === id)
      if (!profile) throw new Error('Unknown model profile')
      if (!await this.isValidForActivation(profile, document)) throw new Error('An API key is required before activating this model provider')
      const next = profile.kind === 'llm'
        ? { ...document, activeLlmId: profile.id }
        : { ...document, activeVlmId: profile.id }
      await this.repository.save(next)
      return this.toRendererProfile(profile, next)
    })
  }

  async delete(id: string, options: { replacementId?: string | null; allowNoActive?: boolean } = {}): Promise<void> {
    await this.ensureLegacyMigration()
    await this.mutate(async () => {
      const document = await this.loadDocumentInMutation()
      const profile = document.profiles.find(candidate => candidate.id === id)
      if (!profile) throw new Error('Unknown model profile')
      if (profile.kind === 'llm' && document.profiles.some(candidate => candidate.kind === 'vlm' && candidate.apiKeyProfileId === profile.id)) {
        throw new Error('Cannot delete a model profile while its API key is referenced by a VLM')
      }
      const activeId = profile.kind === 'llm' ? document.activeLlmId : document.activeVlmId
      let replacementId = activeId

      if (activeId === profile.id) {
        if (options.replacementId) {
          const replacement = document.profiles.find(candidate => candidate.id === options.replacementId)
          if (!replacement || replacement.id === profile.id || replacement.kind !== profile.kind || !await this.isValidForActivation(replacement, document)) {
            throw new Error('Active model replacement must be an available profile of the same kind')
          }
          replacementId = replacement.id
        } else if (options.allowNoActive === true) {
          replacementId = null
        } else {
          throw new Error('Deleting an active model requires an explicit replacement or no-route choice')
        }
      }

      const nextProfiles = document.profiles.filter(candidate => candidate.id !== profile.id)
      const explicitNoRoute = activeId === profile.id && replacementId === null
      const next = profile.kind === 'llm'
        ? { ...document, profiles: nextProfiles, activeLlmId: replacementId, ...(explicitNoRoute ? { autoActivateLlm: false } : {}) }
        : { ...document, profiles: nextProfiles, activeVlmId: replacementId, ...(explicitNoRoute ? { autoActivateVlm: false } : {}) }
      await this.repository.save(next)
      try {
        await this.secrets.remove(secretKey(profile.id))
      } catch (error) {
        await this.repository.save(document).catch(() => undefined)
        throw error
      }
    })
  }

  async setRouting(routing: ModelRouting): Promise<ModelRouting> {
    await this.ensureLegacyMigration()
    return this.mutate(async () => {
      const document = await this.loadDocumentInMutation()
      const next = { ...document, routing: modelRoutingSchema.parse(routing) }
      await this.repository.save(next)
      return next.routing
    })
  }

  async getRouting(): Promise<ModelRouting> {
    return this.read(document => document.routing)
  }

  async resolveRoute(request: { hasImages: boolean }): Promise<ProtectedModelProfile> {
    return this.read(async document => {
      const kind: ModelProfileKind = document.routing === 'vision-only' || request.hasImages ? 'vlm' : 'llm'
      const activeId = kind === 'llm' ? document.activeLlmId : document.activeVlmId
      if (!activeId) throw new Error(`No active ${kind.toUpperCase()} model profile`)
      const profile = document.profiles.find(candidate => candidate.id === activeId && candidate.kind === kind)
      if (!profile) throw new Error(`Active ${kind.toUpperCase()} model profile is unavailable`)
      return this.toProtectedProfile(profile, document)
    })
  }

  async getActiveLlmSettings(): Promise<RoutedModelSettings | null> {
    return this.read(async document => {
      if (!document.activeLlmId) return null
      const profile = document.profiles.find(candidate => candidate.id === document.activeLlmId && candidate.kind === 'llm')
      if (!profile || profile.contextLimit === undefined) return null
      const protectedProfile = await this.toProtectedProfile(profile, document)
      return { endpoint: profile.endpoint, model: profile.model, contextLimit: profile.contextLimit, apiKey: protectedProfile.apiKey ?? '', provider: profile.provider, profileId: profile.id }
    })
  }

  async prepareForConnectionTest(input: ModelProfileInput): Promise<RoutedModelSettings> {
    const parsed = modelProfileInputSchema.parse(input)
    const apiKey = parsed.apiKey === undefined ? undefined : validateModelApiKey(parsed.apiKey)
    return this.read(async document => {
      const id = parsed.id ?? this.createId()
      const profile: PersistedModelProfile = {
        id,
        name: parsed.name,
        kind: parsed.kind,
        provider: parsed.provider,
        model: parsed.model,
        endpoint: parsed.endpoint,
        ...(parsed.contextLimit === undefined ? {} : { contextLimit: parsed.contextLimit }),
        ...(parsed.maxImages === undefined ? {} : { maxImages: parsed.maxImages }),
        ...(parsed.apiKeyProfileId ? { apiKeyProfileId: parsed.apiKeyProfileId } : {}),
      }
      const resolvedApiKey = apiKey ?? await this.resolveApiKey(profile, document)
      if (profile.provider !== 'ollama' && !resolvedApiKey) throw new Error('An API key is required for this model provider')
      return {
        endpoint: profile.endpoint,
        model: profile.model,
        contextLimit: profile.contextLimit ?? profile.maxImages ?? 1_024,
        apiKey: resolvedApiKey ?? '',
        provider: profile.provider,
        profileId: id,
      }
    })
  }

  private async read<T>(operation: (document: ModelProfileDocument) => Promise<T> | T): Promise<T> {
    await this.ensureLegacyMigration()
    return this.mutate(async () => operation(await this.loadDocumentInMutation()))
  }

  private loadDocumentInMutation(): Promise<ModelProfileDocument> {
    return this.repository.load()
  }

  private async ensureLegacyMigration(): Promise<void> {
    if (this.migrationChecked || !this.legacySettings) return
    await this.mutate(async () => {
      const document = await this.repository.load()
      if (document.migrations.legacyModelSettings === 1) {
        await this.completeLegacyKeyMigration(document)
        this.migrationChecked = true
        return
      }

      const legacy = await this.legacySettings!.load()
      const next: ModelProfileDocument = {
        ...document,
        migrations: { ...document.migrations, legacyModelSettings: 1 },
      }
      if (legacy) {
        const hasLlm = document.profiles.some(profile => profile.kind === 'llm')
        const id = hasLlm
          ? document.activeLlmId ?? document.profiles.find(profile => profile.kind === 'llm')?.id
          : this.createMigrationProfileId(document)
        if (id) next.migrations = { ...next.migrations, legacyModelProfileId: id }
        if (!hasLlm && id) {
          const profile: PersistedModelProfile = {
            id,
            kind: 'llm',
            name: '已迁移模型配置',
            provider: 'openai',
            model: legacy.model,
            endpoint: legacy.endpoint,
            contextLimit: legacy.contextLimit,
          }
          const oldKey = await this.secrets.load('model.apiKey')
          let validatedOldKey: string | undefined
          if (oldKey) {
            try {
              validatedOldKey = validateModelApiKey(oldKey)
            } catch {
              // completeLegacyKeyMigration removes rejected legacy material
              // after the migration document has been durably recorded.
              validatedOldKey = undefined
            }
          }
          next.profiles = [...next.profiles, profile]
          if (next.activeLlmId === null && (validatedOldKey || profile.provider === 'ollama')) next.activeLlmId = id
        }
      }
      await this.repository.save(next)
      await this.completeLegacyKeyMigration(next)
      this.migrationChecked = true
    })
  }

  private async completeLegacyKeyMigration(document: ModelProfileDocument): Promise<void> {
    if (!document.migrations.legacyModelProfileId) return
    const oldKey = await this.secrets.load('model.apiKey')
    if (!oldKey) return

    let validatedOldKey: string
    try {
      validatedOldKey = validateModelApiKey(oldKey)
    } catch {
      // Invalid legacy material cannot become an active profile credential.
      // Remove it from protected storage so migration cannot retry it forever.
      await this.secrets.remove('model.apiKey')
      return
    }

    const targetId = document.migrations.legacyModelProfileId
      ?? document.activeLlmId
      ?? document.profiles.find(profile => profile.kind === 'llm' && profile.name === '已迁移模型配置')?.id
      ?? document.profiles.find(profile => profile.kind === 'llm')?.id
    const target = targetId ? document.profiles.find(profile => profile.id === targetId && profile.kind === 'llm') : undefined
    if (!target) return

    const targetKey = await this.secrets.load(secretKey(target.id))
    if (!targetKey) await this.secrets.save(secretKey(target.id), validatedOldKey)
    await this.secrets.remove('model.apiKey')
  }

  async saveApiKey(id: string, apiKey: string): Promise<RendererModelProfile> {
    await this.ensureLegacyMigration()
    return this.mutate(async () => {
      const document = await this.loadDocumentInMutation()
      const profile = document.profiles.find(candidate => candidate.id === id)
      if (!profile) throw new Error('Unknown model profile')
      const value = validateModelApiKey(apiKey)
      const savedProfile = profile.apiKeyProfileId ? omitApiKeyReference(profile) : profile
      const previousApiKey = await this.secrets.load(secretKey(id))
      await this.secrets.save(secretKey(id), value)
      const withSavedProfile = savedProfile === profile
        ? document
        : { ...document, profiles: document.profiles.map(candidate => candidate.id === id ? savedProfile : candidate) }
      const next = savedProfile.kind === 'llm' && document.activeLlmId === null && document.autoActivateLlm !== false && await this.isValidForActivation(savedProfile, withSavedProfile, value)
        ? { ...withSavedProfile, activeLlmId: id }
        : savedProfile.kind === 'vlm' && document.activeVlmId === null && document.autoActivateVlm !== false && await this.isValidForActivation(savedProfile, withSavedProfile, value)
          ? { ...withSavedProfile, activeVlmId: id }
          : withSavedProfile
      try {
        if (next !== document) await this.repository.save(next)
      } catch (error) {
        await this.restoreSecret(secretKey(id), previousApiKey)
        throw error
      }
      return this.toRendererProfile(savedProfile, next, value)
    })
  }

  private async isValidForActivation(profile: PersistedModelProfile, document: ModelProfileDocument, currentApiKey?: string): Promise<boolean> {
    return profile.provider === 'ollama' || Boolean(currentApiKey ?? await this.resolveApiKey(profile, document))
  }

  private async toRendererProfile(
    profile: PersistedModelProfile,
    document: ModelProfileDocument,
    knownApiKey?: string,
  ): Promise<RendererModelProfile> {
    const apiKey = knownApiKey ?? await this.resolveApiKey(profile, document)
    return {
      id: profile.id,
      name: profile.name,
      kind: profile.kind,
      provider: profile.provider,
      model: profile.model,
      endpoint: profile.endpoint,
      ...(profile.contextLimit === undefined ? {} : { contextLimit: profile.contextLimit }),
      ...(profile.maxImages === undefined ? {} : { maxImages: profile.maxImages }),
      hasApiKey: Boolean(apiKey),
      ...(profile.apiKeyProfileId ? { apiKeyProfileId: profile.apiKeyProfileId } : {}),
      active: profile.kind === 'llm' ? document.activeLlmId === profile.id : document.activeVlmId === profile.id,
    }
  }

  private async toProtectedProfile(profile: PersistedModelProfile, document: ModelProfileDocument): Promise<ProtectedModelProfile> {
    return { ...profile, apiKey: await this.resolveApiKey(profile, document) }
  }

  private async resolveApiKey(profile: PersistedModelProfile, document: ModelProfileDocument): Promise<string | null> {
    if (profile.apiKeyProfileId) {
      const referenced = document.profiles.find(candidate => candidate.id === profile.apiKeyProfileId && candidate.kind === 'llm')
      return referenced ? this.secrets.load(secretKey(referenced.id)) : null
    }
    return this.secrets.load(secretKey(profile.id))
  }

  private requireLlmKeyProfile(document: ModelProfileDocument, referenceId: string, profileId: string): void {
    if (referenceId === profileId || !document.profiles.some(profile => profile.id === referenceId && profile.kind === 'llm')) {
      throw new Error('VLM API key reference must target an LLM profile')
    }
  }

  private createMigrationProfileId(document: ModelProfileDocument): string {
    let id = this.createId()
    while (document.profiles.some(profile => profile.id === id)) id = this.createId()
    return id
  }

  private async restoreSecret(key: string, previousValue: string | null): Promise<void> {
    try {
      if (previousValue === null) await this.secrets.remove(key)
      else await this.secrets.save(key, previousValue)
    } catch {
      // Preserve the original persistence error; a later retry can restore the key again.
    }
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation)
    this.mutationTail = result.then(() => undefined, () => undefined)
    return result
  }
}

function secretKey(id: string): string {
  return `model-profile.${id}.apiKey`
}

function omitApiKeyReference(profile: PersistedModelProfile): PersistedModelProfile {
  const withoutReference = { ...profile }
  delete withoutReference.apiKeyProfileId
  return withoutReference
}
