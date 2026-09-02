import { sshHostIdentity, sshHostnameDisplayLabels } from './shell-display-label'

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
 * Return one default connection for every host identity.  The stable
 * connection id is used when calculating ordinals, so the default remains
 * the same if the user reorders terminal cards.  A unique host has ordinal 1
 * and therefore is selected as well; duplicate hosts select only ordinal 1.
 */
export function defaultChatContextSessionIds(
  connections: readonly ChatContextConnection[],
): string[] {
  const live = connections.filter(connection => connection.status === undefined || connection.status === 'open')
  const labels = sshHostnameDisplayLabels(live.map(connection => ({
    hostname: connection.hostname,
    observedHostname: connection.observedHostname,
    displayName: connection.title,
    stableKey: connection.id,
  })))
  const selectedIdentities = new Set<string>()
  const selected: string[] = []
  live.forEach((connection, index) => {
    const identity = sshHostIdentity({
      hostname: connection.hostname,
      observedHostname: connection.observedHostname,
      displayName: connection.title,
    })
    const ordinal = labels[index]?.ordinal ?? 1
    if (ordinal !== 1 || selectedIdentities.has(identity)) return
    selectedIdentities.add(identity)
    selected.push(connection.id)
  })
  return selected
}

/**
 * Normalize a user-provided selection against currently live connections.
 * `undefined` means the caller did not provide a selection and therefore gets
 * the safe default; an explicit empty array intentionally selects no Shells.
 */
export function normalizeChatContextSessionIds(
  connections: readonly ChatContextConnection[],
  requested: readonly string[] | undefined,
): string[] {
  if (requested === undefined) return defaultChatContextSessionIds(connections)
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
