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
  if (primaryFailure === undefined && failures.length > 0) {
    throw new AggregateError(failures, 'Release launcher cleanup failed')
  }
}
