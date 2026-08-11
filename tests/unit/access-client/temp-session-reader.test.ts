import { describe, expect, it } from 'vitest'
import { readTempSession } from '../../../src/main/access-client/temp-session-reader'
import { AccessClientLaunchFailure } from '../../../src/main/access-client/launch-failure'

describe('readTempSession', () => {
  it('defaults an AccessClient direct-mode temporary profile without Protocol to SSH', async () => {
    await expect(readTempSession('C:\\temp\\access-client.conf', async () => Buffer.from([
      'NoRemoteWinTitle=0',
      'LineCodePage=UTF-8',
      'HostName=192.0.2.10',
      'mode=direct',
      'PortNumber=22',
      'TermHeight=24',
      'TermWidth=80',
      'UserName=test-user',
      'websid=00000000-0000-0000-0000-000000000000',
      'WinTitle=AccessClient session',
    ].join('\n'), 'utf8'))).resolves.toEqual({
      host: '192.0.2.10',
      port: 22,
      username: 'test-user',
      protocol: 'ssh',
      title: 'AccessClient session',
      columns: 80,
      rows: 24,
      lineCodePage: 'UTF-8',
    })
  })

  it('accepts a Raw temporary profile without a hostname for the compatibility fallback', async () => {
    await expect(readTempSession('C:\\temp\\raw.conf', async () => Buffer.from([
      'PortNumber=22022',
      'UserName=',
      'Protocol=raw',
      'WinTitle=堡垒机会话',
    ].join('\n'), 'utf8'))).resolves.toEqual({
      host: '',
      port: 22022,
      username: '',
      protocol: 'raw',
      title: '堡垒机会话',
      columns: 80,
      rows: 24,
    })
  })

  it('gives a Raw temporary profile without a hostname or title a local display title', async () => {
    await expect(readTempSession('C:\\temp\\raw.conf', async () => Buffer.from([
      'PortNumber=22022',
      'Protocol=raw',
    ].join('\n'), 'utf8'))).resolves.toMatchObject({
      host: '',
      port: 22022,
      protocol: 'raw',
      title: 'Raw 22022',
    })
  })

  it('uses a typed sanitized error when the temporary session file cannot be read', async () => {
    const temporaryPath = 'C:\\Users\\test-user\\AppData\\Local\\Temp\\sensitive-session.conf'

    await expect(readTempSession(temporaryPath, async () => {
      throw new Error('disk access denied')
    })).rejects.toMatchObject({ code: 'temporary-profile-unreadable' } satisfies Partial<AccessClientLaunchFailure>)
    await expect(readTempSession(temporaryPath, async () => {
      throw new Error('disk access denied')
    })).rejects.not.toThrow(temporaryPath)
  })

  it('uses a typed error for an invalid temporary profile without exposing its path', async () => {
    const temporaryPath = 'C:\\Users\\test-user\\AppData\\Local\\Temp\\sensitive-session.conf'

    await expect(readTempSession(temporaryPath, async () => Buffer.from('Protocol=ssh\n', 'utf8')))
      .rejects.toMatchObject({ code: 'temporary-profile-invalid' } satisfies Partial<AccessClientLaunchFailure>)
  })

  it('rejects an explicitly unsupported temporary profile protocol', async () => {
    await expect(readTempSession('C:\\temp\\unsupported.conf', async () => Buffer.from([
      'HostName=192.0.2.10',
      'PortNumber=23',
      'UserName=test-user',
      'Protocol=telnet',
    ].join('\n'), 'utf8')))
      .rejects.toMatchObject({ code: 'temporary-profile-invalid' } satisfies Partial<AccessClientLaunchFailure>)
  })
})
