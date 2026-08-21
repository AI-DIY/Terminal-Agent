import {
  modelSettingsInputSchema,
  type ModelSettingsInput,
  type ModelProvider,
  type PersistedModelSettings,
  type RendererModelSettingsInput as RendererModelSettingsRequest,
} from '../../shared/validation'
import type { SecretStore } from './secret-store'
import type { SettingsRepository } from './settings-repository'
import type { ModelProfileService } from './model-profile-service'
import { validateModelApiKey } from './model-api-key-validation'

export type ModelSettings = PersistedModelSettings & { apiKey: string | null; provider?: 'openai' | 'ollama' | 'llama-cpp' }
export type RendererModelSettings = PersistedModelSettings & { hasApiKey: boolean }
export type RendererModelSettingsInput = RendererModelSettingsRequest
export type ModelConnectionTestSettings = ModelSettingsInput & { provider?: ModelProvider }
type MainProcessModelSettingsRequest = RendererModelSettingsInput | ModelSettingsInput

export class ModelSettingsService {
  private readonly profiles: ModelProfileService | undefined
  private readonly settings: SettingsRepository | undefined
  private readonly secrets: Pick<SecretStore, 'load' | 'save'> | undefined

  constructor(
    settingsOrProfiles: SettingsRepository | ModelProfileService,
    secrets?: Pick<SecretStore, 'load' | 'save'>,
  ) {
    if (isProfileService(settingsOrProfiles)) {
      this.profiles = settingsOrProfiles
    } else {
      this.settings = settingsOrProfiles
      this.secrets = secrets
    }
  }

  async save(input: ModelSettingsInput): Promise<void> {
    if (this.profiles) {
      const current = await this.profiles.getActiveLlmSettings()
      const existing = current ? (await this.profiles.get(current.profileId)) : null
      await this.profiles.save({
        id: existing?.id,
        name: existing?.name ?? '兼容模型配置',
        kind: 'llm',
        provider: existing?.provider ?? 'openai',
        model: input.model,
        endpoint: input.endpoint,
        contextLimit: input.contextLimit,
        apiKey: input.apiKey,
      })
      return
    }
    const parsed = modelSettingsInputSchema.parse({ ...input, apiKey: validateModelApiKey(input.apiKey) })
    const { apiKey, ...persisted } = parsed

    await this.secrets!.save('model.apiKey', apiKey)
    await this.settings!.save(persisted)
  }

  async load(): Promise<ModelSettings | null> {
    if (this.profiles) {
      const active = await this.profiles.getActiveLlmSettings()
      if (!active) return null
      return {
        endpoint: active.endpoint,
        model: active.model,
        contextLimit: active.contextLimit,
        apiKey: active.apiKey || null,
        provider: active.provider,
      }
    }
    const settings = await this.settings!.load()
    if (!settings) {
      return null
    }

    return {
      ...settings,
      apiKey: await this.secrets!.load('model.apiKey'),
    }
  }

  async loadForRenderer(): Promise<RendererModelSettings | null> {
    if (this.profiles) {
      const active = (await this.profiles.list('llm')).find(profile => profile.active)
      if (!active || active.contextLimit === undefined) return null
      return { endpoint: active.endpoint, model: active.model, contextLimit: active.contextLimit, hasApiKey: active.hasApiKey }
    }
    const settings = await this.load()
    if (!settings) return null
    const { apiKey, ...persisted } = settings
    return { ...persisted, hasApiKey: apiKey !== null }
  }

  async saveFromRenderer(input: RendererModelSettingsInput): Promise<void> {
    const prepared = await this.prepareForConnectionTest(input)
    await this.save({
      endpoint: input.endpoint,
      model: input.model,
      contextLimit: input.contextLimit,
      apiKey: prepared.apiKey,
    })
  }

  async prepareForConnectionTest(input: MainProcessModelSettingsRequest): Promise<ModelConnectionTestSettings> {
    if (this.profiles) {
      const current = await this.profiles.getActiveLlmSettings()
      const existing = current ? await this.profiles.get(current.profileId) : null
      const directApiKey = 'apiKey' in input ? input.apiKey : undefined
      const prepared = await this.profiles.prepareForConnectionTest({
        id: existing?.id,
        name: existing?.name ?? '兼容模型配置',
        kind: 'llm',
        provider: existing?.provider ?? 'openai',
        model: input.model,
        endpoint: input.endpoint,
        contextLimit: input.contextLimit,
        ...(directApiKey ? { apiKey: directApiKey } : {}),
      })
      return { endpoint: prepared.endpoint, model: prepared.model, contextLimit: prepared.contextLimit, apiKey: prepared.apiKey, provider: prepared.provider }
    }
    const existingKey = await this.secrets!.load('model.apiKey')
    const directApiKey = 'apiKey' in input ? input.apiKey : undefined
    const apiKey = directApiKey ?? existingKey
    if (!apiKey) throw new Error('An API key is required for the first model connection save')
    return modelSettingsInputSchema.parse({ ...input, apiKey: validateModelApiKey(apiKey) })
  }
}

function isProfileService(value: SettingsRepository | ModelProfileService): value is ModelProfileService {
  return typeof (value as ModelProfileService).getActiveLlmSettings === 'function'
}
