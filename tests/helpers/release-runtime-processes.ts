export interface RuntimeProcessIdentity {
  processId: number
  executablePath: string
  creationDate: string
}

export function runtimeProcessIdentityKey(identity: RuntimeProcessIdentity): string {
  return `${identity.processId}:${normalizeExecutablePath(identity.executablePath)}:${identity.creationDate}`
}

export function ownsRuntimeProcess(
  current: RuntimeProcessIdentity | undefined,
  expected: RuntimeProcessIdentity,
): boolean {
  if (current === undefined || current.processId !== expected.processId) return false
  return normalizeExecutablePath(current.executablePath) === normalizeExecutablePath(expected.executablePath)
    && current.creationDate === expected.creationDate
}

export async function terminateOwnedRuntimeProcess(
  expected: RuntimeProcessIdentity,
  readCurrent: (processId: number) => Promise<RuntimeProcessIdentity | undefined>,
  terminate: (processId: number) => Promise<void>,
): Promise<void> {
  const current = await readCurrent(expected.processId)
  if (!ownsRuntimeProcess(current, expected)) return
  await terminate(expected.processId)
}

export function selectNewRuntimeProcessId(
  runtimeProcessIds: readonly number[],
  preexistingRuntimeProcessIds: ReadonlySet<number>,
): number | undefined {
  return runtimeProcessIds.find(processId => !preexistingRuntimeProcessIds.has(processId))
}

function normalizeExecutablePath(path: string): string {
  return path.replace(/\//g, '\\').replace(/[\\]+$/, '').toLowerCase()
}
