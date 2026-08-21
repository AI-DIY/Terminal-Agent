export const MAX_VISIBLE_PANES = 4

export function selectVisiblePane(
  visibleSessionIds: readonly string[],
  selectedSessionId: string,
  previouslyActiveSessionId: string | null,
  requestedVisibleCount = MAX_VISIBLE_PANES,
): string[] {
  const limit = clampVisibleCount(requestedVisibleCount)
  const current = [...visibleSessionIds.slice(0, limit)]
  if (current.includes(selectedSessionId)) return current
  if (current.length < limit) return [...current, selectedSessionId]

  const activeIndex = previouslyActiveSessionId ? current.indexOf(previouslyActiveSessionId) : -1
  const replacementIndex = activeIndex >= 0 ? activeIndex : 0
  return current.map((sessionId, index) => index === replacementIndex ? selectedSessionId : sessionId)
}

export function reconcileVisiblePanes(
  visibleSessionIds: readonly string[],
  availableSessionIds: readonly string[],
  activeSessionId: string | null,
  requestedVisibleCount: number,
): string[] {
  const available = new Set(availableSessionIds)
  const limit = Math.min(clampVisibleCount(requestedVisibleCount), available.size)
  const kept = [...new Set(visibleSessionIds)].filter(id => available.has(id)).slice(0, limit)

  if (activeSessionId && available.has(activeSessionId) && !kept.includes(activeSessionId) && limit > 0) {
    if (kept.length === limit) kept[kept.length - 1] = activeSessionId
    else kept.push(activeSessionId)
  }
  for (const sessionId of availableSessionIds) {
    if (kept.length >= limit) break
    if (!kept.includes(sessionId)) kept.push(sessionId)
  }
  return kept
}

function clampVisibleCount(value: number): number {
  return Math.min(MAX_VISIBLE_PANES, Math.max(1, Math.round(value)))
}
