import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileSavedSessionRepository, type SavedSessionProfile } from '../../../src/main/access-client/saved-session-repository'

describe('FileSavedSessionRepository', () => {
  it('atomically saves only the non-secret compatible profile fields', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-access-client-'))
    const path = join(directory, 'sessions.json')
    try {
      const repository = new FileSavedSessionRepository(path)
      await repository.save({
        name: 'prod', host: 'server-a', port: 22, username: 'ops', protocol: 'ssh', title: 'prod', columns: 120, rows: 40,
      })

      const persisted = await readFile(path, 'utf8')
      expect(JSON.parse(persisted)).toEqual([{
        name: 'prod', host: 'server-a', port: 22, username: 'ops', protocol: 'ssh', title: 'prod', columns: 120, rows: 40,
      }])
      await expect(new FileSavedSessionRepository(path).load('prod')).resolves.toMatchObject({ host: 'server-a', username: 'ops' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('projects runtime input onto the saved-profile whitelist before writing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-access-client-'))
    const path = join(directory, 'sessions.json')
    try {
      const repository = new FileSavedSessionRepository(path)
      await repository.save({
        ...compatibleProfile(),
        password: 'never-persist',
        privateKey: 'never-persist',
        passphrase: 'never-persist',
        temporaryPath: 'C:\\sensitive\\session.conf',
        unknown: 'never-persist',
      } as SavedSessionProfile)

      await expect(readPersisted(path)).resolves.toEqual([compatibleProfile()])
      await expect(repository.load('prod')).resolves.toEqual(compatibleProfile())
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('projects old JSON properties before a later write', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-access-client-'))
    const path = join(directory, 'sessions.json')
    try {
      await writeFile(path, JSON.stringify([{
        ...compatibleProfile(),
        password: 'old-secret',
        privateKey: 'old-secret',
        passphrase: 'old-secret',
        temporaryPath: 'C:\\sensitive\\session.conf',
        arbitraryLegacyField: 'discard-me',
      }]), 'utf8')
      const repository = new FileSavedSessionRepository(path)

      await expect(repository.load('prod')).resolves.toEqual(compatibleProfile())
      await repository.save({ ...compatibleProfile(), name: 'staging', title: 'staging' })

      await expect(readPersisted(path)).resolves.toEqual([
        compatibleProfile(),
        { ...compatibleProfile(), name: 'staging', title: 'staging' },
      ])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects invalid persisted profile values explicitly', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-access-client-'))
    const path = join(directory, 'sessions.json')
    try {
      await writeFile(path, JSON.stringify([{ ...compatibleProfile(), port: 0 }]), 'utf8')

      await expect(new FileSavedSessionRepository(path).load('prod')).rejects.toThrow('Invalid saved AccessClient session store')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('serializes simultaneous saves so each compatible profile remains in the JSON store', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-access-client-'))
    const path = join(directory, 'sessions.json')
    try {
      const repository = new FileSavedSessionRepository(path)

      await Promise.all([
        repository.save(compatibleProfile()),
        repository.save({ ...compatibleProfile(), name: 'staging', title: 'staging' }),
      ])

      await expect(readPersisted(path)).resolves.toEqual([
        compatibleProfile(),
        { ...compatibleProfile(), name: 'staging', title: 'staging' },
      ])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

function compatibleProfile(): SavedSessionProfile {
  return {
    name: 'prod', host: 'server-a', port: 22, username: 'ops', protocol: 'ssh', title: 'prod', columns: 120, rows: 40,
  }
}

async function readPersisted(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'))
}
