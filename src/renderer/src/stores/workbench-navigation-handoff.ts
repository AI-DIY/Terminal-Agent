/**
 * A one-shot in-memory handoff for an authenticated WorkbenchView that opens
 * Settings or Skills. It is renderer-local and is neither persisted nor sent
 * over IPC.
 */
export type WorkbenchNavigationHandoff = Readonly<{ selectedChatId: string }>

let pending: WorkbenchNavigationHandoff | null = null

export function setWorkbenchNavigationHandoff(selectedChatId: string | null | undefined): void {
  const normalized = selectedChatId?.trim()
  pending = normalized ? { selectedChatId: normalized } : null
}

export function consumeWorkbenchNavigationHandoff(): WorkbenchNavigationHandoff | null {
  const current = pending
  pending = null
  return current ? { ...current } : null
}

export function clearWorkbenchNavigationHandoff(): void {
  pending = null
}
