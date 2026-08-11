import { appendFile } from 'node:fs/promises'

export type BridgeLaunchMetadata = {
  logPath: string
  launchId: string
}

export type BridgeDiagnostics = {
  record(metadata: BridgeLaunchMetadata | undefined, event: string, fields?: Record<string, string | number | boolean>): Promise<void>
}

type BridgeDiagnosticWriter = (path: string, line: string) => Promise<void>

const secretOptions = new Set([
  '-pw',
  '-pwfile',
  '--password',
  '--token',
  '--api-key',
  '--passphrase',
  '-passphrase',
])

export function extractBridgeLaunchMetadata(argv: readonly string[]): BridgeLaunchMetadata | undefined {
  const logPath = argumentValue(argv, '--terminal-agent-bridge-log')
  const launchId = argumentValue(argv, '--terminal-agent-bridge-id')
  return logPath && launchId ? { logPath, launchId } : undefined
}

export function redactLaunchArguments(argv: readonly string[]): string[] {
  return argv.map((argument, index) => {
    const previous = argv[index - 1]?.toLowerCase()
    if (previous && secretOptions.has(previous)) return '[REDACTED]'
    const lowercase = argument.toLowerCase()
    const matchingOption = [...secretOptions].find(option => lowercase.startsWith(`${option}=`))
    return matchingOption ? `${matchingOption}=[REDACTED]` : argument
  })
}

export function createBridgeDiagnostics(write: BridgeDiagnosticWriter = appendDiagnosticLine): BridgeDiagnostics {
  return {
    async record(metadata, event, fields = {}) {
      if (!metadata) return
      const line = `${JSON.stringify({
        timestamp: new Date().toISOString(),
        launchId: metadata.launchId,
        source: 'runtime',
        event,
        ...fields,
      })}\n`
      try {
        await write(metadata.logPath, line)
      } catch {
        // Diagnostics must not prevent an otherwise valid bastion launch.
      }
    },
  }
}

function argumentValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  const value = index >= 0 ? argv[index + 1]?.trim() : undefined
  return value && !value.startsWith('-') ? value : undefined
}

async function appendDiagnosticLine(path: string, line: string): Promise<void> {
  await appendFile(path, line, 'utf8')
}
