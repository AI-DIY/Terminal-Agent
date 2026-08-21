import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()) },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(value)),
    decryptString: vi.fn((value: Buffer) => value.toString()),
  },
}))

import { ElectronSecretStore } from '../../../src/main/settings/secret-store'

describe('ElectronSecretStore', () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
  })

  async function createStore(): Promise<{ store: ElectronSecretStore; filePath: string }> {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-secret-store-'))
    temporaryDirectories.push(directory)
    const filePath = join(directory, 'secrets.json')
    return { store: new ElectronSecretStore(filePath), filePath }
  }

  it('preserves concurrent writes from model and SSH owners', async () => {
    const { store } = await createStore()

    await Promise.all([
      store.save('model-profile.llm.apiKey', 'model-secret'),
      store.save('ssh.host.secret', 'ssh-secret'),
    ])

    await expect(store.load('model-profile.llm.apiKey')).resolves.toBe('model-secret')
    await expect(store.load('ssh.host.secret')).resolves.toBe('ssh-secret')
  })

  it('preserves unrelated keys when remove and save run concurrently', async () => {
    const { store, filePath } = await createStore()
    await store.save('keep', 'keep-secret')
    await store.save('remove', 'remove-secret')

    await Promise.all([
      store.remove('remove'),
      store.save('new', 'new-secret'),
    ])

    await expect(store.load('keep')).resolves.toBe('keep-secret')
    await expect(store.load('remove')).resolves.toBeNull()
    await expect(store.load('new')).resolves.toBe('new-secret')
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual(expect.objectContaining({ keep: expect.any(String), new: expect.any(String) }))
  })
})
