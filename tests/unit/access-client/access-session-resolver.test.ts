import { describe, expect, it } from 'vitest'
import { AccessSessionResolver } from '../../../src/main/access-client/access-session-resolver'
import { SavedSessionRepository } from '../../../src/main/access-client/saved-session-repository'
import { readTempSession } from '../../../src/main/access-client/temp-session-reader'

const temporarySession = [
  'HostName=bastion-target',
  'PortNumber=2222',
  'UserName=ops',
  'Protocol=ssh',
  'WinTitle=生产终端',
  'TermWidth=120',
  'TermHeight=40',
  'LineCodePage=UTF-8',
  'mode=autonomous',
  'websid=not-persisted',
].join('\n')

describe('AccessSessionResolver', () => {
  it('uses the local raw fallback without surfacing a fourth UI connection option', async () => {
    const resolver = createResolver()

    await expect(resolver.resolve({ kind: 'raw-port', port: 22022 })).resolves.toMatchObject({
      connection: { host: '127.0.0.1', port: 22022, protocol: 'raw' },
    })
  })

  it('uses the local raw fallback for a temporary Raw profile without a hostname', async () => {
    const resolver = new AccessSessionResolver(
      new SavedSessionRepository(),
      async () => ({ host: '', port: 22022, username: '', protocol: 'raw', title: '堡垒机会话', columns: 80, rows: 24 }),
    )

    await expect(resolver.resolve({ kind: 'temporary-session', path: 'C:\\temp\\raw.conf' })).resolves.toMatchObject({
      connection: { host: '127.0.0.1', port: 22022, protocol: 'raw' },
      persistentProfile: { host: '', protocol: 'raw' },
    })
  })

  it('reads only supported tmp fields and does not persist the launch password', async () => {
    const profiles = new SavedSessionRepository()
    const resolver = createResolver(profiles)

    const result = await resolver.resolve({ kind: 'temporary-session', path: 'C:\\temp\\session.conf', password: 'secret' })

    expect(result.connection).toMatchObject({ host: 'bastion-target', port: 2222, username: 'ops', protocol: 'ssh', password: 'secret' })
    expect(result.persistentProfile).toEqual({
      name: '生产终端',
      host: 'bastion-target',
      port: 2222,
      username: 'ops',
      protocol: 'ssh',
      title: '生产终端',
      columns: 120,
      rows: 40,
      lineCodePage: 'UTF-8',
    })
    expect(JSON.stringify(result.persistentProfile)).not.toContain('secret')
    expect(JSON.stringify(result.persistentProfile)).not.toContain('websid')
    expect(JSON.stringify(result.persistentProfile)).not.toContain('mode')
    await expect(profiles.load('生产终端')).resolves.toEqual(result.persistentProfile)
  })

  it('resolves a saved profile and reports a missing name locally', async () => {
    const profiles = new SavedSessionRepository([{
      name: 'prod', host: 'server-a', port: 22, username: 'ops', protocol: 'ssh', title: 'prod', columns: 80, rows: 24,
    }])
    const resolver = new AccessSessionResolver(profiles, async () => { throw new Error('not used') })

    await expect(resolver.resolve({ kind: 'saved-session', name: 'prod' })).resolves.toMatchObject({
      connection: { host: 'server-a', port: 22, username: 'ops', protocol: 'ssh' },
    })
    await expect(resolver.resolve({ kind: 'saved-session', name: 'missing' })).rejects.toThrow('AccessClient session not found: missing')
  })
})

function createResolver(profiles = new SavedSessionRepository()): AccessSessionResolver {
  return new AccessSessionResolver(
    profiles,
    path => readTempSession(path, async () => Buffer.from(temporarySession, 'utf8')),
  )
}
