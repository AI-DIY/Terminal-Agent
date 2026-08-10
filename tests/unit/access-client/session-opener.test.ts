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
})

function createSessions() {
  return {
    connect: vi.fn().mockResolvedValue({ id: 's1' }),
    connectAccessSsh: vi.fn().mockResolvedValue({ id: 's1' }),
    connectRaw: vi.fn().mockResolvedValue({ id: 's1' }),
  }
}
