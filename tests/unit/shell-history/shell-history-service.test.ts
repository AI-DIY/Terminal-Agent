import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerShellHistoryHandlers } from '../../../src/main/shell-history/register-shell-history-handlers'
import { ShellHistoryService } from '../../../src/main/shell-history/shell-history-service'
import { ShellHistoryRepository, type ShellHistoryRecord, type ShellHistoryRepositoryPort } from '../../../src/main/shell-history/shell-history-repository'

const { handle, removeHandler } = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle, removeHandler } }))

describe('ShellHistoryService', () => {
  it('keeps output in order, truncates one record to 256 KiB, and redacts secrets before persistence', async () => {
    const repository = createRepository()
    const service = new ShellHistoryService(repository, { createId: () => 'history-a' })
    service.attach({ sessionId: 'session-a', chatId: 'chat-a', hostname: 'web-01', title: 'web-01', connectionType: 'direct-ssh', startedAt: '2026-08-16T08:00:00.000Z' })
    service.append({ sessionId: 'session-a', data: 'first\r\n' })
    service.append({ sessionId: 'session-a', data: 'password=secret\r\n' })
    service.append({ sessionId: 'session-a', data: 'token=token-secret\r\n' })
    service.append({ sessionId: 'session-a', data: 'loaded tmp:C:\\Temp\\access-client\\session.conf\r\n' })
    service.append({ sessionId: 'session-a', data: 'x'.repeat(256 * 1024) })

    await service.close({ sessionId: 'session-a', endedAt: '2026-08-16T08:01:00.000Z' })

    const persisted = repository.saved[0]
    expect(persisted.output.startsWith('first\r\n')).toBe(true)
    expect(persisted.output).toContain('[REDACTED SENSITIVE CONTENT]')
    expect(persisted.output).not.toContain('secret')
    expect(persisted.output).not.toContain('token-secret')
    expect(persisted.output).not.toContain('C:\\Temp\\access-client\\session.conf')
    expect(Buffer.byteLength(persisted.output, 'utf8')).toBeLessThanOrEqual(256 * 1024)
  })

  it('adds a chat association after a session has already started and exposes only a safe renderer DTO', async () => {
    const repository = createRepository()
    const service = new ShellHistoryService(repository, { createId: () => 'history-b' })
    service.attach({ sessionId: 'session-b', hostname: 'db-01', title: 'db-01', connectionType: 'direct-ssh', startedAt: '2026-08-16T08:00:00.000Z' })
    service.append({ sessionId: 'session-b', data: 'select 1\r\n' })
    service.associate({ sessionId: 'session-b', chatId: 'chat-b', historyId: 'history-b' })

    await service.close({ sessionId: 'session-b', endedAt: '2026-08-16T08:01:00.000Z' })

    const summary = (await service.list({ chatId: 'chat-b' }))[0]
    expect(summary).toEqual({
      id: 'history-b', chatId: 'chat-b', hostname: 'db-01', title: 'db-01',
      startedAt: '2026-08-16T08:00:00.000Z', endedAt: '2026-08-16T08:01:00.000Z',
      status: 'closed', preview: 'select 1\r\n', reconnectable: false,
    })
    expect(Object.keys(summary).sort()).toEqual(['chatId', 'endedAt', 'hostname', 'id', 'preview', 'reconnectable', 'startedAt', 'status', 'title'])
    await expect(service.get('history-b')).resolves.toMatchObject({ id: 'history-b', output: 'select 1\r\n' })
  })

  it('reports a safe persistence error without rejecting terminal close', async () => {
    const repository = createRepository()
    repository.save = vi.fn().mockRejectedValue(new Error('password=secret at C:\\Temp\\access-client\\session.conf'))
    const service = new ShellHistoryService(repository)
    const changed: unknown[] = []
    service.onChanged(event => changed.push(event))
    service.attach({ sessionId: 'session-c', chatId: 'chat-c', hostname: 'web-02', title: 'web-02', connectionType: 'direct-ssh', startedAt: '2026-08-16T08:00:00.000Z' })
    service.append({ sessionId: 'session-c', data: 'output' })

    await expect(service.close({ sessionId: 'session-c', endedAt: '2026-08-16T08:01:00.000Z' })).resolves.toBeUndefined()
    expect(changed).toEqual([{ kind: 'error', message: 'Shell 历史保存失败，实时连接未受影响。' }])
    expect(JSON.stringify(changed)).not.toContain('secret')
    expect(JSON.stringify(changed)).not.toContain('access-client')
  })

  it('returns fixed safe list/get errors when a repository rejects with unsafe source data', async () => {
    const unsafeValue = 'INLINE_CREDENTIAL_PLACEHOLDER'
    const repository = createRepository()
    repository.list = vi.fn().mockRejectedValue(new Error(`malformed ${unsafeValue}`))
    repository.get = vi.fn().mockRejectedValue(new Error(`schema-invalid ${unsafeValue}`))
    const service = new ShellHistoryService(repository)

    for (const operation of [() => service.list({}), () => service.get('history-safe-error')]) {
      const error = await operation().catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe('Shell 历史暂不可用。')
      expect((error as Error).message).not.toContain(unsafeValue)
    }
  })

  it('redacts normal AccessClient temporary directories from persisted data and every history DTO', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-shell-history-service-temp-'))
    const path = join(directory, 'shell-history.json')
    const temporaryPaths = [
      ['C:', 'Temp', 'access-client', 'session.conf'].join('\\'),
      ['C:', 'Users', 'test-user', 'AppData', 'Local', 'Temp', 'terminal-agent-access-client-123', 'session.conf'].join('\\'),
    ]
    try {
      const service = new ShellHistoryService(new ShellHistoryRepository(path), { createId: () => 'history-temp' })
      const events: unknown[] = []
      service.onChanged(event => events.push(event))
      service.attach({
        sessionId: 'session-temp', chatId: 'chat-temp', hostname: 'web-03', title: temporaryPaths[0],
        connectionType: 'access-client-ssh', startedAt: '2026-08-16T08:00:00.000Z',
      })
      service.append({ sessionId: 'session-temp', data: temporaryPaths.map(temporaryPath => `opened ${temporaryPath}\r\n`).join('') })

      await service.close({ sessionId: 'session-temp', endedAt: '2026-08-16T08:01:00.000Z' })

      const persisted = await readFile(path, 'utf8')
      const summary = (await service.list({ chatId: 'chat-temp' }))[0]
      const detail = await service.get('history-temp')
      for (const temporaryPath of temporaryPaths) {
        for (const value of [persisted, summary, detail, events]) {
          expect(JSON.stringify(value)).not.toContain(temporaryPath)
          expect(JSON.stringify(value)).toContain('[REDACTED SENSITIVE CONTENT]')
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('redacts UNC AccessClient tmp paths from persisted data and every history DTO', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-shell-history-unc-'))
    const path = join(directory, 'shell-history.json')
    const temporaryPath = 'tmp:\\\\server\\share\\session.conf'
    try {
      const service = new ShellHistoryService(new ShellHistoryRepository(path), { createId: () => 'history-unc' })
      const events: unknown[] = []
      service.onChanged(event => events.push(event))
      service.attach({
        sessionId: 'session-unc', chatId: 'chat-unc', hostname: 'web-unc', title: 'web-unc',
        connectionType: 'access-client-ssh', startedAt: '2026-08-16T08:00:00.000Z',
      })
      service.append({ sessionId: 'session-unc', data: `opened ${temporaryPath}\r\n` })

      await service.close({ sessionId: 'session-unc', endedAt: '2026-08-16T08:01:00.000Z' })

      const persisted = await readFile(path, 'utf8')
      const summary = (await service.list({ chatId: 'chat-unc' }))[0]
      const detail = await service.get('history-unc')
      for (const value of [persisted, summary, detail, events]) {
        expect(JSON.stringify(value)).not.toContain(temporaryPath)
        expect(JSON.stringify(value)).toContain('[REDACTED SENSITIVE CONTENT]')
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('redacts complete private-key blocks and private-key paths from persistence and every renderer boundary', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-shell-history-private-key-'))
    const path = join(directory, 'shell-history.json')
    const privateKeyBlock = [
      '-----BEGIN TEST PRIVATE KEY-----',
      'PLACEHOLDER-KEY-MATERIAL-LINE',
      '-----END TEST PRIVATE KEY-----',
    ].join('\r\n')
    const privateKeyPaths = [
      ['C:', 'Users', 'example', '.ssh', 'id_ed25519'].join('\\'),
      '/home/example/.ssh/id_ed25519',
      '.ssh/id_ed25519',
      ['.ssh', 'id_ed25519'].join('\\'),
      '/opt/example/client.pem',
      ['C:', 'keys', 'client.ppk'].join('\\'),
      '/srv/keys/client.key',
      '/home/example/client.pem:',
      'client.ppk,',
      'client.key)',
    ]
    try {
      const service = new ShellHistoryService(new ShellHistoryRepository(path), { createId: () => 'history-private-key' })
      const events: unknown[] = []
      service.onChanged(event => events.push(event))
      service.attach({
        sessionId: 'session-private-key', chatId: 'chat-private-key', hostname: 'web-private-key', title: privateKeyPaths[0],
        connectionType: 'direct-ssh', startedAt: '2026-08-16T08:00:00.000Z',
      })
      service.append({
        sessionId: 'session-private-key',
        data: `${privateKeyBlock}\r\n${privateKeyPaths.map(privateKeyPath => `loaded ${privateKeyPath}`).join('\r\n')}`,
      })

      await service.close({ sessionId: 'session-private-key', endedAt: '2026-08-16T08:01:00.000Z' })

      const persisted = await readFile(path, 'utf8')
      const summary = (await service.list({ chatId: 'chat-private-key' }))[0]
      const detail = await service.get('history-private-key')
      for (const unsafeValue of ['PLACEHOLDER-KEY-MATERIAL-LINE', '-----END TEST PRIVATE KEY-----', ...privateKeyPaths]) {
        for (const value of [persisted, summary, detail, events]) {
          expect(JSON.stringify(value)).not.toContain(unsafeValue)
        }
      }
      for (const value of [persisted, summary, detail, events]) {
        expect(JSON.stringify(value)).toContain('[REDACTED SENSITIVE CONTENT]')
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('redacts every accepted relative and absolute tmp argument from persistence and every renderer boundary', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-shell-history-tmp-argument-'))
    const path = join(directory, 'shell-history.json')
    const temporaryPaths = [
      'tmp:session.conf',
      'tmp:C:session.conf',
      'tmp:relative folder\\session.conf',
      'tmp:C:\\Temp\\access-client\\session.conf',
      'tmp:\\\\server\\share\\session.conf',
      'tmp:\\\\?\\C:\\Temp\\access-client\\session.conf',
    ]
    try {
      const service = new ShellHistoryService(new ShellHistoryRepository(path), { createId: () => 'history-tmp-argument' })
      const events: unknown[] = []
      service.onChanged(event => events.push(event))
      service.attach({
        sessionId: 'session-tmp-argument', chatId: 'chat-tmp-argument', hostname: 'web-tmp-argument', title: temporaryPaths[0],
        connectionType: 'access-client-ssh', startedAt: '2026-08-16T08:00:00.000Z',
      })
      service.append({
        sessionId: 'session-tmp-argument',
        data: temporaryPaths.map(temporaryPath => `opened ${temporaryPath}\r\n`).join(''),
      })

      await service.close({ sessionId: 'session-tmp-argument', endedAt: '2026-08-16T08:01:00.000Z' })

      const persisted = await readFile(path, 'utf8')
      const summary = (await service.list({ chatId: 'chat-tmp-argument' }))[0]
      const detail = await service.get('history-tmp-argument')
      for (const temporaryPath of temporaryPaths) {
        for (const value of [persisted, summary, detail, events]) {
          expect(JSON.stringify(value)).not.toContain(temporaryPath)
        }
      }
      for (const value of [persisted, summary, detail, events]) {
        expect(JSON.stringify(value)).toContain('[REDACTED SENSITIVE CONTENT]')
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('redacts inline credentials from live output, command audit, persistence, and renderer history boundaries', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-shell-history-inline-credential-'))
    const path = join(directory, 'shell-history.json')
    const inlineCredentialCommands = [
      'curl --user operator:INLINE_CREDENTIAL_PLACEHOLDER https://host.example',
      'sshpass -p INLINE_CREDENTIAL_PLACEHOLDER ssh host.example',
      'redis-cli -a INLINE_CREDENTIAL_PLACEHOLDER',
    ]
    try {
      const service = new ShellHistoryService(new ShellHistoryRepository(path), { createId: () => 'history-inline-credential' })
      const events: unknown[] = []
      service.onChanged(event => events.push(event))
      service.attach({
        sessionId: 'session-inline-credential', chatId: 'chat-inline-credential', hostname: 'web-inline-credential', title: 'web-inline-credential',
        connectionType: 'direct-ssh', startedAt: '2026-08-16T08:00:00.000Z',
      })
      service.append({ sessionId: 'session-inline-credential', data: `${inlineCredentialCommands.join('\r\n')}\r\n` })
      for (const command of inlineCredentialCommands) service.audit({ sessionId: 'session-inline-credential', data: `${command}\r` })

      await service.close({ sessionId: 'session-inline-credential', endedAt: '2026-08-16T08:01:00.000Z' })

      const persisted = await readFile(path, 'utf8')
      const summary = (await service.list({ chatId: 'chat-inline-credential' }))[0]
      const detail = await service.get('history-inline-credential')
      for (const value of [persisted, summary, detail, events]) {
        expect(JSON.stringify(value)).not.toContain('INLINE_CREDENTIAL_PLACEHOLDER')
        expect(JSON.stringify(value)).toContain('[REDACTED SENSITIVE CONTENT]')
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('redacts a chunked ANSI password echo before every persistence, service, event, and IPC boundary', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-shell-history-password-echo-'))
    const path = join(directory, 'shell-history.json')
    const placeholder = 'INLINE_CREDENTIAL_PLACEHOLDER'
    const repository = new ShellHistoryRepository(path)
    const service = new ShellHistoryService(repository, { createId: () => 'history-password-echo' })
    const events: unknown[] = []
    const sender = { send: vi.fn() }
    handle.mockReset()
    removeHandler.mockReset()
    const dispose = registerShellHistoryHandlers(service, sender as never)
    service.onChanged(event => events.push(event))

    try {
      service.attach({
        sessionId: 'session-password-echo', chatId: 'chat-password-echo', hostname: 'web-password-echo', title: 'web-password-echo',
        connectionType: 'direct-ssh', startedAt: '2026-08-16T08:00:00.000Z',
      })
      service.append({ sessionId: 'session-password-echo', data: '\u001b[33mPassword: ' })
      service.append({ sessionId: 'session-password-echo', data: `${placeholder}\u001b[0m\r\n$ ` })

      await service.close({ sessionId: 'session-password-echo', endedAt: '2026-08-16T08:01:00.000Z' })

      const persisted = await readFile(path, 'utf8')
      const repositoryList = await repository.list({ chatId: 'chat-password-echo' })
      const repositoryDetail = await repository.get('history-password-echo')
      const serviceList = await service.list({ chatId: 'chat-password-echo' })
      const serviceDetail = await service.get('history-password-echo')
      const handlerList = await registeredHandler('shell-history:list')({ sender }, { chatId: 'chat-password-echo' })
      const handlerDetail = await registeredHandler('shell-history:get')({ sender }, 'history-password-echo')

      for (const value of [persisted, repositoryList, repositoryDetail, serviceList, serviceDetail, events, handlerList, handlerDetail]) {
        expect(JSON.stringify(value)).not.toContain(placeholder)
      }
    } finally {
      dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('redacts compact, URL, ANSI, and continuation-line inline credentials across every history boundary', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-shell-history-inline-credential-bypass-'))
    const path = join(directory, 'shell-history.json')
    const unsafeCommands = [
      'curl -uoperator:INLINE_CREDENTIAL_PLACEHOLDER https://host.example',
      'curl https://operator:INLINE_CREDENTIAL_PLACEHOLDER@host.example/',
      'redis-cli -aINLINE_CREDENTIAL_PLACEHOLDER ping',
      'curl -u \\\noperator:INLINE_CREDENTIAL_PLACEHOLDER https://host.example',
      '\u001b[31mcurl -uoperator:INLINE_CREDENTIAL_PLACEHOLDER https://host.example\u001b[0m',
    ]
    try {
      const service = new ShellHistoryService(new ShellHistoryRepository(path), { createId: () => 'history-inline-credential-bypass' })
      const events: unknown[] = []
      service.onChanged(event => events.push(event))
      service.attach({
        sessionId: 'session-inline-credential-bypass', chatId: 'chat-inline-credential-bypass', hostname: 'web-inline-credential-bypass', title: 'web-inline-credential-bypass',
        connectionType: 'direct-ssh', startedAt: '2026-08-16T08:00:00.000Z',
      })
      service.append({ sessionId: 'session-inline-credential-bypass', data: `${unsafeCommands.join('\r\n')}\r\n` })
      for (const command of unsafeCommands) service.audit({ sessionId: 'session-inline-credential-bypass', data: `${command}\r` })

      await service.close({ sessionId: 'session-inline-credential-bypass', endedAt: '2026-08-16T08:01:00.000Z' })

      const persisted = await readFile(path, 'utf8')
      const summary = (await service.list({ chatId: 'chat-inline-credential-bypass' }))[0]
      const detail = await service.get('history-inline-credential-bypass')
      for (const value of [persisted, summary, detail, events]) {
        expect(JSON.stringify(value)).not.toContain('INLINE_CREDENTIAL_PLACEHOLDER')
        expect(JSON.stringify(value)).toContain('[REDACTED SENSITIVE CONTENT]')
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('removes complete terminal control sequences before sensitive detection and every history boundary', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-shell-history-terminal-controls-'))
    const path = join(directory, 'shell-history.json')
    const controls = {
      csi: '\u001b[31m',
      oscBel: '\u001b]8;;https://host.example\u0007',
      oscSt: '\u001b]0;terminal title\u001b\\',
      dcs: '\u001bPignored\u001b\\',
      apc: '\u001b_ignored\u001b\\',
      pm: '\u001b^ignored\u001b\\',
      sos: '\u001bXignored\u001b\\',
    }
    const unsafeOutput = [
      `Pass${controls.oscBel}word:`,
      `curl --us${controls.oscSt}er operator:INLINE_CREDENTIAL_PLACEHOLDER https://host.example`,
      `curl https://operator:${controls.dcs}INLINE_CREDENTIAL_PLACEHOLDER@host.example/`,
      `-----BEGIN ${controls.apc}PRIVATE KEY-----\r\nTERMINAL-CONTROL-KEY-MATERIAL`,
      `opened tmp:${controls.pm}relative-session.conf`,
      `safe${controls.csi}${controls.sos} text`,
    ].join('\r\n')
    try {
      const service = new ShellHistoryService(new ShellHistoryRepository(path), { createId: () => 'history-terminal-controls' })
      const events: unknown[] = []
      service.onChanged(event => events.push(event))
      service.attach({
        sessionId: 'session-terminal-controls', chatId: 'chat-terminal-controls', hostname: 'web-terminal-controls', title: 'web-terminal-controls',
        connectionType: 'direct-ssh', startedAt: '2026-08-16T08:00:00.000Z',
      })
      service.append({ sessionId: 'session-terminal-controls', data: `${unsafeOutput}\r\n` })
      service.audit({ sessionId: 'session-terminal-controls', data: `curl --us${controls.oscSt}er operator:INLINE_CREDENTIAL_PLACEHOLDER https://host.example\r` })

      await service.close({ sessionId: 'session-terminal-controls', endedAt: '2026-08-16T08:01:00.000Z' })

      const persisted = await readFile(path, 'utf8')
      const summary = (await service.list({ chatId: 'chat-terminal-controls' }))[0]
      const detail = await service.get('history-terminal-controls')
      for (const value of [persisted, summary, detail, events]) {
        expect(JSON.stringify(value)).not.toContain('\u001b')
        expect(JSON.stringify(value)).not.toContain('\\u001b')
        expect(JSON.stringify(value)).not.toContain('INLINE_CREDENTIAL_PLACEHOLDER')
        expect(JSON.stringify(value)).not.toContain('TERMINAL-CONTROL-KEY-MATERIAL')
        expect(JSON.stringify(value)).not.toContain('tmp:relative-session.conf')
        expect(JSON.stringify(value)).toContain('[REDACTED SENSITIVE CONTENT]')
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('redacts shell continuation forms by removing backslash-newline across output and audit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-shell-history-continuation-'))
    const path = join(directory, 'shell-history.json')
    const continuedCommands = [
      'curl --user operator\\\r\n:INLINE_CREDENTIAL_PLACEHOLDER https://host.example',
      'curl https://operator\\\r\n:INLINE_CREDENTIAL_PLACEHOLDER@host.example/',
      'sshpass -\\\r\np INLINE_CREDENTIAL_PLACEHOLDER ssh host.example',
      'redis-cli -\\\r\naINLINE_CREDENTIAL_PLACEHOLDER',
    ]
    try {
      const service = new ShellHistoryService(new ShellHistoryRepository(path), { createId: () => 'history-continuation' })
      const events: unknown[] = []
      service.onChanged(event => events.push(event))
      service.attach({
        sessionId: 'session-continuation', chatId: 'chat-continuation', hostname: 'web-continuation', title: 'web-continuation',
        connectionType: 'direct-ssh', startedAt: '2026-08-16T08:00:00.000Z',
      })
      service.append({ sessionId: 'session-continuation', data: `${continuedCommands.join('\r\n')}\r\n` })
      for (const command of continuedCommands) service.audit({ sessionId: 'session-continuation', data: `${command}\r` })

      await service.close({ sessionId: 'session-continuation', endedAt: '2026-08-16T08:01:00.000Z' })

      const persisted = await readFile(path, 'utf8')
      const summary = (await service.list({ chatId: 'chat-continuation' }))[0]
      const detail = await service.get('history-continuation')
      for (const value of [persisted, summary, detail, events]) {
        expect(JSON.stringify(value)).not.toContain('INLINE_CREDENTIAL_PLACEHOLDER')
        expect(JSON.stringify(value)).toContain('[REDACTED SENSITIVE CONTENT]')
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('suppresses a sensitive prompt response while retaining following terminal output', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-shell-history-prompt-echo-'))
    const path = join(directory, 'shell-history.json')
    const response = 'INLINE_CREDENTIAL_PLACEHOLDER'
    try {
      const service = new ShellHistoryService(new ShellHistoryRepository(path), { createId: () => 'history-prompt-echo' })
      const events: unknown[] = []
      service.onChanged(event => events.push(event))
      service.attach({
        sessionId: 'session-prompt-echo', chatId: 'chat-prompt-echo', hostname: 'web-prompt-echo', title: 'web-prompt-echo',
        connectionType: 'direct-ssh', startedAt: '2026-08-16T08:00:00.000Z',
      })
      service.append({ sessionId: 'session-prompt-echo', data: '\u001b]0;ignored\u001b\\Enter pass' })
      service.append({ sessionId: 'session-prompt-echo', data: ` phrase ${'prompt-padding-'.repeat(50)}for key 'C:\\Users\\example\\.ssh\\id_ed25519': ` })
      service.audit({ sessionId: 'session-prompt-echo', data: `${response}\r` })
      service.append({ sessionId: 'session-prompt-echo', data: `${response}\r\n$ \r\n` })

      await service.close({ sessionId: 'session-prompt-echo', endedAt: '2026-08-16T08:01:00.000Z' })

      const persisted = await readFile(path, 'utf8')
      const summary = (await service.list({ chatId: 'chat-prompt-echo' }))[0]
      const detail = await service.get('history-prompt-echo')
      for (const value of [persisted, summary, detail, events]) {
        expect(JSON.stringify(value)).not.toContain(response)
        expect(JSON.stringify(value)).toContain('$ ')
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('persists a bounded redacted command audit without exposing it through renderer DTOs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-shell-history-command-audit-'))
    const path = join(directory, 'shell-history.json')
    const auditChunks = ['printf t', 'mp:relative folder\\session.conf .ssh/id_ed25519', '\r', 'x'.repeat(256 * 1024)]
    try {
      const service = new ShellHistoryService(new ShellHistoryRepository(path), { createId: () => 'history-command-audit' })
      const events: unknown[] = []
      service.onChanged(event => events.push(event))
      service.attach({
        sessionId: 'session-command-audit', chatId: 'chat-command-audit', hostname: 'web-command-audit', title: 'web-command-audit',
        connectionType: 'direct-ssh', startedAt: '2026-08-16T08:00:00.000Z',
      })
      expect('audit' in service).toBe(true)
      const audit = (service as ShellHistoryService & { audit(input: { sessionId: string; data: string }): void }).audit.bind(service)
      for (const data of auditChunks) audit({ sessionId: 'session-command-audit', data })

      await service.close({ sessionId: 'session-command-audit', endedAt: '2026-08-16T08:01:00.000Z' })

      const persisted = await readFile(path, 'utf8')
      const document = JSON.parse(persisted) as { records: Array<{ commandAudit: { input: string } }> }
      const summary = (await service.list({ chatId: 'chat-command-audit' }))[0]
      const detail = await service.get('history-command-audit')
      expect(document.records[0]?.commandAudit.input).toContain('[REDACTED SENSITIVE CONTENT]')
      expect(document.records[0]?.commandAudit.input).not.toContain('tmp:relative folder\\session.conf')
      expect(document.records[0]?.commandAudit.input).not.toContain('.ssh/id_ed25519')
      expect(Buffer.byteLength(document.records[0]?.commandAudit.input ?? '', 'utf8')).toBeLessThanOrEqual(256 * 1024)
      for (const value of [summary, detail, events]) {
        expect(value).not.toHaveProperty('commandAudit')
        expect(JSON.stringify(value)).not.toContain('tmp:relative folder\\session.conf')
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('drops an unlabelled interactive secret response after a sensitive terminal prompt', async () => {
    const repository = createRepository()
    const service = new ShellHistoryService(repository, { createId: () => 'history-sensitive-prompt' })
    service.attach({
      sessionId: 'session-sensitive-prompt', chatId: 'chat-sensitive-prompt', hostname: 'web-sensitive-prompt', title: 'web-sensitive-prompt',
      connectionType: 'direct-ssh', startedAt: '2026-08-16T08:00:00.000Z',
    })
    service.append({ sessionId: 'session-sensitive-prompt', data: '\u001b[31m[sudo] password for ops:\u001b[0m ' })
    service.audit({ sessionId: 'session-sensitive-prompt', data: 'STANDALONE-' })
    service.audit({ sessionId: 'session-sensitive-prompt', data: 'PLACEHOLDER\r' })
    service.append({ sessionId: 'session-sensitive-prompt', data: '\r\n$ ' })
    service.audit({ sessionId: 'session-sensitive-prompt', data: 'whoami\r' })

    await service.close({ sessionId: 'session-sensitive-prompt', endedAt: '2026-08-16T08:01:00.000Z' })

    expect(repository.saved[0]?.commandAudit.input).toContain('whoami')
    expect(repository.saved[0]?.commandAudit.input).not.toContain('STANDALONE-PLACEHOLDER')
  })

  it('drops secret responses after chunked prompts containing Windows paths, URLs, ANSI, and long text', async () => {
    const repository = createRepository()
    const service = new ShellHistoryService(repository, { createId: () => 'history-complex-prompt' })
    service.attach({
      sessionId: 'session-complex-prompt', chatId: 'chat-complex-prompt', hostname: 'web-complex-prompt', title: 'web-complex-prompt',
      connectionType: 'direct-ssh', startedAt: '2026-08-16T08:00:00.000Z',
    })
    service.append({ sessionId: 'session-complex-prompt', data: '\u001b[33mEnter pass' })
    service.append({ sessionId: 'session-complex-prompt', data: "phrase for key 'C:\\Users\\example\\.ssh\\id_ed25519':\u001b[0m " })
    service.audit({ sessionId: 'session-complex-prompt', data: 'WINDOWS-PATH-PLACEHOLDER\r' })
    service.append({ sessionId: 'session-complex-prompt', data: `\r\nPassword ${'prompt-padding-'.repeat(50)}` })
    service.append({ sessionId: 'session-complex-prompt', data: "for 'https://user@github.example': " })
    service.audit({ sessionId: 'session-complex-prompt', data: 'URL-PLACEHOLDER\r' })
    service.append({ sessionId: 'session-complex-prompt', data: '\r\n$ ' })
    service.audit({ sessionId: 'session-complex-prompt', data: 'hostname\r' })

    await service.close({ sessionId: 'session-complex-prompt', endedAt: '2026-08-16T08:01:00.000Z' })

    expect(repository.saved[0]?.commandAudit.input).toContain('hostname')
    expect(repository.saved[0]?.commandAudit.input).not.toContain('WINDOWS-PATH-PLACEHOLDER')
    expect(repository.saved[0]?.commandAudit.input).not.toContain('URL-PLACEHOLDER')
  })

  it('recognizes every supported password-like prompt marker and punctuation before accepting a bare response', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-shell-history-prompt-markers-'))
    const path = join(directory, 'shell-history.json')
    const prompts = [
      'Password:', 'Passphrase?', 'Pass phrase：', 'Pass-phrase？', 'passwd:', 'token?', 'secret：',
      'API key？', 'API Key:', 'API 密钥?', '密码：', '口令？', '令牌:', '密钥？',
    ]
    try {
      const service = new ShellHistoryService(new ShellHistoryRepository(path))
      for (const [index, prompt] of prompts.entries()) {
        const sessionId = `session-prompt-marker-${index}`
        const response = `PROMPT_MARKER_RESPONSE_${index}`
        service.attach({
          sessionId, historyId: `history-prompt-marker-${index}`, chatId: 'chat-prompt-marker', hostname: `host-prompt-marker-${index}`, title: `title-prompt-marker-${index}`,
          connectionType: 'direct-ssh', startedAt: '2026-08-16T08:00:00.000Z',
        })
        service.append({ sessionId, data: `${prompt} ` })
        service.audit({ sessionId, data: `${response}\r` })
        service.append({ sessionId, data: `${response}\r\nready-marker-${index}\r\n` })
        await service.close({ sessionId, endedAt: '2026-08-16T08:01:00.000Z' })
      }

      const persisted = await readFile(path, 'utf8')
      const summary = await service.list({ chatId: 'chat-prompt-marker' })
      for (const index of prompts.keys()) {
        const response = `PROMPT_MARKER_RESPONSE_${index}`
        const detail = await service.get(`history-prompt-marker-${index}`)
        for (const value of [persisted, summary, detail]) expect(JSON.stringify(value)).not.toContain(response)
      }
      expect(JSON.stringify(summary)).toContain(`ready-marker-${prompts.length - 1}`)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('redacts inline URL passwords with named and empty users before persistence or service DTOs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-shell-history-url-user-info-'))
    const path = join(directory, 'shell-history.json')
    const commands = [
      'https://operator:URL_USER_INFO_PLACEHOLDER@host.example',
      'redis://:URL_USER_INFO_PLACEHOLDER@cache.example',
    ]
    try {
      const service = new ShellHistoryService(new ShellHistoryRepository(path), { createId: () => 'history-url-user-info' })
      service.attach({
        sessionId: 'session-url-user-info', chatId: 'chat-url-user-info', hostname: 'host-url-user-info', title: 'title-url-user-info',
        connectionType: 'direct-ssh', startedAt: '2026-08-16T08:00:00.000Z',
      })
      service.append({ sessionId: 'session-url-user-info', data: `${commands.join('\r\n')}\r\n` })
      for (const command of commands) service.audit({ sessionId: 'session-url-user-info', data: `${command}\r` })
      await service.close({ sessionId: 'session-url-user-info', endedAt: '2026-08-16T08:01:00.000Z' })

      const persisted = await readFile(path, 'utf8')
      const summary = await service.list({ chatId: 'chat-url-user-info' })
      const detail = await service.get('history-url-user-info')
      for (const value of [persisted, summary, detail]) {
        expect(JSON.stringify(value)).not.toContain('URL_USER_INFO_PLACEHOLDER')
        expect(JSON.stringify(value)).toContain('[REDACTED SENSITIVE CONTENT]')
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('redacts extensionless SSH identity paths before persistence or service DTOs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-shell-history-identity-file-'))
    const path = join(directory, 'shell-history.json')
    const commands = [
      'ssh -i /opt/keys/production ssh-user@example.com',
      'ssh --identity-file C:\\Users\\operator\\keys\\production ssh-user@example.com',
    ]
    try {
      const service = new ShellHistoryService(new ShellHistoryRepository(path), { createId: () => 'history-identity-file' })
      service.attach({
        sessionId: 'session-identity-file', chatId: 'chat-identity-file', hostname: 'host-identity-file', title: 'title-identity-file',
        connectionType: 'direct-ssh', startedAt: '2026-08-16T08:00:00.000Z',
      })
      service.append({ sessionId: 'session-identity-file', data: `${commands.join('\r\n')}\r\n` })
      for (const command of commands) service.audit({ sessionId: 'session-identity-file', data: `${command}\r` })
      await service.close({ sessionId: 'session-identity-file', endedAt: '2026-08-16T08:01:00.000Z' })

      const persisted = await readFile(path, 'utf8')
      const summary = await service.list({ chatId: 'chat-identity-file' })
      const detail = await service.get('history-identity-file')
      for (const value of [persisted, summary, detail]) {
        expect(JSON.stringify(value)).not.toContain('/opt/keys/production')
        expect(JSON.stringify(value)).not.toContain('C:\\Users\\operator\\keys\\production')
        expect(JSON.stringify(value)).toContain('[REDACTED SENSITIVE CONTENT]')
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('does not rescan accumulated audit input for character-sized terminal writes', () => {
    const service = new ShellHistoryService(createRepository())
    service.attach({
      sessionId: 'session-audit-cost', chatId: 'chat-audit-cost', hostname: 'web-audit-cost', title: 'web-audit-cost',
      connectionType: 'direct-ssh', startedAt: '2026-08-16T08:00:00.000Z',
    })
    const byteLength = vi.spyOn(Buffer, 'byteLength')

    for (let index = 0; index < 1_000; index += 1) {
      service.audit({ sessionId: 'session-audit-cost', data: 'x' })
    }

    const accumulatedScans = byteLength.mock.calls.filter(([value]) => typeof value === 'string' && value.length > 1)
    byteLength.mockRestore()
    expect(accumulatedScans).toHaveLength(0)
  })

  it('rejects a missing history id with a fixed safe error', async () => {
    const repository = createRepository()
    const service = new ShellHistoryService(repository)

    const error = await service.get('history-private-placeholder').catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('Shell 历史记录不存在。')
    expect((error as Error).message).not.toContain('history-private-placeholder')
  })

  it('persists a safe internal connection type without exposing it in renderer history DTOs', async () => {
    const repository = createRepository()
    const service = new ShellHistoryService(repository, { createId: () => 'history-raw' })
    service.attach({
      sessionId: 'session-raw', chatId: 'chat-raw', hostname: '127.0.0.1', title: 'Raw terminal',
      connectionType: 'access-client-raw', startedAt: '2026-08-16T08:00:00.000Z',
    })

    await service.close({ sessionId: 'session-raw', endedAt: '2026-08-16T08:01:00.000Z' })

    expect(repository.saved[0]).toMatchObject({ connectionType: 'access-client-raw', reconnectable: false })
    expect(await service.list({ chatId: 'chat-raw' })).toEqual([expect.not.objectContaining({ connectionType: expect.anything() })])
    await expect(service.get('history-raw')).resolves.toEqual(expect.not.objectContaining({ connectionType: expect.anything() }))
  })

  it('persists only an opaque reconnect reference and returns a second authoritative session for duplicate or reconnect', async () => {
    const repository = createRepository()
    const opener = {
      canReconnect: vi.fn((reference: string) => reference === 'reconnect:0123456789abcdef'),
      duplicate: vi.fn(async (sessionId: string) => ({ id: `${sessionId}-copy`, hostname: 'web-01', mode: 'copilot' as const })),
      reconnect: vi.fn(async (_reference: string, chatId: string) => ({ id: 'session-reconnected', hostname: 'web-01', mode: 'copilot' as const, chatId })),
    }
    const service = new ShellHistoryService(repository, {
      createId: () => 'history-reconnect',
      connectionOpener: opener,
      now: () => new Date('2026-08-16T08:02:00.000Z'),
    })
    service.attach({
      sessionId: 'session-live', chatId: 'chat-reconnect', hostname: 'web-01', title: 'web-01',
      connectionType: 'direct-ssh', reconnectReference: 'reconnect:0123456789abcdef', startedAt: '2026-08-16T08:00:00.000Z',
    })

    await service.close({ sessionId: 'session-live', endedAt: '2026-08-16T08:01:00.000Z' })
    const duplicated = await service.duplicate('session-live')
    const reconnected = await service.reconnect('history-reconnect')
    const persisted = repository.saved[0]
    const rendererSummary = (await service.list({ chatId: 'chat-reconnect' }))[0]
    const rendererDetail = await service.get('history-reconnect')

    expect(duplicated).toEqual({ id: 'session-live-copy', hostname: 'web-01', mode: 'copilot' })
    expect(reconnected).toMatchObject({ id: 'session-reconnected', hostname: 'web-01', chatId: 'chat-reconnect' })
    expect(opener.duplicate).toHaveBeenCalledWith('session-live')
    expect(opener.reconnect).toHaveBeenCalledWith('reconnect:0123456789abcdef', 'chat-reconnect')
    expect(persisted).toMatchObject({ reconnectReference: 'reconnect:0123456789abcdef', reconnectable: true, reconnectAudit: { count: 1, lastReconnectedAt: '2026-08-16T08:02:00.000Z' } })
    for (const boundary of [rendererSummary, rendererDetail]) {
      expect(boundary).not.toHaveProperty('reconnectReference')
      expect(boundary).not.toHaveProperty('connectionType')
      expect(JSON.stringify(boundary)).not.toContain('credential-placeholder')
    }
  })

  it('refuses a reconnect after its main-process descriptor has expired without exposing the opaque reference', async () => {
    const repository = createRepository()
    const opener = {
      canReconnect: vi.fn(() => false),
      duplicate: vi.fn(),
      reconnect: vi.fn(),
    }
    const service = new ShellHistoryService(repository, { createId: () => 'history-expired', connectionOpener: opener })
    service.attach({
      sessionId: 'session-expired', chatId: 'chat-expired', hostname: 'web-expired', title: 'web-expired',
      connectionType: 'access-client-ssh', reconnectReference: 'reconnect:fedcba9876543210', startedAt: '2026-08-16T08:00:00.000Z',
    })
    await service.close({ sessionId: 'session-expired', endedAt: '2026-08-16T08:01:00.000Z' })

    const error = await service.reconnect('history-expired').catch((caught: unknown) => caught)
    const summary = (await service.list({ chatId: 'chat-expired' }))[0]

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('Shell 历史重连不可用。')
    expect((error as Error).message).not.toContain('reconnect:fedcba9876543210')
    expect(opener.reconnect).not.toHaveBeenCalled()
    expect(summary?.reconnectable).toBe(false)
  })
})

function createRepository(): ShellHistoryRepositoryPort & { saved: ShellHistoryRecord[] } {
  const saved: ShellHistoryRecord[] = []
  return {
    saved,
    save: vi.fn(async (record: ShellHistoryRecord) => {
      const index = saved.findIndex(item => item.id === record.id)
      if (index >= 0) saved[index] = record
      else saved.push(record)
    }),
    list: vi.fn(async ({ chatId, hostname }: { chatId?: string; hostname?: string }) => saved.filter(item => (!chatId || item.chatId === chatId) && (!hostname || item.hostname === hostname))),
    get: vi.fn(async (id: string) => saved.find(item => item.id === id)),
  }
}

function registeredHandler(channel: string): (event: { sender: unknown }, request?: unknown) => Promise<unknown> {
  const match = handle.mock.calls.find(([registered]) => registered === channel)
  if (!match) throw new Error(`Missing handler: ${channel}`)
  return match[1] as (event: { sender: unknown }, request?: unknown) => Promise<unknown>
}
