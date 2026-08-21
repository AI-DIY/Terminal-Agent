import { describe, expect, it, vi } from 'vitest'
import {
  linuxProcessCommand,
  linuxReadOnlyCommands,
  ObservationRunner,
} from '../../../src/main/observation/observation-runner'

describe('ObservationRunner', () => {
  it('drops synthetic bare credential formats from recursive observation facts', async () => {
    for (const value of syntheticBareCredentials) {
      const facts = await new ObservationRunner(async command => {
        if (command === 'hostname') return 'api-prod\n'
        if (command === 'uname -s') return 'Linux\n'
        if (command === 'uname -r') return `${value}\n`
        return ''
      }).collectFacts('linux', {
        scopes: { identity: true, hardware: false, processes: false, runtime: false },
      })

      expect(facts.operatingSystem).toEqual({ name: 'Linux' })
      expect(JSON.stringify(facts)).not.toContain(value)
    }
  })

  it('collects the four bounded V18 categories from fixed read-only commands', async () => {
    const execute = vi.fn(async (command: string) => {
      if (command === 'hostname') return 'api-prod\n'
      if (command === 'uname -s') return 'Linux\n'
      if (command === 'uname -r') return '6.1.0\n'
      if (command === 'uname -m') return 'x86_64\n'
      if (command.includes('model name')) return 'Example CPU\n'
      if (command.includes('_NPROCESSORS_ONLN')) return '8\n'
      if (command.includes('MemTotal')) return '8388608\n'
      if (command.startsWith('lsblk ')) return 'sda 128000000000 disk\nloop0 100 loop\n'
      if (command.startsWith('ip -o addr')) return '2: eth0    inet 192.0.2.10/24 scope global eth0\n2: eth0    inet6 2001:db8::10/64 scope global\n'
      if (command.startsWith('for p in /proc/')) return '1842\tapi-server\t/srv/apps/api\n'
      if (command === 'id -un') return 'appuser\n'
      if (command === 'pwd -P') return '/srv/apps/api\n'
      if (command.startsWith('systemctl ')) return 'nginx.service loaded active running nginx\n'
      return ''
    })

    const facts = await new ObservationRunner(execute).collectFacts('linux', {
      connectionIp: '192.0.2.10',
      scopes: { identity: true, hardware: true, processes: true, runtime: true },
    })

    expect(facts).toEqual({
      hostname: 'api-prod', observedAt: expect.any(String), connectionIp: '192.0.2.10',
      operatingSystem: { name: 'Linux', version: '6.1.0' },
      cpu: { model: 'Example CPU', architecture: 'x86_64', logicalCores: 8 },
      memory: { totalBytes: 8_589_934_592 },
      disks: [{ name: 'sda', totalBytes: 128_000_000_000 }],
      networkInterfaces: [{ name: 'eth0', addresses: ['192.0.2.10', '2001:db8::10'] }],
      processes: [{ name: 'api-server', pid: 1842, workingDirectory: '/srv/apps/api' }],
      currentUser: 'appuser', workingDirectory: '/srv/apps/api',
      services: { 'nginx.service': 'active running' },
    })
    expect(facts).not.toHaveProperty('legacyFacts')
    expect(execute.mock.calls.flat().join('\n')).not.toMatch(/(?:cmdline|environ|printenv)/)
  })

  it('preserves the filesystem root as a legitimate runtime and process working directory', async () => {
    const execute = vi.fn(async (command: string) => {
      if (command === linuxProcessCommand) return '1\tinit\t/\n'
      if (command === 'id -un') return 'root\n'
      if (command === 'pwd -P') return '/\n'
      return ''
    })

    const facts = await new ObservationRunner(execute).collectFacts('linux', {
      knownHostname: 'api-prod',
      scopes: { identity: false, hardware: false, processes: true, runtime: true },
    })

    expect(facts.processes).toEqual([{ name: 'init', pid: 1, workingDirectory: '/' }])
    expect(facts.workingDirectory).toBe('/')
  })

  it('runs only process reads when only the V18 process scope is enabled', async () => {
    const execute = vi.fn(async (command: string) => command === 'hostname' ? 'api-prod\n' : '')
    await new ObservationRunner(execute).collectFacts('linux', {
      scopes: { identity: false, hardware: false, processes: true, runtime: false },
    })
    const commands = execute.mock.calls.map(([command]) => command)
    expect(commands[0]).toBe('hostname')
    expect(commands.slice(1)).toHaveLength(1)
    expect(commands[1]).toContain('/proc/[0-9]*')
  })

  it('checks the current gate before every remote read', async () => {
    let allowed = true
    const commands: string[] = []
    const runner = new ObservationRunner(async command => { commands.push(command); allowed = false; return command === 'hostname' ? 'api-prod\n' : '' })
    await runner.collectFacts('linux', { beforeCommand: async () => allowed })
    expect(commands).toEqual(['hostname'])
  })
  it('stops before the next scoped read when that scope is disabled', async () => {
    let processes = true
    const commands: string[] = []
    const runner = new ObservationRunner(async command => { commands.push(command); processes = false; return '' })
    await runner.collectFacts('linux', {
      knownHostname: 'api-prod',
      scopes: { identity: false, hardware: false, processes: true, runtime: false },
      beforeCommand: async () => processes,
    })
    expect(commands).toEqual([linuxProcessCommand])
  })
  it('sends only its fixed read-only Linux observation commands', async () => {
    const execute = vi.fn().mockResolvedValue('ok')
    await new ObservationRunner(execute).run('linux')

    expect(execute.mock.calls.flat()).toEqual([...linuxReadOnlyCommands])
    expect(execute.mock.calls.flat().join('\n')).toContain('systemctl list-units --type=service --state=running,failed --no-pager --no-legend')
    expect(execute.mock.calls.flat().join('\n')).not.toMatch(/\b(kill|rm|vi|systemctl\s+restart)\b/)
    expect(execute.mock.calls.flat().join('\n')).not.toMatch(/(?:cmdline|environ|printenv)/)
  })

  it('collects only bounded hardware structures when only hardware is enabled', async () => {
    const execute = vi.fn((command: string) => Promise.resolve(command === 'hostname' ? 'api-prod\n' : ''))
    const runner = new ObservationRunner(execute)
    const scopes = { identity: false, hardware: true, processes: false, runtime: false }
    const facts = await runner.collectFacts('linux', { scopes })

    expect(facts.disks).toEqual([])
    expect(facts.networkInterfaces).toEqual([])
    expect(facts).not.toHaveProperty('operatingSystem')
    expect(facts).not.toHaveProperty('processes')
    expect(facts).not.toHaveProperty('services')
  })

  it('does not run category reads when every scope is disabled', async () => {
    const execute = vi.fn((command: string) => Promise.resolve(command === 'hostname' ? 'api-prod\n' : ''))
    const facts = await new ObservationRunner(execute).collectFacts('linux', {
      scopes: { identity: false, hardware: false, processes: false, runtime: false },
    })

    expect(execute.mock.calls.flat()).toEqual(['hostname'])
    expect(facts).toEqual({ hostname: 'api-prod', observedAt: expect.any(String) })
  })
})

const syntheticBareCredentials = [
  'sk-proj-00000000000000000000000000000000',
  'ghp_000000000000000000000000000000000000',
  'AKIA0000000000000000',
  'eyJzeW50aGV0aWMiOiJ0ZXN0In0.eyJub25mdW5jdGlvbmFsIjp0cnVlfQ.invalidsignature',
  'Bearer synthetic-nonfunctional-value-00000000',
] as const
