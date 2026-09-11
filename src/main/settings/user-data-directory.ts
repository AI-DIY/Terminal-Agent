import { cp, readFile, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { resolveSsoConfigHomeDirectory } from './sso-config-home'

type ElectronPathName = 'home' | 'userData'

const legacyUserDataMigrationMarkerName = '.terminal-agent-user-data-migration-v1'
const legacyUserDataMigrationMarkerContents = 'complete\n'
const excludedLegacyUserDataEntries = new Set([
  'SingletonCookie',
  'SingletonLock',
  'SingletonSocket',
  'DevToolsActivePort',
  legacyUserDataMigrationMarkerName,
])

export type UserDataPathApp = {
  getPath(name: ElectronPathName): string
  isPackaged: boolean
  setPath?: (name: 'userData', path: string) => void
}

export type UserDataDirectoryEnvironment = {
  TERMINAL_AGENT_E2E?: string
  TERMINAL_AGENT_TEST_SSO_HOME?: string
}

export type TerminalAgentUserDataDirectory = {
  /** The home directory used for user-owned Terminal-Agent data. */
  homeDirectory: string
  /**
   * The root used for user-config.yml and its migration sources. Explicit and
   * E2E profiles use their active Electron profile rather than a real home.
   */
  userConfigHomeDirectory?: string
  /** The active Electron userData directory after configuration. */
  directory: string
  /** The prior Electron userData directory to copy once, when applicable. */
  legacyDirectory?: string
}

export type UserDataCopyFileSystem = {
  copy: (source: string, destination: string, options: {
    recursive: true
    force: false
    errorOnExist: false
    filter: (source: string, destination: string) => boolean
  }) => Promise<void>
  readFile?: (path: string) => Promise<string>
  writeFile?: (path: string, contents: string) => Promise<void>
}

/**
 * Keeps every application-managed data file beneath the same user-visible
 * directory as user-config.yml. Explicit test and diagnostic profiles retain
 * their requested --user-data-dir isolation.
 */
export function configureTerminalAgentUserDataDirectory(options: {
  app: UserDataPathApp
  environment?: UserDataDirectoryEnvironment
  argv?: readonly string[]
  platform?: NodeJS.Platform
}): TerminalAgentUserDataDirectory {
  const environment = options.environment ?? process.env
  const platform = options.platform ?? process.platform
  const homeDirectory = resolveSsoConfigHomeDirectory(
    options.app.getPath('home'),
    environment,
    options.app.isPackaged,
  )
  const currentDirectory = options.app.getPath('userData')

  const explicitUserDataDirectory = hasExplicitUserDataDirectory(options.argv ?? process.argv)
  // A user who explicitly selects an Electron profile expects every setting
  // and migration source to remain in that profile. An E2E run always uses
  // both an explicit profile and a separate temporary SSO home; in that case
  // the isolated SSO home stays authoritative so tests never read or write the
  // developer's real config, and never fall back to the real home for E2E.
  if (environment.TERMINAL_AGENT_E2E === '1' || explicitUserDataDirectory) {
    const e2eHomeIsIsolated = environment.TERMINAL_AGENT_E2E === '1'
      && !sameDirectory(homeDirectory, options.app.getPath('home'), platform)
    return {
      homeDirectory,
      userConfigHomeDirectory: e2eHomeIsIsolated ? homeDirectory : currentDirectory,
      directory: currentDirectory,
    }
  }

  const canonicalDirectory = join(homeDirectory, '.terminal-agent')
  if (sameDirectory(currentDirectory, canonicalDirectory, platform)) {
    return {
      homeDirectory,
      userConfigHomeDirectory: homeDirectory,
      directory: canonicalDirectory,
    }
  }

  // Electron always provides setPath in production. Keeping the fallback
  // makes this small boundary safe for lightweight test doubles as well.
  if (typeof options.app.setPath !== 'function') {
    return {
      homeDirectory,
      userConfigHomeDirectory: homeDirectory,
      directory: currentDirectory,
    }
  }
  options.app.setPath('userData', canonicalDirectory)
  return {
    homeDirectory,
    userConfigHomeDirectory: homeDirectory,
    directory: canonicalDirectory,
    legacyDirectory: currentDirectory,
  }
}

/**
 * Copies the previous Electron profile into the canonical directory without
 * overwriting any file already written there. The old directory is retained,
 * so rollback and manual recovery remain possible after an upgrade.
 */
export async function migrateLegacyUserDataDirectory(
  location: TerminalAgentUserDataDirectory,
  fileSystem: UserDataCopyFileSystem = { copy: cp },
): Promise<boolean> {
  if (!location.legacyDirectory || sameDirectory(location.legacyDirectory, location.directory, process.platform)) {
    return false
  }

  const migrationMarkerPath = join(location.directory, legacyUserDataMigrationMarkerName)
  const readMigrationMarker = fileSystem.readFile ?? (path => readFile(path, 'utf8'))
  const writeMigrationMarker = fileSystem.writeFile ?? ((path, contents) => writeFile(path, contents, 'utf8'))
  if (await hasCompletedLegacyUserDataMigration(migrationMarkerPath, readMigrationMarker)) return false

  try {
    await fileSystem.copy(location.legacyDirectory, location.directory, {
      recursive: true,
      force: false,
      errorOnExist: false,
      filter: shouldCopyLegacyUserDataEntry,
    })
  } catch (error) {
    if (isMissingPath(error)) return false
    throw error
  }

  // Write this only after a successful complete copy. A failed copy or marker
  // write remains retryable, while a durable marker prevents old files from
  // being reintroduced after a user removes them from the new profile.
  await writeMigrationMarker(migrationMarkerPath, legacyUserDataMigrationMarkerContents)
  return true
}

function hasExplicitUserDataDirectory(argv: readonly string[]): boolean {
  return argv.some((argument, index) => argument.startsWith('--user-data-dir=')
    || (argument === '--user-data-dir' && index < argv.length - 1))
}

function shouldCopyLegacyUserDataEntry(source: string): boolean {
  // These files describe one running Chromium instance. They cannot contain
  // durable application data and can prevent the new profile from starting.
  // The completion marker is excluded so a partial copy cannot mark itself
  // complete before every legacy entry has been transferred.
  return !excludedLegacyUserDataEntries.has(basename(source))
}

async function hasCompletedLegacyUserDataMigration(
  markerPath: string,
  readMigrationMarker: (path: string) => Promise<string>,
): Promise<boolean> {
  try {
    return await readMigrationMarker(markerPath) === legacyUserDataMigrationMarkerContents
  } catch (error) {
    if (isMissingPath(error)) return false
    throw error
  }
}

function sameDirectory(left: string, right: string, platform: NodeJS.Platform): boolean {
  const normalize = (value: string): string => {
    const normalized = resolve(value)
    return platform === 'win32' ? normalized.toLowerCase() : normalized
  }
  return normalize(left) === normalize(right)
}

function isMissingPath(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
