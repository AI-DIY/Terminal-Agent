import { ipcMain, type WebContents } from 'electron'

type LaunchFailureSource = {
  snapshot(): string[]
  onFailure(listener: (message: string) => void): () => void
}

export function registerAccessClientLaunchHandlers(source: LaunchFailureSource, sender: WebContents): () => void {
  ipcMain.handle('access-client:errors', event => {
    if (event.sender !== sender) throw new Error('Untrusted renderer')
    return source.snapshot()
  })
  const unsubscribe = source.onFailure(message => sender.send('access-client:error', message))
  return () => {
    unsubscribe()
    ipcMain.removeHandler('access-client:errors')
  }
}
