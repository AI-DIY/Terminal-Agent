import { extractBridgeLaunchMetadata } from './bridge-diagnostics'
import { AccessClientLaunchFailure, formatAccessClientLaunchFailure } from './launch-failure'

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
    } catch (error) {
      const failure = error instanceof AccessClientLaunchFailure
        ? error
        : new AccessClientLaunchFailure('transport-connect-failed')
      this.publishFailure(formatAccessClientLaunchFailure(failure.code, extractBridgeLaunchMetadata(argv)?.logPath))
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
