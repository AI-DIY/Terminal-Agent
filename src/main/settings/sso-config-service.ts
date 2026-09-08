import { readFile as readFileFromDisk } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { TextDecoder } from 'node:util'
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
import { userConfigYamlCodec } from './user-config-yaml'

export { createDefaultSsoConfiguration }

/** Canonical portable user configuration shared by SSO and model profiles. */
export function getSsoConfigPath(homeDirectory: string): string {
  return join(homeDirectory, '.terminal-agent', 'user-config.yml')
}

/** The JSON path used by the immediately previous release. */
export function getPreviousSsoConfigPath(homeDirectory: string): string {
  return join(homeDirectory, '.terminal-agent', 'user-config')
}

/** The pre-v3.2 location retained as a one-time migration source. */
export function getLegacySsoConfigPath(homeDirectory: string): string {
  return join(homeDirectory, '.ta', 'user-config')
}

export type SsoConfigServiceOptions = Pick<AtomicJsonStoreOptions, 'fileSystem' | 'createId'> & {
  /** Optional legacy file to import when the canonical path is absent. */
  legacyPath?: string
  /**
   * Ordered JSON migration sources.  Earlier entries win conflicts while
   * fields found only in a later source are retained.
   */
  legacyPaths?: readonly string[]
}

export class SsoConfigService {
  private readonly store: AtomicJsonStore<SsoDocument>
  private recoveryRequired = false

  private readonly legacyPaths: readonly string[]
  private readonly legacyReadFile: (path: string) => Promise<Buffer>

  constructor(private readonly path: string, options: SsoConfigServiceOptions = {}) {
    this.legacyPaths = uniquePaths([
      ...(options.legacyPaths ?? []),
      ...(options.legacyPath ? [options.legacyPath] : []),
    ], path)
    this.legacyReadFile = options.fileSystem?.readFile ?? (async path => Buffer.from(await readFileFromDisk(path)))
    this.store = new AtomicJsonStore(path, ssoDocumentSchema, () => ({
      version: 1,
      sso: createDefaultSsoConfiguration(),
    }), {
      ...options,
      codec: userConfigYamlCodec,
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
      return (await this.store.createIfMissing(() => this.readLegacyOrDefault())).sso
    } catch (error) {
      if (isAtomicJsonStoreInvalidDataError(error)) this.recoveryRequired = true
      throw error
    }
  }

  /**
   * Seed a missing canonical file from the legacy location.  The store checks
   * the canonical path first and publishes with an exclusive link, so an
   * existing canonical file is never overwritten—even when another process
   * creates it while the legacy file is being read.
   */
  private async readLegacyOrDefault(): Promise<SsoDocument> {
    const empty = (): SsoDocument => ({ version: 1, sso: createDefaultSsoConfiguration() })
    const imported: ImportedSsoDocument[] = []

    for (const legacyPath of this.legacyPaths) {
      let source: Buffer
      try {
        source = await this.legacyReadFile(legacyPath)
      } catch (error) {
        if (isMissingFile(error)) continue
        throw error
      }

      // Keep every JSON source untouched.  Parsing and schema validation happen
      // before publication; unknown top-level fields are retained by the
      // passthrough user-config envelope below.
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(source)
      const persisted = JSON.parse(decoded) as unknown
      imported.push({
        document: ssoDocumentSchema.parse(migrateSsoDocument(persisted).value),
        syntheticSso: isRecord(persisted) && isStandaloneModelProfileDocument(persisted),
      })
    }

    if (imported.length === 0) return empty()
    // The most recent no-extension .terminal-agent document is listed first.
    // Overlay it last while retaining values found only in the older .ta file.
    const [first, ...remaining] = imported.slice().reverse()
    return remaining.reduce((merged, source) => mergeDocuments(merged, source.document, source.syntheticSso), first.document)
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

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const resolved = resolve(value)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  return normalize(left) === normalize(right)
}

function uniquePaths(paths: readonly string[], canonicalPath: string): string[] {
  const unique: string[] = []
  for (const path of paths) {
    if (!path || samePath(path, canonicalPath) || unique.some(existing => samePath(existing, path))) continue
    unique.push(path)
  }
  return unique
}

type ImportedSsoDocument = {
  document: SsoDocument
  /** A standalone model document receives a default SSO section only to satisfy the schema. */
  syntheticSso: boolean
}

function mergeDocuments(base: SsoDocument, overlay: SsoDocument, omitSyntheticSso = false): SsoDocument {
  if (!omitSyntheticSso) return ssoDocumentSchema.parse(mergeRecords(base, overlay))
  const withoutSyntheticSso: Record<string, unknown> = { ...overlay }
  delete withoutSyntheticSso.sso
  return ssoDocumentSchema.parse(mergeRecords(base, withoutSyntheticSso))
}

function mergeRecords(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(overlay)) {
    const previous = merged[key]
    merged[key] = isRecord(previous) && isRecord(value)
      ? mergeRecords(previous, value)
      : value
  }
  return merged
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
