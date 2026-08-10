export type BridgeLaunchMetadata = {
  logPath: string
  launchId: string
}

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

function argumentValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  const value = index >= 0 ? argv[index + 1]?.trim() : undefined
  return value || undefined
}
