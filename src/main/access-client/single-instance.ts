export type AccessClientElectronApp = {
  requestSingleInstanceLock(): boolean
  quit(): void
  on(event: 'second-instance', listener: (_event: unknown, argv: string[]) => void): void
}

type AccessClientLauncher = {
  tryOpenFromArgv(argv: readonly string[]): Promise<boolean>
}

export function configureAccessClientSingleInstance(app: AccessClientElectronApp, launcher: AccessClientLauncher): boolean {
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return false
  }
  app.on('second-instance', (_event, argv) => {
    void launcher.tryOpenFromArgv(argv)
  })
  return true
}
