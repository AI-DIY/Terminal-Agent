import {
  modelSettingsInputSchema,
  type ModelSettingsInput,
  type PersistedModelSettings,
} from '../../shared/validation'
import type { SecretStore } from './secret-store'
import type { SettingsRepository } from './settings-repository'

export type ModelSettings = PersistedModelSettings & { apiKey: string | null }
export type RendererModelSettings = PersistedModelSettings & { hasApiKey: boolean }
export type RendererModelSettingsInput = PersistedModelSettings & { apiKey?: string }

export class ModelSettingsService {
  constructor(
    private readonly settings: SettingsRepository,
    private readonly secrets: Pick<SecretStore, 'load' | 'save'>,
  ) {}

  async save(input: ModelSettingsInput): Promise<void> {
    const parsed = modelSettingsInputSchema.parse(input)
    const { apiKey, ...persisted } = parsed

    await this.secrets.save('model.apiKey', apiKey)
    await this.settings.save(persisted)
  }

  async load(): Promise<ModelSettings | null> {
    const settings = await this.settings.load()
    if (!settings) {
      return null
    }

    return {
      ...settings,
      apiKey: await this.secrets.load('model.apiKey'),
    }
  }

  async loadForRenderer(): Promise<RendererModelSettings | null> {
    const settings = await this.load()
    if (!settings) return null
    const { apiKey, ...persisted } = settings
    return { ...persisted, hasApiKey: apiKey !== null }
  }

  async saveFromRenderer(input: RendererModelSettingsInput): Promise<void> {
    const existingKey = await this.secrets.load('model.apiKey')
    const apiKey = input.apiKey?.trim() || existingKey
    if (!apiKey) throw new Error('An API key is required for the first model connection save')
    await this.save({ ...input, apiKey })
  }
}
