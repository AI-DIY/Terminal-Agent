export type ReleaseLauncherCleanupStep = () => Promise<void> | void

export async function runReleaseLauncherCleanup(
  primaryFailure: unknown,
  steps: readonly ReleaseLauncherCleanupStep[],
): Promise<void> {
  const failures: unknown[] = []
  for (const step of steps) {
    try {
      await step()
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length === 0) return
  throw new AggregateError(
    primaryFailure === undefined ? failures : [primaryFailure, ...failures],
    'Release launcher cleanup failed',
  )
}
