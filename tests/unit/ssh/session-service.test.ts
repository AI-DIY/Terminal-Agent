import { describe, expect, it, vi } from 'vitest'
import { SessionService } from '../../../src/main/ssh/session-service'

describe('SessionService', () => {
  it('opens an AccessClient SSH session without converting an absent password into an empty password', async () => {
    const shell = createShell()
    const connection = { close: vi.fn(), openShell: vi.fn().mockResolvedValue(shell) }
    const client = { connect: vi.fn().mockResolvedValue(connection) }
    const service = new SessionService(client, { load: vi.fn() })
    const opened: unknown[] = []
    service.onOpened(session => opened.push(session))

    const session = await service.connectAccessSsh({
      host: 'server-a', port: 2222, username: 'ops', title: '生产终端', columns: 120, rows: 40,
    })

    expect(client.connect).toHaveBeenCalledWith({ host: 'server-a', port: 2222, username: 'ops' })
    expect(connection.openShell).toHaveBeenCalledWith(120, 40)
    expect(session).toEqual({ id: 's1', hostname: 'server-a', title: '生产终端', mode: 'copilot' })
    expect(service.snapshot()).toEqual([session])
    expect(opened).toEqual([session])
  })

  it('applies AccessClient SSH password, title, and initial dimensions to one session request', async () => {
    const shell = createShell()
    const connection = { close: vi.fn(), openShell: vi.fn().mockResolvedValue(shell) }
    const client = { connect: vi.fn().mockResolvedValue(connection) }
    const service = new SessionService(client, { load: vi.fn() })

    const session = await service.connectAccessSsh({
      host: 'server-a', port: 2222, username: 'ops', password: 'temporary-secret', title: '生产终端', columns: 120, rows: 40,
    })

    expect(client.connect).toHaveBeenCalledWith({ host: 'server-a', port: 2222, username: 'ops', password: 'temporary-secret' })
    expect(connection.openShell).toHaveBeenCalledWith(120, 40)
    expect(session).toMatchObject({ hostname: 'server-a', title: '生产终端' })
  })

  it('opens an internal raw terminal session without adding SSH credentials', async () => {
    const rawShell = createShell()
    const rawConnection = { close: vi.fn(), openShell: vi.fn().mockResolvedValue(rawShell) }
    const rawClient = { connect: vi.fn().mockResolvedValue(rawConnection) }
    const service = new SessionService(
      { connect: vi.fn() },
      { load: vi.fn() },
      rawClient,
    )

    const session = await service.connectRaw({ host: '127.0.0.1', port: 22022 })

    expect(rawClient.connect).toHaveBeenCalledWith({ host: '127.0.0.1', port: 22022 })
    expect(session).toEqual({ id: 's1', hostname: '127.0.0.1', mode: 'copilot' })
  })

  it('keeps Raw session metadata out of the transport request while using its initial dimensions', async () => {
    const rawShell = createShell()
    const rawConnection = { close: vi.fn(), openShell: vi.fn().mockResolvedValue(rawShell) }
    const rawClient = { connect: vi.fn().mockResolvedValue(rawConnection) }
    const service = new SessionService({ connect: vi.fn() }, { load: vi.fn() }, rawClient)

    const session = await service.connectRaw({ host: '127.0.0.1', port: 22022, title: 'Raw 22022', columns: 120, rows: 40 })

    expect(rawClient.connect).toHaveBeenCalledWith({ host: '127.0.0.1', port: 22022 })
    expect(rawConnection.openShell).toHaveBeenCalledWith(120, 40)
    expect(session).toMatchObject({ hostname: '127.0.0.1', title: 'Raw 22022' })
  })

  it('executes read-only observation only after an SSH shell is ready', async () => {
    const shell = createShell()
    const order: string[] = []
    const connection = {
      close: vi.fn(),
      openShell: vi.fn(async () => {
        order.push('shell-ready')
        return shell
      }),
      execute: vi.fn(async (command: string) => {
        order.push(`execute:${command}`)
        return 'api-prod\n'
      }),
    }
    const service = new SessionService({ connect: vi.fn().mockResolvedValue(connection) }, { load: vi.fn() })

    const session = await service.connect({
      host: '10.0.0.12', port: 22, username: 'ops', auth: { kind: 'password', password: 'secret' },
    })

    await expect(service.executeReadOnly(session.id, 'hostname')).resolves.toBe('api-prod\n')
    expect(order).toEqual(['shell-ready', 'execute:hostname'])
  })

  it('does not offer read-only observation to Raw TCP sessions', async () => {
    const shell = createShell()
    const rawClient = { connect: vi.fn().mockResolvedValue({ close: vi.fn(), openShell: vi.fn().mockResolvedValue(shell) }) }
    const service = new SessionService({ connect: vi.fn() }, { load: vi.fn() }, rawClient)
    const session = await service.connectRaw({ host: '127.0.0.1', port: 22022 })

    expect(service.supportsReadOnlyObservation(session.id)).toBe(false)
    await expect(service.executeReadOnly(session.id, 'hostname')).rejects.toThrow('Read-only observation is unavailable')
  })

  it('updates the snapshot mode only when the main process sets it for an active session', async () => {
    const shell = createShell()
    const client = { connect: vi.fn().mockResolvedValue({ close: vi.fn(), openShell: vi.fn().mockResolvedValue(shell) }) }
    const service = new SessionService(client, { load: vi.fn() })
    const updated: unknown[] = []
    service.onUpdated(session => updated.push(session))
    const session = await service.connect({
      host: 'server-a', port: 22, username: 'ops', auth: { kind: 'password', password: 'secret' },
    })

    service.setMode(session.id, 'autonomous')

    expect(service.snapshot()).toEqual([{ ...session, mode: 'autonomous' }])
    expect(updated).toEqual([{ ...session, mode: 'autonomous' }])
    expect(() => service.setMode('missing', 'autonomous')).toThrow('Unknown terminal session')
  })

  it('includes an observed hostname in snapshots and update events', async () => {
    const shell = createShell()
    const client = { connect: vi.fn().mockResolvedValue({ close: vi.fn(), openShell: vi.fn().mockResolvedValue(shell) }) }
    const service = new SessionService(client, { load: vi.fn() })
    const updated: unknown[] = []
    service.onUpdated(session => updated.push(session))
    const session = await service.connect({
      host: '10.0.0.12', port: 22, username: 'ops', auth: { kind: 'password', password: 'secret' },
    })

    service.setObservedHostname(session.id, ' api-prod\n')

    const expected = { ...session, observedHostname: 'api-prod' }
    expect(service.snapshot()).toEqual([expected])
    expect(updated).toEqual([expected])
  })

  it('sends password credentials only to the SSH adapter and starts in Copilot mode', async () => {
    const shell = createShell()
    const client = { connect: vi.fn().mockResolvedValue({ close: vi.fn(), openShell: vi.fn().mockResolvedValue(shell) }) }
    const service = new SessionService(client, { load: vi.fn() })

    const session = await service.connect({
      host: 'server-a',
      port: 22,
      username: 'ops',
      auth: { kind: 'password', password: 'secret' },
    })

    expect(client.connect).toHaveBeenCalledWith(expect.objectContaining({ password: 'secret', username: 'ops' }))
    expect(client.connect.mock.results[0]?.value).resolves.toEqual(expect.anything())
    expect(session).toEqual({ id: 's1', hostname: 'server-a', mode: 'copilot' })
  })

  it('routes writes and resize events only to the session shell', async () => {
    const shell = createShell()
    const client = { connect: vi.fn().mockResolvedValue({ close: vi.fn(), openShell: vi.fn().mockResolvedValue(shell) }) }
    const service = new SessionService(client, { load: vi.fn() })

    const session = await service.connect({
      host: 'server-a',
      port: 22,
      username: 'ops',
      auth: { kind: 'password', password: 'secret' },
    })

    service.write(session.id, 'whoami\n')
    service.resize(session.id, 120, 40)

    expect(() => service.write('missing', 'whoami\n')).toThrow('Unknown terminal session')
    expect(shell.write).toHaveBeenCalledWith('whoami\n')
    expect(shell.resize).toHaveBeenCalledWith(120, 40)
  })

  it('forwards shell output with its session id and removes a remotely closed session', async () => {
    const shell = createShell()
    const client = { connect: vi.fn().mockResolvedValue({ close: vi.fn(), openShell: vi.fn().mockResolvedValue(shell) }) }
    const service = new SessionService(client, { load: vi.fn() })
    const received: unknown[] = []
    const closed: unknown[] = []
    service.onData(event => received.push(event))
    service.onClosed(event => closed.push(event))

    const session = await service.connect({
      host: 'server-a',
      port: 22,
      username: 'ops',
      auth: { kind: 'password', password: 'secret' },
    })

    shell.emitData(Buffer.from('server output'))
    shell.emitClose()

    expect(received).toEqual([{ sessionId: session.id, data: 'server output' }])
    expect(closed).toEqual([{ sessionId: session.id }])
    expect(() => service.write(session.id, 'whoami\n')).toThrow('Unknown terminal session')
  })

  it('closes the shell and connection once, then announces the closed session', async () => {
    const shell = createShell()
    const connection = { close: vi.fn(), openShell: vi.fn().mockResolvedValue(shell) }
    const client = { connect: vi.fn().mockResolvedValue(connection) }
    const service = new SessionService(client, { load: vi.fn() })
    const closed: unknown[] = []
    service.onClosed(event => closed.push(event))
    const session = await service.connect({
      host: 'server-a',
      port: 22,
      username: 'ops',
      auth: { kind: 'password', password: 'secret' },
    })

    service.close(session.id)

    expect(shell.close).toHaveBeenCalledOnce()
    expect(connection.close).toHaveBeenCalledOnce()
    expect(closed).toEqual([{ sessionId: session.id }])
    expect(() => service.close(session.id)).toThrow('Unknown terminal session')
  })

  it('closes a connected transport when opening its shell fails without registering a session', async () => {
    const connection = { close: vi.fn(), openShell: vi.fn().mockRejectedValue(new Error('shell unavailable')) }
    const client = { connect: vi.fn().mockResolvedValue(connection) }
    const service = new SessionService(client, { load: vi.fn() })

    await expect(service.connect({
      host: 'server-a',
      port: 22,
      username: 'ops',
      auth: { kind: 'password', password: 'secret' },
    })).rejects.toThrow('shell unavailable')

    expect(connection.close).toHaveBeenCalledOnce()
    expect(() => service.write('s1', 'whoami\n')).toThrow('Unknown terminal session')
  })

  it('decodes split UTF-8 shell data without emitting replacement characters', async () => {
    const shell = createShell()
    const client = { connect: vi.fn().mockResolvedValue({ close: vi.fn(), openShell: vi.fn().mockResolvedValue(shell) }) }
    const service = new SessionService(client, { load: vi.fn() })
    const received: unknown[] = []
    service.onData(event => received.push(event))
    const session = await service.connect({
      host: 'server-a',
      port: 22,
      username: 'ops',
      auth: { kind: 'password', password: 'secret' },
    })
    const encoded = Buffer.from('你🙂', 'utf8')

    shell.emitData(encoded.subarray(0, 2))
    shell.emitData(encoded.subarray(2))

    expect(received).toEqual([{ sessionId: session.id, data: '你🙂' }])
  })

  it('flushes pending decoder data when a shell closes', async () => {
    const shell = createShell()
    const client = { connect: vi.fn().mockResolvedValue({ close: vi.fn(), openShell: vi.fn().mockResolvedValue(shell) }) }
    const service = new SessionService(client, { load: vi.fn() })
    const received: unknown[] = []
    service.onData(event => received.push(event))
    const session = await service.connect({
      host: 'server-a',
      port: 22,
      username: 'ops',
      auth: { kind: 'password', password: 'secret' },
    })

    shell.emitData(Buffer.from('你', 'utf8').subarray(0, 2))
    shell.emitClose()

    expect(received).toEqual([{ sessionId: session.id, data: '�' }])
  })
})

function createShell() {
  let dataListener: ((data: Buffer) => void) | undefined
  let closeListener: (() => void) | undefined
  return {
    write: vi.fn(),
    resize: vi.fn(),
    close: vi.fn(),
    onData: vi.fn((listener: (data: Buffer) => void) => { dataListener = listener }),
    onClose: vi.fn((listener: () => void) => { closeListener = listener }),
    emitData: (data: Buffer) => dataListener?.(data),
    emitClose: () => closeListener?.(),
  }
}
