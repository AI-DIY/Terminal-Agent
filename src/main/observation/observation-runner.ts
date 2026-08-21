import { hostMemoryRecordSchema, type HostMemoryScopes } from '../../shared/contracts'
import { containsSensitiveHostMemoryData, normalizeSafeHostMemoryConnectionIp } from '../../shared/host-memory-safety'
import type { HostFacts, ObservationPlatform } from './observation-schema'

export const linuxCpuModelCommand = 'awk -F: \'/^model name[[:space:]]*:/ { sub(/^[[:space:]]+/, "", $2); print $2; exit }\' /proc/cpuinfo'
export const linuxMemoryCommand = 'awk \'/^MemTotal:/ { print $2; exit }\' /proc/meminfo'
export const linuxDiskCommand = 'lsblk -b -dn -o NAME,SIZE,TYPE | head -n 64'
export const linuxNetworkCommand = 'ip -o addr show | head -n 128'
export const linuxProcessCommand = 'for p in /proc/[0-9]*; do [ -r "$p/comm" ] || continue; pid=${p##*/}; name=$(head -n 1 "$p/comm"); cwd=$(readlink "$p/cwd" 2>/dev/null || true); printf \'%s\\t%s\\t%s\\n\' "$pid" "$name" "$cwd"; done | head -n 200'
export const linuxServiceCommand = 'systemctl list-units --type=service --state=running,failed --no-pager --no-legend | head -n 128'
export const linuxReadOnlyCommands = [
  'hostname', 'uname -s', 'uname -r', linuxCpuModelCommand, 'uname -m', 'getconf _NPROCESSORS_ONLN',
  linuxMemoryCommand, linuxDiskCommand, linuxNetworkCommand, linuxProcessCommand, 'id -un', 'pwd -P', linuxServiceCommand,
] as const
export const maxObservationOutputBytes = 256 * 1024

export type ObservationOutput = Readonly<Record<string, string>>
export type ReadOnlyCommandExecutor = (command: string) => Promise<string>
type CommandOutputObserver = (command: string, output: string) => void
export type ObservationOptions = {
  observedAt?: string
  onHostname?: (hostname: string) => void
  knownHostname?: string
  connectionIp?: string
  scopes?: HostMemoryScopes
  beforeCommand?: (command: string) => Promise<boolean>
}

export class ObservationRunner {
  constructor(private readonly execute: ReadOnlyCommandExecutor) {}

  async run(platform: ObservationPlatform, onCommandOutput?: CommandOutputObserver, scopes?: HostMemoryScopes, includeHostname = true, beforeCommand?: (command: string) => Promise<boolean>): Promise<ObservationOutput> {
    const output: Record<string, string> = {}
    for (const command of commandsFor(platform, scopes, includeHostname)) {
      if (beforeCommand && !await beforeCommand(command)) break
      try {
        output[command] = boundedOutput(await this.execute(command))
        onCommandOutput?.(command, output[command])
      } catch {
        output[command] = ''
      }
    }
    return output
  }

  async collectFacts(platform: ObservationPlatform, options: ObservationOptions = {}): Promise<HostFacts> {
    const scopes = options.scopes ?? allScopes
    const output = await this.run(platform, (command, value) => {
      if (command !== 'hostname') return
      const hostname = firstLine(value)
      if (hostname) options.onHostname?.(hostname)
    }, scopes, !options.knownHostname, options.beforeCommand)
    const hostname = options.knownHostname ?? firstLine(output.hostname)
    if (!hostname) throw new Error('Read-only observation did not return a hostname')

    const facts: HostFacts = { hostname, observedAt: options.observedAt ?? new Date().toISOString() }
    if (scopes.identity) {
      const connectionIp = safeIp(options.connectionIp)
      if (connectionIp) facts.connectionIp = connectionIp
      const name = safeText(firstLine(output['uname -s']))
      const version = safeText(firstLine(output['uname -r']))
      if (name) facts.operatingSystem = { name, ...(version ? { version } : {}) }
    }
    if (scopes.hardware) {
      const model = safeText(firstLine(output[linuxCpuModelCommand]))
      const architecture = safeIdentifier(firstLine(output['uname -m']), 64)
      const logicalCores = positiveInteger(firstLine(output['getconf _NPROCESSORS_ONLN']), 65_536)
      if (model || architecture || logicalCores) facts.cpu = { ...(model ? { model } : {}), ...(architecture ? { architecture } : {}), ...(logicalCores ? { logicalCores } : {}) }
      const memoryKib = positiveInteger(firstLine(output[linuxMemoryCommand]), Math.floor(Number.MAX_SAFE_INTEGER / 1024))
      if (memoryKib) facts.memory = { totalBytes: memoryKib * 1024 }
      facts.disks = parseDisks(output[linuxDiskCommand] ?? '')
      facts.networkInterfaces = parseNetworkInterfaces(output[linuxNetworkCommand] ?? '')
    }
    if (scopes.processes) facts.processes = parseProcesses(output[linuxProcessCommand] ?? '')
    if (scopes.runtime) {
      const currentUser = safeUser(firstLine(output['id -un']))
      const workingDirectory = safePath(firstLine(output['pwd -P']))
      if (currentUser) facts.currentUser = currentUser
      if (workingDirectory) facts.workingDirectory = workingDirectory
      facts.services = parseServices(output[linuxServiceCommand] ?? '')
    }
    return hostMemoryRecordSchema.parse(facts)
  }
}

const allScopes: HostMemoryScopes = { identity: true, hardware: true, processes: true, runtime: true }

function commandsFor(platform: ObservationPlatform, scopes: HostMemoryScopes | undefined, includeHostname: boolean): readonly string[] {
  if (platform !== 'linux') throw new Error(`Unsupported observation platform: ${platform}`)
  const selected = scopes ?? allScopes
  return [
    ...(includeHostname ? ['hostname'] : []),
    ...(selected.identity ? ['uname -s', 'uname -r'] : []),
    ...(selected.hardware ? [linuxCpuModelCommand, 'uname -m', 'getconf _NPROCESSORS_ONLN', linuxMemoryCommand, linuxDiskCommand, linuxNetworkCommand] : []),
    ...(selected.processes ? [linuxProcessCommand] : []),
    ...(selected.runtime ? ['id -un', 'pwd -P', linuxServiceCommand] : []),
  ]
}

function boundedOutput(value: string): string {
  const bytes = Buffer.from(value, 'utf8')
  return bytes.length <= maxObservationOutputBytes ? value : bytes.subarray(0, maxObservationOutputBytes).toString('utf8')
}

function firstLine(value: string | undefined): string { return value?.split(/\r?\n/, 1)[0]?.trim() ?? '' }
function safeText(value: string): string | undefined { return value && value.length <= 255 && !hasControlCharacters(value) && !containsSensitiveHostMemoryData(value) ? value : undefined }
function safeIdentifier(value: string, max: number): string | undefined { return value.length <= max && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value) ? value : undefined }
function safeUser(value: string): string | undefined { return /^[A-Za-z_][A-Za-z0-9_.-]{0,63}\$?$/.test(value) && !containsSensitiveHostMemoryData(value) ? value : undefined }
function safePath(value: string): string | undefined { return value.length <= 512 && /^\/(?:[A-Za-z0-9._+@:-]+(?:\/[A-Za-z0-9._+@:-]+)*)?$/.test(value) && !value.split('/').includes('..') && !containsSensitiveHostMemoryData(value) ? value : undefined }
function safeIp(value: string | undefined): string | undefined { try { return value ? normalizeSafeHostMemoryConnectionIp(value) : undefined } catch { return undefined } }
function positiveInteger(value: string, max: number): number | undefined { const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= max ? parsed : undefined }
function hasControlCharacters(value: string): boolean { return [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) }

function parseDisks(value: string): NonNullable<HostFacts['disks']> {
  const disks: NonNullable<HostFacts['disks']> = []
  for (const line of value.split(/\r?\n/)) {
    const [name, rawSize, type, ...extra] = line.trim().split(/\s+/)
    const totalBytes = positiveInteger(rawSize ?? '', Number.MAX_SAFE_INTEGER)
    if (extra.length || type !== 'disk' || !name || !safeIdentifier(name, 128) || !totalBytes) continue
    disks.push({ name, totalBytes })
    if (disks.length === 64) break
  }
  return disks
}

function parseNetworkInterfaces(value: string): NonNullable<HostFacts['networkInterfaces']> {
  const interfaces = new Map<string, string[]>()
  for (const line of value.split(/\r?\n/)) {
    const match = /^\d+:\s+([A-Za-z0-9][A-Za-z0-9_.:@-]{0,63})\s+inet6?\s+([^\s/]+)(?:\/\d+)?\b/.exec(line.trim())
    if (!match) continue
    const name = match[1]!
    const address = safeIp(match[2])
    if (!address) continue
    if (!interfaces.has(name) && interfaces.size === 64) continue
    const addresses = interfaces.get(name) ?? []
    if (!addresses.includes(address) && addresses.length < 16) addresses.push(address)
    interfaces.set(name, addresses)
  }
  return [...interfaces].map(([name, addresses]) => ({ name, addresses }))
}

function parseProcesses(value: string): NonNullable<HostFacts['processes']> {
  const processes: NonNullable<HostFacts['processes']> = []
  for (const line of value.split(/\r?\n/)) {
    const [rawPid, name, rawWorkingDirectory, ...extra] = line.split('\t')
    const pid = positiveInteger(rawPid?.trim() ?? '', 4_194_304)
    if (extra.length || !pid || !name || !/^[A-Za-z0-9][A-Za-z0-9.+@:_-]{0,126}$/.test(name) || /^[A-Z_][A-Z0-9_]*$/.test(name)) continue
    const workingDirectory = safePath(rawWorkingDirectory?.trim() ?? '')
    processes.push({ name, pid, ...(workingDirectory ? { workingDirectory } : {}) })
    if (processes.length === 200) break
  }
  return processes
}

function parseServices(value: string): NonNullable<HostFacts['services']> {
  const services: Record<string, string> = {}
  for (const line of value.split(/\r?\n/)) {
    const [name, , activeState, subState] = line.trim().split(/\s+/, 4)
    const status = activeState && subState ? `${activeState} ${subState}` : ''
    if (!name?.match(/^[A-Za-z0-9][A-Za-z0-9@_.:-]{0,247}\.service$/) || !status.match(/^(?:active|inactive|failed|activating|deactivating|reloading|maintenance|refreshing) [a-z][a-z0-9-]{0,63}$/)) continue
    services[name] = status
    if (Object.keys(services).length === 128) break
  }
  return services
}
