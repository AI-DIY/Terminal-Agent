import { ipcMain, type WebContents } from 'electron'
import { terminalSessionIdSchema } from '../../shared/contracts'

type SessionModeUpgradeSource = {
  upgradeFromUserAction(sessionId: string): void
}

export function registerSessionModeHandlers(source: SessionModeUpgradeSource, sender: WebContents): () => void {
  ipcMain.handle('session-modes:upgrade', (event, sessionId: unknown) => {
    if (event.sender !== sender) throw new Error('Untrusted renderer')
    const parsedSessionId = terminalSessionIdSchema.parse(sessionId)
    source.upgradeFromUserAction(parsedSessionId)
    return { sessionId: parsedSessionId, mode: 'autonomous' as const }
  })

  return () => {
    ipcMain.removeHandler('session-modes:upgrade')
  }
}
