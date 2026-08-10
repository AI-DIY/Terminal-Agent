import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { KeyMaterialStore } from '../../../src/main/ssh/key-material-store'
import type { SessionService } from '../../../src/main/ssh/session-service'
import { registerSessionHandlers } from '../../../src/main/ipc/register-handlers'

const { handle, removeHandler } = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}))

vi.mock('electron', () => ({
  ipcMain: { handle, removeHandler },
}))

describe('registerSessionHandlers', () => {
  beforeEach(() => {
    handle.mockReset()
    removeHandler.mockReset()
  })

  it('rejects an invalid direct connection request before it reaches SSH', async () => {
    const sessions = createSessions()
    const sender = createSender()
    registerSessionHandlers(sessions, createKeys(), sender as never)
    const connect = handlerFor('sessions:connect')

    await expect(connect(trustedEvent(sender), {
      host: '   ',
      port: 22,
      username: 'ops',
      auth: { kind: 'password', password: 'secret' },
    })).rejects.toThrow()

    expect(sessions.connect).not.toHaveBeenCalled()
  })

  it('resolves a private-key reference only in the main process and removes all handlers on dispose', async () => {
    const sessions = createSessions()
    const keys = createKeys()
    const sender = createSender()
    const dispose = registerSessionHandlers(sessions, keys, sender as never)
    const connect = handlerFor('sessions:connect')

    await connect(trustedEvent(sender), {
      host: 'server-a',
      port: 22,
      username: 'ops',
      auth: { kind: 'privateKey', keyReference: 'key-reference', passphrase: 'phrase' },
    })

    expect(keys.take).toHaveBeenCalledWith('key-reference', 'phrase')
    expect(sessions.connect).toHaveBeenCalledWith({
      host: 'server-a',
      port: 22,
      username: 'ops',
      auth: {
        kind: 'privateKey',
        key: { fileName: 'prod.ppk', content: Buffer.from('private key'), passphrase: 'phrase' },
      },
    })

    dispose()
    expect(sessions.closeAll).toHaveBeenCalledOnce()
    expect(keys.clear).toHaveBeenCalledOnce()
    expect(removeHandler.mock.calls.map(([channel]) => channel)).toEqual([
      'sessions:connect',
      'sessions:selectPrivateKey',
      'sessions:write',
      'sessions:resize',
      'sessions:close',
      'sessions:list',
    ])
  })

  it('does not forward invalid terminal input to an existing shell', async () => {
    const sessions = createSessions()
    const sender = createSender()
    registerSessionHandlers(sessions, createKeys(), sender as never)
    const write = handlerFor('sessions:write')
    const resize = handlerFor('sessions:resize')

    expect(() => write(trustedEvent(sender), 's1', 'x'.repeat(65_537))).toThrow()
    expect(() => resize(trustedEvent(sender), 's1', 0, 24)).toThrow()

    expect(sessions.write).not.toHaveBeenCalled()
    expect(sessions.resize).not.toHaveBeenCalled()
  })

  it('rejects every session IPC channel from an untrusted renderer before validation or side effects', async () => {
    const sessions = createSessions()
    const keys = createKeys()
    const trustedSender = createSender()
    registerSessionHandlers(sessions, keys, trustedSender as never)
    const foreignEvent = { sender: createSender() }

    await expect(invoke(handlerFor('sessions:connect'), foreignEvent, {
      host: 'server-a', port: 22, username: 'ops', auth: { kind: 'password', password: 'secret' },
    })).rejects.toThrow('Untrusted renderer')
    await expect(invoke(handlerFor('sessions:selectPrivateKey'), foreignEvent)).rejects.toThrow('Untrusted renderer')
    await expect(invoke(handlerFor('sessions:write'), foreignEvent, 's1', 'whoami\n')).rejects.toThrow('Untrusted renderer')
    await expect(invoke(handlerFor('sessions:resize'), foreignEvent, 's1', 120, 40)).rejects.toThrow('Untrusted renderer')
    await expect(invoke(handlerFor('sessions:close'), foreignEvent, 's1')).rejects.toThrow('Untrusted renderer')

    expect(sessions.connect).not.toHaveBeenCalled()
    expect(sessions.write).not.toHaveBeenCalled()
    expect(sessions.resize).not.toHaveBeenCalled()
    expect(sessions.close).not.toHaveBeenCalled()
    expect(keys.select).not.toHaveBeenCalled()
  })

  it('returns a session snapshot and forwards sessions opened outside renderer-originated connects', async () => {
    const sessions = createSessions()
    const sender = createSender()
    const sessionMocks = sessions as unknown as {
      snapshot: ReturnType<typeof vi.fn>
      onOpened: ReturnType<typeof vi.fn>
      onUpdated: ReturnType<typeof vi.fn>
    }
    sessionMocks.snapshot.mockReturnValue([{ id: 's1', hostname: 'bastion-target', title: '生产终端', mode: 'copilot' }])
    registerSessionHandlers(sessions, createKeys(), sender as never)

    expect(handlerFor('sessions:list')(trustedEvent(sender))).toEqual([
      { id: 's1', hostname: 'bastion-target', title: '生产终端', mode: 'copilot' },
    ])
    const opened = sessionMocks.onOpened.mock.calls[0]?.[0] as (session: unknown) => void
    opened({ id: 's2', hostname: '127.0.0.1', title: 'Raw 22022', mode: 'copilot' })

    const updated = sessionMocks.onUpdated.mock.calls[0]?.[0] as (session: unknown) => void
    updated({ id: 's1', hostname: 'bastion-target', title: '生产终端', mode: 'autonomous' })

    expect(sender.send).toHaveBeenCalledWith('sessions:opened', {
      id: 's2', hostname: '127.0.0.1', title: 'Raw 22022', mode: 'copilot',
    })
    expect(sender.send).toHaveBeenCalledWith('sessions:updated', {
      id: 's1', hostname: 'bastion-target', title: '生产终端', mode: 'autonomous',
    })
  })

  it('lists, saves, opens and removes only direct SSH profiles without returning credentials to the renderer', async () => {
    const sessions = createSessions()
    const keys = createKeys()
    const profiles = createProfiles()
    const sender = createSender()
    const dispose = registerSessionHandlers(sessions, keys, sender as never, profiles)

    await expect(invoke(handlerFor('sessions:profiles:list'), trustedEvent(sender))).resolves.toEqual([{
      id: 'prod-api', name: '生产 API', host: 'api.example.com', port: 22, username: 'ops', authKind: 'password',
    }])
    await invoke(handlerFor('sessions:profiles:save'), trustedEvent(sender), {
      id: 'prod-api', name: '生产 API', host: 'api.example.com', port: 22, username: 'ops',
      auth: { kind: 'password', password: 'secret-password' },
    })
    await invoke(handlerFor('sessions:profiles:open'), trustedEvent(sender), 'prod-api')
    await invoke(handlerFor('sessions:profiles:delete'), trustedEvent(sender), 'prod-api')

    expect(profiles.save).toHaveBeenCalledWith({
      id: 'prod-api', name: '生产 API', host: 'api.example.com', port: 22, username: 'ops',
      auth: { kind: 'password', password: 'secret-password' },
    })
    expect(sessions.connect).toHaveBeenCalledWith({
      host: 'api.example.com', port: 22, username: 'ops', auth: { kind: 'password', password: 'secret-password' },
    })
    expect(profiles.remove).toHaveBeenCalledWith('prod-api')
    expect(JSON.stringify(sender.send.mock.calls)).not.toContain('secret-password')

    dispose()
    expect(removeHandler.mock.calls.map(([channel]) => channel)).toContain('sessions:profiles:delete')
  })

  it('updates direct-session metadata with its stable ID while retaining an unchanged password only in the main process', async () => {
    const sessions = createSessions()
    const keys = createKeys()
    const profiles = createProfiles()
    const sender = createSender()
    registerSessionHandlers(sessions, keys, sender as never, profiles)

    await invoke(handlerFor('sessions:profiles:save'), trustedEvent(sender), {
      id: 'prod-api', name: '生产 API（新名称）', host: 'api.internal.example', port: 2222, username: 'ops',
      auth: { kind: 'password' },
    })

    expect(profiles.load).toHaveBeenCalledWith('prod-api')
    expect(profiles.save).toHaveBeenCalledWith({
      id: 'prod-api', name: '生产 API（新名称）', host: 'api.internal.example', port: 2222, username: 'ops',
      auth: { kind: 'password', password: 'secret-password' },
    })
    expect(JSON.stringify(sender.send.mock.calls)).not.toContain('secret-password')
  })

  it('retains an unchanged private-key passphrase only in the main process while editing direct-session metadata', async () => {
    const sessions = createSessions()
    const keys = createKeys()
    const profiles = createProfiles()
    profiles.load.mockResolvedValueOnce({
      id: 'prod-key', name: '生产密钥', host: 'key.example.com', port: 22, username: 'ops',
      auth: { kind: 'privateKey', privateKeyPath: 'C:\\keys\\prod.key', passphrase: 'key-phrase' },
    })
    const sender = createSender()
    registerSessionHandlers(sessions, keys, sender as never, profiles)

    await invoke(handlerFor('sessions:profiles:save'), trustedEvent(sender), {
      id: 'prod-key', name: '生产密钥（新名称）', host: 'key.internal.example', port: 2200, username: 'ops',
      auth: { kind: 'privateKey', privateKeyPath: 'C:\\keys\\prod.key' },
    })

    expect(profiles.save).toHaveBeenCalledWith({
      id: 'prod-key', name: '生产密钥（新名称）', host: 'key.internal.example', port: 2200, username: 'ops',
      auth: { kind: 'privateKey', privateKeyPath: 'C:\\keys\\prod.key', passphrase: 'key-phrase' },
    })
    expect(JSON.stringify(sender.send.mock.calls)).not.toContain('key-phrase')
  })

  it('loads a saved private key only in the main process when reopening a direct profile', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-private-profile-'))
    const privateKeyPath = join(directory, 'prod.key')
    await writeFile(privateKeyPath, 'PRIVATE KEY CONTENT', 'utf8')
    const sessions = createSessions()
    const profiles = createProfiles()
    profiles.load.mockResolvedValueOnce({
      id: 'prod-api', name: '生产 API', host: 'api.example.com', port: 22, username: 'ops',
      auth: { kind: 'privateKey', privateKeyPath, passphrase: 'key-phrase' },
    })
    const sender = createSender()
    registerSessionHandlers(sessions, createKeys(), sender as never, profiles)

    try {
      await invoke(handlerFor('sessions:profiles:open'), trustedEvent(sender), 'prod-api')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }

    expect(sessions.connect).toHaveBeenCalledWith({
      host: 'api.example.com', port: 22, username: 'ops',
      auth: { kind: 'privateKey', key: { fileName: 'prod.key', content: Buffer.from('PRIVATE KEY CONTENT'), passphrase: 'key-phrase' } },
    })
    expect(JSON.stringify(sender.send.mock.calls)).not.toContain('PRIVATE KEY CONTENT')
    expect(JSON.stringify(sender.send.mock.calls)).not.toContain('key-phrase')
  })
})

function handlerFor(channel: string): (...args: unknown[]) => unknown {
  const match = handle.mock.calls.find(([registeredChannel]) => registeredChannel === channel)
  if (!match) throw new Error(`Missing handler: ${channel}`)
  return match[1] as (...args: unknown[]) => unknown
}

function createSessions() {
  return {
    connect: vi.fn().mockResolvedValue({ id: 's1', hostname: 'server-a', mode: 'copilot' }),
    write: vi.fn(),
    resize: vi.fn(),
    close: vi.fn(),
    closeAll: vi.fn(),
    snapshot: vi.fn(),
    onData: vi.fn().mockReturnValue(vi.fn()),
    onClosed: vi.fn().mockReturnValue(vi.fn()),
    onOpened: vi.fn().mockReturnValue(vi.fn()),
    onUpdated: vi.fn().mockReturnValue(vi.fn()),
  } as unknown as SessionService
}

function createSender() {
  return { send: vi.fn() }
}

function trustedEvent(sender: ReturnType<typeof createSender>) {
  return { sender }
}

async function invoke(handler: (...args: unknown[]) => unknown, ...args: unknown[]): Promise<unknown> {
  return handler(...args)
}

function createKeys() {
  return {
    select: vi.fn(),
    take: vi.fn().mockReturnValue({ fileName: 'prod.ppk', content: Buffer.from('private key'), passphrase: 'phrase' }),
    clear: vi.fn(),
  } as unknown as KeyMaterialStore
}

function createProfiles() {
  return {
    list: vi.fn().mockResolvedValue([{
      id: 'prod-api', name: '生产 API', host: 'api.example.com', port: 22, username: 'ops', authKind: 'password',
    }]),
    save: vi.fn().mockResolvedValue(undefined),
    load: vi.fn().mockResolvedValue({
      id: 'prod-api', name: '生产 API', host: 'api.example.com', port: 22, username: 'ops',
      auth: { kind: 'password', password: 'secret-password' },
    }),
    remove: vi.fn().mockResolvedValue(undefined),
  }
}
