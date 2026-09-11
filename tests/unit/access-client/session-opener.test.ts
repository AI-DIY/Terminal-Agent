import { describe, expect, it, vi } from 'vitest'
import { createAccessClientSessionOpener } from '../../../src/main/access-client/session-opener'

describe('createAccessClientSessionOpener', () => {
  it('uses a non-secret SSH request when AccessClient did not provide a temporary password', async () => {
    const sessions = createSessions()
    const opener = createAccessClientSessionOpener(sessions)

    await opener.openSsh({ host: 'server-a', port: 2222, username: 'ops', title: '生产终端', columns: 120, rows: 40 })

    expect(sessions.connectAccessSsh).toHaveBeenCalledWith({
      host: 'server-a', port: 2222, username: 'ops', title: '生产终端', columns: 120, rows: 40,
    })
    expect(sessions.connect).not.toHaveBeenCalled()
  })

  it('keeps a provided temporary password in memory while preserving AccessClient title and initial dimensions', async () => {
    const sessions = createSessions()
    const opener = createAccessClientSessionOpener(sessions)

    await opener.openSsh({
      host: 'server-a', port: 2222, username: 'ops', password: 'temporary-secret', title: '生产终端', columns: 120, rows: 40,
    })

    expect(sessions.connectAccessSsh).toHaveBeenCalledWith({
      host: 'server-a',
      port: 2222,
      username: 'ops',
      password: 'temporary-secret',
      title: '生产终端',
      columns: 120,
      rows: 40,
    })
    expect(sessions.connect).not.toHaveBeenCalled()
  })

  it('passes a logical bastion hostname through while retaining the relay transport address', async () => {
    const sessions = createSessions()
    const opener = createAccessClientSessionOpener(sessions)

    await opener.openRaw({
      host: '127.0.0.1',
      hostname: 'app-prod-01',
      port: 22022,
      title: 'ops@app-prod-01',
      columns: 120,
      rows: 40,
    })

    expect(sessions.connectRaw).toHaveBeenCalledWith({
      host: '127.0.0.1',
      hostname: 'app-prod-01',
      port: 22022,
      title: 'ops@app-prod-01',
      columns: 120,
      rows: 40,
    })
  })
})

function createSessions() {
  return {
    connect: vi.fn().mockResolvedValue({ id: 's1' }),
    connectAccessSsh: vi.fn().mockResolvedValue({ id: 's1' }),
    connectRaw: vi.fn().mockResolvedValue({ id: 's1' }),
  }
}
