import { describe, expect, it } from 'vitest'
import { createBridgeDiagnostics, extractBridgeLaunchMetadata, redactLaunchArguments } from '../../../src/main/access-client/bridge-diagnostics'

describe('bridge diagnostics', () => {
  it('extracts bridge metadata without treating it as an AccessClient option', () => {
    expect(extractBridgeLaunchMetadata([
      'Terminal-Agent-runtime.exe',
      '--terminal-agent-bridge-log', 'D:\\Assess\\putty-bridge.log',
      '--terminal-agent-bridge-id', 'launch-001',
      '--', '-load', 'tmp:C:\\Temp\\session.conf', '-pw', 'secret',
    ])).toEqual({ logPath: 'D:\\Assess\\putty-bridge.log', launchId: 'launch-001' })
  })

  it('redacts every configured credential option value', () => {
    expect(redactLaunchArguments([
      '-load', 'tmp:C:\\Temp\\session.conf',
      '-pw', 'password-secret',
      '--token', 'token-secret',
      '--api-key', 'api-key-secret',
      '--passphrase', 'passphrase-secret',
    ])).toEqual([
      '-load', 'tmp:C:\\Temp\\session.conf',
      '-pw', '[REDACTED]',
      '--token', '[REDACTED]',
      '--api-key', '[REDACTED]',
      '--passphrase', '[REDACTED]',
    ])
  })

  it('writes a correlated runtime event without credentials', async () => {
    const writes: Array<{ path: string; line: string }> = []
    const diagnostics = createBridgeDiagnostics(async (path, line) => { writes.push({ path, line }) })

    await diagnostics.record({ logPath: 'D:\\Assess\\putty-bridge.log', launchId: 'launch-002' }, 'invocation-parsed', {
      protocol: 'ssh', port: 22,
    })

    expect(writes).toHaveLength(1)
    expect(writes[0]?.path).toBe('D:\\Assess\\putty-bridge.log')
    expect(writes[0]?.line).toContain('"launchId":"launch-002"')
    expect(writes[0]?.line).toContain('"source":"runtime"')
    expect(writes[0]?.line).not.toContain('password-secret')
  })
})
