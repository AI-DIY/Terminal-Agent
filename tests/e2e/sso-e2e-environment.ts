import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type SsoE2eDirectories = {
  rootDir: string
  userDataDir: string
  ssoHomeDir: string
}

export type E2ePrimaryFailure = { error: unknown }

export async function createSsoE2eDirectories(prefix: string): Promise<SsoE2eDirectories> {
  const rootDir = await mkdtemp(join(tmpdir(), prefix))
  const userDataDir = join(rootDir, 'user-data')
  const ssoHomeDir = join(rootDir, 'sso-home')
  try {
    await Promise.all([mkdir(userDataDir), mkdir(ssoHomeDir)])
    return { rootDir, userDataDir, ssoHomeDir }
  } catch (error) {
    const cleanupFailures = await closeE2eResources(async () => {
      await rm(rootDir, { recursive: true, force: true })
    })
    throwCleanupFailures({ error }, cleanupFailures)
    throw error
  }
}

export function ssoE2eEnvironment(ssoHomeDir: string): Record<string, string> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
  return {
    ...inherited,
    TERMINAL_AGENT_E2E: '1',
    TERMINAL_AGENT_TEST_SSO_HOME: ssoHomeDir,
  }
}

export async function removeSsoE2eDirectories(directories: Pick<SsoE2eDirectories, 'rootDir'>): Promise<void> {
  await rm(directories.rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

export async function closeE2eResources(...close: Array<() => Promise<void>>): Promise<unknown[]> {
  const failures: unknown[] = []
  for (const resource of close) {
    try { await resource() }
    catch (error) { failures.push(error) }
  }
  return failures
}

export function throwCleanupFailures(primaryFailure: E2ePrimaryFailure | undefined, failures: unknown[]): void {
  if (primaryFailure) {
    if (failures.length > 0) {
      throw new AggregateError([primaryFailure.error, ...failures], 'E2E test and cleanup failed')
    }
    return
  }
  if (failures.length === 0) return
  if (failures.length === 1) throw failures[0]
  throw new AggregateError(failures, 'E2E resource cleanup failed')
}
