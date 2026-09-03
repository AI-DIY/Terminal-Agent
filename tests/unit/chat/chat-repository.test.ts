import { mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chatDocumentSchema, type ChatDocument } from '../../../src/main/chat/chat-contracts'
import { ChatRepository, nextLogicalTimestamp, summarizeChats } from '../../../src/main/chat/chat-repository'
import { chatWorkspaceSchema } from '../../../src/shared/contracts'
import type { AtomicJsonStoreFileSystem } from '../../../src/main/persistence/atomic-json-store'

const dirs: string[] = []
const ids = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
]
const fingerprint = 'a'.repeat(64)

async function createRepository() {
  const dir = await mkdtemp(join(tmpdir(), 'chat-repository-'))
  dirs.push(dir)
  let index = 0
  return new ChatRepository(join(dir, 'chat-workspaces.json'), {
    now: () => new Date('2026-08-16T08:00:00.000Z'),
    createId: () => ids[index++] ?? `55555555-5555-4555-8555-${String(index).padStart(12, '0')}`,
  })
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('ChatRepository', () => {
  it('round-trips a version-2 text-and-image user message without sharing content references', async () => {
    const repository = await createRepository()
    const chat = (await repository.create({ requestId: 'create-image' })).value
    const content = [
      { type: 'text' as const, text: '看图' },
      { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,AA==' } },
    ]
    await repository.appendMessage({ requestId: 'append-image', chatId: chat.id, role: 'user', state: 'complete', content })
    content[0].text = '被外部修改'
    const loaded = await repository.get(chat.id)
    expect(loaded.messages[0]?.content).toEqual([
      { type: 'text', text: '看图' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
    ])
  })

  it('archives a non-empty task conversation without changing its SSH ownership or live task', async () => {
    const repository = await createRepository()
    const chat = (await repository.create({ requestId: 'create-conversation-task' })).value
    await repository.associateShell({
      requestId: 'associate-conversation-shell', chatId: chat.id, sessionId: 'terminal-1',
      historyId: 'history-1', hostname: 'host-1', title: 'host-1',
    })
    await repository.appendMessage({
      requestId: 'append-conversation-history', chatId: chat.id, role: 'user', state: 'complete', content: '保留这一段对话',
    })
    const before = chatDocumentSchema.parse(JSON.parse(await readFile(repository.path, 'utf8')))

    const created = await repository.createConversationSession({
      requestId: 'create-conversation-1', chatId: chat.id,
    })

    expect(created).toMatchObject({
      changed: true,
      liveChatId: chat.id,
      value: { id: chat.id, messages: [] },
    })
    // Persisted inner-session bookkeeping is deliberately not part of the
    // renderer's strict ChatWorkspace contract.
    expect(chatWorkspaceSchema.parse(created.value)).toEqual(created.value)
    expect(created.value).not.toHaveProperty('activeConversationSessionId')
    expect(created.value).not.toHaveProperty('activeConversationSessionCreatedAt')
    expect(created.value).not.toHaveProperty('nextConversationSessionOrdinal')
    expect(created.value.shells).toEqual([
      expect.objectContaining({
        id: before.associations[0]?.id, chatId: chat.id, sessionId: 'terminal-1',
        historyId: 'history-1', hostname: 'host-1', title: 'host-1', status: 'open',
      }),
    ])
    await expect(repository.listConversationSessions(chat.id)).resolves.toMatchObject({
      chatId: chat.id,
      activeSessionId: expect.any(String),
      sessions: [{ id: chat.id, label: '会话1' }],
    })

    const after = chatDocumentSchema.parse(JSON.parse(await readFile(repository.path, 'utf8')))
    expect(after.liveChatId).toBe(before.liveChatId)
    expect(after.associations).toEqual(before.associations)
    expect(after.chats).toHaveLength(1)
    expect(after.conversationSessions).toEqual([
      expect.objectContaining({ id: chat.id, chatId: chat.id, label: '会话1' }),
    ])
  })

  it('does not create an archive or mutate a task when its active conversation is empty', async () => {
    const repository = await createRepository()
    const chat = (await repository.create({ requestId: 'create-empty-conversation-task' })).value
    const before = await readFile(repository.path)

    await expect(repository.createConversationSession({
      requestId: 'create-empty-conversation', chatId: chat.id,
    })).rejects.toThrow('Cannot create a conversation session from an empty conversation')

    expect(await readFile(repository.path)).toEqual(before)
    await expect(repository.listConversationSessions(chat.id)).resolves.toMatchObject({ sessions: [] })
  })

  it('switches task-internal conversations atomically and keeps backup numbering continuous after reactivation', async () => {
    const repository = await createRepository()
    const chat = (await repository.create({ requestId: 'create-switch-conversation-task' })).value
    await repository.associateShell({
      requestId: 'associate-switch-conversation-shell', chatId: chat.id, sessionId: 'terminal-switch-1',
      historyId: 'history-switch-1', hostname: 'host-switch-1', title: 'host-switch-1',
    })
    const shellsBeforeSwitch = (await repository.get(chat.id)).shells
    await repository.appendMessage({
      requestId: 'append-original-conversation', chatId: chat.id, role: 'user', state: 'complete', content: '原始会话',
    })
    await repository.createConversationSession({ requestId: 'create-switch-conversation-1', chatId: chat.id })
    await repository.appendMessage({
      requestId: 'append-new-conversation', chatId: chat.id, role: 'user', state: 'complete', content: '新会话',
    })

    const restored = await repository.switchConversationSession({
      requestId: 'switch-to-original-conversation', chatId: chat.id, targetSessionId: chat.id,
    })
    expect(restored.value.messages.map(message => message.content)).toEqual(['原始会话'])
    expect(restored.value.shells).toEqual(shellsBeforeSwitch)
    expect(restored.liveChatId).toBe(chat.id)
    await expect(repository.listConversationSessions(chat.id)).resolves.toMatchObject({
      activeSessionId: chat.id,
      sessions: [expect.objectContaining({ label: '会话2' })],
    })

    const fresh = await repository.createConversationSession({
      requestId: 'create-switch-conversation-2', chatId: chat.id,
    })
    expect(fresh.value.messages).toEqual([])
    await expect(repository.listConversationSessions(chat.id)).resolves.toMatchObject({
      sessions: [
        expect.objectContaining({ label: '会话2' }),
        expect.objectContaining({ label: '会话3' }),
      ],
    })
  })

  it('does not save an empty active conversation while switching to an archived conversation', async () => {
    const repository = await createRepository()
    const chat = (await repository.create({ requestId: 'create-empty-switch-task' })).value
    await repository.appendMessage({
      requestId: 'append-empty-switch-source', chatId: chat.id, role: 'user', state: 'complete', content: '可恢复会话',
    })
    await repository.createConversationSession({ requestId: 'create-empty-switch-archive', chatId: chat.id })

    const switched = await repository.switchConversationSession({
      requestId: 'switch-empty-to-archive', chatId: chat.id, targetSessionId: chat.id,
    })

    expect(switched.value.messages.map(message => message.content)).toEqual(['可恢复会话'])
    await expect(repository.listConversationSessions(chat.id)).resolves.toMatchObject({
      activeSessionId: chat.id,
      sessions: [],
    })
  })

  it('persists archived task conversations across restart and makes a create request idempotent', async () => {
    const repository = await createRepository()
    const chat = (await repository.create({ requestId: 'create-restart-conversation-task' })).value
    await repository.appendMessage({
      requestId: 'append-restart-conversation', chatId: chat.id, role: 'user', state: 'complete', content: '重启后仍可恢复',
    })
    const request = { requestId: 'create-restart-conversation', chatId: chat.id }
    const first = await repository.createConversationSession(request)
    const persistedAfterFirst = await readFile(repository.path)
    const replayed = await repository.createConversationSession(request)

    expect(first.changed).toBe(true)
    expect(replayed).toMatchObject({ changed: false, value: { id: chat.id, messages: [] } })
    expect(await readFile(repository.path)).toEqual(persistedAfterFirst)

    const restarted = new ChatRepository(repository.path, { now: () => new Date('2026-08-16T08:00:00.000Z') })
    await expect(restarted.get(chat.id)).resolves.toMatchObject({ id: chat.id, messages: [] })
    await expect(restarted.listConversationSessions(chat.id)).resolves.toMatchObject({
      activeSessionId: expect.any(String),
      sessions: [{ id: chat.id, label: '会话1' }],
    })
    const restored = await restarted.switchConversationSession({
      requestId: 'restore-after-restart', chatId: chat.id, targetSessionId: chat.id,
    })
    expect(restored.value.messages.map(message => message.content)).toEqual(['重启后仍可恢复'])
  })

  it('reads legacy version-two messages as the initial conversation before it archives them', async () => {
    const repository = await createRepository()
    const chat = (await repository.create({ requestId: 'create-legacy-conversation-task' })).value
    await repository.appendMessage({
      requestId: 'append-legacy-conversation', chatId: chat.id, role: 'user', state: 'complete', content: '旧版记录',
    })
    const legacy = JSON.parse(await readFile(repository.path, 'utf8')) as {
      conversationSessions?: unknown
      chats: Array<{ activeConversationSessionId?: unknown; activeConversationSessionCreatedAt?: unknown; nextConversationSessionOrdinal?: unknown }>
      messages: Array<{ conversationSessionId?: unknown }>
    }
    delete legacy.conversationSessions
    delete legacy.chats[0].activeConversationSessionId
    delete legacy.chats[0].activeConversationSessionCreatedAt
    delete legacy.chats[0].nextConversationSessionOrdinal
    delete legacy.messages[0].conversationSessionId
    await writeFile(repository.path, JSON.stringify(legacy), 'utf8')

    const restarted = new ChatRepository(repository.path, { now: () => new Date('2026-08-16T08:00:00.000Z') })
    await expect(restarted.get(chat.id)).resolves.toMatchObject({
      messages: [expect.objectContaining({ content: '旧版记录' })],
    })
    await restarted.createConversationSession({ requestId: 'archive-legacy-conversation', chatId: chat.id })
    await expect(restarted.listConversationSessions(chat.id)).resolves.toMatchObject({
      sessions: [{ id: chat.id, label: '会话1' }],
    })
  })

  it('persists execution plans and audits while excluding audits from retry source', async () => {
    const repository = await createRepository()
    const chat = (await repository.create({ requestId: 'create-plan' })).value
    const plan = { id: 'EP-1', title: '检查', status: 'pending_review' as const, steps: [{ id: 'step-1', target: 'web-02', explanation: '查看状态', originalCommand: 'systemctl status api', sendState: 'pending' as const }] }
    await repository.appendMessage({ requestId: 'assistant-plan', chatId: chat.id, role: 'assistant', state: 'complete', content: '{"version":1,"reply":"准备执行","plan":null}', executionPlan: plan })
    await repository.appendMessage({ requestId: 'assistant-error', chatId: chat.id, role: 'assistant', state: 'error', content: '失败', retryable: true })
    await repository.appendMessage({ requestId: 'audit-1', chatId: chat.id, role: 'user', state: 'complete', messageType: 'execution_audit', content: '【执行审计】计划 EP-1 已发送。' })
    const loaded = await repository.get(chat.id)
    expect(loaded.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ executionPlan: expect.objectContaining({ id: 'EP-1' }) }),
      expect.objectContaining({ messageType: 'execution_audit' }),
    ]))
    await expect(repository.findRetryMessage(chat.id)).resolves.toBeUndefined()
  })

  it('removes stale execution plan fields when updating a message', async () => {
    const repository = await createRepository()
    const chat = (await repository.create({ requestId: 'create-update-plan' })).value
    const plan = { id: 'EP-2', title: '检查', status: 'pending_review' as const, steps: [{ id: 'step-2', target: 'web-02', explanation: '查看状态', originalCommand: 'systemctl status api', sendState: 'pending' as const }] }
    const appended = await repository.appendMessage({ requestId: 'append-plan', chatId: chat.id, role: 'assistant', state: 'complete', content: '{"version":1,"reply":"准备执行","plan":null}', executionPlan: plan })
    const messageId = appended.value.messages.at(-1)!.id
    await repository.updateMessage({ requestId: 'update-plan', chatId: chat.id, messageId, state: 'error', content: '失败' })
    expect((await repository.get(chat.id)).messages.at(-1)).not.toHaveProperty('executionPlan')
  })
  it('pins and unpins a task without changing its updatedAt', async () => {
    const repository = await createRepository()
    const created = await repository.create({ requestId: 'create-pin-task' })
    const updatedAt = created.value.updatedAt

    const pinned = await repository.pin({ requestId: 'pin-task', chatId: created.value.id })
    expect(pinned.value).toMatchObject({
      id: created.value.id,
      titleState: 'new',
      pinnedAt: '2026-08-16T08:00:00.001Z',
      updatedAt,
      mode: 'copilot',
    })

    const unpinned = await repository.unpin({ requestId: 'unpin-task', chatId: created.value.id })
    expect(unpinned.value).toMatchObject({
      id: created.value.id,
      titleState: 'new',
      pinnedAt: null,
      updatedAt,
      mode: 'copilot',
    })

    const persisted = chatDocumentSchema.parse(JSON.parse(await readFile(repository.path, 'utf8')))
    expect(persisted.operations.slice(-2)).toMatchObject([
      { kind: 'pin', appliedAt: '2026-08-16T08:00:00.001Z', result: { pinnedAt: '2026-08-16T08:00:00.001Z', updatedAt } },
      { kind: 'unpin', appliedAt: '2026-08-16T08:00:00.002Z', result: { pinnedAt: null, updatedAt } },
    ])
  })

  it('persists streaming message updates with independent update request ids', async () => {
    const repository = await createRepository()
    const chat = (await repository.create({ requestId: 'create-streaming' })).value
    const streaming = await repository.appendMessage({
      requestId: 'append-streaming', chatId: chat.id, role: 'assistant', content: 'partial', state: 'streaming',
    })
    const messageId = streaming.value.messages.at(-1)?.id
    expect(messageId).toBeTruthy()

    await repository.updateMessage({
      requestId: 'update-streaming', chatId: chat.id, messageId: messageId!, content: 'partial text', state: 'streaming',
    })
    await repository.updateMessage({
      requestId: 'complete-streaming', chatId: chat.id, messageId: messageId!, content: 'complete text', state: 'complete',
    })

    const restarted = new ChatRepository(repository.path, { now: () => new Date('2026-08-16T08:00:00.000Z') })
    await expect(restarted.get(chat.id)).resolves.toMatchObject({
      messages: [expect.objectContaining({ id: messageId, content: 'complete text', state: 'complete' })],
    })
    const persisted = chatDocumentSchema.parse(JSON.parse(await readFile(repository.path, 'utf8')))
    expect(persisted.messages[0]).toMatchObject({ id: messageId, requestId: 'append-streaming', content: 'complete text', state: 'complete' })
    expect(persisted.operations.filter(operation => operation.kind === 'updateMessage').map(operation => operation.resultId)).toEqual([messageId, messageId])
  })

  it('recovers persisted interrupted assistant streams exactly once after restart', async () => {
    const repository = await createRepository()
    const chat = (await repository.create({ requestId: 'create-interrupted-stream' })).value
    const streaming = await repository.appendMessage({
      requestId: 'append-interrupted-stream', chatId: chat.id, role: 'assistant', content: 'partial-provider-output', state: 'streaming',
    })
    const messageId = streaming.value.messages.at(-1)?.id
    expect(messageId).toBeTruthy()
    await repository.appendMessage({
      requestId: 'append-user-stream', chatId: chat.id, role: 'user', content: 'user-message-stays-intact', state: 'streaming',
    })

    const restarted = new ChatRepository(repository.path, { now: () => new Date('2026-08-16T08:00:00.000Z') })
    await expect(restarted.recoverInterruptedStreams()).resolves.toBe(1)

    await expect(restarted.get(chat.id)).resolves.toMatchObject({
      messages: expect.arrayContaining([
        expect.objectContaining({ id: messageId, content: '聊天请求已中断，请重试。', state: 'error' }),
        expect.objectContaining({ role: 'user', content: 'user-message-stays-intact', state: 'streaming' }),
      ]),
    })
    await expect(restarted.findRetryMessage(chat.id)).resolves.toBeUndefined()

    const recoveredBytes = await readFile(repository.path)
    expect(recoveredBytes.toString('utf8')).not.toContain('partial-provider-output')
    const persisted = chatDocumentSchema.parse(JSON.parse(recoveredBytes.toString('utf8')))
    expect(persisted.messages.find(message => message.id === messageId)).toMatchObject({
      content: '聊天请求已中断，请重试。', state: 'error',
    })
    expect(persisted.operations.filter(operation => operation.kind === 'updateMessage' && operation.resultId === messageId))
      .toHaveLength(1)

    await expect(restarted.recoverInterruptedStreams()).resolves.toBe(0)
    await expect(readFile(repository.path)).resolves.toEqual(recoveredBytes)
  })

  it('does not return a historical assistant error as the retry target after a newer completed exchange', async () => {
    const repository = await createRepository()
    const chat = (await repository.create({ requestId: 'create-retry-pairing' })).value
    await repository.appendMessage({ requestId: 'append-user-1', chatId: chat.id, role: 'user', content: 'first question', state: 'complete' })
    const historicalError = await repository.appendMessage({ requestId: 'append-error-1', chatId: chat.id, role: 'assistant', content: 'historical failure', state: 'error' })
    await repository.appendMessage({ requestId: 'append-user-2', chatId: chat.id, role: 'user', content: 'newer question', state: 'complete' })
    await repository.appendMessage({ requestId: 'append-answer-2', chatId: chat.id, role: 'assistant', content: 'newer answer', state: 'complete' })

    expect(historicalError.value.messages.at(-1)?.state).toBe('error')
    await expect(repository.findRetryMessage(chat.id, 'newer question')).resolves.toBeUndefined()
  })

  it('refuses to reuse a terminal cancellation but preserves the following retryable error', async () => {
    const repository = await createRepository()
    const chat = (await repository.create({ requestId: 'create-terminal-retry' })).value
    await repository.appendMessage({ requestId: 'append-user-cancelled', chatId: chat.id, role: 'user', content: 'cancelled request', state: 'complete' })
    await repository.appendMessage({ requestId: 'append-cancelled', chatId: chat.id, role: 'assistant', content: '已取消。', state: 'error', retryable: false })

    await expect(repository.findRetryMessage(chat.id, 'cancelled request')).resolves.toBeUndefined()

    await repository.appendMessage({ requestId: 'append-user-retryable', chatId: chat.id, role: 'user', content: 'retryable request', state: 'complete' })
    const retryable = await repository.appendMessage({ requestId: 'append-retryable', chatId: chat.id, role: 'assistant', content: 'temporary failure', state: 'error', retryable: true })

    await expect(repository.findRetryMessage(chat.id, 'retryable request')).resolves.toBe(retryable.value.messages.at(-1)?.id)
  })

  it('does not rewrite v2 cancellation records during restart', async () => {
    const repository = await createRepository()
    const chat = (await repository.create({ requestId: 'create-legacy-cancellation' })).value
    await repository.appendMessage({ requestId: 'append-legacy-user', chatId: chat.id, role: 'user', content: 'legacy cancellation', state: 'complete' })
    await repository.appendMessage({ requestId: 'append-legacy-cancellation', chatId: chat.id, role: 'assistant', content: '已取消。', state: 'error' })

    const restored = await new ChatRepository(repository.path).get(chat.id)

    expect(restored.messages.at(-1)).toMatchObject({ role: 'assistant', content: '已取消。', state: 'error' })
    expect(Object.keys(JSON.parse(await readFile(repository.path, 'utf8')).messages.at(-1))).not.toContain('retryable')
  })

  it('computes the next logical timestamp for a legal large document without argument expansion', () => {
    const base = Date.parse('2026-01-01T00:00:00.000Z')
    const count = 30_000
    const chats: ChatDocument['chats'] = []
    const operations: ChatDocument['operations'] = []
    for (let index = 0; index < count; index += 1) {
      const timestamp = new Date(base + index).toISOString()
      const chatId = `chat-${index}`
      chats.push({ id: chatId, title: 'Chat', titleState: 'custom', pinnedAt: null, createdAt: timestamp, updatedAt: timestamp, mode: 'copilot' })
      operations.push({
        requestId: `create-${index}`,
        kind: 'create',
        chatId,
        fingerprint,
        appliedAt: timestamp,
        result: { title: 'Chat', titleState: 'custom', pinnedAt: null, createdAt: timestamp, updatedAt: timestamp, mode: 'copilot' },
      })
    }
    const document: ChatDocument = { version: 2, liveChatId: null, chats, messages: [], associations: [], operations }

    expect(nextLogicalTimestamp(new Date(base), document)).toBe(new Date(base + count).toISOString())
  })

  it('rejects an invalid physical clock with a stable domain error before writing', async () => {
    const repository = await createRepository()
    const chat = (await repository.create({ requestId: 'create-1' })).value
    const before = await readFile(repository.path)
    const createId = vi.fn(() => ids[1])
    const restarted = new ChatRepository(repository.path, { now: () => new Date(Number.NaN), createId })

    await expect(restarted.updateTitle({ requestId: 'title-invalid-now', chatId: chat.id, title: 'Changed' }))
      .rejects.toThrow('Invalid chat clock')
    expect(await readFile(repository.path)).toEqual(before)
    expect(createId).not.toHaveBeenCalled()
  })

  it('rejects advancing beyond the maximum canonical timestamp before writing or creating an id', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chat-repository-max-clock-'))
    dirs.push(dir)
    const path = join(dir, 'chat-workspaces.json')
    const first = new ChatRepository(path, {
      now: () => new Date('9999-12-31T23:59:59.999Z'),
      createId: () => ids[0],
    })
    await first.create({ requestId: 'create-max' })
    const before = await readFile(path)
    const createId = vi.fn(() => ids[1])
    const restarted = new ChatRepository(path, {
      now: () => new Date('9999-12-31T23:59:59.999Z'),
      createId,
    })

    await expect(restarted.create({ requestId: 'create-overflow' }))
      .rejects.toThrow('Chat logical timestamp exhausted')
    expect(await readFile(path)).toEqual(before)
    expect(createId).not.toHaveBeenCalled()
  })

  it('builds summaries from chats and one association aggregation without messages', () => {
    const summaries = summarizeChats([
      { id: 'chat-1', title: 'One', titleState: 'custom', pinnedAt: null, createdAt: '2026-08-16T08:00:00.000Z', updatedAt: '2026-08-16T08:02:00.000Z', mode: 'copilot' },
      { id: 'chat-2', title: 'Two', titleState: 'custom', pinnedAt: null, createdAt: '2026-08-16T08:01:00.000Z', updatedAt: '2026-08-16T08:01:00.000Z', mode: 'autonomous' },
      { id: 'chat-3', title: '已删除任务', titleState: 'custom', pinnedAt: null, createdAt: '2026-08-16T08:00:00.000Z', updatedAt: '2026-08-16T08:03:00.000Z', mode: 'copilot', deletedAt: '2026-08-16T08:03:00.000Z' },
    ], [
      { id: 'association-1', chatId: 'chat-1', requestId: 'associate-1', historyId: 'history-1', hostname: 'host-1', title: 'Shell 1', status: 'closed', associatedAt: '2026-08-16T08:00:00.001Z', closedAt: '2026-08-16T08:00:00.002Z', closeRequestId: 'close-1' },
      { id: 'association-2', chatId: 'chat-1', requestId: 'associate-2', historyId: 'history-2', hostname: 'host-2', title: 'Shell 2', status: 'open', associatedAt: '2026-08-16T08:00:00.003Z' },
      { id: 'association-3', chatId: 'chat-3', requestId: 'associate-3', historyId: 'history-3', hostname: 'host-3', title: 'Deleted shell', status: 'open', associatedAt: '2026-08-16T08:00:00.004Z' },
    ])

    expect(summaries).toEqual([
      { id: 'chat-1', title: 'One', titleState: 'custom', pinnedAt: null, createdAt: '2026-08-16T08:00:00.000Z', updatedAt: '2026-08-16T08:02:00.000Z', mode: 'copilot', shellCount: 2, live: true },
      { id: 'chat-2', title: 'Two', titleState: 'custom', pinnedAt: null, createdAt: '2026-08-16T08:01:00.000Z', updatedAt: '2026-08-16T08:01:00.000Z', mode: 'autonomous', shellCount: 0, live: false },
    ])
  })

  it('transfers multiple open sessions atomically and replays the batch idempotently', async () => {
    const repository = await createRepository()
    const source = (await repository.create({ requestId: 'create-source' })).value
    const target = (await repository.create({ requestId: 'create-target' })).value
    for (const [index, sessionId] of ['s1', 's2'].entries()) {
      await repository.associateShell({
        requestId: `associate-${index}`,
        chatId: source.id,
        sessionId,
        historyId: `history-${index}`,
        hostname: `host-${index}`,
        title: `Shell ${index}`,
      })
    }

    const request = { requestId: 'transfer-1', sourceChatId: source.id, targetChatId: target.id, sessionIds: ['s1', 's2'] as string[] }
    const metadata = request.sessionIds.map((sessionId, index) => ({
      sessionId, historyId: `history-${index}`, hostname: `host-${index}`, title: `Shell ${index}`,
    }))
    const transferred = await repository.transferSessions(request, metadata)

    expect(transferred.changed).toBe(true)
    expect(transferred.value.target.shells.filter(shell => shell.status === 'open').map(shell => shell.sessionId)).toEqual(['s1', 's2'])
    expect(transferred.value.source.shells.every(shell => shell.status === 'closed')).toBe(true)
    const beforeReplay = await readFile(repository.path)
    const replayed = await repository.transferSessions(request, metadata)
    expect(replayed.changed).toBe(false)
    expect(replayed.value.target).toEqual(transferred.value.target)
    expect((await repository.listSnapshot()).liveChatId).toBe(target.id)
    expect(await readFile(repository.path)).toEqual(beforeReplay)
    await expect(repository.transferSessions(
      { ...request, sessionIds: ['s2', 's1'] },
      [...metadata].reverse(),
    )).rejects.toThrow('Chat request idempotency conflict')
    expect(await readFile(repository.path)).toEqual(beforeReplay)

    const restarted = new ChatRepository(repository.path)
    await expect(restarted.findOpenSession('s1')).resolves.toMatchObject({ chatId: target.id, status: 'open' })
    await expect(restarted.findOpenSession('s2')).resolves.toMatchObject({ chatId: target.id, status: 'open' })
  })

  it('closes the current owner when a session close interleaves with a transfer', async () => {
    const repository = await createRepository()
    const source = (await repository.create({ requestId: 'create-source' })).value
    const target = (await repository.create({ requestId: 'create-target' })).value
    await repository.associateShell({
      requestId: 'associate-source', chatId: source.id, sessionId: 's1', historyId: 'history-1', hostname: 'host', title: 'Shell',
    })
    const closing = repository.closeSession('s1', 'close-session')
    const transferring = repository.transferSessions(
      { requestId: 'transfer-session', sourceChatId: source.id, targetChatId: target.id, sessionIds: ['s1'] },
      [{ sessionId: 's1', historyId: 'history-1', hostname: 'host', title: 'Shell' }],
    )
    const [closed, transferred] = await Promise.allSettled([closing, transferring])

    expect(closed.status).toBe('fulfilled')
    expect(transferred).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ message: 'Unknown source terminal session' }) })
    await expect(repository.findOpenSession('s1')).resolves.toBeUndefined()
    await expect(repository.get(target.id)).resolves.toMatchObject({
      live: false,
      shells: [],
    })
  })

  it('closes the target owner when transfer commits before the session close', async () => {
    const repository = await createRepository()
    const source = (await repository.create({ requestId: 'create-source' })).value
    const target = (await repository.create({ requestId: 'create-target' })).value
    await repository.associateShell({
      requestId: 'associate-source', chatId: source.id, sessionId: 's1', historyId: 'history-1', hostname: 'host', title: 'Shell',
    })

    const transferred = await repository.transferSessions(
      { requestId: 'transfer-session', sourceChatId: source.id, targetChatId: target.id, sessionIds: ['s1'] },
      [{ sessionId: 's1', historyId: 'history-1', hostname: 'host', title: 'Shell' }],
    )
    const closed = await repository.closeSession('s1', 'close-session')

    expect(transferred.changed).toBe(true)
    expect(closed).toMatchObject({ changed: true, value: { id: target.id, live: false } })
    await expect(repository.findOpenSession('s1')).resolves.toBeUndefined()
    await expect(repository.get(target.id)).resolves.toMatchObject({
      live: false,
      shells: [expect.objectContaining({ sessionId: 's1', status: 'closed' })],
    })
  })

  it('rejects batch request-id reuse with a different source chat', async () => {
    const repository = await createRepository()
    const source = (await repository.create({ requestId: 'create-source' })).value
    const otherSource = (await repository.create({ requestId: 'create-other-source' })).value
    const target = (await repository.create({ requestId: 'create-target' })).value
    await repository.associateShell({
      requestId: 'associate-1',
      chatId: source.id,
      sessionId: 's1',
      historyId: 'history-1',
      hostname: 'host-1',
      title: 'Shell 1',
    })
    const request = { requestId: 'transfer-1', sourceChatId: source.id, targetChatId: target.id, sessionIds: ['s1'] }
    const metadata = [{ sessionId: 's1', historyId: 'history-1', hostname: 'host-1', title: 'Shell 1' }]
    await repository.transferSessions(request, metadata)
    const beforeConflict = await readFile(repository.path)

    await expect(repository.transferSessions(
      { ...request, sourceChatId: otherSource.id },
      metadata,
    )).rejects.toThrow('Chat request idempotency conflict')
    expect(await readFile(repository.path)).toEqual(beforeConflict)
  })

  it('replays the same public transfer request when live session metadata changes', async () => {
    const repository = await createRepository()
    const source = (await repository.create({ requestId: 'create-source' })).value
    const target = (await repository.create({ requestId: 'create-target' })).value
    await repository.associateShell({
      requestId: 'associate-1',
      chatId: source.id,
      sessionId: 's1',
      historyId: 'history-1',
      hostname: 'host-before',
      title: 'Shell before',
    })
    const request = { requestId: 'transfer-1', sourceChatId: source.id, targetChatId: target.id, sessionIds: ['s1'] }
    await repository.transferSessions(request, [
      { sessionId: 's1', historyId: 'history-1', hostname: 'host-before', title: 'Shell before' },
    ])
    const beforeReplay = await readFile(repository.path)

    const replayed = await repository.transferSessions(request, [
      { sessionId: 's1', historyId: 'different-history', hostname: 'host-after', title: 'Shell after' },
    ])

    expect(replayed.changed).toBe(false)
    expect(replayed.value.target.shells.find(shell => shell.sessionId === 's1')).toMatchObject({
      historyId: 'history-1', hostname: 'host-before', title: 'Shell before', status: 'open',
    })
    expect(await readFile(repository.path)).toEqual(beforeReplay)
  })

  it('creates a fallback target inside a targetless batch transfer', async () => {
    const repository = await createRepository()
    const source = (await repository.create({ requestId: 'create-source' })).value
    for (const [index, sessionId] of ['s1', 's2'].entries()) {
      await repository.associateShell({
        requestId: `associate-${index}`,
        chatId: source.id,
        sessionId,
        historyId: `history-${index}`,
        hostname: `host-${index}`,
        title: `Shell ${index}`,
      })
    }
    const request = { requestId: 'transfer-fallback', sourceChatId: source.id, sessionIds: ['s1', 's2'] }
    const metadata = request.sessionIds.map((sessionId, index) => ({
      sessionId, historyId: `history-${index}`, hostname: `host-${index}`, title: `Shell ${index}`,
    }))

    const transferred = await repository.transferSessions(request, metadata)

    expect(transferred.changed).toBe(true)
    expect(transferred.value.target.id).not.toBe(source.id)
    expect(transferred.value.target.shells.filter(shell => shell.status === 'open').map(shell => shell.sessionId)).toEqual(['s1', 's2'])
    expect(transferred.value.source.shells.every(shell => shell.status === 'closed')).toBe(true)
    const beforeReplay = await readFile(repository.path)
    await expect(repository.transferSessions(request, metadata)).resolves.toMatchObject({ changed: false })
    expect(await readFile(repository.path)).toEqual(beforeReplay)
    expect(await repository.list()).toHaveLength(2)
  })

  it('rolls back fallback creation when a targetless batch contains an unknown source session', async () => {
    const repository = await createRepository()
    const source = (await repository.create({ requestId: 'create-source' })).value
    await repository.associateShell({ requestId: 'associate-1', chatId: source.id, sessionId: 's1', historyId: 'history-1', hostname: 'host-1', title: 'Shell 1' })
    const before = await readFile(repository.path)

    await expect(repository.transferSessions(
      { requestId: 'transfer-fallback-invalid', sourceChatId: source.id, sessionIds: ['s1', 'missing'] },
      [
        { sessionId: 's1', historyId: 'history-1', hostname: 'host-1', title: 'Shell 1' },
        { sessionId: 'missing', historyId: 'history-missing', hostname: 'host-missing', title: 'Missing' },
      ],
    )).rejects.toThrow('Unknown source terminal session')
    expect(await readFile(repository.path)).toEqual(before)
    expect(await repository.list()).toHaveLength(1)
  })

  it('rolls back every session when one batch transfer session is invalid', async () => {
    const repository = await createRepository()
    const source = (await repository.create({ requestId: 'create-source' })).value
    const target = (await repository.create({ requestId: 'create-target' })).value
    await repository.associateShell({ requestId: 'associate-1', chatId: source.id, sessionId: 's1', historyId: 'history-1', hostname: 'host-1', title: 'Shell 1' })
    const request = { requestId: 'transfer-invalid', sourceChatId: source.id, targetChatId: target.id, sessionIds: ['s1', 'missing'] as string[] }
    const before = await readFile(repository.path)

    await expect(repository.transferSessions(request, [
      { sessionId: 's1', historyId: 'history-1', hostname: 'host-1', title: 'Shell 1' },
      { sessionId: 'missing', historyId: 'history-missing', hostname: 'host-missing', title: 'Missing' },
    ])).rejects.toThrow('Unknown source terminal session')
    expect(await readFile(repository.path)).toEqual(before)
    await expect(repository.findOpenSession('s1')).resolves.toMatchObject({ chatId: source.id, status: 'open' })
  })

  it('creates a default task with deterministic fallback title and persists request idempotency', async () => {
    const repository = await createRepository()
    const first = await repository.create({ requestId: 'create-1' })
    const second = await repository.create({ requestId: 'create-1' })

    expect(second.value).toEqual(first.value)
    expect(first.changed).toBe(true)
    expect(second.changed).toBe(false)
    expect(first.value.title).toBe('新建任务 2026-08-16 16:00:00')
    expect(first.value.titleState).toBe('new')
    expect(first.value.mode).toBe('copilot')
    expect(JSON.parse(await readFile(join(dirs[0], 'chat-workspaces.json'), 'utf8')).version).toBe(2)
  })

  it('starts a task only for the first persisted user message and preserves a custom title', async () => {
    const repository = await createRepository()
    const created = (await repository.create({ requestId: 'create-title-lifecycle' })).value

    const assistant = await repository.appendMessage({
      requestId: 'append-assistant-before-user', chatId: created.id, role: 'assistant', content: '正在生成', state: 'streaming',
    })
    expect(assistant.value).toMatchObject({
      title: '新建任务 2026-08-16 16:00:00',
      titleState: 'new',
    })

    const user = await repository.appendMessage({
      requestId: 'append-first-user', chatId: created.id, role: 'user', content: '检查服务状态', state: 'complete',
    })
    expect(user.value).toMatchObject({
      title: '任务 2026-08-16 16:00:00',
      titleState: 'started',
    })

    await repository.updateTitle({ requestId: 'rename-started-task', chatId: created.id, title: '生产环境排障' })
    const later = await repository.appendMessage({
      requestId: 'append-later-user', chatId: created.id, role: 'user', content: '继续检查', state: 'complete',
    })
    expect(later.value).toMatchObject({ title: '生产环境排障', titleState: 'custom' })
  })

  it('starts a task when its first Shell association is persisted', async () => {
    const repository = await createRepository()
    const created = (await repository.create({ requestId: 'create-shell-title-lifecycle' })).value

    const associated = await repository.associateShell({
      requestId: 'associate-first-shell', chatId: created.id, historyId: 'history-first-shell', hostname: 'host-1', title: 'Shell 1',
    })

    expect(associated.value).toMatchObject({
      title: '任务 2026-08-16 16:00:00',
      titleState: 'started',
    })
  })

  it('preserves associated Shell metadata verbatim for the authorized model context', async () => {
    const repository = await createRepository()
    const chat = (await repository.create({ requestId: 'create-raw-shell-metadata' })).value
    const hostname = 'tmp:C:\\synthetic\\AppData\\Local\\Temp\\access\\profile.conf'
    const title = `C:\\synthetic\\.ssh\\id_rsa sk-proj-${'A'.repeat(32)}`

    await repository.associateShell({
      requestId: 'associate-raw-shell-metadata', chatId: chat.id, sessionId: 'raw-session', historyId: 'raw-history', hostname, title,
    })

    await expect(repository.get(chat.id)).resolves.toMatchObject({
      shells: [expect.objectContaining({ hostname, title })],
    })
    const persisted = JSON.parse(await readFile(repository.path, 'utf8')) as { associations: Array<{ hostname: string; title: string }> }
    expect(persisted.associations).toEqual([expect.objectContaining({ hostname, title })])
  })

  it('sorts by updated time and exposes shell count and appended-only messages', async () => {
    const repository = await createRepository()
    const first = (await repository.create({ requestId: 'create-1', title: 'first' })).value
    const second = (await repository.create({ requestId: 'create-2', title: 'second' })).value
    await repository.appendMessage({ requestId: 'message-1', chatId: first.id, role: 'user', content: 'hello', state: 'complete' })
    await repository.associateShell({ requestId: 'associate-1', chatId: first.id, sessionId: 's1', historyId: 'history-1', hostname: 'host', title: 'shell' })

    const list = await repository.list()
    expect(list.map(chat => chat.id)).toEqual([first.id, second.id])
    expect(list[0].shellCount).toBe(1)
    expect((await repository.get(first.id)).messages).toHaveLength(1)
    expect((await repository.get(first.id)).messages[0].content).toBe('hello')
    expect(second.id).not.toBe(first.id)
  })

  it('persists the current empty live workspace after a background chat closes', async () => {
    const repository = await createRepository()
    const first = (await repository.create({ requestId: 'create-first', title: 'first' })).value
    await repository.associateShell({
      requestId: 'associate-first', chatId: first.id, sessionId: 'session-first', historyId: 'history-first', hostname: 'host', title: 'shell',
    })
    const current = (await repository.create({ requestId: 'create-current', title: 'current' })).value
    const association = (await repository.get(first.id)).shells.find(shell => shell.status === 'open')!
    await repository.closeAssociation({ requestId: 'close-first', chatId: first.id, associationId: association.id })

    const restarted = new ChatRepository(repository.path)
    const snapshot = await restarted.listSnapshot()

    expect(snapshot.chats.map(chat => chat.id)).toEqual([first.id, current.id])
    expect(snapshot.liveChatId).toBe(current.id)
  })

  it('rejects a v2 document missing liveChatId without rewriting its bytes', async () => {
    const repository = await createRepository()
    const open = (await repository.create({ requestId: 'create-open', title: 'open' })).value
    await repository.associateShell({
      requestId: 'associate-open', chatId: open.id, sessionId: 'session-open',
      historyId: 'history-open', hostname: 'host', title: 'shell',
    })
    await repository.create({ requestId: 'create-empty', title: 'empty' })
    const legacy = JSON.parse(await readFile(repository.path, 'utf8')) as Record<string, unknown>
    delete legacy.liveChatId
    await writeFile(repository.path, JSON.stringify(legacy), 'utf8')

    const source = await readFile(repository.path)
    const restarted = new ChatRepository(repository.path)
    await expect(restarted.listSnapshot()).rejects.toThrow('AtomicJsonStore could not read valid JSON data')
    expect(await readFile(repository.path)).toEqual(source)
  })

  it('preserves an explicit null liveChatId during restart migration checks', async () => {
    const repository = await createRepository()
    const open = (await repository.create({ requestId: 'create-open', title: 'open' })).value
    await repository.associateShell({
      requestId: 'associate-open', chatId: open.id, sessionId: 'session-open',
      historyId: 'history-open', hostname: 'host', title: 'shell',
    })
    await repository.create({ requestId: 'create-empty', title: 'empty' })
    const document = JSON.parse(await readFile(repository.path, 'utf8')) as Record<string, unknown>
    document.liveChatId = null
    await writeFile(repository.path, JSON.stringify(document), 'utf8')

    const restarted = new ChatRepository(repository.path)
    expect((await restarted.listSnapshot()).liveChatId).toBeNull()
    expect(JSON.parse(await readFile(repository.path, 'utf8')).liveChatId).toBeNull()
  })

  it('does not rewrite persisted v2 association display metadata during restart', async () => {
    const repository = await createRepository()
    const chat = (await repository.create({ requestId: 'create-1', title: 'safe chat title' })).value
    await repository.appendMessage({ requestId: 'message-1', chatId: chat.id, role: 'user', content: 'SAFE_MESSAGE_PLACEHOLDER', state: 'complete' })
    await repository.associateShell({
      requestId: 'associate-1', chatId: chat.id, sessionId: 'session-safe', historyId: 'history-safe', hostname: 'safe-host', title: 'safe shell title',
    })
    const persisted = JSON.parse(await readFile(repository.path, 'utf8')) as Record<string, unknown>
    const associations = persisted.associations as Array<Record<string, unknown>>
    associations[0].hostname = 'tmp:SAFE_PATH_PLACEHOLDER'
    associations[0].title = 'curl --user operator:SAFE_KEY_MATERIAL_PLACEHOLDER https://host.example'
    await writeFile(repository.path, JSON.stringify(persisted), 'utf8')

    const source = await readFile(repository.path)
    const restarted = new ChatRepository(repository.path)
    const workspace = await restarted.get(chat.id)

    expect(workspace.shells[0]).toMatchObject({ hostname: 'tmp:SAFE_PATH_PLACEHOLDER', title: 'curl --user operator:SAFE_KEY_MATERIAL_PLACEHOLDER https://host.example' })
    expect(await readFile(repository.path)).toEqual(source)
  })

  it('does not rewrite existing v2 shell metadata or request history', async () => {
    const repository = await createRepository()
    const chat = (await repository.create({ requestId: 'create-migration', title: 'migration chat' })).value
    await repository.appendMessage({
      requestId: 'message-migration', chatId: chat.id, role: 'user', content: 'MESSAGE_SAFE_PLACEHOLDER', state: 'complete',
    })
    await repository.associateShell({
      requestId: 'associate-migration', chatId: chat.id, sessionId: 'session-migration', historyId: 'history-migration',
      hostname: 'safe-host', title: 'safe shell',
    })
    const legacy = JSON.parse(await readFile(repository.path, 'utf8')) as {
      associations: Array<{ hostname: string; title: string }>
    }
    legacy.associations[0]!.hostname = 'tmp:INLINE_CREDENTIAL_PLACEHOLDER'
    legacy.associations[0]!.title = 'curl --user operator:INLINE_CREDENTIAL_PLACEHOLDER'
    await writeFile(repository.path, JSON.stringify(legacy), 'utf8')

    const source = await readFile(repository.path, 'utf8')
    const restarted = new ChatRepository(repository.path)
    const workspace = await restarted.get(chat.id)
    const owner = await restarted.findOpenSession('session-migration')

    expect(workspace.messages).toEqual([expect.objectContaining({ content: 'MESSAGE_SAFE_PLACEHOLDER' })])
    expect(workspace.shells).toEqual([expect.objectContaining({ hostname: 'tmp:INLINE_CREDENTIAL_PLACEHOLDER', title: 'curl --user operator:INLINE_CREDENTIAL_PLACEHOLDER' })])
    expect(owner).toEqual(expect.objectContaining({ chatId: chat.id, hostname: 'tmp:INLINE_CREDENTIAL_PLACEHOLDER', title: 'curl --user operator:INLINE_CREDENTIAL_PLACEHOLDER' }))
    expect(await readFile(repository.path, 'utf8')).toEqual(source)

    await expect(restarted.associateShell({
      requestId: 'associate-migration', chatId: chat.id, sessionId: 'session-migration', historyId: 'history-migration',
      hostname: 'safe-host', title: 'safe shell',
    })).resolves.toMatchObject({ changed: false, liveChatId: chat.id })
  })
  it('clears the live workspace when its last open Shell closes', async () => {
    const repository = await createRepository()
    const current = (await repository.create({ requestId: 'create-current' })).value
    await repository.associateShell({
      requestId: 'associate-current', chatId: current.id, sessionId: 'session-current',
      historyId: 'history-current', hostname: 'host', title: 'shell',
    })

    await repository.closeSession('session-current', 'close-current')

    expect((await repository.listSnapshot()).liveChatId).toBeNull()
  })

  it.each(['closeSession', 'closeAssociation'] as const)(
    'keeps the current workspace live when only one of its open Shells closes through %s',
    async closeMethod => {
    const repository = await createRepository()
    const current = (await repository.create({ requestId: 'create-current' })).value
    const first = await repository.associateShell({
      requestId: 'associate-first', chatId: current.id, sessionId: 'session-first',
      historyId: 'history-first', hostname: 'host-first', title: 'first shell',
    })
    await repository.associateShell({
      requestId: 'associate-second', chatId: current.id, sessionId: 'session-second',
      historyId: 'history-second', hostname: 'host-second', title: 'second shell',
    })

    if (closeMethod === 'closeSession') {
      await repository.closeSession('session-first', 'close-first')
    } else {
      await repository.closeAssociation({
        requestId: 'close-first', chatId: current.id, associationId: first.value.shells[0].id,
      })
    }

    expect((await repository.listSnapshot()).liveChatId).toBe(current.id)
    await expect(repository.findOpenSession('session-second')).resolves.toMatchObject({ chatId: current.id })
    },
  )

  it('falls back to another open workspace after the current empty workspace is removed', async () => {
    const repository = await createRepository()
    const open = (await repository.create({ requestId: 'create-open' })).value
    await repository.associateShell({
      requestId: 'associate-open', chatId: open.id, sessionId: 'session-open',
      historyId: 'history-open', hostname: 'host', title: 'shell',
    })
    const current = (await repository.create({ requestId: 'create-current' })).value

    await repository.remove({ requestId: 'remove-current', chatId: current.id })

    expect((await repository.listSnapshot()).liveChatId).toBe(open.id)
  })

  it('binds a stale deleted target to the authoritative empty live workspace', async () => {
    const repository = await createRepository()
    const open = (await repository.create({ requestId: 'create-open' })).value
    await repository.associateShell({
      requestId: 'associate-open', chatId: open.id, sessionId: 'session-open',
      historyId: 'history-open', hostname: 'open-host', title: 'open shell',
    })
    const deleted = (await repository.create({ requestId: 'create-deleted' })).value
    await repository.remove({ requestId: 'remove-deleted', chatId: deleted.id })
    const current = (await repository.create({ requestId: 'create-current' })).value

    const associated = await repository.associateOrCreateShell({
      requestId: 'associate-stale-target', chatId: deleted.id, sessionId: 'session-new',
      historyId: 'history-new', hostname: 'new-host', title: 'new shell',
    })

    expect(associated.value.id).toBe(current.id)
    expect((await repository.listSnapshot()).liveChatId).toBe(current.id)
    await expect(repository.findOpenSession('session-new')).resolves.toMatchObject({ chatId: current.id })
  })

  it('deduplicates writes after a fresh repository instance', async () => {
    const repository = await createRepository()
    const chat = (await repository.create({ requestId: 'create-1' })).value
    await repository.appendMessage({ requestId: 'message-1', chatId: chat.id, role: 'user', content: 'one', state: 'complete' })
    const restarted = new ChatRepository(repository.path, {
      now: () => new Date('2026-08-16T08:01:00.000Z'),
      createId: () => ids[2],
    })
    await restarted.appendMessage({ requestId: 'message-1', chatId: chat.id, role: 'user', content: 'one', state: 'complete' })
    expect((await restarted.get(chat.id)).messages.map(message => message.content)).toEqual(['one'])
  })

  it('removes chat records after their terminal association is closed', async () => {
    const repository = await createRepository()
    const chat = (await repository.create({ requestId: 'create-1' })).value
    const associated = await repository.associateShell({ requestId: 'associate-1', chatId: chat.id, sessionId: 's1', historyId: 'history-1', hostname: 'host', title: 'shell' })
    await repository.closeAssociation({ requestId: 'close-1', chatId: chat.id, associationId: associated.value.shells[0].id })
    await repository.remove({ requestId: 'remove-1', chatId: chat.id })
    await expect(repository.get(chat.id)).rejects.toThrow('Unknown chat')
    expect(await repository.list()).toEqual([])
  })

  it('persists idempotent title, mode, association-close, and remove mutations', async () => {
    const repository = await createRepository()
    const chat = (await repository.create({ requestId: 'create-1' })).value
    const title = await repository.updateTitle({ requestId: 'title-1', chatId: chat.id, title: 'renamed' })
    const mode = await repository.setMode({ requestId: 'mode-1', chatId: chat.id, mode: 'autonomous' })
    const association = await repository.associateShell({ requestId: 'associate-1', chatId: chat.id, sessionId: 's1', historyId: 'history-1', hostname: 'host', title: 'shell' })
    const closed = await repository.closeAssociation({ requestId: 'close-1', chatId: chat.id, associationId: association.value.shells[0].id })

    expect(title.value.title).toBe('renamed')
    expect(mode.value.mode).toBe('autonomous')
    expect(closed.value.live).toBe(false)
    expect((await repository.updateTitle({ requestId: 'title-1', chatId: chat.id, title: 'renamed' })).changed).toBe(false)
    expect((await repository.setMode({ requestId: 'mode-1', chatId: chat.id, mode: 'autonomous' })).changed).toBe(false)
    expect((await repository.closeAssociation({ requestId: 'close-1', chatId: chat.id, associationId: association.value.shells[0].id })).changed).toBe(false)
    expect((await repository.remove({ requestId: 'remove-1', chatId: chat.id })).changed).toBe(true)
    expect((await repository.remove({ requestId: 'remove-1', chatId: chat.id })).changed).toBe(false)
  })

  it('keeps deterministic updatedAt ordering and stable id ordering for ties', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chat-repository-sort-'))
    dirs.push(dir)
    const times = [
      new Date('2026-08-16T08:00:00.000Z'),
      new Date('2026-08-16T08:01:00.000Z'),
      new Date('2026-08-16T08:02:00.000Z'),
    ]
    let idIndex = 0
    let timeIndex = 0
    const repository = new ChatRepository(join(dir, 'chat-workspaces.json'), {
      now: () => times[timeIndex++] ?? times.at(-1)!,
      createId: () => ids[idIndex++],
    })
    const first = (await repository.create({ requestId: 'create-1' })).value
    const second = (await repository.create({ requestId: 'create-2' })).value
    expect((await repository.list()).map(chat => chat.id)).toEqual([second.id, first.id])

    await repository.updateTitle({ requestId: 'title-1', chatId: first.id, title: 'newest' })
    expect((await repository.list()).map(chat => chat.id)).toEqual([first.id, second.id])
  })

  it('keeps every write request idempotent across repository restarts', async () => {
    const repository = await createRepository()
    const chat = (await repository.create({ requestId: 'create-1' })).value
    const association = await repository.associateShell({ requestId: 'associate-1', chatId: chat.id, sessionId: 's1', historyId: 'history-1', hostname: 'host', title: 'shell' })
    await repository.updateTitle({ requestId: 'title-1', chatId: chat.id, title: 'first title' })
    await repository.setMode({ requestId: 'mode-1', chatId: chat.id, mode: 'autonomous' })
    await repository.closeAssociation({ requestId: 'close-1', chatId: chat.id, associationId: association.value.shells[0].id })

    const restarted = new ChatRepository(repository.path, {
      now: () => new Date('2026-08-16T09:00:00.000Z'),
      createId: () => ids[3],
    })
    expect((await restarted.create({ requestId: 'create-1' })).changed).toBe(false)
    expect((await restarted.associateShell({ requestId: 'associate-1', chatId: chat.id, sessionId: 's1', historyId: 'history-1', hostname: 'host', title: 'shell' })).changed).toBe(false)
    expect((await restarted.updateTitle({ requestId: 'title-1', chatId: chat.id, title: 'first title' })).changed).toBe(false)
    expect((await restarted.setMode({ requestId: 'mode-1', chatId: chat.id, mode: 'autonomous' })).changed).toBe(false)
    expect((await restarted.closeAssociation({ requestId: 'close-1', chatId: chat.id, associationId: association.value.shells[0].id })).changed).toBe(false)
    expect(await restarted.get(chat.id)).toMatchObject({ title: 'first title', mode: 'autonomous', shellCount: 1, live: false })
    expect(Object.keys((await restarted.get(chat.id)).shells[0])).not.toContain('requestId')

    expect((await restarted.remove({ requestId: 'remove-1', chatId: chat.id })).changed).toBe(true)
    const afterRemoveRestart = new ChatRepository(repository.path)
    expect((await afterRemoveRestart.remove({ requestId: 'remove-1', chatId: chat.id })).changed).toBe(false)
  })

  it('does not call time or id dependencies for a duplicate persisted request', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chat-repository-effects-'))
    dirs.push(dir)
    const now = vi.fn(() => new Date('2026-08-16T08:00:00.000Z'))
    let idIndex = 0
    const createId = vi.fn(() => ids[idIndex++])
    const repository = new ChatRepository(join(dir, 'chat-workspaces.json'), { now, createId })

    await repository.create({ requestId: 'create-1' })
    const beforeDuplicate = await readFile(repository.path, 'utf8')
    await repository.create({ requestId: 'create-1' })
    const afterDuplicate = await readFile(repository.path, 'utf8')
    await repository.create({ requestId: 'create-2' })

    expect(afterDuplicate).toBe(beforeDuplicate)
    expect(now).toHaveBeenCalledTimes(2)
    expect(createId).toHaveBeenCalledTimes(2)
    const persisted = chatDocumentSchema.parse(JSON.parse(afterDuplicate))
    expect(persisted.operations.map(operation => operation.appliedAt)).toEqual([
      '2026-08-16T08:00:00.000Z',
    ])
    const afterNextWrite = chatDocumentSchema.parse(JSON.parse(await readFile(repository.path, 'utf8')))
    expect(afterNextWrite.operations.map(operation => operation.appliedAt)).toEqual([
      '2026-08-16T08:00:00.000Z', '2026-08-16T08:00:00.001Z',
    ])
  })

  it('does not rewrite the document when recordSessionRequest replays a duplicate', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chat-repository-record-replay-'))
    dirs.push(dir)
    const path = join(dir, 'chat-workspaces.json')
    let atomicWrites = 0
    const fileSystem: AtomicJsonStoreFileSystem = {
      mkdir,
      readFile: file => readFile(file),
      async openExclusive(file) {
        atomicWrites += 1
        const handle = await open(file, 'wx')
        return {
          writeFile: (data, options) => handle.writeFile(data, options),
          close: () => handle.close(),
        }
      },
      rename,
      rm: (file, options) => rm(file, options),
    }
    const repository = new ChatRepository(path, {
      fileSystem,
      now: () => new Date('2026-08-16T08:00:00.000Z'),
      createId: (() => {
        const generated = [...ids]
        return () => generated.shift()!
      })(),
    })
    const chat = (await repository.create({ requestId: 'create-1' })).value
    await repository.associateOrCreateShell({
      requestId: 'bind-initial', chatId: chat.id, sessionId: 'session-1',
      historyId: 'history-1', hostname: 'host', title: 'shell',
    })
    const request = { requestId: 'bind-replay', chatId: chat.id, sessionId: 'session-1' }
    await expect(repository.recordSessionRequest(request)).resolves.toMatchObject({ changed: true })
    const writesBeforeReplay = atomicWrites

    await expect(repository.recordSessionRequest(request)).resolves.toMatchObject({ changed: false })
    expect(atomicWrites).toBe(writesBeforeReplay)
  })

  it('replays current state while active and a content-free result after deletion', async () => {
    const repository = await createRepository()
    const created = await repository.create({ requestId: 'create-1' })
    await repository.updateTitle({ requestId: 'title-1', chatId: created.value.id, title: 'later' })
    const replayBeforeDelete = await repository.create({ requestId: 'create-1' })
    expect(replayBeforeDelete).toMatchObject({ value: { id: created.value.id, title: 'later' }, changed: false })

    await repository.remove({ requestId: 'remove-1', chatId: created.value.id })
    const restarted = new ChatRepository(repository.path)
    const replayAfterDelete = await restarted.create({ requestId: 'create-1' })
    expect(replayAfterDelete).toEqual({
      value: { ...created.value, title: '已删除任务', titleState: 'custom', pinnedAt: null, updatedAt: '2026-08-16T08:00:00.002Z' },
      changed: false,
      liveChatId: null,
    })
    expect(await restarted.list()).toEqual([])
  })

  it('removes message and shell identity content from the persisted document', async () => {
    const repository = await createRepository()
    const chat = (await repository.create({ requestId: 'create-1', title: 'sensitive-chat-title' })).value
    await repository.appendMessage({ requestId: 'message-1', chatId: chat.id, role: 'user', content: 'sensitive-message-body', state: 'complete' })
    const associated = await repository.associateShell({ requestId: 'associate-1', chatId: chat.id, sessionId: 'sensitive-session-id', historyId: 'sensitive-history-id', hostname: 'sensitive-hostname', title: 'sensitive-shell-title' })
    const associationId = associated.value.shells[0].id
    await repository.closeAssociation({ requestId: 'close-sensitive', chatId: chat.id, associationId })
    await repository.remove({ requestId: 'remove-1', chatId: chat.id })

    const persisted = await readFile(repository.path, 'utf8')
    const operationRecords = JSON.parse(persisted).operations as Array<Record<string, unknown>>
    const operations = JSON.stringify(operationRecords)
    expect(persisted).not.toContain('sensitive-chat-title')
    expect(persisted).not.toContain('sensitive-message-body')
    expect(persisted).not.toContain('sensitive-session-id')
    expect(persisted).not.toContain('sensitive-history-id')
    expect(persisted).not.toContain('sensitive-hostname')
    expect(persisted).not.toContain('sensitive-shell-title')
    expect(operations).not.toContain(associationId)
    expect(operations).not.toContain('resultId')
    expect(operationRecords.every(operation => typeof operation.fingerprint === 'string' && /^[0-9a-f]{64}$/.test(operation.fingerprint))).toBe(true)
  })

  it('stores each appended message body only once', async () => {
    const repository = await createRepository()
    const chat = (await repository.create({ requestId: 'create-1' })).value
    await repository.appendMessage({ requestId: 'message-1', chatId: chat.id, role: 'user', content: 'unique-body-one', state: 'complete' })
    await repository.appendMessage({ requestId: 'message-2', chatId: chat.id, role: 'assistant', content: 'unique-body-two', state: 'complete' })

    const persisted = await readFile(repository.path, 'utf8')
    expect(persisted.match(/unique-body-one/g)).toHaveLength(1)
    expect(persisted.match(/unique-body-two/g)).toHaveLength(1)
  })

  it('rejects a remove request id reused for another chat without deleting it', async () => {
    const repository = await createRepository()
    const first = (await repository.create({ requestId: 'create-1' })).value
    const second = (await repository.create({ requestId: 'create-2' })).value
    await repository.remove({ requestId: 'remove-1', chatId: first.id })

    await expect(repository.remove({ requestId: 'remove-1', chatId: second.id })).rejects.toThrow('Chat request idempotency conflict')
    await expect(repository.get(second.id)).resolves.toMatchObject({ id: second.id })
  })

  it('rejects a request id reused across operation kinds or chats', async () => {
    const repository = await createRepository()
    const first = (await repository.create({ requestId: 'create-1', title: 'first' })).value
    const second = (await repository.create({ requestId: 'create-2', title: 'second' })).value

    await expect(repository.setMode({ requestId: 'create-1', chatId: first.id, mode: 'autonomous' }))
      .rejects.toThrow('Chat request idempotency conflict')
    await repository.updateTitle({ requestId: 'title-1', chatId: first.id, title: 'renamed' })
    await expect(repository.updateTitle({ requestId: 'title-1', chatId: second.id, title: 'must-not-apply' }))
      .rejects.toThrow('Chat request idempotency conflict')
    await expect(repository.get(second.id)).resolves.toMatchObject({ title: 'second' })
  })

  it('rejects a different canonical payload for every reused write request id without side effects', async () => {
    const repository = await createRepository()
    const chat = (await repository.create({ requestId: 'create-1', title: 'original' })).value
    await repository.appendMessage({ requestId: 'message-1', chatId: chat.id, role: 'user', content: 'one', state: 'complete' })
    await repository.updateTitle({ requestId: 'title-1', chatId: chat.id, title: 'renamed' })
    await repository.setMode({ requestId: 'mode-1', chatId: chat.id, mode: 'autonomous' })
    const firstAssociation = await repository.associateShell({ requestId: 'associate-1', chatId: chat.id, sessionId: 's1', historyId: 'history-1', hostname: 'host-1', title: 'shell-1' })
    const secondAssociation = await repository.associateShell({ requestId: 'associate-2', chatId: chat.id, historyId: 'history-2', hostname: 'host-2', title: 'shell-2' })
    await repository.closeAssociation({ requestId: 'close-1', chatId: chat.id, associationId: firstAssociation.value.shells[0].id })

    const now = vi.fn(() => new Date('2026-08-16T09:00:00.000Z'))
    const createId = vi.fn(() => ids[3])
    const restarted = new ChatRepository(repository.path, { now, createId })
    const conflicts = [
      () => restarted.create({ requestId: 'create-1', title: 'different' }),
      () => restarted.appendMessage({ requestId: 'message-1', chatId: chat.id, role: 'user', content: 'two', state: 'complete' }),
      () => restarted.updateTitle({ requestId: 'title-1', chatId: chat.id, title: 'different' }),
      () => restarted.setMode({ requestId: 'mode-1', chatId: chat.id, mode: 'copilot' }),
      () => restarted.associateShell({ requestId: 'associate-1', chatId: chat.id, sessionId: 's1', historyId: 'history-1', hostname: 'different', title: 'shell-1' }),
      () => restarted.closeAssociation({ requestId: 'close-1', chatId: chat.id, associationId: secondAssociation.value.shells[1].id }),
    ]
    for (const conflict of conflicts) {
      const before = await readFile(repository.path)
      await expect(conflict()).rejects.toThrow('Chat request idempotency conflict')
      expect(await readFile(repository.path)).toEqual(before)
    }
    expect(now).not.toHaveBeenCalled()
    expect(createId).not.toHaveBeenCalled()

    await repository.closeAssociation({ requestId: 'close-2', chatId: chat.id, associationId: secondAssociation.value.shells[1].id })
    await repository.remove({ requestId: 'remove-1', chatId: chat.id })
    const afterDeleteNow = vi.fn(() => new Date('2026-08-16T10:00:00.000Z'))
    const afterDeleteCreateId = vi.fn(() => ids[3])
    const afterDelete = new ChatRepository(repository.path, { now: afterDeleteNow, createId: afterDeleteCreateId })
    const deletedBytes = await readFile(repository.path)
    await expect(afterDelete.remove({ requestId: 'remove-1', chatId: 'different-chat' }))
      .rejects.toThrow('Chat request idempotency conflict')
    await expect(afterDelete.create({ requestId: 'create-1', title: 'different' }))
      .rejects.toThrow('Chat request idempotency conflict')
    expect(await readFile(repository.path)).toEqual(deletedBytes)
    expect(afterDeleteNow).not.toHaveBeenCalled()
    expect(afterDeleteCreateId).not.toHaveBeenCalled()
  })

  it('uses deterministic ordering when chats have exactly the same updatedAt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chat-repository-tie-'))
    dirs.push(dir)
    const reverseIds = [ids[1], ids[0]]
    const repository = new ChatRepository(join(dir, 'chat-workspaces.json'), {
      now: () => new Date('2026-08-16T08:00:00.000Z'),
      createId: () => reverseIds.shift()!,
    })
    await repository.create({ requestId: 'create-1' })
    await repository.create({ requestId: 'create-2' })

    expect((await repository.list()).map(chat => chat.id)).toEqual([ids[0], ids[1]])
    expect((await new ChatRepository(repository.path).list()).map(chat => chat.id)).toEqual([ids[0], ids[1]])
  })

  it('keeps persisted file growth linear across multiple message scales', async () => {
    async function persistedSize(messageCount: number): Promise<number> {
      const dir = await mkdtemp(join(tmpdir(), `chat-repository-scale-${messageCount}-`))
      dirs.push(dir)
      let id = 0
      const repository = new ChatRepository(join(dir, 'chat-workspaces.json'), {
        now: () => new Date('2026-08-16T08:00:00.000Z'),
        createId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
      })
      const chat = (await repository.create({ requestId: 'create' })).value
      for (let index = 0; index < messageCount; index += 1) {
        await repository.appendMessage({
          requestId: `message-${index}`,
          chatId: chat.id,
          role: 'user',
          content: `${String(index).padStart(4, '0')}:${'x'.repeat(1_024)}`,
          state: 'complete',
        })
      }
      return (await stat(repository.path)).size
    }

    const [size8, size16, size32] = await Promise.all([persistedSize(8), persistedSize(16), persistedSize(32)])
    expect(size16 / size8).toBeGreaterThan(1.7)
    expect(size16 / size8).toBeLessThan(2.2)
    expect(size32 / size16).toBeGreaterThan(1.7)
    expect(size32 / size16).toBeLessThan(2.2)
  })

  it('preserves append order when the physical clock ties and generated ids sort in reverse', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chat-repository-order-'))
    dirs.push(dir)
    const reverseIds = [
      '55555555-5555-4555-8555-555555555555',
      ids[3], ids[2], ids[1], ids[0],
    ]
    const repository = new ChatRepository(join(dir, 'chat-workspaces.json'), {
      now: () => new Date('2026-08-16T08:00:00.000Z'),
      createId: () => reverseIds.shift()!,
    })
    const chat = (await repository.create({ requestId: 'create-1' })).value
    await repository.appendMessage({ requestId: 'message-1', chatId: chat.id, role: 'user', content: 'first', state: 'complete' })
    await repository.appendMessage({ requestId: 'message-2', chatId: chat.id, role: 'assistant', content: 'second', state: 'complete' })
    await repository.associateShell({ requestId: 'associate-1', chatId: chat.id, historyId: 'history-first', hostname: 'first', title: 'first' })
    await repository.associateShell({ requestId: 'associate-2', chatId: chat.id, historyId: 'history-second', hostname: 'second', title: 'second' })

    const workspace = await repository.get(chat.id)
    expect(workspace.messages.map(message => message.content)).toEqual(['first', 'second'])
    expect(workspace.shells.map(shell => shell.historyId)).toEqual(['history-first', 'history-second'])
  })

  it.each(['appendMessage', 'updateTitle', 'setMode', 'associateShell', 'closeAssociation', 'remove'] as const)(
    'keeps %s timestamps monotonic when the injected clock moves backward',
    async (operation) => {
      const dir = await mkdtemp(join(tmpdir(), `chat-repository-clock-${operation}-`))
      dirs.push(dir)
      const times = [new Date('2026-08-16T10:00:00.000Z')]
      if (operation === 'closeAssociation') times.push(new Date('2026-08-16T10:00:00.000Z'))
      times.push(new Date('2026-08-16T09:00:00.000Z'))
      let id = 0
      const repository = new ChatRepository(join(dir, 'chat-workspaces.json'), {
        now: () => times.shift()!,
        createId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
      })
      const chat = (await repository.create({ requestId: 'create-1' })).value
      let associationId: string | undefined
      if (operation === 'closeAssociation') {
        const associated = await repository.associateShell({
          requestId: 'associate-1', chatId: chat.id, historyId: 'history-1', hostname: 'host', title: 'shell',
        })
        associationId = associated.value.shells[0].id
      }

      if (operation === 'appendMessage') {
        await repository.appendMessage({ requestId: 'write-1', chatId: chat.id, role: 'user', content: 'hello', state: 'complete' })
      } else if (operation === 'updateTitle') {
        await repository.updateTitle({ requestId: 'write-1', chatId: chat.id, title: 'renamed' })
      } else if (operation === 'setMode') {
        await repository.setMode({ requestId: 'write-1', chatId: chat.id, mode: 'autonomous' })
      } else if (operation === 'associateShell') {
        await repository.associateShell({ requestId: 'write-1', chatId: chat.id, historyId: 'history-1', hostname: 'host', title: 'shell' })
      } else if (operation === 'closeAssociation') {
        await repository.closeAssociation({ requestId: 'write-1', chatId: chat.id, associationId: associationId! })
      } else {
        await repository.remove({ requestId: 'write-1', chatId: chat.id })
      }

      const persisted = chatDocumentSchema.parse(JSON.parse(await readFile(repository.path, 'utf8')))
      const persistedChat = persisted.chats.find(item => item.id === chat.id)!
      const expectedWriteAt = operation === 'closeAssociation'
        ? '2026-08-16T10:00:00.002Z'
        : '2026-08-16T10:00:00.001Z'
      expect(persistedChat.updatedAt).toBe(expectedWriteAt)
      for (const message of persisted.messages) {
        expect(message.createdAt).toBe(expectedWriteAt)
      }
      for (const association of persisted.associations) {
        expect(association.associatedAt).toBe('2026-08-16T10:00:00.001Z')
        if (association.status === 'closed') expect(association.closedAt).toBe(expectedWriteAt)
      }
      await expect(new ChatRepository(repository.path).list()).resolves.toBeInstanceOf(Array)
    },
  )

  it('rejects a persisted active chat whose remove request would otherwise replay as a false no-op', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chat-repository-active-remove-'))
    dirs.push(dir)
    const path = join(dir, 'chat-workspaces.json')
    await writeFile(path, JSON.stringify({
      version: 1,
      chats: [{
        id: 'chat-1', title: 'still active', createdAt: '2026-08-16T08:00:00.000Z',
        updatedAt: '2026-08-16T08:00:00.000Z', mode: 'copilot',
      }],
      messages: [],
      associations: [],
      operations: [
        {
          requestId: 'create-1', kind: 'create', chatId: 'chat-1', fingerprint, appliedAt: '2026-08-16T08:00:00.000Z',
          result: { createdAt: '2026-08-16T08:00:00.000Z', updatedAt: '2026-08-16T08:00:00.000Z', mode: 'copilot' },
        },
        { requestId: 'remove-1', kind: 'remove', chatId: 'chat-1', fingerprint, appliedAt: '2026-08-16T08:00:00.000Z' },
      ],
    }), 'utf8')

    const repository = new ChatRepository(path)
    const source = await readFile(path)
    await expect(repository.list()).rejects.toThrow('任务数据版本不兼容，请清空旧任务数据后重试。')
    expect(await readFile(path)).toEqual(source)
  })

  it('uses one global logical watermark across chats and every write kind', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chat-repository-global-clock-'))
    dirs.push(dir)
    const times = [10, 9, 8, 7, 6, 5, 4, 3].map(hour => new Date(`2026-08-16T${String(hour).padStart(2, '0')}:00:00.000Z`))
    let id = 0
    const repository = new ChatRepository(join(dir, 'chat-workspaces.json'), {
      now: () => times.shift()!,
      createId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
    })
    const first = (await repository.create({ requestId: 'create-1', title: 'first' })).value
    const second = (await repository.create({ requestId: 'create-2' })).value
    await repository.appendMessage({ requestId: 'message-1', chatId: first.id, role: 'user', content: 'hello', state: 'complete' })
    await repository.updateTitle({ requestId: 'title-1', chatId: second.id, title: 'second' })
    await repository.setMode({ requestId: 'mode-1', chatId: first.id, mode: 'autonomous' })
    const associated = await repository.associateShell({ requestId: 'associate-1', chatId: second.id, historyId: 'history-1', hostname: 'host', title: 'shell' })
    await repository.closeAssociation({ requestId: 'close-1', chatId: second.id, associationId: associated.value.shells[0].id })
    await repository.remove({ requestId: 'remove-1', chatId: first.id })

    const persisted = chatDocumentSchema.parse(JSON.parse(await readFile(repository.path, 'utf8')))
    expect(second.createdAt).toBe('2026-08-16T10:00:00.001Z')
    expect(second.title).toBe('新建任务 2026-08-16 18:00:00')
    expect(persisted.operations.map(operation => operation.appliedAt)).toEqual([
      '2026-08-16T10:00:00.000Z',
      '2026-08-16T10:00:00.001Z',
      '2026-08-16T10:00:00.002Z',
      '2026-08-16T10:00:00.003Z',
      '2026-08-16T10:00:00.004Z',
      '2026-08-16T10:00:00.005Z',
      '2026-08-16T10:00:00.006Z',
      '2026-08-16T10:00:00.007Z',
    ])
    await expect(new ChatRepository(repository.path).list()).resolves.toHaveLength(1)
  })

  it('clamps the first remove of an unknown chat to the global watermark', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chat-repository-remove-missing-clock-'))
    dirs.push(dir)
    const times = [new Date('2026-08-16T10:00:00.000Z'), new Date('2026-08-16T09:00:00.000Z')]
    let id = 0
    const repository = new ChatRepository(join(dir, 'chat-workspaces.json'), {
      now: () => times.shift()!,
      createId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
    })
    await repository.create({ requestId: 'create-1' })
    await repository.remove({ requestId: 'remove-missing-1', chatId: 'missing-chat' })

    const persisted = chatDocumentSchema.parse(JSON.parse(await readFile(repository.path, 'utf8')))
    const tombstone = persisted.chats.find(chat => chat.id === 'missing-chat')!
    expect(tombstone).toMatchObject({
      createdAt: '2026-08-16T10:00:00.001Z',
      updatedAt: '2026-08-16T10:00:00.001Z',
      deletedAt: '2026-08-16T10:00:00.001Z',
    })
    expect(persisted.operations.at(-1)?.appliedAt).toBe('2026-08-16T10:00:00.001Z')
  })

  it.each([
    ['equal to', '2026-08-16T10:00:00.999Z'],
    ['earlier than', '2026-08-16T09:00:00.000Z'],
  ])('restores the global watermark after restart when the physical clock is %s it', async (_label, restartedNow) => {
    const dir = await mkdtemp(join(tmpdir(), 'chat-repository-restart-clock-'))
    dirs.push(dir)
    let id = 0
    const path = join(dir, 'chat-workspaces.json')
    const firstRepository = new ChatRepository(path, {
      now: () => new Date('2026-08-16T10:00:00.999Z'),
      createId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
    })
    await firstRepository.create({ requestId: 'create-1' })
    const restarted = new ChatRepository(path, {
      now: () => new Date(restartedNow),
      createId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
    })
    const second = (await restarted.create({ requestId: 'create-2' })).value

    expect(second).toMatchObject({
      title: '新建任务 2026-08-16 18:00:01',
      createdAt: '2026-08-16T10:00:01.000Z',
      updatedAt: '2026-08-16T10:00:01.000Z',
    })
    const persisted = chatDocumentSchema.parse(JSON.parse(await readFile(path, 'utf8')))
    expect(persisted.operations.map(operation => operation.appliedAt)).toEqual([
      '2026-08-16T10:00:00.999Z', '2026-08-16T10:00:01.000Z',
    ])
  })

  it('rejects a legacy version-one task document without rewriting its bytes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chat-repository-legacy-association-safety-'))
    dirs.push(dir)
    const path = join(dir, 'chat-workspaces.json')
    const placeholder = 'INLINE_CREDENTIAL_PLACEHOLDER'
    const source = JSON.stringify({
      version: 1,
      chats: [{ id: 'chat-1', title: 'Chat', createdAt: '2026-08-16T08:00:00.000Z', updatedAt: '2026-08-16T08:00:00.002Z', mode: 'copilot' }],
      messages: [{
        id: 'message-1', chatId: 'chat-1', requestId: 'message-request-1', role: 'user', content: placeholder,
        createdAt: '2026-08-16T08:00:00.001Z', state: 'complete',
      }],
      associations: [{
        id: 'association-1', chatId: 'chat-1', requestId: 'association-request-1', historyId: 'history-1',
        hostname: `tmp:${placeholder}`, title: `curl --user operator:${placeholder}`, status: 'open', associatedAt: '2026-08-16T08:00:00.002Z',
      }],
      operations: [
        {
          requestId: 'create-request-1', kind: 'create', chatId: 'chat-1', fingerprint, appliedAt: '2026-08-16T08:00:00.000Z',
          result: { createdAt: '2026-08-16T08:00:00.000Z', updatedAt: '2026-08-16T08:00:00.000Z', mode: 'copilot' },
        },
        {
          requestId: 'message-request-1', kind: 'appendMessage', chatId: 'chat-1', fingerprint, appliedAt: '2026-08-16T08:00:00.001Z',
          resultId: 'message-1', result: { createdAt: '2026-08-16T08:00:00.000Z', updatedAt: '2026-08-16T08:00:00.001Z', mode: 'copilot' },
        },
        {
          requestId: 'association-request-1', kind: 'associateShell', chatId: 'chat-1', fingerprint, appliedAt: '2026-08-16T08:00:00.002Z',
          resultId: 'association-1', result: { createdAt: '2026-08-16T08:00:00.000Z', updatedAt: '2026-08-16T08:00:00.002Z', mode: 'copilot' },
        },
      ],
    })
    await writeFile(path, source, 'utf8')

    const repository = new ChatRepository(path)
    await expect(repository.get('chat-1')).rejects.toThrow('任务数据版本不兼容，请清空旧任务数据后重试。')
    expect(await readFile(path, 'utf8')).toBe(source)
  })
})
