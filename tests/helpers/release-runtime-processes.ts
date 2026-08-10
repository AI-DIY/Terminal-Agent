export function selectNewRuntimeProcessId(
  runtimeProcessIds: readonly number[],
  preexistingRuntimeProcessIds: ReadonlySet<number>,
): number | undefined {
  return runtimeProcessIds.find(processId => !preexistingRuntimeProcessIds.has(processId))
}
