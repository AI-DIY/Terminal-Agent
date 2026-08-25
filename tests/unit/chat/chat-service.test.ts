import { describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, open, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ChatRepository } from '../../../src/main/chat/chat-repository'
import { ChatService } from '../../../src/main/chat/chat-service'
import { SessionService } from '../../../src/main/ssh/session-service'
import type { AtomicJsonStoreFileSystem } from '../../../src/main/persistence/atomic-json-store'

function service() {
  const repository = {
    create: vi.fn(), listSnapshot: vi.fn(), get: vi.fn(), setMode: vi.fn(), remove: vi.fn(),
    appendMessage: vi.fn(), updateTitle: vi.fn(), pin: vi.fn(), unpin: vi.fn(), associateShell: vi.fn(), associateOrCreateShell: vi.fn(), recordSessionRequest: vi.fn(), transferSessions: vi.fn(), closeAssociation: vi.fn(), closeSession: vi.fn(), findOpenSession: vi.fn(), findSessionRequest: vi.fn(), openSessionIds: vi.fn(), recoverInterruptedStreams: vi.fn(),
  }
  return { repository, service: new ChatService(repository as unknown as ChatRepository) }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}

describe('ChatService', () => {
  it('publishes pin state only after a real repository mutation', async () => {
    const { repository, service: chatService } = service()
    const workspace = {
      id: 'chat-1', title: '任务', titleState: 'custom' as const, pinnedAt: '2026-08-16T08:01:00.000Z',
      createdAt: '2026-08-16T08:00:00.000Z', updatedAt: '2026-08-16T08:00:00.000Z',
      shellCount: 0, mode: 'copilot' as const, live: false, messages: [], shells: [],
    }
    repository.pin.mockResolvedValue({ value: workspace, changed: true, liveChatId: null })
    repository.unpin.mockResolvedValue({ value: { ...workspace, pinnedAt: null }, changed: false, liveChatId: null })
    const listener = vi.fn()
    chatService.onChanged(listener)

    await expect(chatService.pin({ requestId: 'pin-1', chatId: workspace.id })).resolves.toMatchObject({ revision: 1, chat: workspace })
    await expect(chatService.unpin({ requestId: 'unpin-1', chatId: workspace.id })).resolves.toMatchObject({ revision: 1 })

    expect(repository.pin).toHaveBeenCalledWith({ requestId: 'pin-1', chatId: workspace.id })
    expect(repository.unpin).toHaveBeenCalledWith({ requestId: 'unpin-1', chatId: workspace.id })
    expect(listener).toHaveBeenCalledOnce()
  })

  it('serializes interrupted stream recovery without publishing a renderer change', async () => {
    const { repository, service: chatService } = service()
    repository.recoverInterruptedStreams.mockResolvedValue(1)
    const listener = vi.fn()
    chatService.onChanged(listener)

    await expect(chatService.recoverInterruptedStreams()).resolves.toBeUndefined()

    expect(repository.recoverInterruptedStreams).toHaveBeenCalledOnce()
    expect(listener).not.toHaveBeenCalled()
  })

  it('returns revisioned snapshots and publishes full workspaces in revision order', async () => {
    const { repository, service: chatService } = service()
    const workspace = {
      id: '11111111-1111-4111-8111-111111111111', title: 'chat', titleState: 'custom' as const, pinnedAt: null, createdAt: '2026-08-16T08:00:00.000Z', updatedAt: '2026-08-16T08:00:00.000Z',
      shellCount: 0, mode: 'copilot' as const, live: false, messages: [], shells: [],
    }
    repository.listSnapshot.mockResolvedValue({ chats: [workspace], liveChatId: workspace.id })
    repository.create.mockResolvedValue({ value: workspace, changed: true, liveChatId: workspace.id })
    const listener = vi.fn()
    chatService.onChanged(listener)

    await expect(chatService.list()).resolves.toEqual({ revision: 0, chats: [workspace], liveChatId: workspace.id })
    await expect(chatService.create({ requestId: 'create-1' })).resolves.toEqual({ revision: 1, chat: workspace, liveChatId: workspace.id })

    expect(listener).toHaveBeenCalledWith({ revision: 1, kind: 'created', chat: workspace, liveChatId: workspace.id })
    await expect(chatService.list()).resolves.toEqual({ revision: 1, chats: [workspace], liveChatId: workspace.id })
  })

  it('retries a workspace read when its result predates the current revision', async () => {
    const { repository, service: chatService } = service()
    const oldWorkspace = {
      id: 'chat-1', title: '旧标题', titleState: 'custom' as const, pinnedAt: null, createdAt: '2026-08-16T08:00:00.000Z', updatedAt: '2026-08-16T08:00:00.000Z',
      shellCount: 0, mode: 'copilot' as const, live: false, messages: [], shells: [],
    }
    const newWorkspace = { ...oldWorkspace, title: '新标题', updatedAt: '2026-08-16T08:01:00.000Z' }
    const pending = deferred<typeof oldWorkspace>()
    repository.get.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(newWorkspace)
    repository.listSnapshot.mockResolvedValue({ chats: [newWorkspace], liveChatId: newWorkspace.id })
    repository.create.mockResolvedValue({ value: newWorkspace, changed: true, liveChatId: newWorkspace.id })

    const reading = chatService.get('chat-1')
    await chatService.create({ requestId: 'create-1' })
    pending.resolve(oldWorkspace)

    await expect(reading).resolves.toEqual({ revision: 1, chat: newWorkspace, liveChatId: newWorkspace.id })
    expect(repository.get).toHaveBeenCalledTimes(2)
  })

  it('resolves an active session to its authoritative chat workspace', async () => {
    const { repository, service: chatService } = service()
    const association = {
      id: 'association-1', chatId: 'chat-1', sessionId: 'session-1', historyId: 'history-1', hostname: 'host', title: 'host',
      status: 'open' as const, associatedAt: '2026-08-16T08:00:00.000Z',
    }
    const workspace = {
      id: 'chat-1', title: 'chat', titleState: 'custom' as const, pinnedAt: null, createdAt: association.associatedAt, updatedAt: association.associatedAt,
      shellCount: 1, mode: 'copilot' as const, live: true, messages: [], shells: [association],
    }
    repository.findOpenSession.mockResolvedValue(association)
    repository.get.mockResolvedValue(workspace)
    repository.listSnapshot.mockResolvedValue({ chats: [workspace], liveChatId: workspace.id })

    await expect((chatService as unknown as {
      resolveSession(sessionId: string): Promise<unknown>
    }).resolveSession('session-1')).resolves.toEqual({ revision: 0, sessionId: 'session-1', chat: workspace, liveChatId: workspace.id })
    repository.findOpenSession.mockResolvedValue(undefined)
    await expect((chatService as unknown as {
      resolveSession(sessionId: string): Promise<unknown>
    }).resolveSession('unowned')).resolves.toEqual({ revision: 0, sessionId: 'unowned', chat: null, liveChatId: workspace.id })
  })

  it('derives association metadata from a real main-process session and closes it by session id', async () => {
    const { repository, service: chatService } = service()
    const workspace = {
      id: '11111111-1111-4111-8111-111111111111', title: 'chat', titleState: 'custom' as const, pinnedAt: null, createdAt: '2026-08-16T08:00:00.000Z', updatedAt: '2026-08-16T08:00:00.000Z',
      shellCount: 1, mode: 'copilot' as const, live: true, messages: [], shells: [],
    }
    repository.associateOrCreateShell.mockResolvedValue({ value: workspace, changed: true, liveChatId: workspace.id })
    repository.closeSession.mockResolvedValue({ value: workspace, changed: true, liveChatId: null })

    await expect(chatService.associateSession(
      { requestId: 'bind-1', chatId: workspace.id, sessionId: 's1' },
      { id: 's1', hostname: 'real-host', title: 'trusted title', mode: 'copilot' },
    )).resolves.toEqual({ revision: 1, chat: workspace, liveChatId: workspace.id })
    await chatService.closeSession('s1')

    expect(repository.associateOrCreateShell).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'bind-1', chatId: workspace.id, sessionId: 's1', hostname: 'real-host', title: 'trusted title',
    }))
    expect(repository.closeSession).toHaveBeenCalledWith('s1', expect.any(String))
  })

  it('sanitizes normal session-bind metadata before chat persistence and changed events', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chat-service-safe-bind-'))
    const path = join(directory, 'chat-workspaces.json')
    const chatService = new ChatService(new ChatRepository(path))
    const changed: unknown[] = []
    const unsafeValue = 'INLINE_CREDENTIAL_PLACEHOLDER'
    chatService.onChanged(event => changed.push(event))
    try {
      const chat = (await chatService.create({ requestId: 'create-safe-bind' })).chat
      await chatService.associateSession(
        { requestId: 'bind-safe-metadata', chatId: chat.id, sessionId: 'session-safe-bind' },
        {
          id: 'session-safe-bind',
          hostname: `tmp:\\\\server\\share\\${unsafeValue}.conf`,
          title: '\u001b]0;ignored\u0007.ssh/id_ed25519',
          mode: 'copilot',
        },
      )

      const persisted = await readFile(path, 'utf8')
      for (const value of [persisted, changed]) {
        expect(JSON.stringify(value)).not.toContain(unsafeValue)
        expect(JSON.stringify(value)).not.toContain('tmp:\\\\server\\share')
        expect(JSON.stringify(value)).not.toContain('\u001b')
        expect(JSON.stringify(value)).not.toContain('\\u001b')
        expect(JSON.stringify(value)).toContain('[REDACTED SENSITIVE CONTENT]')
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('sanitizes close-before-bind fallback metadata before chat persistence and changed events', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chat-service-safe-fallback-'))
    const path = join(directory, 'chat-workspaces.json')
    const chatService = new ChatService(new ChatRepository(path))
    const changed: unknown[] = []
    const unsafeValue = 'INLINE_CREDENTIAL_PLACEHOLDER'
    chatService.onChanged(event => changed.push(event))
    try {
      await chatService.ensureClosedHistoryAssociation({
        id: 'session-safe-fallback',
        hostname: `password=${unsafeValue} token=${unsafeValue}`,
        title: `tmp:\\\\server\\share\\${unsafeValue}.conf`,
        mode: 'copilot',
      })

      const persisted = await readFile(path, 'utf8')
      for (const value of [persisted, changed]) {
        expect(JSON.stringify(value)).not.toContain(unsafeValue)
        expect(JSON.stringify(value)).not.toContain('tmp:\\\\server\\share')
        expect(JSON.stringify(value)).not.toContain('\u001b')
        expect(JSON.stringify(value)).not.toContain('\\u001b')
        expect(JSON.stringify(value)).toContain('[REDACTED SENSITIVE CONTENT]')
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('keeps same-chat session binding idempotent and atomically transfers cross-chat ownership', async () => {
    const { repository, service: chatService } = service()
    const existing = { id: 'association-1', chatId: 'chat-1', sessionId: 's1', historyId: 'history-1', hostname: 'host', title: 'host', status: 'open' as const, associatedAt: '2026-08-16T08:00:00.000Z' }
    const workspace = { id: 'chat-1', title: 'chat', titleState: 'custom' as const, pinnedAt: null, createdAt: existing.associatedAt, updatedAt: existing.associatedAt, shellCount: 1, mode: 'copilot' as const, live: true, messages: [], shells: [existing] }
    const transferredWorkspace = { ...workspace, id: 'chat-2', title: 'target', shells: [{ ...existing, id: 'association-2', chatId: 'chat-2' }] }
    repository.findOpenSession.mockResolvedValue(existing)
    repository.recordSessionRequest.mockResolvedValue({ value: workspace, changed: true, liveChatId: workspace.id })
    repository.transferSessions.mockResolvedValue({
      value: { source: workspace, target: transferredWorkspace }, changed: true, liveChatId: transferredWorkspace.id,
    })
    const listener = vi.fn()
    chatService.onChanged(listener)

    await expect(chatService.associateSession(
      { requestId: 'bind-1', chatId: 'chat-1', sessionId: 's1' },
      { id: 's1', hostname: 'host', mode: 'copilot' },
    )).resolves.toEqual({ revision: 1, chat: workspace, liveChatId: workspace.id })
    await expect(chatService.associateSession(
      { requestId: 'bind-2', chatId: 'chat-2', sessionId: 's1' },
      { id: 's1', hostname: 'host', mode: 'copilot' },
    )).resolves.toEqual({ revision: 2, chat: transferredWorkspace, liveChatId: transferredWorkspace.id })
    expect(repository.transferSessions).toHaveBeenCalledWith(
      { requestId: 'bind-2', sourceChatId: 'chat-1', targetChatId: 'chat-2', sessionIds: ['s1'] },
      [expect.objectContaining({ sessionId: 's1', hostname: 'host', title: 'host' })],
      { requestId: 'bind-2', chatId: 'chat-2', sessionId: 's1' },
    )
    expect(repository.associateShell).not.toHaveBeenCalled()
    expect(listener.mock.calls.map(([event]) => [event.revision, event.chat.id, event.kind])).toEqual([
      [1, workspace.id, 'updated'],
      [2, workspace.id, 'updated'],
      [2, transferredWorkspace.id, 'updated'],
    ])
  })

  it('records concurrent same-owner bind requests so replay cannot transfer ownership back', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chat-service-concurrent-bind-'))
    const path = join(directory, 'chats.json')
    const repository = new ChatRepository(path, { now: () => new Date('2026-08-16T08:00:00.000Z') })
    const chatService = new ChatService(repository)
    const session = { id: 'session-1', hostname: 'host', title: 'host', mode: 'copilot' as const }

    try {
      const source = (await chatService.create({ requestId: 'create-source' })).chat
      const target = (await chatService.create({ requestId: 'create-target' })).chat
      const bothOwnershipReadsFinished = deferred<void>()
      const findOpenSession = repository.findOpenSession.bind(repository)
      let ownershipReads = 0
      vi.spyOn(repository, 'findOpenSession').mockImplementation(async sessionId => {
        const owner = await findOpenSession(sessionId)
        ownershipReads += 1
        if (ownershipReads === 2) bothOwnershipReadsFinished.resolve(undefined)
        await bothOwnershipReadsFinished.promise
        return owner
      })

      const first = chatService.associateSession(
        { requestId: 'bind-source-first', chatId: source.id, sessionId: session.id },
        session,
      )
      const second = chatService.associateSession(
        { requestId: 'bind-source-second', chatId: source.id, sessionId: session.id },
        session,
      )
      await Promise.all([first, second])

      await chatService.associateSession(
        { requestId: 'bind-target', chatId: target.id, sessionId: session.id },
        session,
      )
      const replayed = await chatService.associateSession(
        { requestId: 'bind-source-second', chatId: source.id, sessionId: session.id },
        session,
      )

      expect(replayed.chat.id).toBe(target.id)
      await expect(repository.findOpenSession(session.id)).resolves.toMatchObject({ chatId: target.id, status: 'open' })
      await expect(repository.findSessionRequest({
        requestId: 'bind-source-second', chatId: source.id, sessionId: session.id,
      })).resolves.toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('persists transferred session ownership across source deletion and restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chat-service-transfer-session-'))
    const path = join(directory, 'chats.json')
    const ids = ['source-chat', 'target-chat', 'source-association', 'target-association']
    const repository = new ChatRepository(path, {
      now: () => new Date('2026-08-16T08:00:00.000Z'),
      createId: () => ids.shift()!,
    })
    const chatService = new ChatService(repository)
    const session = { id: 'session-1', hostname: 'host', title: 'host', mode: 'copilot' as const }

    try {
      const source = (await chatService.create({ requestId: 'create-source' })).chat
      const target = (await chatService.create({ requestId: 'create-target' })).chat
      await chatService.associateSession({ requestId: 'bind-source', chatId: source.id, sessionId: session.id }, session)

      const transferred = await chatService.associateSession(
        { requestId: 'bind-target', chatId: target.id, sessionId: session.id },
        session,
      )

      expect(transferred.chat).toMatchObject({ id: target.id, live: true })
      expect(transferred.chat.shells).toEqual([expect.objectContaining({ chatId: target.id, sessionId: session.id, status: 'open' })])
      await expect(repository.get(source.id)).resolves.toMatchObject({
        live: false,
        shells: [expect.objectContaining({ sessionId: session.id, status: 'closed' })],
      })

      await chatService.remove({ requestId: 'remove-source', chatId: source.id })
      const restarted = new ChatRepository(path)
      await expect(restarted.findOpenSession(session.id)).resolves.toMatchObject({ chatId: target.id, status: 'open' })
      await expect(restarted.get(target.id)).resolves.toMatchObject({ id: target.id, live: true })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('replays a generic transfer after the source chat is removed and the service restarts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chat-service-replayed-transfer-'))
    const path = join(directory, 'chats.json')
    const ids = ['chat-a', 'chat-b', 'association-a', 'association-b']
    const repository = new ChatRepository(path, {
      now: () => new Date('2026-08-16T08:00:00.000Z'),
      createId: () => ids.shift()!,
    })
    const chatService = new ChatService(repository)
    const session = { id: 'session-1', hostname: 'host', title: 'host', mode: 'copilot' as const }

    try {
      const chatA = (await chatService.create({ requestId: 'create-a' })).chat
      const chatB = (await chatService.create({ requestId: 'create-b' })).chat
      await chatService.associateSession({ requestId: 'bind-a', chatId: chatA.id, sessionId: session.id }, session)
      const transferRequest = {
        requestId: 'transfer-1', sourceChatId: chatA.id, targetChatId: chatB.id, sessionIds: [session.id],
      }
      await chatService.transferSessions(transferRequest, [session])
      await chatService.remove({ requestId: 'remove-a', chatId: chatA.id })
      const beforeReplay = await readFile(path, 'utf8')

      const openExclusive = vi.fn(async (temporaryPath: string) => {
        const handle = await open(temporaryPath, 'wx')
        return {
          writeFile: (data: string | Buffer, options: 'utf8') => handle.writeFile(data, options),
          close: () => handle.close(),
        }
      })
      const renameFile = vi.fn((source: string, destination: string) => rename(source, destination))
      const fileSystem: AtomicJsonStoreFileSystem = {
        mkdir,
        readFile: filePath => readFile(filePath),
        openExclusive,
        rename: renameFile,
        rm: (filePath, options) => rm(filePath, options),
      }
      const restartedRepository = new ChatRepository(path, { fileSystem })
      const restartedService = new ChatService(restartedRepository)
      const replayed = await restartedService.transferSessions(transferRequest, [session])

      expect(replayed.chat).toMatchObject({ id: chatB.id, live: true })
      await expect(restartedRepository.findOpenSession(session.id)).resolves.toMatchObject({
        chatId: chatB.id, status: 'open',
      })
      await expect(readFile(path, 'utf8')).resolves.toBe(beforeReplay)
      expect(openExclusive).not.toHaveBeenCalled()
      expect(renameFile).not.toHaveBeenCalled()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('does not move a session back when an older bind request is replayed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chat-service-replayed-bind-'))
    const path = join(directory, 'chats.json')
    const ids = ['chat-a', 'chat-b', 'association-a', 'association-b', 'association-replayed-a']
    const repository = new ChatRepository(path, {
      now: () => new Date('2026-08-16T08:00:00.000Z'),
      createId: () => ids.shift()!,
    })
    const chatService = new ChatService(repository)
    const session = { id: 'session-1', hostname: 'host', title: 'host', mode: 'copilot' as const }

    try {
      const chatA = (await chatService.create({ requestId: 'create-a' })).chat
      const chatB = (await chatService.create({ requestId: 'create-b' })).chat
      await chatService.associateSession({ requestId: 'bind-a', chatId: chatA.id, sessionId: session.id }, session)
      await chatService.associateSession({ requestId: 'bind-b', chatId: chatB.id, sessionId: session.id }, session)

      const replayed = await chatService.associateSession(
        { requestId: 'bind-a', chatId: chatA.id, sessionId: session.id },
        session,
      )

      expect(replayed.chat.id).toBe(chatB.id)
      await expect(repository.findOpenSession(session.id)).resolves.toMatchObject({ chatId: chatB.id, status: 'open' })
      await expect(repository.get(chatA.id)).resolves.toMatchObject({ live: false })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('returns a coherent snapshot when an older bind replay races an authority change', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chat-service-coherent-replayed-bind-'))
    const path = join(directory, 'chats.json')
    const ids = ['chat-a', 'association-a', 'chat-b']
    const repository = new ChatRepository(path, {
      now: () => new Date('2026-08-16T08:00:00.000Z'),
      createId: () => ids.shift()!,
    })
    const chatService = new ChatService(repository)
    const session = { id: 'session-1', hostname: 'host', title: 'host', mode: 'copilot' as const }

    try {
      const chatA = (await chatService.create({ requestId: 'create-a' })).chat
      const bindRequest = { requestId: 'bind-a', chatId: chatA.id, sessionId: session.id }
      await chatService.associateSession(bindRequest, session)

      const replayReadStarted = deferred<void>()
      const continueReplayRead = deferred<void>()
      let holdReplayRead = true
      const get = repository.get.bind(repository)
      const recordSessionRequest = repository.recordSessionRequest.bind(repository)
      vi.spyOn(repository, 'get').mockImplementation(async chatId => {
        if (holdReplayRead) {
          replayReadStarted.resolve(undefined)
          await continueReplayRead.promise
        }
        return get(chatId)
      })
      vi.spyOn(repository, 'recordSessionRequest').mockImplementation(async request => {
        if (holdReplayRead) {
          replayReadStarted.resolve(undefined)
          await continueReplayRead.promise
        }
        return recordSessionRequest(request)
      })

      const replaying = chatService.associateSession(bindRequest, session)
      await replayReadStarted.promise
      const created = await chatService.create({ requestId: 'create-b' })
      holdReplayRead = false
      continueReplayRead.resolve(undefined)
      const replayed = await replaying

      expect(replayed).toMatchObject({
        revision: created.revision,
        chat: { id: chatA.id },
        liveChatId: created.chat.id,
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('does not move a session back when a successful same-owner bind is replayed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chat-service-replayed-same-owner-bind-'))
    const path = join(directory, 'chats.json')
    const ids = ['chat-a', 'chat-b', 'association-a', 'association-b', 'association-replayed-a']
    const repository = new ChatRepository(path, {
      now: () => new Date('2026-08-16T08:00:00.000Z'),
      createId: () => ids.shift()!,
    })
    const chatService = new ChatService(repository)
    const session = { id: 'session-1', hostname: 'host', title: 'host', mode: 'copilot' as const }

    try {
      const chatA = (await chatService.create({ requestId: 'create-a' })).chat
      const chatB = (await chatService.create({ requestId: 'create-b' })).chat
      await chatService.associateSession({ requestId: 'bind-a', chatId: chatA.id, sessionId: session.id }, session)
      await chatService.associateSession({ requestId: 'bind-same-a', chatId: chatA.id, sessionId: session.id }, session)
      await chatService.associateSession({ requestId: 'bind-b', chatId: chatB.id, sessionId: session.id }, session)
      await chatService.remove({ requestId: 'remove-a', chatId: chatA.id })

      const restartedRepository = new ChatRepository(path)
      const restartedService = new ChatService(restartedRepository)
      const replayed = await restartedService.associateSession(
        { requestId: 'bind-same-a', chatId: chatA.id, sessionId: session.id },
        session,
      )

      expect(replayed.chat.id).toBe(chatB.id)
      await expect(restartedRepository.findOpenSession(session.id)).resolves.toMatchObject({ chatId: chatB.id, status: 'open' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('replays an older bind after its chat is removed and the service restarts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chat-service-replayed-removed-bind-'))
    const path = join(directory, 'chats.json')
    const ids = ['chat-a', 'chat-b', 'association-a', 'association-b']
    const repository = new ChatRepository(path, {
      now: () => new Date('2026-08-16T08:00:00.000Z'),
      createId: () => ids.shift()!,
    })
    const chatService = new ChatService(repository)
    const session = { id: 'session-1', hostname: 'host', title: 'host', mode: 'copilot' as const }

    try {
      const chatA = (await chatService.create({ requestId: 'create-a' })).chat
      const chatB = (await chatService.create({ requestId: 'create-b' })).chat
      await chatService.associateSession({ requestId: 'bind-a', chatId: chatA.id, sessionId: session.id }, session)
      await chatService.associateSession({ requestId: 'bind-b', chatId: chatB.id, sessionId: session.id }, session)
      await chatService.remove({ requestId: 'remove-a', chatId: chatA.id })

      const restartedRepository = new ChatRepository(path)
      const restartedService = new ChatService(restartedRepository)
      const replayed = await restartedService.associateSession(
        { requestId: 'bind-a', chatId: chatA.id, sessionId: session.id },
        session,
      )

      expect(replayed.chat.id).toBe(chatB.id)
      await expect(restartedRepository.findOpenSession(session.id)).resolves.toMatchObject({ chatId: chatB.id, status: 'open' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('keeps a session owned when binding races after its requested chat is deleted', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chat-service-bind-after-delete-'))
    const path = join(directory, 'chats.json')
    const repository = new ChatRepository(path, { now: () => new Date('2026-08-16T08:00:00.000Z') })
    const chatService = new ChatService(repository)
    const session = { id: 'session-race', hostname: 'host', title: 'host', mode: 'copilot' as const }

    try {
      const source = (await chatService.create({ requestId: 'create-source' })).chat
      const removing = chatService.remove({ requestId: 'remove-source', chatId: source.id })
      await Promise.resolve()
      const binding = chatService.associateSession({ requestId: 'bind-after-remove', chatId: source.id, sessionId: session.id }, session)
      await removing
      const bound = await binding

      expect(bound.chat.id).not.toBe(source.id)
      await expect(repository.findOpenSession(session.id)).resolves.toMatchObject({ chatId: bound.chat.id, status: 'open' })
      await expect(new ChatRepository(path).findOpenSession(session.id)).resolves.toMatchObject({ chatId: bound.chat.id, status: 'open' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('recovers when ownership lookup is stale because the source chat was deleted', async () => {
    const { repository, service: chatService } = service()
    const stale = {
      id: 'association-1', chatId: 'deleted-source', sessionId: 's1', historyId: 'history-1', hostname: 'host', title: 'host',
      status: 'open' as const, associatedAt: '2026-08-16T08:00:00.000Z',
    }
    const fallback = {
      id: 'fallback', title: 'fallback', titleState: 'custom' as const, pinnedAt: null, createdAt: '2026-08-16T08:00:00.000Z', updatedAt: '2026-08-16T08:00:00.001Z',
      shellCount: 1, mode: 'copilot' as const, live: true, messages: [], shells: [{ ...stale, chatId: 'fallback' }],
    }
    repository.findOpenSession.mockResolvedValue(stale)
    repository.transferSessions.mockRejectedValue(new Error('Unknown chat'))
    repository.associateOrCreateShell.mockResolvedValue({ value: fallback, changed: true, liveChatId: fallback.id })

    await expect(chatService.associateSession(
      { requestId: 'bind-after-stale-read', chatId: 'requested-target', sessionId: 's1' },
      { id: 's1', hostname: 'host', mode: 'copilot' },
    )).resolves.toEqual({ revision: 1, chat: fallback, liveChatId: fallback.id })
    expect(repository.associateOrCreateShell).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'bind-after-stale-read', chatId: 'requested-target', sessionId: 's1',
    }))
  })

  it('uses stable session metadata when an atomic transfer request is retried', async () => {
    const { repository, service: chatService } = service()
    const source = {
      id: 'source', title: 'source', titleState: 'custom' as const, pinnedAt: null, createdAt: '2026-08-16T08:00:00.000Z', updatedAt: '2026-08-16T08:00:00.001Z',
      shellCount: 2, mode: 'copilot' as const, live: false, messages: [], shells: [],
    }
    const target = { ...source, id: 'target', title: 'target', live: true }
    repository.transferSessions
      .mockResolvedValueOnce({ value: { source, target }, changed: true, liveChatId: target.id })
      .mockResolvedValueOnce({ value: { source, target }, changed: false, liveChatId: target.id })
    const request = { requestId: 'transfer-retry', sourceChatId: source.id, targetChatId: target.id, sessionIds: ['s1', 's2'] }
    const sessions = [
      { id: 's1', hostname: 'host-1', mode: 'copilot' as const },
      { id: 's2', hostname: 'host-2', mode: 'copilot' as const },
    ]

    await chatService.transferSessions(request, sessions)
    await chatService.transferSessions(request, sessions)

    expect(repository.transferSessions.mock.calls[0][1]).toEqual(repository.transferSessions.mock.calls[1][1])
  })

  it('rejects a generic transfer request id when it is reused as a bind', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chat-service-transfer-id-as-bind-'))
    const path = join(directory, 'chats.json')
    const ids = ['chat-a', 'chat-b', 'association-a', 'association-b']
    const repository = new ChatRepository(path, {
      now: () => new Date('2026-08-16T08:00:00.000Z'),
      createId: () => ids.shift()!,
    })
    const chatService = new ChatService(repository)
    const session = { id: 'session-1', hostname: 'host', title: 'host', mode: 'copilot' as const }

    try {
      const chatA = (await chatService.create({ requestId: 'create-a' })).chat
      const chatB = (await chatService.create({ requestId: 'create-b' })).chat
      await chatService.associateSession({ requestId: 'bind-a', chatId: chatA.id, sessionId: session.id }, session)
      await chatService.transferSessions(
        { requestId: 'shared-transfer-id', sourceChatId: chatA.id, targetChatId: chatB.id, sessionIds: [session.id] },
        [session],
      )

      await expect(chatService.associateSession(
        { requestId: 'shared-transfer-id', chatId: chatB.id, sessionId: session.id },
        session,
      )).rejects.toThrow('Chat request idempotency conflict')
      await expect(repository.findOpenSession(session.id)).resolves.toMatchObject({ chatId: chatB.id, status: 'open' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('publishes both sides of a transfer at one authoritative revision', async () => {
    const { repository, service: chatService } = service()
    const source = {
      id: 'source', title: 'source', titleState: 'custom' as const, pinnedAt: null, createdAt: '2026-08-16T08:00:00.000Z', updatedAt: '2026-08-16T08:00:00.001Z',
      shellCount: 0, mode: 'copilot' as const, live: false, messages: [], shells: [],
    }
    const target = { ...source, id: 'target', title: 'target', shellCount: 1, live: true }
    repository.transferSessions.mockResolvedValue({ value: { source, target }, changed: true, liveChatId: target.id })
    const listener = vi.fn()
    chatService.onChanged(listener)

    await expect(chatService.transferSessions(
      { requestId: 'transfer-once', sourceChatId: source.id, targetChatId: target.id, sessionIds: ['s1'] },
      [{ id: 's1', hostname: 'host', mode: 'copilot' }],
    )).resolves.toEqual({ revision: 1, chat: target, liveChatId: target.id })

    expect(listener.mock.calls.map(([event]) => event)).toEqual([
      { revision: 1, kind: 'updated', chat: source, liveChatId: target.id },
      { revision: 1, kind: 'updated', chat: target, liveChatId: target.id },
    ])
  })

  it('closes stale persisted associations before renderer restores navigation', async () => {
    const { repository, service: chatService } = service()
    const workspace = { id: 'chat-1', title: 'chat', titleState: 'custom' as const, pinnedAt: null, createdAt: '2026-08-16T08:00:00.000Z', updatedAt: '2026-08-16T08:01:00.000Z', shellCount: 1, mode: 'copilot' as const, live: false, messages: [], shells: [] }
    repository.openSessionIds.mockResolvedValue(['stale-s1', 'live-s2'])
    repository.closeSession.mockResolvedValue({ value: workspace, changed: true, liveChatId: null })

    await chatService.reconcileSessions(() => [{ id: 'live-s2', hostname: 'host', mode: 'copilot' }])

    expect(repository.closeSession).toHaveBeenCalledTimes(1)
    expect(repository.closeSession).toHaveBeenCalledWith('stale-s1', expect.any(String))
  })
  it('publishes changed events with chat identity and keeps remove independent from sessions', async () => {
    const { repository, service: chatService } = service()
    repository.remove.mockResolvedValue({ value: undefined, changed: true, liveChatId: null })
    const listener = vi.fn()
    const unsubscribe = chatService.onChanged(listener)

    await chatService.remove({ chatId: '11111111-1111-4111-8111-111111111111', requestId: 'remove-1' })
    unsubscribe()

    expect(repository.remove).toHaveBeenCalledWith({ chatId: '11111111-1111-4111-8111-111111111111', requestId: 'remove-1' })
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ chatId: '11111111-1111-4111-8111-111111111111' }))
  })

  it('never accepts a chat mode outside the strict session mode contract', async () => {
    const { repository, service: chatService } = service()
    await expect(chatService.setMode({ chatId: '11111111-1111-4111-8111-111111111111', requestId: 'mode-1', mode: 'agent' as never })).rejects.toThrow()
    expect(repository.setMode).not.toHaveBeenCalled()
  })

  it('publishes one event for each first write, suppresses duplicate writes, and honors unsubscribe', async () => {
    const { repository, service: chatService } = service()
    const workspace = {
      id: '11111111-1111-4111-8111-111111111111', title: 'chat', titleState: 'custom' as const, pinnedAt: null,
      createdAt: '2026-08-16T08:00:00.000Z', updatedAt: '2026-08-16T08:00:00.000Z',
      shellCount: 1, mode: 'copilot' as const, live: true, messages: [], shells: [{
        id: '22222222-2222-4222-8222-222222222222', chatId: '11111111-1111-4111-8111-111111111111',
        historyId: 'history-1', hostname: 'host', title: 'shell', status: 'open' as const,
        associatedAt: '2026-08-16T08:00:00.000Z',
      }],
    }
    const writes = [
      () => chatService.create({ requestId: 'create-1' }),
      () => chatService.appendMessage({ requestId: 'message-1', chatId: workspace.id, role: 'user', content: 'hello', state: 'complete' }),
      () => chatService.updateTitle({ requestId: 'title-1', chatId: workspace.id, title: 'renamed' }),
      () => chatService.setMode({ requestId: 'mode-1', chatId: workspace.id, mode: 'autonomous' }),
      () => chatService.associateShell({ requestId: 'associate-1', chatId: workspace.id, historyId: 'history-2', hostname: 'host-2', title: 'shell-2' }),
      () => chatService.closeAssociation({ requestId: 'close-1', chatId: workspace.id, associationId: workspace.shells[0].id }),
      () => chatService.remove({ requestId: 'remove-1', chatId: workspace.id }),
    ]
    for (const mock of [repository.create, repository.appendMessage, repository.updateTitle, repository.setMode, repository.associateShell, repository.associateOrCreateShell, repository.closeAssociation]) {
      mock.mockResolvedValueOnce({ value: workspace, changed: true, liveChatId: workspace.id })
        .mockResolvedValueOnce({ value: workspace, changed: false, liveChatId: workspace.id })
    }
    repository.remove.mockResolvedValueOnce({ value: undefined, changed: true, liveChatId: null })
      .mockResolvedValueOnce({ value: undefined, changed: false, liveChatId: null })
    const listener = vi.fn()
    const unsubscribedListener = vi.fn()
    const unsubscribe = chatService.onChanged(listener)
    chatService.onChanged(unsubscribedListener)()

    for (const method of writes) await method()
    for (const method of writes) await method()

    expect(listener).toHaveBeenCalledTimes(7)
    expect(unsubscribedListener).not.toHaveBeenCalled()
    expect(listener.mock.calls.map(([event]) => event.kind)).toEqual([
      'created', 'updated', 'updated', 'updated', 'updated', 'updated', 'removed',
    ])
    unsubscribe()
    repository.create.mockResolvedValueOnce({ value: workspace, changed: true, liveChatId: workspace.id })
    await chatService.create({ requestId: 'create-2' })
    expect(listener).toHaveBeenCalledTimes(7)
  })

  it('refuses to remove a chat while it still owns a running terminal session', async () => {
    const shell = {
      onData: vi.fn(), onClose: vi.fn(), write: vi.fn(), resize: vi.fn(), close: vi.fn(),
    }
    const connection = { openShell: vi.fn().mockResolvedValue(shell), close: vi.fn() }
    const sessions = new SessionService(
      { connect: vi.fn().mockResolvedValue(connection) },
      { load: vi.fn() },
    )
    const session = await sessions.connect({
      host: 'server.example', port: 22, username: 'ops', auth: { kind: 'password', password: 'secret' },
    })
    const directory = await mkdtemp(join(tmpdir(), 'chat-service-live-session-'))
    const generatedIds = ['chat-1', 'association-1']
    const chatService = new ChatService(new ChatRepository(join(directory, 'chats.json'), {
      now: () => new Date('2026-08-16T08:00:00.000Z'),
      createId: () => generatedIds.shift()!,
    }))

    try {
      const chat = (await chatService.create({ requestId: 'create-1' })).chat
      await chatService.associateShell({
        requestId: 'associate-1', chatId: chat.id, sessionId: session.id,
        historyId: 'history-1', hostname: session.hostname, title: 'shell',
      })
      await expect(chatService.remove({ requestId: 'remove-1', chatId: chat.id }))
        .rejects.toThrow('Cannot remove a chat with open terminal sessions')

      expect(sessions.snapshot()).toEqual([session])
      expect(shell.close).not.toHaveBeenCalled()
      expect(connection.close).not.toHaveBeenCalled()
      await expect(chatService.resolveSession(session.id)).resolves.toMatchObject({ chat: { id: chat.id, live: true } })
      await expect(chatService.get(chat.id)).resolves.toMatchObject({ chat: { id: chat.id, live: true } })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
