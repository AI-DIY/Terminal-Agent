import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileDirectSessionRepository } from '../../../src/main/ssh/direct-session-repository'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('FileDirectSessionRepository', () => {
  it('stores only direct-session metadata in JSON and retrieves an encrypted password separately', async () => {
    const { repository, secrets, metadataPath } = await createRepository()

    await repository.save({
      id: 'prod-api', name: '生产 API', host: 'api.example.com', port: 22, username: 'ops',
      auth: { kind: 'password', password: 'secret-password' },
    })

    await expect(repository.list()).resolves.toEqual([{
      id: 'prod-api', name: '生产 API', host: 'api.example.com', port: 22, username: 'ops', authKind: 'password',
    }])
    await expect(repository.load('prod-api')).resolves.toEqual({
      id: 'prod-api', name: '生产 API', host: 'api.example.com', port: 22, username: 'ops',
      auth: { kind: 'password', password: 'secret-password' },
    })
    await expect(readFile(metadataPath, 'utf8')).resolves.not.toContain('secret-password')
    expect(secrets.save).toHaveBeenCalledWith('direct-session:prod-api:password', 'secret-password')
  })

  it('keeps only the private-key path in metadata and clears stale password secrets', async () => {
    const { repository, secrets, metadataPath } = await createRepository()

    await repository.save({
      id: 'prod-api', name: '生产 API', host: 'api.example.com', port: 22, username: 'ops',
      auth: { kind: 'privateKey', privateKeyPath: 'C:\\keys\\prod.ppk', passphrase: 'key-phrase' },
    })

    await expect(repository.list()).resolves.toEqual([{
      id: 'prod-api', name: '生产 API', host: 'api.example.com', port: 22, username: 'ops',
      authKind: 'privateKey', privateKeyPath: 'C:\\keys\\prod.ppk',
    }])
    await expect(repository.load('prod-api')).resolves.toEqual({
      id: 'prod-api', name: '生产 API', host: 'api.example.com', port: 22, username: 'ops',
      auth: { kind: 'privateKey', privateKeyPath: 'C:\\keys\\prod.ppk', passphrase: 'key-phrase' },
    })
    await expect(readFile(metadataPath, 'utf8')).resolves.not.toContain('key-phrase')
    expect(secrets.save).toHaveBeenCalledWith('direct-session:prod-api:passphrase', 'key-phrase')
    expect(secrets.remove).toHaveBeenCalledWith('direct-session:prod-api:password')
  })

  it('deletes metadata and every possible secret when a direct profile is removed', async () => {
    const { repository, secrets } = await createRepository()
    await repository.save({
      id: 'prod-api', name: '生产 API', host: 'api.example.com', port: 22, username: 'ops',
      auth: { kind: 'password', password: 'secret-password' },
    })
    secrets.remove.mockClear()

    await repository.remove('prod-api')

    await expect(repository.list()).resolves.toEqual([])
    await expect(repository.load('prod-api')).rejects.toThrow('Saved direct SSH session not found: prod-api')
    expect(secrets.remove).toHaveBeenCalledWith('direct-session:prod-api:password')
    expect(secrets.remove).toHaveBeenCalledWith('direct-session:prod-api:passphrase')
  })
})

async function createRepository() {
  const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-direct-sessions-'))
  directories.push(directory)
  const values = new Map<string, string>()
  const secrets = {
    load: vi.fn(async (key: string) => values.get(key) ?? null),
    save: vi.fn(async (key: string, value: string) => { values.set(key, value) }),
    remove: vi.fn(async (key: string) => { values.delete(key) }),
  }
  return {
    repository: new FileDirectSessionRepository(join(directory, 'direct-sessions.json'), secrets),
    secrets,
    metadataPath: join(directory, 'direct-sessions.json'),
  }
}
