import { describe, expect, it } from 'vitest'
import { readTempSession } from '../../../src/main/access-client/temp-session-reader'

describe('readTempSession', () => {
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

  it('uses a fixed sanitized error when the temporary session file cannot be read', async () => {
    const temporaryPath = 'C:\\Users\\test-user\\AppData\\Local\\Temp\\sensitive-session.conf'

    await expect(readTempSession(temporaryPath, async () => {
      throw new Error('disk access denied')
    })).rejects.toThrow('Unable to read AccessClient session')
    await expect(readTempSession(temporaryPath, async () => {
      throw new Error('disk access denied')
    })).rejects.not.toThrow(temporaryPath)
  })
})
