import { describe, expect, it, vi } from 'vitest'
import { AccessClientService } from '../../../src/main/access-client/access-client-service'
import { AccessSessionResolver } from '../../../src/main/access-client/access-session-resolver'
import { SavedSessionRepository } from '../../../src/main/access-client/saved-session-repository'

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
      host: 'server-a', port: 22, username: 'ops', password: undefined, title: 'prod', columns: 80, rows: 24,
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

    expect(openRaw).toHaveBeenCalledWith({ host: '127.0.0.1', port: 22022, title: 'Raw 22022', columns: 80, rows: 24 })
    expect(openSsh).not.toHaveBeenCalled()
  })
})
