/**
 * Renderer/main-process projection of a live SSH connection that can provide
 * recent output to the AI workspace.  This deliberately contains display
 * metadata only; credentials and transport details never cross the boundary.
 */
export type ChatContextConnection = {
  id: string
  hostname: string
  observedHostname?: string
  title?: string
  status?: 'open' | 'closed' | string
}

/**
 * Whether the renderer has received metadata for every SSH association in a
 * task. The connection snapshot and task association snapshot arrive over
 * separate IPC paths, so a partial list must not be mistaken for a user's
 * deliberate selection.
 */
export function chatContextSessionsAreResolved(
  associatedSessionCount: number,
  resolvedSessionCount: number,
): boolean {
  return associatedSessionCount === 0 || resolvedSessionCount >= associatedSessionCount
}

/**
 * Normalize a user-provided selection against currently live connections.
 * `undefined` means the caller did not provide a selection.  The AI workspace
 * deliberately treats that just like an explicit empty array: SSH output is
 * opt-in and is not appended until the user checks a host.
 */
export function normalizeChatContextSessionIds(
  connections: readonly ChatContextConnection[],
  requested: readonly string[] | undefined,
): string[] {
  if (requested === undefined) return []
  const available = new Set(
    connections
      .filter(connection => connection.status === undefined || connection.status === 'open')
      .map(connection => connection.id),
  )
  const result: string[] = []
  const seen = new Set<string>()
  for (const id of requested) {
    if (!available.has(id) || seen.has(id)) continue
    seen.add(id)
    result.push(id)
  }
  return result
}
