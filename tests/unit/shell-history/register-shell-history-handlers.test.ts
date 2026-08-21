import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerShellHistoryHandlers } from '../../../src/main/shell-history/register-shell-history-handlers'
import { ShellHistoryRepository } from '../../../src/main/shell-history/shell-history-repository'
import { ShellHistoryService } from '../../../src/main/shell-history/shell-history-service'
import type { ShellHistoryChangedEvent } from '../../../src/shared/contracts'
import type { ShellHistoryDetail } from '../../../src/shared/contracts'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { handle, removeHandler } = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle, removeHandler } }))

describe('registerShellHistoryHandlers', () => {
  beforeEach(() => { handle.mockReset(); removeHandler.mockReset() })

  it('validates trusted list/get requests, forwards changes, and removes every handler', async () => {
    const unsubscribe = vi.fn()
    let changed: ((event: ShellHistoryChangedEvent) => void) | undefined
    const service = {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue({
        id: 'history-a', chatId: 'chat-a', hostname: 'web-01', title: 'web-01',
        startedAt: '2026-08-16T08:00:00.000Z', endedAt: '2026-08-16T08:01:00.000Z',
        status: 'closed', preview: 'ready', output: 'ready', reconnectable: false,
      } satisfies ShellHistoryDetail),
      duplicate: vi.fn(),
      reconnect: vi.fn(),
      onChanged: vi.fn((listener: (event: ShellHistoryChangedEvent) => void) => {
        changed = listener
        return unsubscribe
      }),
    }
    const sender = { send: vi.fn() }
    const dispose = registerShellHistoryHandlers(service, sender as never)

    await expect(handler('shell-history:list')({ sender }, { chatId: 'chat-a', hostname: 'web-01' })).resolves.toEqual([])
    await expect(handler('shell-history:get')({ sender }, 'history-a')).resolves.toMatchObject({ id: 'history-a' })
    expect(service.list).toHaveBeenCalledWith({ chatId: 'chat-a', hostname: 'web-01' })
    expect(service.get).toHaveBeenCalledWith('history-a')
    expect(() => handler('shell-history:list')({ sender: {} }, { chatId: 'chat-a' })).toThrow('Untrusted renderer')
    expect(() => handler('shell-history:list')({ sender }, { chatId: 'chat-a', credential: 'secret' })).toThrow()
    expect(() => handler('shell-history:get')({ sender }, { historyId: 'history-a' })).toThrow()

    changed?.({ kind: 'error', message: 'Shell 历史保存失败，实时连接未受影响。' })
    expect(sender.send).toHaveBeenCalledWith('shell-history:changed', { kind: 'error', message: 'Shell 历史保存失败，实时连接未受影响。' })

    dispose()
    dispose()
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(removeHandler).toHaveBeenCalledWith('shell-history:list')
    expect(removeHandler).toHaveBeenCalledWith('shell-history:get')
    expect(removeHandler).toHaveBeenCalledWith('shell-history:duplicate')
    expect(removeHandler).toHaveBeenCalledWith('shell-history:reconnect')
    expect(removeHandler).toHaveBeenCalledTimes(4)
  })

  it('accepts only IDs for duplicate and reconnect, returning a strict safe connected-session DTO', async () => {
    const service = {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn(),
      duplicate: vi.fn().mockResolvedValue({ id: 'session-copy', hostname: 'web-01', mode: 'copilot', password: 'credential-placeholder' }),
      reconnect: vi.fn().mockResolvedValue({ id: 'session-reconnected', hostname: 'web-01', title: 'web-01', mode: 'copilot', chatId: 'chat-history', reconnectReference: 'reconnect:0123456789abcdef' }),
      onChanged: vi.fn(() => () => undefined),
    }
    const sender = { send: vi.fn() }
    registerShellHistoryHandlers(service as never, sender as never)

    await expect(handler('shell-history:duplicate')({ sender }, 'session-live')).resolves.toEqual({ id: 'session-copy', hostname: 'web-01', mode: 'copilot' })
    await expect(handler('shell-history:duplicate')({ sender }, { sessionId: 'session-live', chatId: 'chat-target' })).resolves.toEqual({ id: 'session-copy', hostname: 'web-01', mode: 'copilot' })
    await expect(handler('shell-history:reconnect')({ sender }, 'history-a')).resolves.toEqual({ id: 'session-reconnected', hostname: 'web-01', title: 'web-01', mode: 'copilot', chatId: 'chat-history' })
    expect(service.duplicate).toHaveBeenCalledWith('session-live')
    expect(service.duplicate).toHaveBeenCalledWith('session-live', 'chat-target')
    expect(service.reconnect).toHaveBeenCalledWith('history-a')
    expect(() => handler('shell-history:duplicate')({ sender }, { sessionId: 'session-live', password: 'credential-placeholder' })).toThrow()
    expect(() => handler('shell-history:reconnect')({ sender }, { historyId: 'history-a', command: 'credential-placeholder' })).toThrow()
  })

  it('runtime-validates and sanitizes outbound list/get DTOs before they reach the renderer', async () => {
    const unsafeValue = 'INLINE_CREDENTIAL_PLACEHOLDER'
    const sender = { send: vi.fn() }
    const service = {
      list: vi.fn()
        .mockResolvedValueOnce([{
          id: 'history-a', chatId: 'chat-a', hostname: `tmp:${unsafeValue}`, title: `curl --user operator:${unsafeValue}`,
          startedAt: '2026-08-16T08:00:00.000Z', endedAt: '2026-08-16T08:01:00.000Z', status: 'closed',
          preview: `\u001b[31mcurl --user operator:${unsafeValue}`, reconnectable: false,
        }])
        .mockResolvedValueOnce([{
          id: 'history-a', chatId: 'chat-a', hostname: 'web-01', title: 'web-01',
          startedAt: '2026-08-16T08:00:00.000Z', endedAt: '2026-08-16T08:01:00.000Z', status: 'closed', preview: 'ready', reconnectable: false,
          commandAudit: { input: unsafeValue },
        }]),
      get: vi.fn().mockResolvedValue({
        id: 'history-a', chatId: 'chat-a', hostname: 'web-01', title: 'web-01',
        startedAt: '2026-08-16T08:00:00.000Z', endedAt: '2026-08-16T08:01:00.000Z', status: 'closed',
        preview: `curl --user operator:${unsafeValue}`, output: `\u001b]0;ignored\u001b\\${unsafeValue}`, reconnectable: false,
      }),
      onChanged: vi.fn(() => () => undefined),
    }
    registerShellHistoryHandlers(service as never, sender as never)

    const list = await handler('shell-history:list')({ sender }, {})
    const detail = await handler('shell-history:get')({ sender }, 'history-a')

    for (const value of [list, detail]) {
      expect(JSON.stringify(value)).not.toContain(unsafeValue)
      expect(JSON.stringify(value)).not.toContain('\u001b')
      expect(JSON.stringify(value)).toContain('[REDACTED SENSITIVE CONTENT]')
    }
    await expect(handler('shell-history:list')({ sender }, {})).rejects.toThrow()
  })

  it('redacts an ANSI coalesced password response while preserving following safe output across public boundaries', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-shell-history-password-response-'))
    const path = join(directory, 'shell-history.json')
    const sender = { send: vi.fn() }
    try {
      const service = new ShellHistoryService(new ShellHistoryRepository(path), { createId: () => 'history-password-response' })
      const savedEvents: unknown[] = []
      service.onChanged(event => savedEvents.push(event))
      service.attach({
        sessionId: 'session-password-response', chatId: 'chat-password-response', hostname: 'host-password-response', title: 'title-password-response',
        connectionType: 'direct-ssh', startedAt: '2026-08-16T08:00:00.000Z',
      })
      service.append({ sessionId: 'session-password-response', data: '\u001b[31mPassword:\u001b[0m\r\nINLINE_CREDENTIAL_PLACEHOLDER\r\nready\r\n' })
      registerShellHistoryHandlers(service, sender as never)

      await service.close({ sessionId: 'session-password-response', endedAt: '2026-08-16T08:01:00.000Z' })

      const persisted = await readFile(path, 'utf8')
      const summary = (await service.list({ chatId: 'chat-password-response' }))[0]
      const detail = await service.get('history-password-response')
      const listOutput = await handler('shell-history:list')({ sender }, { chatId: 'chat-password-response' })
      const getOutput = await handler('shell-history:get')({ sender }, 'history-password-response')
      const handlerEvent = sender.send.mock.calls[0]?.[1]

      for (const value of [persisted, summary, detail, savedEvents, listOutput, getOutput, handlerEvent]) {
        expect(JSON.stringify(value)).not.toContain('INLINE_CREDENTIAL_PLACEHOLDER')
        expect(JSON.stringify(value)).toContain('ready')
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('redacts bare responses after prompts split through every supported terminal control family at all public boundaries', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-shell-history-split-controls-'))
    const path = join(directory, 'shell-history.json')
    const sender = { send: vi.fn() }
    const response = 'SPLIT_CONTROL_RESPONSE_PLACEHOLDER'
    const controls = [
      ['Pass\u001b[', '31mword: '],
      ['Pass\u001b]0;ignored', '\u001b\\word: '],
      ['Pass\u001bPignored', '\u001b\\word: '],
      ['Pass\u001b_ignored', '\u001b\\word: '],
      ['Pass\u001b^ignored', '\u001b\\word: '],
      ['Pass\u001bXignored', '\u001b\\word: '],
      ['Pass\u009b', '31mword: '],
      ['Pass\u009dignored', '\u009cword: '],
      ['Pass\u0090ignored', '\u009cword: '],
      ['Pass\u009fignored', '\u009cword: '],
      ['Pass\u009eignored', '\u009cword: '],
      ['Pass\u0098ignored', '\u009cword: '],
    ] as const
    try {
      const service = new ShellHistoryService(new ShellHistoryRepository(path))
      const savedEvents: unknown[] = []
      service.onChanged(event => savedEvents.push(event))
      registerShellHistoryHandlers(service, sender as never)

      for (const [index, [firstChunk, secondChunk]] of controls.entries()) {
        const sessionId = `session-split-controls-${index}`
        const historyId = `history-split-controls-${index}`
        service.attach({
          sessionId, historyId, chatId: 'chat-split-controls', hostname: `host-split-controls-${index}`, title: `title-split-controls-${index}`,
          connectionType: 'direct-ssh', startedAt: '2026-08-16T08:00:00.000Z',
        })
        service.append({ sessionId, data: firstChunk })
        service.append({ sessionId, data: secondChunk })
        service.append({ sessionId, data: '\r\n' })
        service.audit({ sessionId, data: `${response}\r` })
        service.append({ sessionId, data: `${response}\r\nready-${index}\r\n` })
        await service.close({ sessionId, endedAt: '2026-08-16T08:01:00.000Z' })

        const detail = await handler('shell-history:get')({ sender }, historyId)
        expect(JSON.stringify(detail)).not.toContain(response)
        expect(JSON.stringify(detail)).toContain(`ready-${index}`)
      }

      const persisted = await readFile(path, 'utf8')
      const summary = await service.list({ chatId: 'chat-split-controls' })
      const listOutput = await handler('shell-history:list')({ sender }, { chatId: 'chat-split-controls' })
      const handlerEvents = sender.send.mock.calls.map(([, event]) => event)
      for (const value of [persisted, summary, savedEvents, listOutput, handlerEvents]) {
        expect(JSON.stringify(value)).not.toContain(response)
        expect(JSON.stringify(value)).toContain('ready-0')
        expect(JSON.stringify(value)).toContain(`ready-${controls.length - 1}`)
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('redacts private-key blocks and password values split across append chunks at every public boundary', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-shell-history-split-secrets-'))
    const path = join(directory, 'shell-history.json')
    const sender = { send: vi.fn() }
    const privateKeyMaterial = 'c3BsaXQtcHJpdmF0ZS1rZXktbWF0ZXJpYWw='
    const passwordValue = 'SPLIT_PASSWORD_VALUE_PLACEHOLDER'
    const promptResponse = 'SPLIT_PROMPT_RESPONSE_PLACEHOLDER'
    try {
      const repository = new ShellHistoryRepository(path)
      const service = new ShellHistoryService(repository)
      const savedEvents: unknown[] = []
      service.onChanged(event => savedEvents.push(event))
      registerShellHistoryHandlers(service, sender as never)

      service.attach({
        sessionId: 'session-split-private-key', historyId: 'history-split-private-key', chatId: 'chat-split-secrets', hostname: 'host-split-private-key', title: 'title-split-private-key',
        connectionType: 'direct-ssh', startedAt: '2026-08-16T08:00:00.000Z',
      })
      service.append({ sessionId: 'session-split-private-key', data: '-----BEGIN OPENSSH PRIVATE KEY-----\r\n' })
      service.append({ sessionId: 'session-split-private-key', data: `${privateKeyMaterial}\r\n` })
      service.append({ sessionId: 'session-split-private-key', data: '-----END OPENSSH PRIVATE KEY-----\r\nsafe-private-key-output\r\n' })
      await service.close({ sessionId: 'session-split-private-key', endedAt: '2026-08-16T08:01:00.000Z' })

      service.attach({
        sessionId: 'session-split-password', historyId: 'history-split-password', chatId: 'chat-split-secrets', hostname: 'host-split-password', title: 'title-split-password',
        connectionType: 'direct-ssh', startedAt: '2026-08-16T08:00:00.000Z',
      })
      service.append({ sessionId: 'session-split-password', data: 'password=' })
      service.append({ sessionId: 'session-split-password', data: `${passwordValue}\r\nsafe-password-output\r\n` })
      await service.close({ sessionId: 'session-split-password', endedAt: '2026-08-16T08:01:00.000Z' })

      service.attach({
        sessionId: 'session-prompt-safe-output', historyId: 'history-prompt-safe-output', chatId: 'chat-split-secrets', hostname: 'host-prompt-safe-output', title: 'title-prompt-safe-output',
        connectionType: 'direct-ssh', startedAt: '2026-08-16T08:00:00.000Z',
      })
      service.append({ sessionId: 'session-prompt-safe-output', data: 'Password:\r\n' })
      service.audit({ sessionId: 'session-prompt-safe-output', data: `${promptResponse}\r` })
      service.append({ sessionId: 'session-prompt-safe-output', data: `${promptResponse}\r\nsafe-after-redacted-prompt\r\n` })
      await service.close({ sessionId: 'session-prompt-safe-output', endedAt: '2026-08-16T08:01:00.000Z' })

      const persisted = await readFile(path, 'utf8')
      const repositoryList = await repository.list({ chatId: 'chat-split-secrets' })
      const repositoryDetails = await Promise.all([
        repository.get('history-split-private-key'),
        repository.get('history-split-password'),
        repository.get('history-prompt-safe-output'),
      ])
      const serviceList = await service.list({ chatId: 'chat-split-secrets' })
      const serviceDetails = await Promise.all([
        service.get('history-split-private-key'),
        service.get('history-split-password'),
        service.get('history-prompt-safe-output'),
      ])
      const ipcList = await handler('shell-history:list')({ sender }, { chatId: 'chat-split-secrets' })
      const ipcDetails = await Promise.all([
        handler('shell-history:get')({ sender }, 'history-split-private-key'),
        handler('shell-history:get')({ sender }, 'history-split-password'),
        handler('shell-history:get')({ sender }, 'history-prompt-safe-output'),
      ])
      const handlerEvents = sender.send.mock.calls.map(([, event]) => event)

      for (const value of [persisted, repositoryList, repositoryDetails, serviceList, serviceDetails, savedEvents, ipcList, ipcDetails, handlerEvents]) {
        expect(JSON.stringify(value)).not.toContain(privateKeyMaterial)
        expect(JSON.stringify(value)).not.toContain(passwordValue)
        expect(JSON.stringify(value)).not.toContain(promptResponse)
        expect(JSON.stringify(value)).toContain('[REDACTED SENSITIVE CONTENT]')
      }
      for (const value of [persisted, repositoryList, repositoryDetails, serviceList, serviceDetails, savedEvents, ipcList, ipcDetails, handlerEvents]) {
        expect(JSON.stringify(value)).toContain('safe-after-redacted-prompt')
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

function handler(channel: string): (event: { sender: unknown }, request?: unknown) => Promise<unknown> {
  const match = handle.mock.calls.find(([registered]) => registered === channel)
  if (!match) throw new Error(`Missing handler: ${channel}`)
  return match[1] as (event: { sender: unknown }, request?: unknown) => Promise<unknown>
}
