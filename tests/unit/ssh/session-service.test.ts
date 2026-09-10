import { describe, expect, it, vi } from 'vitest'
import { MainProcessReconnectDescriptorStore } from '../../../src/main/ssh/direct-session-repository'
import { SessionService } from '../../../src/main/ssh/session-service'
import { ExecutionGateway } from '../../../src/main/agent/execution-gateway'
import { AccessClientLaunchFailure } from '../../../src/main/access-client/launch-failure'

describe('SessionService', () => {
  it('revokes, bounds, and isolates reconnect descriptors across lifecycle transitions', () => {
    let now = 0
    const createStore = () => new MainProcessReconnectDescriptorStore({
      createReference: () => '0123456789abcdef',
      now: () => now,
      closedRetentionMs: 1_000,
    })
    const store = createStore()

    const revoked = store.register({ secret: 'revoked-secret' })
    store.revoke(revoked)
    expect(store.resolve(revoked)).toBeUndefined()

    const closed = store.register({ secret: 'closed-secret' })
    store.markClosed(closed)
    expect(store.resolve(closed)).toEqual({ secret: 'closed-secret' })
    now = 1_000
    expect(store.resolve(closed)).toBeUndefined()

    const restarted = createStore()
    expect(restarted.resolve(closed)).toBeUndefined()
    expect(JSON.stringify({ revoked, closed })).not.toContain('secret')
  })

  it('binds descriptor validity to a direct profile and marks a closed shell for bounded history retention', async () => {
    let now = 0
    const descriptors = new MainProcessReconnectDescriptorStore({
      createReference: () => 'fedcba9876543210',
      now: () => now,
      closedRetentionMs: 1_000,
    })
    const shell = createShell()
    const service = new SessionService(
      { connect: vi.fn().mockResolvedValue({ close: vi.fn(), openShell: vi.fn().mockResolvedValue(shell) }) },
      { load: vi.fn() },
      undefined,
      { createId: () => 'session-profile', reconnectDescriptors: descriptors as never },
    )
    let reconnectReference = ''
    service.onHistoryOpened(session => { reconnectReference = session.reconnectReference })
    const session = await service.connect({
      host: 'profile.example.com', port: 22, username: 'ops', profileId: 'profile-a',
      auth: { kind: 'password', password: 'profile-secret' },
    })

    service.close(session.id)
    expect(service.canReconnect(reconnectReference)).toBe(true)
    service.revokeDirectProfile('profile-a')
    expect(service.canReconnect(reconnectReference)).toBe(false)

    let temporaryReference = ''
    service.onHistoryOpened(next => { if (next.id !== session.id) temporaryReference = next.reconnectReference })
    const second = await service.connect({
      host: 'temporary.example.com', port: 22, username: 'ops',
      auth: { kind: 'password', password: 'temporary-secret' },
    })
    service.close(second.id)
    now = 1_000
    expect(service.canReconnect(temporaryReference)).toBe(false)
  })

  it('revokes an AccessClient profile descriptor without exposing its request data', async () => {
    const shell = createShell()
    const service = new SessionService(
      { connect: vi.fn().mockResolvedValue({ close: vi.fn(), openShell: vi.fn().mockResolvedValue(shell) }) },
      { load: vi.fn() },
      undefined,
      { createId: () => 'access-profile-session' },
    )
    let reference = ''
    service.onHistoryOpened(session => { reference = session.reconnectReference })
    await service.connectAccessSsh({
      host: 'access.example.com', port: 22, username: 'ops', password: 'access-secret',
      title: 'Access profile', columns: 80, rows: 24, profileId: 'access-profile-a',
    })

    expect(JSON.stringify(reference)).not.toContain('access-secret')
    service.revokeAccessProfile('access-profile-a')
    expect(service.canReconnect(reference)).toBe(false)
  })

  it('does not reuse default session ids across main-process service generations', async () => {
    const first = new SessionService(
      { connect: vi.fn().mockResolvedValue({ close: vi.fn(), openShell: vi.fn().mockResolvedValue(createShell()) }) },
      { load: vi.fn() },
    )
    const second = new SessionService(
      { connect: vi.fn().mockResolvedValue({ close: vi.fn(), openShell: vi.fn().mockResolvedValue(createShell()) }) },
      { load: vi.fn() },
    )

    const firstSession = await first.connect({ host: 'first', port: 22, username: 'ops', auth: { kind: 'password', password: 'secret' } })
    const secondSession = await second.connect({ host: 'second', port: 22, username: 'ops', auth: { kind: 'password', password: 'secret' } })

    expect(firstSession.id).not.toBe(secondSession.id)
  })

  it('opens an AccessClient SSH session without converting an absent password into an empty password', async () => {
    const shell = createShell()
    const connection = { close: vi.fn(), openShell: vi.fn().mockResolvedValue(shell) }
    const client = { connect: vi.fn().mockResolvedValue(connection) }
    const service = new SessionService(client, { load: vi.fn() }, undefined, { createId: () => 's1' })
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

  it('reports a credential-free connection type to main-process history collectors for direct, AccessClient SSH, and raw sessions', async () => {
    const directShell = createShell()
    const accessShell = createShell()
    const rawShell = createShell()
    const client = {
      connect: vi.fn()
        .mockResolvedValueOnce({ close: vi.fn(), openShell: vi.fn().mockResolvedValue(directShell) })
        .mockResolvedValueOnce({ close: vi.fn(), openShell: vi.fn().mockResolvedValue(accessShell) }),
    }
    const rawClient = { connect: vi.fn().mockResolvedValue({ close: vi.fn(), openShell: vi.fn().mockResolvedValue(rawShell) }) }
    const ids = ['direct-session', 'access-session', 'raw-session']
    const service = new SessionService(client, { load: vi.fn() }, rawClient, { createId: () => ids.shift()! })
    const historyOpened: unknown[] = []
    service.onHistoryOpened(session => historyOpened.push(session))

    await service.connect({ host: 'direct.example', port: 22, username: 'ops', auth: { kind: 'password', password: 'secret' } })
    await service.connectAccessSsh({ host: 'access.example', port: 2222, username: 'ops', title: 'Access shell', columns: 80, rows: 24 })
    await service.connectRaw({ host: '127.0.0.1', port: 22022 })

    expect(historyOpened).toEqual([
      expect.objectContaining({ id: 'direct-session', hostname: 'direct.example', mode: 'copilot', connectionType: 'direct-ssh', reconnectReference: expect.stringMatching(/^reconnect:/) }),
      expect.objectContaining({ id: 'access-session', hostname: 'access.example', title: 'Access shell', mode: 'copilot', connectionType: 'access-client-ssh', reconnectReference: expect.stringMatching(/^reconnect:/) }),
      expect.objectContaining({ id: 'raw-session', hostname: '127.0.0.1', mode: 'copilot', connectionType: 'access-client-raw', reconnectReference: expect.stringMatching(/^reconnect:/) }),
    ])
    expect(JSON.stringify(historyOpened)).not.toContain('secret')
  })

  it('duplicates a live direct session as a second authoritative session without exposing its descriptor to history listeners', async () => {
    const firstShell = createShell()
    const secondShell = createShell()
    const thirdShell = createShell()
    const client = {
      connect: vi.fn()
        .mockResolvedValueOnce({ close: vi.fn(), openShell: vi.fn().mockResolvedValue(firstShell) })
        .mockResolvedValueOnce({ close: vi.fn(), openShell: vi.fn().mockResolvedValue(secondShell) })
        .mockResolvedValueOnce({ close: vi.fn(), openShell: vi.fn().mockResolvedValue(thirdShell) }),
    }
    const ids = ['session-original', 'session-copy', 'session-targeted']
    const service = new SessionService(client, { load: vi.fn() }, undefined, { createId: () => ids.shift()! })
    const historyOpened: unknown[] = []
    service.onHistoryOpened(session => historyOpened.push(session))

    const original = await service.connect({
      host: 'web-01', port: 22, username: 'ops', auth: { kind: 'password', password: 'credential-placeholder' },
    })
    const copy = await (service as unknown as { duplicate(sessionId: string): Promise<{ id: string; hostname: string; mode: string }> }).duplicate(original.id)

    expect(copy).toEqual({ id: 'session-copy', hostname: 'web-01', mode: 'copilot' })
    expect(copy.id).not.toBe(original.id)
    expect(service.snapshot().map(session => session.id)).toEqual(['session-original', 'session-copy'])
    expect(client.connect).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(historyOpened)).not.toContain('credential-placeholder')
    expect(JSON.stringify(historyOpened)).not.toContain('password')

    const targeted = await (service as unknown as { duplicate(sessionId: string, chatId: string): Promise<{ chatId?: string }> }).duplicate(original.id, 'chat-target')
    expect(targeted).toMatchObject({ chatId: 'chat-target' })
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

  it('classifies an AccessClient transport failure without changing direct-session errors', async () => {
    const client = { connect: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) }
    const service = new SessionService(client, { load: vi.fn() })

    await expect(service.connectAccessSsh({
      host: 'server-a', port: 2222, username: 'ops', title: '生产终端', columns: 120, rows: 40,
    })).rejects.toMatchObject({ code: 'transport-connect-failed' } satisfies Partial<AccessClientLaunchFailure>)
  })

  it('classifies an AccessClient terminal-open failure after closing its connection', async () => {
    const connection = { close: vi.fn(), openShell: vi.fn().mockRejectedValue(new Error('PTY denied')) }
    const service = new SessionService({ connect: vi.fn().mockResolvedValue(connection) }, { load: vi.fn() })

    await expect(service.connectAccessSsh({
      host: 'server-a', port: 2222, username: 'ops', title: '生产终端', columns: 120, rows: 40,
    })).rejects.toMatchObject({ code: 'terminal-open-failed' } satisfies Partial<AccessClientLaunchFailure>)
    expect(connection.close).toHaveBeenCalledOnce()
  })

  it('opens an internal raw terminal session without adding SSH credentials', async () => {
    const rawShell = createShell()
    const rawConnection = { close: vi.fn(), openShell: vi.fn().mockResolvedValue(rawShell) }
    const rawClient = { connect: vi.fn().mockResolvedValue(rawConnection) }
    const service = new SessionService(
      { connect: vi.fn() },
      { load: vi.fn() },
      rawClient,
      { createId: () => 's1' },
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

  it('refuses to inject a shell completion probe into a Raw TCP session', async () => {
    const shell = createShell()
    const rawClient = { connect: vi.fn().mockResolvedValue({ close: vi.fn(), openShell: vi.fn().mockResolvedValue(shell) }) }
    const service = new SessionService({ connect: vi.fn() }, { load: vi.fn() }, rawClient)
    const session = await service.connectRaw({ host: '127.0.0.1', port: 22022 })

    expect(service.supportsCommandCompletion(session.id)).toBe(false)
    await expect(service.writeAndWaitForCompletion(session.id, 'raw payload', 25)).rejects.toThrow('Command completion is unavailable')
    expect(shell.write).not.toHaveBeenCalled()
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

  it('publishes an observed hostname through the session snapshot and update event', async () => {
    const shell = createShell()
    const client = { connect: vi.fn().mockResolvedValue({ close: vi.fn(), openShell: vi.fn().mockResolvedValue(shell) }) }
    const service = new SessionService(client, { load: vi.fn() })
    const updated: unknown[] = []
    service.onUpdated(session => updated.push(session))
    const session = await service.connect({
      host: '10.0.0.12', port: 22, username: 'ops', auth: { kind: 'password', password: 'secret' },
    })

    service.setObservedHostname(session.id, ' api-prod\n')

    expect(service.observedHostname(session.id)).toBe('api-prod')
    expect(service.snapshot()).toEqual([{ ...session, observedHostname: 'api-prod' }])
    expect(updated).toEqual([{ ...session, observedHostname: 'api-prod' }])
  })

  it('does not publish duplicate or blank observed-hostname updates', async () => {
    const shell = createShell()
    const client = { connect: vi.fn().mockResolvedValue({ close: vi.fn(), openShell: vi.fn().mockResolvedValue(shell) }) }
    const service = new SessionService(client, { load: vi.fn() })
    const updated: unknown[] = []
    service.onUpdated(session => updated.push(session))
    const session = await service.connect({
      host: '10.0.0.12', port: 22, username: 'ops', auth: { kind: 'password', password: 'secret' },
    })

    service.setObservedHostname(session.id, '   ')
    service.setObservedHostname(session.id, 'api-prod')
    service.setObservedHostname(session.id, ' api-prod\n')

    expect(updated).toEqual([{ ...session, observedHostname: 'api-prod' }])
    expect(service.snapshot()).toEqual([{ ...session, observedHostname: 'api-prod' }])
  })

  it('clears the public observed hostname and announces the reverted summary', async () => {
    const shell = createShell()
    const client = { connect: vi.fn().mockResolvedValue({ close: vi.fn(), openShell: vi.fn().mockResolvedValue(shell) }) }
    const service = new SessionService(client, { load: vi.fn() })
    const updated: unknown[] = []
    service.onUpdated(session => updated.push(session))
    const session = await service.connect({
      host: '10.0.0.12', port: 22, username: 'ops', auth: { kind: 'password', password: 'secret' },
    })

    service.setObservedHostname(session.id, 'api-prod')
    service.clearObservedHostname(session.id)

    expect(service.observedHostname(session.id)).toBeUndefined()
    expect(service.snapshot()).toEqual([session])
    expect(updated).toEqual([{ ...session, observedHostname: 'api-prod' }, session])
    service.clearObservedHostname(session.id)
    expect(updated).toHaveLength(2)
  })

  it('sends password credentials only to the SSH adapter and starts in Copilot mode', async () => {
    const shell = createShell()
    const client = { connect: vi.fn().mockResolvedValue({ close: vi.fn(), openShell: vi.fn().mockResolvedValue(shell) }) }
    const service = new SessionService(client, { load: vi.fn() }, undefined, { createId: () => 's1' })

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
    const auditedWrites: unknown[] = []
    expect('onWrite' in service).toBe(true)
    const onWrite = (service as SessionService & {
      onWrite(listener: (event: { sessionId: string; data: string }) => void): () => void
    }).onWrite.bind(service)
    onWrite(event => auditedWrites.push(event))

    const session = await service.connect({
      host: 'server-a',
      port: 22,
      username: 'ops',
      auth: { kind: 'password', password: 'secret' },
    })

    service.write(session.id, 'whoami\n')
    const gateway = new ExecutionGateway(
      { get: () => 'autonomous' },
      { consume: () => false },
      { match: () => null },
      (sessionId, command) => {
        service.write(sessionId, `${command}\n`)
        return { kind: 'sent' }
      },
    )
    await gateway.execute({ sessionId: session.id, command: 'hostname' })
    service.resize(session.id, 120, 40)

    expect(() => service.write('missing', 'whoami\n')).toThrow('Unknown terminal session')
    expect(shell.write).toHaveBeenCalledWith('whoami\n')
    expect(shell.write).toHaveBeenCalledWith('hostname\n')
    expect(auditedWrites).toEqual([
      { sessionId: session.id, data: 'whoami\n' },
      { sessionId: session.id, data: 'hostname\n' },
    ])
    expect(shell.resize).toHaveBeenCalledWith(120, 40)
  })

  it('waits for the private completion probe, streams ordinary output, and audits only the reviewed command', async () => {
    const shell = createShell()
    const client = { connect: vi.fn().mockResolvedValue({ close: vi.fn(), openShell: vi.fn().mockResolvedValue(shell) }) }
    const service = new SessionService(client, { load: vi.fn() })
    const received: Array<{ sessionId: string; data: string }> = []
    const audited: Array<{ sessionId: string; data: string }> = []
    service.onData(event => received.push(event))
    service.onWrite(event => audited.push(event))
    const session = await service.connect({
      host: 'server-a', port: 22, username: 'ops', auth: { kind: 'password', password: 'secret' },
    })

    const completion = service.writeAndWaitForCompletion(session.id, 'long-running-check', 1_000)
    const probeInput = shell.write.mock.calls.at(-1)?.[0] as string
    const marker = probeInput.match(/echo (__TA_COMMAND_COMPLETE_[^\r\n]+__)\r?\n$/)?.[1]
    expect(marker).toBeTruthy()
    expect(audited).toEqual([{ sessionId: session.id, data: 'long-running-check\n' }])

    // Ordinary completed lines remain live in the terminal while the plan
    // waits. The marker is deliberately split across transport chunks and
    // must never become visible terminal or AI context.
    shell.emitData(Buffer.from('result-line\n'))
    expect(received).toEqual([{ sessionId: session.id, data: 'result-line\n' }])
    shell.emitData(Buffer.from(`${marker!.slice(0, 9)}`))
    expect(received).toEqual([{ sessionId: session.id, data: 'result-line\n' }])
    shell.emitData(Buffer.from(`${marker!.slice(9)}\n`))

    await expect(completion).resolves.toEqual({ completed: true, timedOut: false })
    expect(received).toEqual([{ sessionId: session.id, data: 'result-line\n' }])
    expect(service.recentLines(session.id)).toEqual(['result-line'])
    expect(JSON.stringify(received)).not.toContain(marker!)
    expect(audited).toEqual([{ sessionId: session.id, data: 'long-running-check\n' }])
  })

  it('terminates POSIX, cmd, and PowerShell line continuations before sending its completion probe', async () => {
    const shell = createShell()
    const client = { connect: vi.fn().mockResolvedValue({ close: vi.fn(), openShell: vi.fn().mockResolvedValue(shell) }) }
    const service = new SessionService(client, { load: vi.fn() })
    const session = await service.connect({
      host: 'server-a', port: 22, username: 'ops', auth: { kind: 'password', password: 'secret' },
    })

    for (const command of ['printf result \\', 'echo result ^', 'Write-Output result`']) {
      const completion = service.writeAndWaitForCompletion(session.id, command, 1_000)
      const probeInput = shell.write.mock.calls.at(-1)?.[0] as string
      expect(probeInput.startsWith(`${command}\n\necho `)).toBe(true)
      const marker = probeInput.match(/echo (__TA_COMMAND_COMPLETE_[^\r\n]+__)\r?\n$/)?.[1]
      expect(marker).toBeTruthy()
      shell.emitData(Buffer.from(`${marker}\n`))
      await expect(completion).resolves.toEqual({ completed: true, timedOut: false })
    }
  })

  it('recognizes a completion marker appended to output without a trailing newline', async () => {
    const shell = createShell()
    const client = { connect: vi.fn().mockResolvedValue({ close: vi.fn(), openShell: vi.fn().mockResolvedValue(shell) }) }
    const service = new SessionService(client, { load: vi.fn() })
    const received: Array<{ sessionId: string; data: string }> = []
    service.onData(event => received.push(event))
    const session = await service.connect({
      host: 'server-a', port: 22, username: 'ops', auth: { kind: 'password', password: 'secret' },
    })

    const completion = service.writeAndWaitForCompletion(session.id, 'printf result', 1_000)
    const probeInput = shell.write.mock.calls.at(-1)?.[0] as string
    const marker = probeInput.match(/echo (__TA_COMMAND_COMPLETE_[^\r\n]+__)\r?\n$/)?.[1]
    expect(marker).toBeTruthy()

    // A PTY can echo the injected command directly after `printf result`,
    // then emit the probe value on that same output line. The input echo must
    // not resolve the wait; the actual token must be consumed instead.
    shell.emitData(Buffer.from(`resultecho ${marker}\r\n`))
    expect(received).toEqual([{ sessionId: session.id, data: 'result' }])
    shell.emitData(Buffer.from(`${marker}\r\n`))

    await expect(completion).resolves.toEqual({ completed: true, timedOut: false })
    expect(received).toEqual([{ sessionId: session.id, data: 'result' }])
    expect(service.recentLines(session.id)).toEqual(['result'])
    expect(JSON.stringify(received)).not.toContain(marker!)
  })

  it('filters ANSI-wrapped completion probes without leaving terminal control sequences behind', async () => {
    const shell = createShell()
    const client = { connect: vi.fn().mockResolvedValue({ close: vi.fn(), openShell: vi.fn().mockResolvedValue(shell) }) }
    const service = new SessionService(client, { load: vi.fn() })
    const received: Array<{ sessionId: string; data: string }> = []
    service.onData(event => received.push(event))
    const session = await service.connect({
      host: 'server-a', port: 22, username: 'ops', auth: { kind: 'password', password: 'secret' },
    })

    const completion = service.writeAndWaitForCompletion(session.id, 'hostname', 1_000)
    const probeInput = shell.write.mock.calls.at(-1)?.[0] as string
    const marker = probeInput.match(/echo (__TA_COMMAND_COMPLETE_[^\r\n]+__)\r?\n$/)?.[1]
    expect(marker).toBeTruthy()
    shell.emitData(Buffer.from(`\u001b[?25l${marker}\u001b[?25h\r\n`))

    await expect(completion).resolves.toEqual({ completed: true, timedOut: false })
    expect(received).toEqual([])
    expect(service.recentLines(session.id)).toEqual([])
  })

  it('holds a split CRLF marker until its line ending is complete', async () => {
    const shell = createShell()
    const client = { connect: vi.fn().mockResolvedValue({ close: vi.fn(), openShell: vi.fn().mockResolvedValue(shell) }) }
    const service = new SessionService(client, { load: vi.fn() })
    const received: Array<{ sessionId: string; data: string }> = []
    service.onData(event => received.push(event))
    const session = await service.connect({
      host: 'server-a', port: 22, username: 'ops', auth: { kind: 'password', password: 'secret' },
    })

    const completion = service.writeAndWaitForCompletion(session.id, 'hostname', 1_000)
    const probeInput = shell.write.mock.calls.at(-1)?.[0] as string
    const marker = probeInput.match(/echo (__TA_COMMAND_COMPLETE_[^\r\n]+__)\r?\n$/)?.[1]
    expect(marker).toBeTruthy()
    shell.emitData(Buffer.from(`${marker}\r`))
    expect(received).toEqual([])
    shell.emitData(Buffer.from('\n'))

    await expect(completion).resolves.toEqual({ completed: true, timedOut: false })
    expect(received).toEqual([])
  })

  it('does not expose a partial private completion token when the shell closes', async () => {
    const shell = createShell()
    const client = { connect: vi.fn().mockResolvedValue({ close: vi.fn(), openShell: vi.fn().mockResolvedValue(shell) }) }
    const service = new SessionService(client, { load: vi.fn() })
    const received: Array<{ sessionId: string; data: string }> = []
    service.onData(event => received.push(event))
    const session = await service.connect({
      host: 'server-a', port: 22, username: 'ops', auth: { kind: 'password', password: 'secret' },
    })

    const completion = service.writeAndWaitForCompletion(session.id, 'hostname', 1_000)
    const probeInput = shell.write.mock.calls.at(-1)?.[0] as string
    const marker = probeInput.match(/echo (__TA_COMMAND_COMPLETE_[^\r\n]+__)\r?\n$/)?.[1]
    expect(marker).toBeTruthy()
    shell.emitData(Buffer.from(marker!.slice(0, 18)))
    shell.emitClose()

    await expect(completion).resolves.toEqual({ completed: false, timedOut: false })
    expect(received).toEqual([])
  })

  it('resolves a bounded completion wait as timed out and flushes held output', async () => {
    vi.useFakeTimers()
    try {
      const shell = createShell()
      const client = { connect: vi.fn().mockResolvedValue({ close: vi.fn(), openShell: vi.fn().mockResolvedValue(shell) }) }
      const service = new SessionService(client, { load: vi.fn() })
      const received: Array<{ sessionId: string; data: string }> = []
      service.onData(event => received.push(event))
      const session = await service.connect({
        host: 'server-a', port: 22, username: 'ops', auth: { kind: 'password', password: 'secret' },
      })

      const completion = service.writeAndWaitForCompletion(session.id, 'silent-check', 25)
      const probeInput = shell.write.mock.calls.at(-1)?.[0] as string
      const marker = probeInput.match(/echo (__TA_COMMAND_COMPLETE_[^\r\n]+__)\r?\n$/)?.[1]
      expect(marker).toBeTruthy()
      shell.emitData(Buffer.from('partial output'))
      expect(received).toEqual([])
      await vi.advanceTimersByTimeAsync(25)

      await expect(completion).resolves.toEqual({ completed: false, timedOut: true })
      expect(received).toEqual([{ sessionId: session.id, data: 'partial output' }])

      // A delayed marker after the timeout must still be private. The plan
      // itself has already failed conservatively, but it must not pollute a
      // subsequent terminal/AI context.
      shell.emitData(Buffer.from(`${marker}\n`))
      expect(received).toEqual([{ sessionId: session.id, data: 'partial output' }])
      expect(JSON.stringify(received)).not.toContain(marker!)
    } finally {
      vi.useRealTimers()
    }
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

  it('keeps only the latest 200 logical shell output lines for main-process context', async () => {
    const shell = createShell()
    const client = { connect: vi.fn().mockResolvedValue({ close: vi.fn(), openShell: vi.fn().mockResolvedValue(shell) }) }
    const service = new SessionService(client, { load: vi.fn() })
    const session = await service.connect({
      host: 'server-a', port: 22, username: 'ops', auth: { kind: 'password', password: 'secret' },
    })

    const output = Array.from({ length: 205 }, (_, index) => `line-${index}\n`).join('')
    shell.emitData(Buffer.from(output.slice(0, 617), 'utf8'))
    shell.emitData(Buffer.from(output.slice(617), 'utf8'))

    expect((service as SessionService & { recentLines(sessionId: string): string[] }).recentLines(session.id)).toEqual(
      Array.from({ length: 200 }, (_, index) => `line-${index + 5}`),
    )
    expect(service.snapshot()[0]).not.toHaveProperty('recentLines')
  })

  it('keeps the latest 200 lines even when their combined output exceeds the character budget', async () => {
    const shell = createShell()
    const client = { connect: vi.fn().mockResolvedValue({ close: vi.fn(), openShell: vi.fn().mockResolvedValue(shell) }) }
    const service = new SessionService(client, { load: vi.fn() })
    const session = await service.connect({
      host: 'server-a', port: 22, username: 'ops', auth: { kind: 'password', password: 'secret' },
    })

    const output = Array.from({ length: 205 }, (_, index) => `line-${index}-${'x'.repeat(2_000)}\n`).join('')
    shell.emitData(Buffer.from(output, 'utf8'))

    const recent = (service as SessionService & { recentLines(sessionId: string): string[] }).recentLines(session.id)
    expect(recent).toHaveLength(200)
    expect(recent[0]).toBe(`line-5-${'x'.repeat(2_000)}`)
    expect(recent.at(-1)).toBe(`line-204-${'x'.repeat(2_000)}`)
  })

  it('honours an explicit context line count above the historical 200-line default', async () => {
    const shell = createShell()
    const client = { connect: vi.fn().mockResolvedValue({ close: vi.fn(), openShell: vi.fn().mockResolvedValue(shell) }) }
    const service = new SessionService(client, { load: vi.fn() })
    const session = await service.connect({
      host: 'server-a', port: 22, username: 'ops', auth: { kind: 'password', password: 'secret' },
    })
    const output = Array.from({ length: 260 }, (_, index) => `line-${index}\n`).join('')
    shell.emitData(Buffer.from(output))

    const recent = service.recentLines(session.id, 240)
    expect(recent).toHaveLength(240)
    expect(recent[0]).toBe('line-20')
    expect(recent.at(-1)).toBe('line-259')
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
    // The transport may announce closure just before a user presses the close
    // button. A stale close remains idempotent instead of escaping over IPC.
    expect(() => service.close(session.id)).not.toThrow()
    expect(shell.close).toHaveBeenCalledOnce()
    expect(connection.close).toHaveBeenCalledOnce()
    expect(closed).toEqual([{ sessionId: session.id }])
  })

  it('continues closing every session and announces closures when transport teardown throws', async () => {
    const firstShell = createShell()
    const secondShell = createShell()
    const firstConnection = {
      close: vi.fn(() => { throw new Error('connection close failed') }),
      openShell: vi.fn().mockResolvedValue(firstShell),
    }
    const secondConnection = { close: vi.fn(), openShell: vi.fn().mockResolvedValue(secondShell) }
    const client = {
      connect: vi.fn()
        .mockResolvedValueOnce(firstConnection)
        .mockResolvedValueOnce(secondConnection),
    }
    const service = new SessionService(client, { load: vi.fn() })
    const closed: unknown[] = []
    service.onClosed(event => closed.push(event))
    const first = await service.connect({ host: 'server-a', port: 22, username: 'ops', auth: { kind: 'password', password: 'secret' } })
    const second = await service.connect({ host: 'server-b', port: 22, username: 'ops', auth: { kind: 'password', password: 'secret' } })
    firstShell.close.mockImplementation(() => { throw new Error('shell close failed') })

    expect(() => service.closeAll()).toThrow('connection close failed')

    expect(firstShell.close).toHaveBeenCalledOnce()
    expect(firstConnection.close).toHaveBeenCalledOnce()
    expect(secondShell.close).toHaveBeenCalledOnce()
    expect(secondConnection.close).toHaveBeenCalledOnce()
    expect(closed).toEqual([{ sessionId: first.id }, { sessionId: second.id }])
    expect(service.snapshot()).toEqual([])
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

  it('keeps the transport connection IP in a main-only lookup and never guesses it from a target label', async () => {
    const shell = createShell()
    const connection = { remoteAddress: '192.0.2.10', close: vi.fn(), openShell: vi.fn().mockResolvedValue(shell), execute: vi.fn().mockResolvedValue('') }
    const service = new SessionService({ connect: vi.fn().mockResolvedValue(connection) }, { load: vi.fn() })
    const session = await service.connect({ host: 'api.example.invalid', port: 22, username: 'ops', auth: { kind: 'password', password: '' } })

    expect(service.connectionIp(session.id)).toBe('192.0.2.10')
    expect(session).not.toHaveProperty('connectionIp')
    expect(service.snapshot()[0]).not.toHaveProperty('connectionIp')

    const unlabeledConnection = { close: vi.fn(), openShell: vi.fn().mockResolvedValue(createShell()), execute: vi.fn().mockResolvedValue('') }
    const unlabeledService = new SessionService({ connect: vi.fn().mockResolvedValue(unlabeledConnection) }, { load: vi.fn() })
    const ipTargetSession = await unlabeledService.connect({ host: '192.0.2.20', port: 22, username: 'ops', auth: { kind: 'password', password: '' } })
    expect(unlabeledService.connectionIp(ipTargetSession.id)).toBeUndefined()
  })

  it('passes a deterministic output limit to every read-only transport command', async () => {
    const shell = createShell()
    const connection = { close: vi.fn(), openShell: vi.fn().mockResolvedValue(shell), execute: vi.fn().mockResolvedValue('api-prod\n') }
    const service = new SessionService({ connect: vi.fn().mockResolvedValue(connection) }, { load: vi.fn() })
    const session = await service.connect({ host: 'api-prod', port: 22, username: 'ops', auth: { kind: 'password', password: '' } })

    await service.executeReadOnly(session.id, 'hostname')

    expect(connection.execute).toHaveBeenCalledWith('hostname', 256 * 1024)
  })

  it('routes remote directory listings through the active SSH connection', async () => {
    const shell = createShell()
    const fileTransfer = {
      listDirectory: vi.fn().mockResolvedValue([
        { name: 'report.txt', kind: 'file' as const, size: 4 },
      ]),
      getWorkingDirectory: vi.fn().mockResolvedValue('/home/ops'),
      ensureDirectory: vi.fn(),
      rename: vi.fn(),
      removeFile: vi.fn(),
      removeDirectory: vi.fn(),
      uploadFile: vi.fn(),
      downloadFile: vi.fn(),
    }
    const connection = {
      close: vi.fn(),
      openShell: vi.fn().mockResolvedValue(shell),
      fileTransfer,
    }
    const service = new SessionService({ connect: vi.fn().mockResolvedValue(connection) }, { load: vi.fn() })
    const session = await service.connect({
      host: 'server-a', port: 22, username: 'ops', auth: { kind: 'password', password: 'secret' },
    })

    await expect(service.listDirectory(session.id, '/tmp')).resolves.toEqual([
      { name: 'report.txt', kind: 'file', size: 4 },
    ])
    expect(service.supportsFileTransfer(session.id)).toBe(true)
    expect(fileTransfer.listDirectory).toHaveBeenCalledWith('/tmp')
    await expect(service.getWorkingDirectory(session.id)).resolves.toBe('/home/ops')
    await service.ensureDirectory(session.id, '/srv/releases')
    await service.rename(session.id, '/srv/old.txt', '/srv/new.txt')
    await service.removeFile(session.id, '/srv/new.txt')
    await service.removeDirectory(session.id, '/srv/releases')
    expect(fileTransfer.getWorkingDirectory).toHaveBeenCalledOnce()
    expect(fileTransfer.ensureDirectory).toHaveBeenCalledWith('/srv/releases')
    expect(fileTransfer.rename).toHaveBeenCalledWith('/srv/old.txt', '/srv/new.txt')
    expect(fileTransfer.removeFile).toHaveBeenCalledWith('/srv/new.txt')
    expect(fileTransfer.removeDirectory).toHaveBeenCalledWith('/srv/releases')
  })

  it('keeps SFTP available for AccessClient SSH while leaving Raw bridge sessions unsupported', async () => {
    const accessFileTransfer = {
      listDirectory: vi.fn().mockResolvedValue([]),
      uploadFile: vi.fn(),
      downloadFile: vi.fn(),
    }
    const accessConnection = {
      close: vi.fn(),
      openShell: vi.fn().mockResolvedValue(createShell()),
      fileTransfer: accessFileTransfer,
    }
    const rawConnection = {
      close: vi.fn(),
      openShell: vi.fn().mockResolvedValue(createShell()),
    }
    const service = new SessionService(
      { connect: vi.fn().mockResolvedValue(accessConnection) },
      { load: vi.fn() },
      { connect: vi.fn().mockResolvedValue(rawConnection) },
    )

    const access = await service.connectAccessSsh({
      host: 'access.example.com', port: 22, username: 'ops', title: 'Access SSH', columns: 80, rows: 24,
    })
    const raw = await service.connectRaw({ host: '127.0.0.1', port: 22022 })

    expect(service.supportsFileTransfer(access.id)).toBe(true)
    expect(service.supportsFileTransfer(raw.id)).toBe(false)
    await expect(service.listDirectory(raw.id, '/')).rejects.toThrow('不支持 SFTP')
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
