const launchFailureMessage = '无法建立 AccessClient 会话。请检查启动参数、连接状态和本次凭据。'

type AccessClientLauncher = {
  tryOpenFromArgv(argv: readonly string[]): Promise<boolean>
}

export class AccessClientLaunchController {
  private readonly failures: string[] = []
  private readonly listeners = new Set<(message: string) => void>()

  constructor(private readonly launcher: AccessClientLauncher) {}

  async tryOpenFromArgv(argv: readonly string[]): Promise<boolean> {
    try {
      return await this.launcher.tryOpenFromArgv(argv)
    } catch {
      this.publishFailure(launchFailureMessage)
      return false
    }
  }

  snapshot(): string[] {
    return [...this.failures]
  }

  onFailure(listener: (message: string) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private publishFailure(message: string): void {
    this.failures.push(message)
    for (const listener of this.listeners) listener(message)
  }
}
