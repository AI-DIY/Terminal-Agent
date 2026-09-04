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

export type ProtectedModelProfile = Omit<PersistedModelProfile, 'apiKey'> & { apiKey: string | null }
export type RoutedModelSettings = ModelSettingsInput & { provider: PersistedModelProfile['provider']; profileId: string }

type LegacyModelSettingsSource = {
  load(): Promise<PersistedModelSettings | null>
}

type LegacyModelProfilesSource = {
  load(): Promise<ModelProfileDocument>
}

type ModelProfileServiceOptions = {
  createId?: () => string
  legacySettings?: LegacyModelSettingsSource
  /** Optional pre-3.2 profile repository to migrate into user-config. */
  legacyProfiles?: LegacyModelProfilesSource
  /** Persist API keys directly in the user-config model document. */
  plaintextApiKeys?: boolean
}

export class ModelProfileService {
  private readonly createId: () => string
  private readonly legacySettings: LegacyModelSettingsSource | undefined
  private readonly legacyProfiles: LegacyModelProfilesSource | undefined
  private readonly plaintextApiKeys: boolean
  private apiKeyReferenceMigrationChecked = false
  private migrationChecked = false
  private mutationTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly repository: Pick<ModelProfileRepositoryPort, 'load' | 'save'>,
    private readonly secrets: Pick<SecretStore, 'load' | 'save' | 'remove'>,
    options: ModelProfileServiceOptions = {},
  ) {
    this.createId = options.createId ?? randomUUID
    this.legacySettings = options.legacySettings
    this.legacyProfiles = options.legacyProfiles
    this.plaintextApiKeys = options.plaintextApiKeys === true
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
      // When the new user-config mode is enabled, an omitted key means
      // "keep the existing credential".  This also opportunistically moves a
      // legacy encrypted credential into the plain JSON profile on the next
      // edit, while preserving the old secret-store behaviour for callers that
      // do not opt in.
      const existingApiKey = current ? await this.resolveApiKey(current) : null
      const persistedApiKey = apiKey ?? existingApiKey
      const profile: PersistedModelProfile = {
        id,
        name: parsed.name,
        kind: parsed.kind,
        provider: parsed.provider,
        model: parsed.model,
        endpoint: parsed.endpoint,
        ...(parsed.contextLimit === undefined ? {} : { contextLimit: parsed.contextLimit }),
        ...(parsed.maxImages === undefined ? {} : { maxImages: parsed.maxImages }),
        ...(this.plaintextApiKeys && persistedApiKey ? { apiKey: persistedApiKey } : {}),
      }
      const next: ModelProfileDocument = {
        ...document,
        profiles: [...document.profiles.filter(candidate => candidate.id !== id), profile],
      }
      const previousApiKey = this.plaintextApiKeys ? null : (apiKey ? await this.secrets.load(secretKey(id)) : null)
      if (!this.plaintextApiKeys && apiKey) await this.secrets.save(secretKey(id), apiKey)
      if (profile.kind === 'llm' && next.activeLlmId === null && next.autoActivateLlm !== false && await this.isValidForActivation(profile, next, persistedApiKey ?? undefined)) next.activeLlmId = id
      if (profile.kind === 'vlm' && next.activeVlmId === null && next.autoActivateVlm !== false && await this.isValidForActivation(profile, next, persistedApiKey ?? undefined)) next.activeVlmId = id

      try {
        await this.repository.save(next)
      } catch (persistenceError) {
        if (!this.plaintextApiKeys && apiKey) {
          try {
            await this.restoreSecret(secretKey(id), previousApiKey)
          } catch (rollbackError) {
            throw stateUncertainError(
              'Failed to persist the model profile and restore its API key; protected credential state may be inconsistent',
              persistenceError,
              rollbackError,
            )
          }
        }
        throw persistenceError
      }
      // A stale encrypted copy is no longer needed once the plain profile has
      // been persisted. Best-effort cleanup keeps old secrets from lingering,
      // but never turns a successful profile save into a failure.
      if (this.plaintextApiKeys && apiKey) await this.secrets.remove(secretKey(id)).catch(() => undefined)
      return this.toRendererProfile(profile, next, persistedApiKey)
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
      if (this.plaintextApiKeys) {
        // The credential is part of the removed profile in user-config mode.
        // Clean up any pre-migration encrypted copy opportunistically.
        await this.secrets.remove(secretKey(profile.id)).catch(() => undefined)
        return
      }
      try {
        await this.secrets.remove(secretKey(profile.id))
      } catch (removeError) {
        try {
          await this.repository.save(document)
        } catch (restoreError) {
          throw stateUncertainError(
            'Failed to remove the deleted profile API key and restore the model profile; model profile state may be inconsistent',
            removeError,
            restoreError,
          )
        }
        throw removeError
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
      return this.toProtectedProfile(profile)
    })
  }

  async getActiveLlmSettings(): Promise<RoutedModelSettings | null> {
    return this.read(async document => {
      if (!document.activeLlmId) return null
      const profile = document.profiles.find(candidate => candidate.id === document.activeLlmId && candidate.kind === 'llm')
      if (!profile || profile.contextLimit === undefined) return null
      const protectedProfile = await this.toProtectedProfile(profile)
      return { endpoint: profile.endpoint, model: profile.model, contextLimit: profile.contextLimit, apiKey: protectedProfile.apiKey ?? '', provider: profile.provider, profileId: profile.id }
    })
  }

  async prepareForConnectionTest(input: ModelProfileInput): Promise<RoutedModelSettings> {
    const parsed = modelProfileInputSchema.parse(input)
    const apiKey = parsed.apiKey === undefined ? undefined : validateModelApiKey(parsed.apiKey)
    return this.read(async document => {
      const id = parsed.id ?? this.createId()
      const existing = parsed.id ? document.profiles.find(candidate => candidate.id === parsed.id) : undefined
      const profile: PersistedModelProfile = {
        id,
        name: parsed.name,
        kind: parsed.kind,
        provider: parsed.provider,
        model: parsed.model,
        endpoint: parsed.endpoint,
        ...(parsed.contextLimit === undefined ? {} : { contextLimit: parsed.contextLimit }),
        ...(parsed.maxImages === undefined ? {} : { maxImages: parsed.maxImages }),
        ...(this.plaintextApiKeys && existing?.apiKey ? { apiKey: existing.apiKey } : {}),
      }
      const resolvedApiKey = apiKey ?? await this.resolveApiKey(profile)
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
    await this.ensureApiKeyReferenceMigration()
    if (this.migrationChecked || (!this.legacySettings && !this.legacyProfiles)) return
    await this.mutate(async () => {
      const document = await this.repository.load()
      const settingsMigrationDone = !this.legacySettings || document.migrations.legacyModelSettings === 1
      const profilesMigrationDone = !this.legacyProfiles || document.migrations.legacyModelProfiles === 1
      if (settingsMigrationDone && profilesMigrationDone) {
        await this.completeLegacyKeyMigration(document)
        this.migrationChecked = true
        return
      }

      let next: ModelProfileDocument = document
      let importedProfileIds: string[] = []
      if (!profilesMigrationDone) {
        const legacyProfiles = await this.legacyProfiles!.load()
        const imported = await this.importLegacyProfiles(next, legacyProfiles)
        next = {
          ...imported.document,
          migrations: { ...imported.document.migrations, legacyModelProfiles: 1 },
        }
        importedProfileIds = imported.profileIds
      }

      if (!settingsMigrationDone) {
        const legacy = await this.legacySettings!.load()
        next = {
          ...next,
          migrations: { ...next.migrations, legacyModelSettings: 1 },
        }
        if (legacy) {
        const hasLlm = next.profiles.some(profile => profile.kind === 'llm')
        const id = hasLlm
          ? next.activeLlmId ?? next.profiles.find(profile => profile.kind === 'llm')?.id
          : this.createMigrationProfileId(next)
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
      }
      await this.repository.save(next)
      await this.removeImportedProfileSecrets(importedProfileIds)
      await this.completeLegacyKeyMigration(next)
      this.migrationChecked = true
    })
  }

  private async importLegacyProfiles(
    document: ModelProfileDocument,
    legacy: ModelProfileDocument | null,
  ): Promise<{ document: ModelProfileDocument; profileIds: string[] }> {
    if (!legacy?.profiles.length) return { document, profileIds: [] }
    const existingIds = new Set(document.profiles.map(profile => profile.id))
    const imported: PersistedModelProfile[] = []
    for (const legacyProfile of legacy.profiles) {
      if (existingIds.has(legacyProfile.id)) continue
      existingIds.add(legacyProfile.id)
      // `apiKey` belongs only to the new plaintext user-config mode.  A
      // profile supplied by a legacy repository can contain that field only
      // after an interrupted/development migration; never carry it into a
      // protected-storage document through a spread operation.
      const profileWithoutApiKey = { ...legacyProfile }
      delete profileWithoutApiKey.apiKey
      // A legacy repository may have carried an embedded key (from an
      // interrupted development migration) or may have kept it in the
      // profile-owned SecretStore.  Read either source, but choose the
      // destination representation below based on this service's storage
      // mode.  In particular, non-plaintext mode must never spread the key
      // into the persisted profile document.
      const legacyKey = await this.resolveApiKey(legacyProfile)
      let validatedKey: string | undefined
      if (legacyKey) {
        try { validatedKey = validateModelApiKey(legacyKey) } catch { /* ignore invalid legacy material */ }
      }
      if (!this.plaintextApiKeys && validatedKey) {
        // Preserve the old protected-storage contract for callers that do not
        // opt into the v3.2 plaintext user-config mode.  Do not overwrite a
        // destination credential that may already have been created by a
        // previous interrupted migration attempt.
        const existingKey = await this.secrets.load(secretKey(legacyProfile.id))
        if (!existingKey) await this.secrets.save(secretKey(legacyProfile.id), validatedKey)
      }
      imported.push(this.plaintextApiKeys && validatedKey
        ? { ...profileWithoutApiKey, apiKey: validatedKey }
        : profileWithoutApiKey)
    }
    if (!imported.length) return { document, profileIds: [] }

    const importedIds = new Set(imported.map(profile => profile.id))
    const next: ModelProfileDocument = {
      ...document,
      profiles: [...document.profiles, ...imported],
      ...(document.activeLlmId === null && legacy.activeLlmId && importedIds.has(legacy.activeLlmId) ? { activeLlmId: legacy.activeLlmId } : {}),
      ...(document.activeVlmId === null && legacy.activeVlmId && importedIds.has(legacy.activeVlmId) ? { activeVlmId: legacy.activeVlmId } : {}),
      ...(document.profiles.length === 0 ? {
        routing: legacy.routing,
        autoActivateLlm: legacy.autoActivateLlm,
        autoActivateVlm: legacy.autoActivateVlm,
      } : {}),
    }
    return { document: next, profileIds: imported.map(profile => profile.id) }
  }

  private async removeImportedProfileSecrets(profileIds: readonly string[]): Promise<void> {
    if (!this.plaintextApiKeys) return
    await Promise.all(profileIds.map(id => this.secrets.remove(secretKey(id)).catch(() => undefined)))
  }

  private async ensureApiKeyReferenceMigration(): Promise<void> {
    if (this.apiKeyReferenceMigrationChecked) return
    await this.mutate(async () => {
      const document = await this.repository.load()
      await this.completeApiKeyReferenceMigration(document)
      this.apiKeyReferenceMigrationChecked = true
    })
  }

  private async completeApiKeyReferenceMigration(document: ModelProfileDocument): Promise<void> {
    const references = document.migrations.apiKeyReferences
    if (!references?.length) return

    let next = document
    const unresolvedReferences: typeof references = []
    const diagnostics: string[] = []
    const validTargets = new Map<string, PersistedModelProfile>()
    const targetsWithKey = new Set<string>()
    const targetsWithUnresolvedReferences = new Set<string>()
    for (const reference of references) {
      const target = document.profiles.find(profile => profile.id === reference.targetProfileId)
      if (!target || target.kind !== 'vlm') {
        unresolvedReferences.push(reference)
        diagnostics.push(`${reference.targetProfileId}: targetProfileId must reference a VLM profile`)
        continue
      }
      const source = document.profiles.find(profile => profile.id === reference.sourceProfileId)
      if (!source || source.kind !== 'llm') {
        unresolvedReferences.push(reference)
        diagnostics.push(`${reference.sourceProfileId}: sourceProfileId must reference an LLM profile`)
        targetsWithUnresolvedReferences.add(target.id)
        continue
      }
      validTargets.set(target.id, target)

      const targetKey = await this.resolveApiKey(target)
      let targetHasKey = Boolean(targetKey)
      if (!targetKey) {
        const sourceKey = await this.resolveApiKey(source)
        if (sourceKey) {
          let validatedSourceKey: string | null = null
          try {
            validatedSourceKey = validateModelApiKey(sourceKey)
          } catch {
            // Invalid source material is left in place, but cannot be copied.
          }
          if (validatedSourceKey) {
            if (this.plaintextApiKeys) {
              next = {
                ...next,
                profiles: next.profiles.map(profile => profile.id === target.id ? { ...profile, apiKey: validatedSourceKey! } : profile),
              }
            } else {
              await this.secrets.save(secretKey(target.id), validatedSourceKey)
            }
            targetHasKey = true
          }
        }
      }
      if (targetHasKey) targetsWithKey.add(target.id)
    }

    for (const target of validTargets.values()) {
      if (!targetsWithKey.has(target.id) && !targetsWithUnresolvedReferences.has(target.id) && target.provider !== 'ollama' && next.activeVlmId === target.id) {
        next = { ...next, activeVlmId: null, autoActivateVlm: false }
      }
    }

    const migrations = { ...next.migrations }
    if (unresolvedReferences.length > 0) migrations.apiKeyReferences = unresolvedReferences
    else delete migrations.apiKeyReferences
    await this.repository.save({ ...next, migrations })
    if (diagnostics.length > 0) {
      throw new Error(`Cannot complete API key reference migration: ${diagnostics.join('; ')}`)
    }
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

    const targetKey = await this.resolveApiKey(target)
    if (!targetKey) {
      if (this.plaintextApiKeys) {
        await this.repository.save({
          ...document,
          profiles: document.profiles.map(profile => profile.id === target.id ? { ...profile, apiKey: validatedOldKey } : profile),
        })
      } else {
        await this.secrets.save(secretKey(target.id), validatedOldKey)
      }
    }
    await this.secrets.remove('model.apiKey')
  }

  async clearApiKey(id: string): Promise<RendererModelProfile> {
    await this.ensureLegacyMigration()
    return this.mutate(async () => {
      const document = await this.loadDocumentInMutation()
      const profile = document.profiles.find(candidate => candidate.id === id)
      if (!profile) throw new Error('Unknown model profile')

      const isActive = profile.kind === 'llm'
        ? document.activeLlmId === profile.id
        : document.activeVlmId === profile.id
      const nextWithRoute = isActive && profile.provider !== 'ollama'
        ? profile.kind === 'llm'
          ? { ...document, activeLlmId: null, autoActivateLlm: false }
          : { ...document, activeVlmId: null, autoActivateVlm: false }
        : document
      const next = this.plaintextApiKeys
        ? {
            ...nextWithRoute,
            profiles: nextWithRoute.profiles.map(candidate => {
              if (candidate.id !== profile.id) return candidate
              const withoutApiKey = { ...candidate }
              delete withoutApiKey.apiKey
              return withoutApiKey
            }),
          }
        : nextWithRoute

      if (next !== document) await this.repository.save(next)
      if (this.plaintextApiKeys) {
        await this.secrets.remove(secretKey(profile.id)).catch(() => undefined)
        return this.toRendererProfile(profile, next, null)
      }
      try {
        await this.secrets.remove(secretKey(profile.id))
      } catch (removeError) {
        if (next !== document) {
          try {
            await this.repository.save(document)
          } catch (restoreError) {
            throw stateUncertainError(
              'Failed to remove the model API key and restore active profile state; model routing state may be inconsistent',
              removeError,
              restoreError,
            )
          }
        }
        throw removeError
      }
      return this.toRendererProfile(profile, next, null)
    })
  }

  private async isValidForActivation(profile: PersistedModelProfile, _document: ModelProfileDocument, currentApiKey?: string): Promise<boolean> {
    return profile.provider === 'ollama' || Boolean(currentApiKey ?? await this.resolveApiKey(profile))
  }

  private async toRendererProfile(
    profile: PersistedModelProfile,
    document: ModelProfileDocument,
    knownApiKey?: string | null,
  ): Promise<RendererModelProfile> {
    const apiKey = knownApiKey === undefined ? await this.resolveApiKey(profile) : knownApiKey
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
      active: profile.kind === 'llm' ? document.activeLlmId === profile.id : document.activeVlmId === profile.id,
    }
  }

  private async toProtectedProfile(profile: PersistedModelProfile): Promise<ProtectedModelProfile> {
    return { ...profile, apiKey: await this.resolveApiKey(profile) }
  }

  private async resolveApiKey(profile: PersistedModelProfile): Promise<string | null> {
    if (profile.apiKey) return profile.apiKey
    return this.secrets.load(secretKey(profile.id))
  }

  private createMigrationProfileId(document: ModelProfileDocument): string {
    let id = this.createId()
    while (document.profiles.some(profile => profile.id === id)) id = this.createId()
    return id
  }

  private async restoreSecret(key: string, previousValue: string | null): Promise<void> {
    if (previousValue === null) await this.secrets.remove(key)
    else await this.secrets.save(key, previousValue)
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

function stateUncertainError(message: string, primaryError: unknown, compensationError: unknown): AggregateError {
  return new AggregateError([primaryError, compensationError], message)
}
