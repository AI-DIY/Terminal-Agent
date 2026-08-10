export const MAX_VISIBLE_PANES = 9

export function selectVisiblePane(
  visibleSessionIds: readonly string[],
  selectedSessionId: string,
  previouslyActiveSessionId: string | null,
): string[] {
  if (visibleSessionIds.includes(selectedSessionId)) return [...visibleSessionIds]
  if (visibleSessionIds.length < MAX_VISIBLE_PANES) return [...visibleSessionIds, selectedSessionId]

  const activeIndex = previouslyActiveSessionId ? visibleSessionIds.indexOf(previouslyActiveSessionId) : -1
  const replacementIndex = activeIndex >= 0 ? activeIndex : 0
  return visibleSessionIds.map((sessionId, index) => index === replacementIndex ? selectedSessionId : sessionId)
}
