type BeforeQuitEvent = { preventDefault(): void }

type QuitApplication = {
  on(event: 'before-quit', listener: (event: BeforeQuitEvent) => void): unknown
  removeListener(event: 'before-quit', listener: (event: BeforeQuitEvent) => void): unknown
  quit(): void
}

export function registerGracefulApplicationShutdown(
  app: QuitApplication,
  closeSessions: () => void,
  drainHistory: () => Promise<void>,
): () => void {
  let shuttingDown = false
  let persistenceFinished = false
  const beforeQuit = (event: BeforeQuitEvent): void => {
    if (persistenceFinished) return
    event.preventDefault()
    if (shuttingDown) return
    shuttingDown = true
    void (async () => {
      try { closeSessions() } catch { /* Shutdown continues even if a transport fails to close. */ }
      try { await drainHistory() } catch { /* History errors are already reported through its fixed local event. */ }
      persistenceFinished = true
      app.quit()
    })()
  }
  app.on('before-quit', beforeQuit)
  return () => app.removeListener('before-quit', beforeQuit)
}
