import { describe, expect, it } from 'vitest'
import { createSshConnectionDiagnostics, SSH_CONNECTION_LOG_FILE_NAME, sshConnectionLogPath } from '../../../src/main/ssh/ssh-connection-diagnostics'

describe('SSH connection diagnostics', () => {
  it('writes ordered, line-delimited connection events beside the runtime', async () => {
    const writes: Array<{ path: string; line: string }> = []
    let complete!: () => void
    const written = new Promise<void>(resolve => { complete = resolve })
    const diagnostics = createSshConnectionDiagnostics(
      'C:\\Tools\\Terminal-Agent\\Terminal-Agent-runtime.exe',
      async (path, line) => {
        writes.push({ path, line })
        if (writes.length === 2) complete()
      },
    )

    diagnostics.record('connection-opening', { host: 'server-a', port: 22 })
    diagnostics.record('sftp-operation-failed', { operation: 'directory-list', error: 'channel reset' })
    await written

    expect(diagnostics.logPath).toBe('C:\\Tools\\Terminal-Agent\\logs\\ssh-connection.log')
    expect(sshConnectionLogPath('C:\\Tools\\Terminal-Agent\\Terminal-Agent-runtime.exe')).toBe(diagnostics.logPath)
    expect(writes.map(write => write.path)).toEqual([diagnostics.logPath, diagnostics.logPath])
    expect(writes[0]?.line).toContain('"event":"connection-opening"')
    expect(writes[0]?.line).toContain('"host":"server-a"')
    expect(writes[1]?.line).toContain('"event":"sftp-operation-failed"')
    expect(writes[1]?.line).toContain('"operation":"directory-list"')
  })

  it('normalizes control characters in diagnostic fields and uses a stable filename', async () => {
    const writes: string[] = []
    let complete!: () => void
    const written = new Promise<void>(resolve => { complete = resolve })
    const diagnostics = createSshConnectionDiagnostics('C:\\TA\\Terminal-Agent-runtime.exe', async (_path, line) => {
      writes.push(line)
      complete()
    })

    diagnostics.record('transport\nclosed', { error: 'peer\r\nclosed' })
    await written

    expect(SSH_CONNECTION_LOG_FILE_NAME).toBe('ssh-connection.log')
    expect(writes[0]).toContain('"event":"transport closed"')
    expect(writes[0]).toContain('"error":"peer  closed"')
  })
})
