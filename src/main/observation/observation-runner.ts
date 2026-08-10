import type { HostFacts, ObservationPlatform } from './observation-schema'

export const linuxReadOnlyCommands = [
  'hostname',
  'uname -a',
  'ps -eo comm=,stat=',
  'systemctl list-units --type=service --no-pager --no-legend',
  "dpkg-query -W -f='${Package}\\t${Version}\\n'",
  "rpm -qa --qf '%{NAME}\\t%{VERSION}-%{RELEASE}\\n'",
] as const

export type ObservationOutput = Readonly<Record<string, string>>
export type ReadOnlyCommandExecutor = (command: string) => Promise<string>

export class ObservationRunner {
  constructor(private readonly execute: ReadOnlyCommandExecutor) {}

  async run(platform: ObservationPlatform): Promise<ObservationOutput> {
    const output: Record<string, string> = {}
    for (const command of commandsFor(platform)) {
      try {
        output[command] = await this.execute(command)
      } catch {
        output[command] = ''
      }
    }
    return output
  }

  async collectFacts(platform: ObservationPlatform, observedAt = new Date().toISOString()): Promise<HostFacts> {
    const output = await this.run(platform)
    const hostname = firstLine(output.hostname)
    if (!hostname) throw new Error('Read-only observation did not return a hostname')

    return {
      hostname,
      observedAt,
      software: {
        ...parsePackages(output["dpkg-query -W -f='${Package}\\t${Version}\\n'"] ?? ''),
        ...parsePackages(output["rpm -qa --qf '%{NAME}\\t%{VERSION}-%{RELEASE}\\n'"] ?? ''),
      },
      processes: parseProcesses(output['ps -eo comm=,stat='] ?? ''),
      installLocations: {},
      services: parseServices(output['systemctl list-units --type=service --no-pager --no-legend'] ?? ''),
      logLocations: [],
      configurationHashes: {},
    }
  }
}

function commandsFor(platform: ObservationPlatform): readonly string[] {
  if (platform === 'linux') return linuxReadOnlyCommands
  throw new Error(`Unsupported observation platform: ${platform}`)
}

function firstLine(value: string | undefined): string {
  return value?.split(/\r?\n/).find(Boolean)?.trim() ?? ''
}

function parsePackages(value: string): Record<string, string> {
  const packages: Record<string, string> = {}
  for (const line of value.split(/\r?\n/)) {
    const [name, version] = line.split('\t', 2).map(part => part.trim())
    if (name && version) packages[name] = version
  }
  return packages
}

function parseProcesses(value: string): HostFacts['processes'] {
  return value.split(/\r?\n/)
    .map(line => line.trim().split(/\s+/, 2))
    .filter(([name, status]) => Boolean(name && status))
    .map(([name, status]) => ({ name: name!, status: status! }))
}

function parseServices(value: string): Record<string, string> {
  const services: Record<string, string> = {}
  for (const line of value.split(/\r?\n/)) {
    const [name, , activeState, subState] = line.trim().split(/\s+/, 4)
    if (name?.endsWith('.service') && activeState && subState) services[name] = `${activeState} ${subState}`
  }
  return services
}
