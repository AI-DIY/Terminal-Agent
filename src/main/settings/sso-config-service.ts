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
import { AtomicJsonStore, isAtomicJsonStoreInvalidDataError } from '../persistence/atomic-json-store'
import type { AtomicJsonStoreOptions } from '../persistence/atomic-json-store'
import { withUserConfigPathLock } from './user-config-lock'

export { createDefaultSsoConfiguration }

export function getSsoConfigPath(homeDirectory: string): string {
  return join(homeDirectory, '.ta', 'user-config')
}

export class SsoConfigService {
  private readonly store: AtomicJsonStore<SsoDocument>
  private recoveryRequired = false

  constructor(private readonly path: string, options: Pick<AtomicJsonStoreOptions, 'fileSystem' | 'createId'> = {}) {
    this.store = new AtomicJsonStore(path, ssoDocumentSchema, () => ({
      version: 1,
      sso: createDefaultSsoConfiguration(),
    }), {
      ...options,
      // A model-profile document from an earlier build may already occupy the
      // shared path. Wrap it as a user-config document so SSO initialisation
      // remains fail-closed while preserving the model section.
      migrate: migrateSsoDocument,
    })
  }

  async ensureInitialized(): Promise<SsoConfiguration> {
    // AtomicJsonStore.createIfMissing already coordinates competing creators
    // through an exclusive hard-link publication. Do not hold the broader
    // cross-adapter lock here: another initializer must be able to observe and
    // join a publication that is currently waiting on its filesystem link.
    try {
      return (await this.store.createIfMissing()).sso
    } catch (error) {
      if (isAtomicJsonStoreInvalidDataError(error)) this.recoveryRequired = true
      throw error
    }
  }

  async get(): Promise<SsoConfiguration> {
    if (this.recoveryRequired) return createDefaultSsoConfiguration()
    return withUserConfigPathLock(this.path, async () => (await this.store.load()).sso)
  }

  async save(input: unknown): Promise<SsoConfiguration> {
    const sso = ssoConfigurationSchema.parse(input)
    return withUserConfigPathLock(this.path, async () => {
      const document = this.recoveryRequired
        ? await this.store.replace({ version: 1, sso })
        : await this.store.update(current => ({ ...current, version: 1, sso }))
      this.recoveryRequired = false
      return document.sso
    })
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

function migrateSsoDocument(persisted: unknown): { value: unknown; changed: boolean } {
  if (!isRecord(persisted)) return { value: persisted, changed: false }
  // Some pre-release builds wrote a standalone model-profile document at the
  // shared path.  It can be either v1 or v2.  Keep it opaque here—the model
  // repository owns its strict validation and v1-to-v2 conversion—but wrap
  // only a clearly standalone document so a malformed SSO document is not
  // silently reinterpreted as a model document.
  if (isStandaloneModelProfileDocument(persisted)) {
    return {
      value: {
        version: 1,
        sso: createDefaultSsoConfiguration(),
        models: persisted,
      },
      changed: true,
    }
  }
  if (persisted.version === 1 && 'sso' in persisted && !('models' in persisted)) {
    return { value: { ...persisted, models: undefined }, changed: false }
  }
  return { value: persisted, changed: false }
}

function isStandaloneModelProfileDocument(persisted: Record<string, unknown>): boolean {
  return (persisted.version === 1 || persisted.version === 2)
    && 'profiles' in persisted
    && !('sso' in persisted)
    && !('models' in persisted)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
