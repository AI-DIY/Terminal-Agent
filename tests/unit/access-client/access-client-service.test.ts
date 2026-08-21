import { describe, expect, it, vi } from 'vitest'
import { AccessClientService } from '../../../src/main/access-client/access-client-service'
import { AccessSessionResolver } from '../../../src/main/access-client/access-session-resolver'
import { SavedSessionRepository } from '../../../src/main/access-client/saved-session-repository'
import { createBridgeDiagnostics } from '../../../src/main/access-client/bridge-diagnostics'

describe('AccessClientService', () => {
  it('opens a saved SSH profile as a new session without adding a user-facing connection type', async () => {
    const openSsh = vi.fn().mockResolvedValue({ id: 's1' })
    const openRaw = vi.fn()
    const service = new AccessClientService(
      new AccessSessionResolver(new SavedSessionRepository([{
        name: 'prod', host: 'server-a', port: 22, username: 'ops', protocol: 'ssh', title: 'prod', columns: 80, rows: 24,
      }]), async () => { throw new Error('not used') }),
      { openSsh, openRaw },
    )

    await service.openFromArgv(['Terminal-Agent.exe', '@prod'])

    expect(openSsh).toHaveBeenCalledWith({
      host: 'server-a', port: 22, username: 'ops', password: undefined, title: 'prod', columns: 80, rows: 24, profileId: 'prod',
    })
    expect(openRaw).not.toHaveBeenCalled()
  })

  it('opens the raw AccessClient fallback through the internal local port', async () => {
    const openSsh = vi.fn()
    const openRaw = vi.fn().mockResolvedValue({ id: 's2' })
    const service = new AccessClientService(
      new AccessSessionResolver(new SavedSessionRepository(), async () => { throw new Error('not used') }),
      { openSsh, openRaw },
    )

    await service.openFromArgv(['Terminal-Agent.exe', '-raw', '-P', '22022'])

    expect(openRaw).toHaveBeenCalledWith({ host: '127.0.0.1', port: 22022, title: 'Raw 22022', columns: 80, rows: 24, profileId: 'raw:22022' })
    expect(openSsh).not.toHaveBeenCalled()
  })

  it('records one redacted trace for a temporary SSH launch', async () => {
    const lines: string[] = []
    const openSsh = vi.fn().mockResolvedValue({ id: 's3' })
    const service = new AccessClientService(
      new AccessSessionResolver(
        new SavedSessionRepository(),
        async () => ({ host: 'bastion-target', port: 2222, username: 'ops', protocol: 'ssh' as const, title: '堡垒机', columns: 80, rows: 24 }),
      ),
      { openSsh, openRaw: vi.fn() },
      createBridgeDiagnostics(async (_path, line) => { lines.push(line) }),
    )

    await expect(service.tryOpenFromArgv([
      'Terminal-Agent-runtime.exe',
      '--terminal-agent-bridge-log', 'D:\\Assess\\putty-bridge.log',
      '--terminal-agent-bridge-id', 'launch-003',
      '--', '-load', 'tmp:C:\\Temp\\session.conf', '-pw', 'password-secret',
    ])).resolves.toBe(true)

    const trace = lines.join('')
    expect(trace).toContain('"launchId":"launch-003"')
    expect(trace).toContain('"event":"invocation-parsed"')
    expect(trace).toContain('"event":"transport-opening"')
    expect(trace).toContain('"event":"session-opened"')
    expect(trace).not.toContain('password-secret')
  })
})
