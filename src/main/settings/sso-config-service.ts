import { join } from 'node:path'
import {
  createDefaultSsoConfiguration,
  ssoConfigurationSchema,
  ssoDocumentSchema,
  type SsoConfiguration,
  type SsoDocument,
} from '../../shared/sso-contracts'
import { parseSsoFieldPath } from '../sso/sso-field-path'
import { normalizeSsoUrl, validateSsoMatcher } from '../sso/sso-url-matcher'
import { AtomicJsonStore } from '../persistence/atomic-json-store'
import type { AtomicJsonStoreOptions } from '../persistence/atomic-json-store'

export { createDefaultSsoConfiguration }

export function getSsoConfigPath(homeDirectory: string): string {
  return join(homeDirectory, '.ta', 'user-config')
}

export class SsoConfigService {
  private readonly store: AtomicJsonStore<SsoDocument>

  constructor(private readonly path: string, options: Pick<AtomicJsonStoreOptions, 'fileSystem' | 'createId'> = {}) {
    this.store = new AtomicJsonStore(path, ssoDocumentSchema, () => ({
      version: 1,
      sso: createDefaultSsoConfiguration(),
    }), options)
  }

  async ensureInitialized(): Promise<SsoConfiguration> {
    return (await this.store.createIfMissing()).sso
  }

  async get(): Promise<SsoConfiguration> {
    return (await this.store.load()).sso
  }

  async save(input: unknown): Promise<SsoConfiguration> {
    const sso = ssoConfigurationSchema.parse(input)
    const document = await this.store.update(() => ({ version: 1, sso }))
    return document.sso
  }

  isComplete(config?: SsoConfiguration): boolean {
    if (!config) return false
    try {
      normalizeSsoUrl(config.loginPageUrl)
      validateSsoMatcher(config.platformUrlMatcher)
      validateSsoMatcher(config.userInfoUrlMatcher)
      parseSsoFieldPath(config.employeeIdField)
      parseSsoFieldPath(config.nameField)
      return true
    } catch {
      return false
    }
  }
}
