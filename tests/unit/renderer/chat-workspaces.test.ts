import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { ChatChangedEvent, ChatSessionResolution, ChatSummary, ChatWorkspace, ChatWorkspaceSnapshot } from '../../../src/shared/contracts'

const now = new Date('2026-08-16T12:00:00.000Z')

function summary(overrides: Partial<ChatSummary> & Pick<ChatSummary, 'id' | 'title' | 'createdAt'>): ChatSummary {
  return {
    updatedAt: overrides.createdAt,
    titleState: 'custom',
    pinnedAt: null,
    shellCount: 0,
    mode: 'copilot',
    live: false,
    ...overrides,
  }
}

function workspace(chat: ChatSummary, overrides: Partial<ChatWorkspace> = {}): ChatWorkspace {
  return { ...chat, messages: [], shells: [], ...overrides }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline })
  return { promise, resolve, reject }
}

function localTimestamp(year: number, monthIndex: number, day: number, hour = 12): string {
  return new Date(year, monthIndex, day, hour).toISOString()
}

function api(chats: ChatSummary[], workspaces: ChatWorkspace[], revision = 4, liveChatId: string | null = chats.find(chat => chat.live)?.id ?? null) {
  const byId = new Map(workspaces.map(chat => [chat.id, chat]))
  const listeners = new Set<(event: ChatChangedEvent) => void>()
  return {
    list: vi.fn(async () => ({ revision, chats, liveChatId })),
    create: vi.fn(async (): Promise<ChatWorkspaceSnapshot> => ({ revision: revision + 1, chat: workspaces.at(-1)!, liveChatId: workspaces.at(-1)!.id })),
    get: vi.fn(async (chatId: string) => ({ revision, chat: byId.get(chatId)!, liveChatId })),
    resolveSession: vi.fn(async (request: { sessionId: string }): Promise<ChatSessionResolution> => ({ revision, sessionId: request.sessionId, chat: null, liveChatId })),
    updateTitle: vi.fn(async (): Promise<ChatWorkspaceSnapshot> => ({ revision: revision + 1, chat: workspaces.at(-1)!, liveChatId })),
    pin: vi.fn(async (): Promise<ChatWorkspaceSnapshot> => ({ revision: revision + 1, chat: workspaces.at(-1)!, liveChatId })),
    unpin: vi.fn(async (): Promise<ChatWorkspaceSnapshot> => ({ revision: revision + 1, chat: workspaces.at(-1)!, liveChatId })),
    remove: vi.fn(async () => undefined),
    onChanged: vi.fn((listener: (event: ChatChangedEvent) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }),
    emit(event: ChatChangedEvent): void {
      for (const listener of listeners) listener(event)
    },
  }
}

describe('chat workspaces store', () => {
  it('preserves operation ownership when opened events interleave before open promises resolve', async () => {
    const { createWorkbenchSessionOwnershipTracker } = await import('../../../src/renderer/src/stores/chat-workspaces')
    const tracker = createWorkbenchSessionOwnershipTracker<{ id: string }>()
    const first = tracker.begin('history-task')
    const second = tracker.begin('new-task')

    expect(tracker.observe({ id: 'session-second' })).toMatchObject({ tracked: true, pending: true })
    expect(tracker.observe({ id: 'session-first' })).toMatchObject({ tracked: true, pending: true })
    expect(tracker.resolve(second, { id: 'session-second' })).toEqual({ targetChatId: 'new-task', queued: true })
    expect(tracker.resolve(first, { id: 'session-first' })).toEqual({ targetChatId: 'history-task', queued: true })
    expect(tracker.observe({ id: 'session-first' })).toEqual({ tracked: true, targetChatId: 'history-task' })
    expect(tracker.observe({ id: 'session-second' })).toEqual({ tracked: true, targetChatId: 'new-task' })
  })

  it('keeps an early opened event operation-scoped until the open result supplies its session id', async () => {
    const { createWorkbenchSessionOwnershipTracker } = await import('../../../src/renderer/src/stores/chat-workspaces')
    const tracker = createWorkbenchSessionOwnershipTracker<{ id: string }>()
    const operation = tracker.begin('selected-history')

    expect(tracker.observe({ id: 'session-early' })).toMatchObject({ tracked: true, pending: true })
    expect(tracker.resolve(operation, { id: 'session-early' })).toEqual({ targetChatId: 'selected-history', queued: true })
    expect(tracker.complete(operation)).toEqual([])
    expect(tracker.observe({ id: 'session-early' })).toEqual({ tracked: true, targetChatId: 'selected-history' })
  })

  it('holds an event before its open result so attach uses the resolved captured owner', async () => {
    const { createWorkbenchSessionOwnershipTracker } = await import('../../../src/renderer/src/stores/chat-workspaces')
    const tracker = createWorkbenchSessionOwnershipTracker<{ id: string }>()
    const operation = tracker.begin('history-task')
    const early = tracker.observe({ id: 'session-early' })
    const selected = 'third-task'
    const resolved = tracker.resolve(operation, { id: 'session-early' })
    const attached: string[] = []
    if (early.pending) attached.push(resolved.targetChatId)
    expect(attached).toEqual(['history-task'])
    expect(selected).toBe('third-task')
  })

  it('runs the opened-event decision path and keeps the captured owner after selection changes', async () => {
    const { createWorkbenchSessionOwnershipTracker, runWorkbenchOpenedSessionEvent } = await import('../../../src/renderer/src/stores/chat-workspaces')
    const tracker = createWorkbenchSessionOwnershipTracker<{ id: string; chatId?: string }>()
    const operation = tracker.begin('captured-task')
    const early = { id: 'session-opened' }
    expect(await runWorkbenchOpenedSessionEvent({ tracker, session: early, currentChatId: 'captured-task', attach: async () => undefined })).toBe(false)
    const resolved = tracker.resolve(operation, early)
    const selected = 'other-task'
    const attached: string[] = []
    await runWorkbenchOpenedSessionEvent({ tracker, session: early, currentChatId: selected, attach: async (_session, target) => { attached.push(target!) } })
    expect(resolved.targetChatId).toBe('captured-task')
    expect(attached).toEqual(['captured-task'])
  })

  it('invokes the registered opened-event handler and binds the captured task after selection changes', async () => {
    const { createWorkbenchOpenedSessionHandler, createWorkbenchSessionOwnershipTracker } = await import('../../../src/renderer/src/stores/chat-workspaces')
    const tracker = createWorkbenchSessionOwnershipTracker<{ id: string; chatId?: string }>()
    const operation = tracker.begin('captured-task')
    let selected = 'captured-task'
    const attached: string[] = []
    const handler = createWorkbenchOpenedSessionHandler({ tracker, currentChatId: () => selected, attach: async (_session, target) => { attached.push(target!) } })
    const session = { id: 'session-runtime' }
    const pending = handler(session)
    selected = 'other-task'
    tracker.resolve(operation, session)
    await pending
    await handler(session)
    expect(attached).toEqual(['captured-task'])
  })

  it('targets the selected history task when opening a new Shell', async () => {
    const { workbenchSessionAttachmentTarget, workbenchReconnectAttachmentTarget, workbenchOpenedAttachmentTarget } = await import('../../../src/renderer/src/stores/chat-workspaces')

    expect(workbenchSessionAttachmentTarget('selected-history', 'live-task')).toBe('selected-history')
    expect(workbenchSessionAttachmentTarget(null, 'live-task')).toBe('live-task')
    expect(workbenchReconnectAttachmentTarget('stored-owner', 'selected-history')).toBe('stored-owner')
    expect(workbenchReconnectAttachmentTarget(null, 'selected-history')).toBe('selected-history')
    expect(workbenchOpenedAttachmentTarget(undefined, 'captured-task', 'newly-selected-task')).toBe('captured-task')
    expect(workbenchOpenedAttachmentTarget('stored-owner', 'captured-task', 'newly-selected-task')).toBe('stored-owner')
  })

  it('creates and selects a fresh startup task before restoring existing ownership', async () => {
    const { initializeWorkbenchTask } = await import('../../../src/renderer/src/stores/chat-workspaces')
    const calls: string[] = []

    const result = await initializeWorkbenchTask({
      load: async () => { calls.push('load') },
      restore: async () => { calls.push('restore'); return ['persisted-owner'] },
      create: async () => { calls.push('create'); return true },
    })

    expect(calls).toEqual(['load', 'create', 'restore'])
    expect(result).toEqual(['persisted-owner'])
  })

  it('keeps a fresh workbench interactive before its first chat is created', async () => {
    const { isInteractiveWorkbenchWorkspace } = await import('../../../src/renderer/src/stores/chat-workspaces')

    expect(isInteractiveWorkbenchWorkspace(null, null)).toBe(true)
  })

  it('groups chats into today, current-week calendar dates, and earlier in descending date order', async () => {
    const { createChatWorkspacesStore } = await import('../../../src/renderer/src/stores/chat-workspaces')
    const chats = [
      summary({ id: 'earlier', title: '更早', createdAt: localTimestamp(2026, 6, 31) }),
      summary({ id: 'monday', title: '当周周一', createdAt: localTimestamp(2026, 7, 10) }),
      summary({ id: 'today', title: '今天', createdAt: localTimestamp(2026, 7, 16) }),
      summary({ id: 'saturday', title: '周六', createdAt: localTimestamp(2026, 7, 15) }),
    ]
    const store = createChatWorkspacesStore(api(chats, chats.map(chat => workspace(chat))), {
      now: () => new Date(2026, 7, 16, 18),
    })

    await store.load()

    expect(store.state.groups.map(group => [group.label, group.chats.map(chat => chat.id)])).toEqual([
      ['今天', ['today']],
      ['8 月 15 日', ['saturday']],
      ['8 月 10 日', ['monday']],
      ['更早', ['earlier']],
    ])
  })

  it('places pinned tasks first by newest pin time and excludes them from date groups', async () => {
    const { groupChatSummaries } = await import('../../../src/renderer/src/stores/chat-workspaces')
    const chats = [
      summary({ id: 'ordinary', title: '普通任务', createdAt: localTimestamp(2026, 7, 16), updatedAt: '2026-08-16T03:00:00.000Z' }),
      summary({ id: 'pin-b', title: '较早置顶', createdAt: localTimestamp(2026, 7, 15), pinnedAt: '2026-08-16T01:00:00.000Z' }),
      summary({ id: 'pin-a', title: '同刻置顶 A', createdAt: localTimestamp(2026, 7, 10), pinnedAt: '2026-08-16T02:00:00.000Z' }),
      summary({ id: 'pin-z', title: '同刻置顶 Z', createdAt: localTimestamp(2026, 7, 11), pinnedAt: '2026-08-16T02:00:00.000Z' }),
    ]

    expect(groupChatSummaries(chats, new Date(2026, 7, 16, 18)).map(group => [
      group.label,
      group.chats.map(chat => chat.id),
    ])).toEqual([
      ['置顶', ['pin-a', 'pin-z', 'pin-b']],
      ['今天', ['ordinary']],
    ])
  })

  it('merges accepted task title and pin snapshots without optimistic changes on failure', async () => {
    const { createChatWorkspacesStore } = await import('../../../src/renderer/src/stores/chat-workspaces')
    const first = summary({ id: 'first', title: '第一项', createdAt: localTimestamp(2026, 7, 16), updatedAt: '2026-08-16T03:00:00.000Z' })
    const second = summary({ id: 'second', title: '第二项', createdAt: localTimestamp(2026, 7, 15), updatedAt: '2026-08-16T02:00:00.000Z' })
    const renamed = workspace({ ...first, title: '已重命名', titleState: 'custom' })
    const pinned = workspace({ ...renamed, pinnedAt: '2026-08-16T04:00:00.000Z' })
    const unpinned = workspace({ ...pinned, pinnedAt: null })
    const chatApi = api([first, second], [workspace(first), workspace(second)])
    chatApi.updateTitle.mockResolvedValue({ revision: 5, chat: renamed, liveChatId: null })
    chatApi.pin.mockResolvedValue({ revision: 6, chat: pinned, liveChatId: null })
    chatApi.unpin.mockResolvedValue({ revision: 7, chat: unpinned, liveChatId: null })
    const store = createChatWorkspacesStore(chatApi, {
      now: () => now,
      requestId: (() => {
        const ids = ['rename-1', 'pin-1', 'unpin-1']
        return () => ids.shift()!
      })(),
    })
    await store.load()

    await expect(store.updateTitle(first.id, ' 已重命名 ')).resolves.toBe(true)
    expect(chatApi.updateTitle).toHaveBeenCalledWith({ requestId: 'rename-1', chatId: first.id, title: ' 已重命名 ' })
    expect(store.state.chats.find(chat => chat.id === first.id)?.title).toBe('已重命名')

    await expect(store.pin(first.id)).resolves.toBe(true)
    expect(store.state.groups[0]).toMatchObject({ label: '置顶', chats: [{ id: first.id }] })

    await expect(store.unpin(first.id)).resolves.toBe(true)
    expect(store.state.groups[0]?.label).toBe('今天')

    chatApi.pin.mockRejectedValueOnce(new Error('任务操作不可用'))
    const orderBeforeFailure = store.state.chats.map(chat => chat.id)
    await expect(store.pin(second.id)).resolves.toBe(false)
    expect(store.state.chats.map(chat => chat.id)).toEqual(orderBeforeFailure)
    expect(store.state.chats.find(chat => chat.id === second.id)?.pinnedAt).toBeNull()
    expect(store.state.error).toBe('任务操作不可用')
  })

  it('starts a new local week on Monday so the preceding Sunday is earlier', async () => {
    const { groupChatSummaries } = await import('../../../src/renderer/src/stores/chat-workspaces')
    const chats = [
      summary({ id: 'sunday', title: '上周周日', createdAt: localTimestamp(2026, 7, 9) }),
      summary({ id: 'monday', title: '本周周一', createdAt: localTimestamp(2026, 7, 10) }),
    ]

    expect(groupChatSummaries(chats, new Date(2026, 7, 10, 9)).map(group => [
      group.label,
      group.chats.map(chat => chat.id),
    ])).toEqual([
      ['今天', ['monday']],
      ['更早', ['sunday']],
    ])
  })

  it('does not put next-week or future-year dates in the current week', async () => {
    const { groupChatSummaries } = await import('../../../src/renderer/src/stores/chat-workspaces')
    const chats = [
      summary({ id: 'next-monday', title: '下周一', createdAt: localTimestamp(2026, 7, 24) }),
      summary({ id: 'future-year', title: '未来年份', createdAt: localTimestamp(2027, 0, 1) }),
      summary({ id: 'current-monday', title: '本周一', createdAt: localTimestamp(2026, 7, 17) }),
    ]

    expect(groupChatSummaries(chats, new Date(2026, 7, 17, 9)).map(group => [
      group.label,
      group.chats.map(chat => chat.id),
    ])).toEqual([
      ['今天', ['current-monday']],
      ['更早', ['future-year', 'next-monday']],
    ])
  })

  it('keeps a cross-year week local and places invalid dates in earlier', async () => {
    const { groupChatSummaries } = await import('../../../src/renderer/src/stores/chat-workspaces')
    const chats = [
      summary({ id: 'invalid', title: '无效日期', createdAt: 'not-a-date' }),
      summary({ id: 'previous-sunday', title: '前一周周日', createdAt: localTimestamp(2025, 11, 28) }),
      summary({ id: 'new-year', title: '元旦', createdAt: localTimestamp(2026, 0, 1) }),
      summary({ id: 'week-monday', title: '跨年周一', createdAt: localTimestamp(2025, 11, 29) }),
    ]

    expect(groupChatSummaries(chats, new Date(2026, 0, 1, 9)).map(group => [
      group.label,
      group.chats.map(chat => chat.id),
    ])).toEqual([
      ['今天', ['new-year']],
      ['12 月 29 日', ['week-monday']],
      ['更早', ['invalid', 'previous-sunday']],
    ])
  })

  it('creates, selects, and removes durable chats with collision-safe request ids', async () => {
    const { createChatWorkspacesStore } = await import('../../../src/renderer/src/stores/chat-workspaces')
    const live = summary({ id: 'live', title: '实时聊天', createdAt: '2026-08-16T02:00:00.000Z', live: true })
    const created = summary({ id: 'created', title: '新聊天', createdAt: '2026-08-16T04:00:00.000Z' })
    const chatApi = api([live], [workspace(live), workspace(created)])
    const requestIds = ['123e4567-e89b-42d3-a456-426614174000', '123e4567-e89b-42d3-a456-426614174001']
    const store = createChatWorkspacesStore(chatApi, { now: () => now, requestId: () => requestIds.shift()! })
    await store.load()

    await store.create()
    expect(chatApi.create).toHaveBeenCalledWith({ requestId: '123e4567-e89b-42d3-a456-426614174000' })
    expect(store.state.selected?.id).toBe('created')

    await store.select('live')
    expect(store.state.selected?.id).toBe('live')

    await store.remove('created')
    expect(chatApi.remove).toHaveBeenCalledWith({ requestId: '123e4567-e89b-42d3-a456-426614174001', chatId: 'created' })
    expect(store.state.chats.map(chat => chat.id)).toEqual(['live'])
  })

  it('waits for main-process removal authority instead of inferring liveChatId locally', async () => {
    const { createChatWorkspacesStore } = await import('../../../src/renderer/src/stores/chat-workspaces')
    const fallback = summary({ id: 'fallback', title: '回退聊天', createdAt: '2026-08-15T02:00:00.000Z' })
    const removed = summary({ id: 'removed', title: '待删除聊天', createdAt: '2026-08-16T02:00:00.000Z' })
    const chatApi = api([removed, fallback], [workspace(removed), workspace(fallback)], 4, removed.id)
    const store = createChatWorkspacesStore(chatApi, { now: () => now })
    await store.load()
    await store.select(fallback.id)
    await store.select(removed.id)

    await store.remove(removed.id)
    expect(store.state.selectedId).toBe(fallback.id)
    expect(store.state.liveChatId).toBe(removed.id)

    await store.apply({ revision: 5, kind: 'removed', chatId: removed.id, liveChatId: fallback.id })
    expect(store.state.liveChatId).toBe(fallback.id)
  })

  it('waits for a pending chat create before an opened session chooses its bind target', async () => {
    const { createChatWorkspacesStore } = await import('../../../src/renderer/src/stores/chat-workspaces')
    const created = summary({ id: 'created', title: '新聊天', createdAt: '2026-08-16T04:00:00.000Z' })
    const createdWorkspace = workspace(created)
    const pendingCreate = deferred<ChatWorkspaceSnapshot>()
    const chatApi = api([], [createdWorkspace], 4, null)
    chatApi.create.mockImplementation(async () => pendingCreate.promise)
    const store = createChatWorkspacesStore(chatApi, { now: () => now })
    await store.load()

    const creating = store.create()
    let bindTarget: string | undefined
    const bindingOpenedSession = (async () => {
      await store.waitForPendingCreate()
      bindTarget = store.state.liveChatId ?? 'generated-fallback'
    })()
    await Promise.resolve()

    expect(bindTarget).toBeUndefined()
    pendingCreate.resolve({ revision: 5, chat: createdWorkspace, liveChatId: created.id })
    await expect(creating).resolves.toBe(true)
    await bindingOpenedSession
    expect(bindTarget).toBe(created.id)
  })

  it('restores a persisted zero-Shell chat as the current live workspace', async () => {
    const { createChatWorkspacesStore } = await import('../../../src/renderer/src/stores/chat-workspaces')
    const empty = summary({
      id: 'empty', title: '未连接的聊天', createdAt: '2026-08-16T02:00:00.000Z', shellCount: 0, live: false,
    })
    const store = createChatWorkspacesStore(api([empty], [workspace(empty)], 4, empty.id), { now: () => now })

    await store.load()

    expect(store.state.selectedId).toBe(empty.id)
    expect(store.state.liveChatId).toBe(empty.id)
    expect(store.state.selected).toEqual(workspace(empty))
  })

  it('restores the authoritative live workspace when a closed history chat sorts first', async () => {
    const { createChatWorkspacesStore } = await import('../../../src/renderer/src/stores/chat-workspaces')
    const history = summary({
      id: 'history', title: '已关闭 Shell 的聊天', createdAt: '2026-08-16T02:00:00.000Z',
      shellCount: 1, live: false, updatedAt: '2026-08-16T12:00:00.000Z',
    })
    const live = summary({
      id: 'live', title: '当前实时聊天', createdAt: '2026-08-16T01:00:00.000Z',
      shellCount: 0, live: false, updatedAt: '2026-08-16T11:00:00.000Z',
    })
    const store = createChatWorkspacesStore(api(
      [history, live], [workspace(history), workspace(live)], 8, live.id,
    ), { now: () => now })

    await store.load()

    expect(store.state.liveChatId).toBe(live.id)
    expect(store.state.selectedId).toBe(live.id)
  })

  it('preserves the authoritative empty live workspace while visiting a chat with an open Shell', async () => {
    const { createChatWorkspacesStore, isInteractiveWorkbenchWorkspace } = await import('../../../src/renderer/src/stores/chat-workspaces')
    const shellChat = summary({
      id: 'shell-chat', title: '运行中的聊天', createdAt: '2026-08-16T01:00:00.000Z', shellCount: 1, live: true,
    })
    const emptyLive = summary({
      id: 'empty-live', title: '当前空聊天', createdAt: '2026-08-16T02:00:00.000Z', shellCount: 0, live: false,
    })
    const shellWorkspace = workspace(shellChat, { shells: [{
      id: 'association-1', chatId: shellChat.id, sessionId: 'session-1', historyId: 'history-1',
      hostname: 'host', title: 'host', status: 'open', associatedAt: '2026-08-16T02:01:00.000Z',
    }] })
    const store = createChatWorkspacesStore(api(
      [emptyLive, shellChat], [workspace(emptyLive), shellWorkspace], 4, emptyLive.id,
    ), { now: () => now })

    await store.load()
    expect(isInteractiveWorkbenchWorkspace(store.state.selected, store.state.liveChatId)).toBe(true)

    await store.select(shellChat.id)
    expect(store.state.liveChatId).toBe(emptyLive.id)
    expect(isInteractiveWorkbenchWorkspace(store.state.selected, store.state.liveChatId)).toBe(true)

    await store.select(emptyLive.id)
    expect(store.state.liveChatId).toBe(emptyLive.id)
    expect(store.state.selectedId).toBe(emptyLive.id)
    expect(isInteractiveWorkbenchWorkspace(store.state.selected, store.state.liveChatId)).toBe(true)
  })

  it('keeps an all-closed chat in history mode after reload and reselection', async () => {
    const { createChatWorkspacesStore } = await import('../../../src/renderer/src/stores/chat-workspaces')
    const history = summary({ id: 'history', title: '已关闭 Shell 的聊天', createdAt: '2026-08-16T02:00:00.000Z', shellCount: 1 })
    const closedWorkspace = workspace(history, { shells: [{
      id: 'association-1', chatId: history.id, historyId: 'history-1', hostname: 'host', title: 'host',
      status: 'closed', associatedAt: '2026-08-16T02:01:00.000Z', closedAt: '2026-08-16T02:02:00.000Z',
    }] })
    const store = createChatWorkspacesStore(api([history], [closedWorkspace]), { now: () => now })

    await store.load()
    await store.select(history.id)

    expect(store.state.liveChatId).toBeNull()
    expect(store.state.selected).toEqual(closedWorkspace)
  })

  it('does not let a stale create completion override a newer chat selection', async () => {
    const { createChatWorkspacesStore } = await import('../../../src/renderer/src/stores/chat-workspaces')
    const live = summary({ id: 'live', title: '实时聊天', createdAt: '2026-08-16T02:00:00.000Z', live: true })
    const history = summary({ id: 'history', title: '历史聊天', createdAt: '2026-08-15T02:00:00.000Z' })
    const created = summary({ id: 'created', title: '较早发起的新聊天', createdAt: '2026-08-16T04:00:00.000Z' })
    const pending = deferred<ChatWorkspaceSnapshot>()
    const chatApi = api([live, history], [workspace(live), workspace(history), workspace(created)])
    chatApi.create.mockImplementation(async () => pending.promise)
    const store = createChatWorkspacesStore(chatApi, { now: () => now })
    await store.load()

    const creating = store.create()
    await store.select('history')
    await store.apply({ revision: 5, kind: 'created', chat: workspace(created), liveChatId: created.id })
    pending.resolve({ revision: 5, chat: workspace(created), liveChatId: created.id })
    await creating

    expect(store.state.selected?.id).toBe('history')
    expect(store.state.liveChatId).toBe(created.id)
  })

  it('retries a delayed initial list without overriding a newer create or its navigation', async () => {
    const { createChatWorkspacesStore } = await import('../../../src/renderer/src/stores/chat-workspaces')
    const initial = summary({ id: 'initial', title: '初始聊天', createdAt: '2026-08-16T02:00:00.000Z' })
    const created = summary({ id: 'created', title: '新聊天', createdAt: '2026-08-16T04:00:00.000Z' })
    const delayedList = deferred<{ revision: number; chats: ChatSummary[]; liveChatId: string | null }>()
    const chatApi = api([initial], [workspace(initial), workspace(created)], 4, initial.id)
    chatApi.list
      .mockImplementationOnce(async () => delayedList.promise)
      .mockResolvedValueOnce({ revision: 5, chats: [created, initial], liveChatId: created.id })
    const store = createChatWorkspacesStore(chatApi, { now: () => now })

    const loading = store.load()
    await expect(store.create()).resolves.toBe(true)
    delayedList.resolve({ revision: 4, chats: [initial], liveChatId: initial.id })
    await loading

    expect(chatApi.list).toHaveBeenCalledTimes(2)
    expect(store.state.liveChatId).toBe(created.id)
    expect(store.state.selectedId).toBe(created.id)
    expect(store.state.chats.map(chat => chat.id)).toEqual([created.id, initial.id])
  })

  it('keeps the newest navigation when concurrent creates complete out of order', async () => {
    const { createChatWorkspacesStore } = await import('../../../src/renderer/src/stores/chat-workspaces')
    const live = summary({ id: 'live', title: '实时聊天', createdAt: '2026-08-16T02:00:00.000Z', live: true })
    const first = summary({ id: 'first-created', title: '第一次新建', createdAt: '2026-08-16T04:00:00.000Z' })
    const second = summary({ id: 'second-created', title: '第二次新建', createdAt: '2026-08-16T05:00:00.000Z' })
    const firstPending = deferred<ChatWorkspaceSnapshot>()
    const secondPending = deferred<ChatWorkspaceSnapshot>()
    const chatApi = api([live], [workspace(live), workspace(first), workspace(second)])
    chatApi.create
      .mockImplementationOnce(async () => firstPending.promise)
      .mockImplementationOnce(async () => secondPending.promise)
    const store = createChatWorkspacesStore(chatApi, { now: () => now })
    await store.load()

    const firstCreating = store.create()
    const secondCreating = store.create()
    secondPending.resolve({ revision: 6, chat: workspace(second), liveChatId: second.id })
    await secondCreating
    firstPending.resolve({ revision: 5, chat: workspace(first), liveChatId: first.id })
    await firstCreating

    expect(store.state.selected?.id).toBe('second-created')
    expect(store.state.liveChatId).toBe('second-created')
  })

  it('keeps a newly created empty chat live when its created event arrives', async () => {
    const { createChatWorkspacesStore } = await import('../../../src/renderer/src/stores/chat-workspaces')
    const created = summary({ id: 'created', title: '新聊天', createdAt: '2026-08-16T04:00:00.000Z' })
    const chatApi = api([], [workspace(created)])
    const store = createChatWorkspacesStore(chatApi, { now: () => now })
    await store.load()

    await store.create()
    await store.apply({ revision: 5, kind: 'created', chat: workspace(created), liveChatId: created.id })

    expect(store.state.selectedId).toBe(created.id)
    expect(store.state.liveChatId).toBe(created.id)
  })

  it('rejects stale changed events and applies the newest selected workspace atomically', async () => {
    const { createChatWorkspacesStore } = await import('../../../src/renderer/src/stores/chat-workspaces')
    const history = summary({ id: 'history-a', title: '旧标题', createdAt: '2026-08-15T03:00:00.000Z' })
    const store = createChatWorkspacesStore(api([history], [workspace(history)]), { now: () => now })
    await store.load()
    await store.select('history-a')
    const newerChat = workspace({ ...history, title: '较新标题', updatedAt: '2026-08-16T05:00:00.000Z' })
    const staleChat = workspace({ ...history, title: '过期标题', updatedAt: '2026-08-16T04:00:00.000Z' })

    store.apply({ revision: 6, kind: 'updated', chat: newerChat, liveChatId: null })
    store.apply({ revision: 5, kind: 'updated', chat: staleChat, liveChatId: null })

    expect(store.state.selected?.title).toBe('较新标题')
    expect(store.state.revision).toBe(6)
  })

  it('applies a source transfer event after the target event at the same revision', async () => {
    const { createChatWorkspacesStore } = await import('../../../src/renderer/src/stores/chat-workspaces')
    const source = summary({ id: 'source', title: '源聊天', createdAt: '2026-08-16T03:00:00.000Z', live: true, shellCount: 1 })
    const target = summary({ id: 'target', title: '目标聊天', createdAt: '2026-08-16T02:00:00.000Z', live: true })
    const sourceWorkspace = workspace(source, { shells: [{
      id: 'shell-source', chatId: source.id, sessionId: 'session-1', historyId: 'history-1', hostname: 'host', title: 'host',
      status: 'open', associatedAt: '2026-08-16T03:00:00.000Z',
    }] })
    const targetWorkspace = workspace(target)
    const transferredSource = workspace({ ...source, live: false }, { shells: [] })
    const transferredTarget = workspace({ ...target, shellCount: 1 }, { shells: sourceWorkspace.shells.map(shell => ({ ...shell, chatId: target.id })) })
    const store = createChatWorkspacesStore(api([source, target], [sourceWorkspace, targetWorkspace], 0), { now: () => now })
    await store.load()

    await store.apply({ revision: 1, kind: 'updated', chat: transferredTarget, liveChatId: target.id })
    await store.apply({ revision: 1, kind: 'updated', chat: transferredSource, liveChatId: target.id })

    expect(store.workspace(source.id)?.shells).toEqual([])
    expect(store.workspace(target.id)?.shells).toHaveLength(1)
  })

  it('does not let a deferred get response overwrite a newer changed event', async () => {
    const { createChatWorkspacesStore } = await import('../../../src/renderer/src/stores/chat-workspaces')
    const live = summary({ id: 'live', title: '实时聊天', createdAt: '2026-08-16T02:00:00.000Z', live: true })
    const history = summary({ id: 'history', title: '旧标题', createdAt: '2026-08-15T02:00:00.000Z' })
    const stale = workspace(history)
    const newer = workspace({ ...history, title: '事件中的新标题', updatedAt: '2026-08-16T05:00:00.000Z' })
    const pending = deferred<ChatWorkspaceSnapshot>()
    const chatApi = api([live, history], [workspace(live), stale])
    chatApi.get.mockImplementation(async chatId => chatId === 'live' ? { revision: 4, chat: workspace(live), liveChatId: live.id } : pending.promise)
    const store = createChatWorkspacesStore(chatApi, { now: () => now })
    await store.load()

    const selecting = store.select('history')
    store.apply({ revision: 5, kind: 'updated', chat: newer, liveChatId: live.id })
    pending.resolve({ revision: 4, chat: stale, liveChatId: live.id })
    await selecting

    expect(store.state.selected).toEqual(newer)
    expect(store.state.revision).toBe(5)
  })

  it('does not let an older bind response reopen a shell closed by a newer event', async () => {
    const { createChatWorkspacesStore } = await import('../../../src/renderer/src/stores/chat-workspaces')
    const live = summary({ id: 'live', title: '实时聊天', createdAt: '2026-08-16T02:00:00.000Z', shellCount: 1, live: true })
    const open = workspace(live, { shells: [{
      id: 'association-1', chatId: 'live', sessionId: 'session-1', historyId: 'history-1', hostname: 'host', title: 'host',
      status: 'open', associatedAt: '2026-08-16T02:01:00.000Z',
    }] })
    const closed = workspace({ ...live, live: false, updatedAt: '2026-08-16T02:02:00.000Z' }, {
      shells: [{ ...open.shells[0], status: 'closed', closedAt: '2026-08-16T02:02:00.000Z' }],
    })
    const store = createChatWorkspacesStore(api([live], [open]), { now: () => now })
    await store.load()

    store.apply({ revision: 6, kind: 'updated', chat: closed, liveChatId: null })
    store.merge({ revision: 5, chat: open, liveChatId: live.id })

    expect(store.state.selected).toEqual(closed)
    expect(store.state.revision).toBe(6)
  })

  it('demotes the current live chat when its last open Shell closes', async () => {
    const { createChatWorkspacesStore } = await import('../../../src/renderer/src/stores/chat-workspaces')
    const live = summary({ id: 'live', title: '实时聊天', createdAt: '2026-08-16T02:00:00.000Z', shellCount: 1, live: true })
    const history = summary({ id: 'history', title: '历史聊天', createdAt: '2026-08-15T02:00:00.000Z' })
    const open = workspace(live, { shells: [{
      id: 'association-1', chatId: live.id, sessionId: 'session-1', historyId: 'history-1', hostname: 'host', title: 'host',
      status: 'open', associatedAt: '2026-08-16T02:01:00.000Z',
    }] })
    const closed = workspace({ ...live, live: false, updatedAt: '2026-08-16T02:02:00.000Z' }, {
      shells: [{ ...open.shells[0], sessionId: undefined, status: 'closed', closedAt: '2026-08-16T02:02:00.000Z' }],
    })
    const chatApi = api([live, history], [open, workspace(history)])
    chatApi.get.mockImplementation(async chatId => ({
      revision: 5,
      chat: chatId === live.id ? closed : workspace(history),
      liveChatId: null,
    }))
    const store = createChatWorkspacesStore(chatApi, { now: () => now })
    await store.load()

    await store.apply({ revision: 5, kind: 'updated', chat: closed, liveChatId: null })
    await store.select(history.id)
    await store.select(live.id)

    expect(store.state.liveChatId).toBeNull()
    expect(store.state.selected).toEqual(closed)
  })

  it('does not let a partial workspace response skip pending events for another chat', async () => {
    const { createChatWorkspacesStore } = await import('../../../src/renderer/src/stores/chat-workspaces')
    const first = summary({ id: 'first', title: '第一聊天', createdAt: '2026-08-16T02:00:00.000Z', live: true })
    const second = summary({ id: 'second', title: '第二聊天', createdAt: '2026-08-15T02:00:00.000Z' })
    const store = createChatWorkspacesStore(api([first, second], [workspace(first), workspace(second)]), { now: () => now })
    await store.load()

    store.merge({ revision: 6, chat: workspace({ ...first, title: '查询到的新标题' }), liveChatId: first.id })
    await store.apply({ revision: 5, kind: 'updated', chat: workspace({ ...second, title: '不能跳过的事件' }), liveChatId: first.id })

    expect(store.state.chats.find(chat => chat.id === 'second')?.title).toBe('不能跳过的事件')
    expect(store.state.revision).toBe(5)
  })

  it('waits for fallback selection before removing the current live chat', async () => {
    const { createChatWorkspacesStore } = await import('../../../src/renderer/src/stores/chat-workspaces')
    const live = summary({ id: 'live', title: '实时聊天', createdAt: '2026-08-16T02:00:00.000Z', live: true })
    const history = summary({ id: 'history', title: '历史聊天', createdAt: '2026-08-15T02:00:00.000Z' })
    const fallback = deferred<ChatWorkspaceSnapshot>()
    const chatApi = api([live, history], [workspace(live), workspace(history)])
    chatApi.get.mockImplementation(async chatId => chatId === 'live' ? { revision: 4, chat: workspace(live), liveChatId: live.id } : fallback.promise)
    const store = createChatWorkspacesStore(chatApi, { now: () => now })
    await store.load()

    let settled = false
    const removing = store.remove('live').then(() => { settled = true })
    await Promise.resolve()
    await Promise.resolve()

    expect(settled).toBe(false)
    fallback.resolve({ revision: 4, chat: workspace(history), liveChatId: live.id })
    await removing
    expect(store.state.selected?.id).toBe('history')
  })

  it('does not let a removed event invalidate a newer pending chat selection', async () => {
    const { createChatWorkspacesStore } = await import('../../../src/renderer/src/stores/chat-workspaces')
    const removed = summary({ id: 'removed', title: '待删除聊天', createdAt: '2026-08-16T03:00:00.000Z', live: true })
    const fallback = summary({ id: 'fallback', title: '回退聊天', createdAt: '2026-08-15T03:00:00.000Z' })
    const selected = summary({ id: 'selected', title: '用户选择聊天', createdAt: '2026-08-14T03:00:00.000Z' })
    const removePending = deferred<undefined>()
    const selectPending = deferred<ChatWorkspaceSnapshot>()
    const chatApi = api([removed, fallback, selected], [workspace(removed), workspace(fallback), workspace(selected)])
    chatApi.remove.mockImplementation(async () => removePending.promise)
    chatApi.get.mockImplementation(async chatId => chatId === selected.id
      ? selectPending.promise
      : { revision: chatId === removed.id ? 4 : 5, chat: workspace(chatId === removed.id ? removed : fallback), liveChatId: removed.id })
    const store = createChatWorkspacesStore(chatApi, { now: () => now })
    await store.load()

    const removing = store.remove(removed.id)
    const selecting = store.select(selected.id)
    chatApi.emit({ revision: 5, kind: 'removed', chatId: removed.id, liveChatId: null })
    removePending.resolve(undefined)
    await removing
    selectPending.resolve({ revision: 5, chat: workspace(selected), liveChatId: null })
    await selecting

    expect(store.state.selectedId).toBe(selected.id)
    expect(chatApi.get).not.toHaveBeenCalledWith(fallback.id)
  })

  it('does not let a removed event invalidate a newer pending chat creation', async () => {
    const { createChatWorkspacesStore } = await import('../../../src/renderer/src/stores/chat-workspaces')
    const removed = summary({ id: 'removed', title: '待删除聊天', createdAt: '2026-08-16T03:00:00.000Z', live: true })
    const fallback = summary({ id: 'fallback', title: '回退聊天', createdAt: '2026-08-15T03:00:00.000Z' })
    const created = summary({ id: 'created', title: '用户新建聊天', createdAt: '2026-08-16T04:00:00.000Z' })
    const removePending = deferred<undefined>()
    const createPending = deferred<ChatWorkspaceSnapshot>()
    const chatApi = api([removed, fallback], [workspace(removed), workspace(fallback), workspace(created)])
    chatApi.remove.mockImplementation(async () => removePending.promise)
    chatApi.create.mockImplementation(async () => createPending.promise)
    chatApi.get.mockImplementation(async chatId => ({
      revision: chatId === removed.id ? 4 : 5,
      chat: workspace(chatId === removed.id ? removed : fallback),
      liveChatId: removed.id,
    }))
    const store = createChatWorkspacesStore(chatApi, { now: () => now })
    await store.load()

    const removing = store.remove(removed.id)
    const creating = store.create()
    chatApi.emit({ revision: 5, kind: 'removed', chatId: removed.id, liveChatId: null })
    removePending.resolve(undefined)
    await removing
    createPending.resolve({ revision: 6, chat: workspace(created), liveChatId: created.id })
    await creating

    expect(store.state.selectedId).toBe(created.id)
    expect(store.state.liveChatId).toBe(created.id)
    expect(chatApi.get).not.toHaveBeenCalledWith(fallback.id)
  })

  it('does not surface an old remove failure after newer navigation', async () => {
    const { createChatWorkspacesStore } = await import('../../../src/renderer/src/stores/chat-workspaces')
    const removed = summary({ id: 'removed', title: '待删除聊天', createdAt: '2026-08-16T03:00:00.000Z', live: true })
    const selected = summary({ id: 'selected', title: '用户选择聊天', createdAt: '2026-08-15T03:00:00.000Z' })
    const pending = deferred<undefined>()
    const chatApi = api([removed, selected], [workspace(removed), workspace(selected)])
    chatApi.remove.mockImplementation(async () => pending.promise)
    const store = createChatWorkspacesStore(chatApi, { now: () => now })
    await store.load()

    const removing = store.remove(removed.id)
    await store.select(selected.id)
    pending.reject(new Error('old remove failed'))
    await removing

    expect(store.state.selectedId).toBe(selected.id)
    expect(store.state.error).toBe('')
  })

  it('does not apply stale local remove completion after a newer workbench operation', async () => {
    const { createChatWorkspacesStore } = await import('../../../src/renderer/src/stores/chat-workspaces')
    const removed = summary({ id: 'removed', title: '待删除聊天', createdAt: '2026-08-16T03:00:00.000Z', live: true })
    const fallback = summary({ id: 'fallback', title: '回退聊天', createdAt: '2026-08-15T03:00:00.000Z' })
    const pending = deferred<undefined>()
    const chatApi = api([removed, fallback], [workspace(removed), workspace(fallback)])
    chatApi.remove.mockImplementation(async () => pending.promise)
    const store = createChatWorkspacesStore(chatApi, { now: () => now })
    await store.load()
    let current = true

    const removing = store.remove(removed.id, () => current)
    current = false
    pending.resolve(undefined)
    await removing

    expect(store.state.selectedId).toBe(removed.id)
    expect(store.state.chats.map(chat => chat.id)).toContain(removed.id)
    expect(store.state.error).toBe('')
  })

  it('waits for fallback selection after an external removed event', async () => {
    const { createChatWorkspacesStore } = await import('../../../src/renderer/src/stores/chat-workspaces')
    const live = summary({ id: 'live', title: '实时聊天', createdAt: '2026-08-16T02:00:00.000Z', live: true })
    const history = summary({ id: 'history', title: '历史聊天', createdAt: '2026-08-15T02:00:00.000Z' })
    const fallback = deferred<ChatWorkspaceSnapshot>()
    const chatApi = api([live, history], [workspace(live), workspace(history)])
    chatApi.get.mockImplementation(async chatId => chatId === 'live' ? { revision: 4, chat: workspace(live), liveChatId: live.id } : fallback.promise)
    const store = createChatWorkspacesStore(chatApi, { now: () => now })
    await store.load()

    let settled = false
    const applying = Promise.resolve(store.apply({ revision: 5, kind: 'removed', chatId: 'live', liveChatId: null })).then(() => { settled = true })
    await Promise.resolve()

    expect(settled).toBe(false)
    fallback.resolve({ revision: 5, chat: workspace(history), liveChatId: null })
    await applying
    expect(store.state.selected?.id).toBe('history')
    expect(store.state.liveChatId).toBeNull()
  })

  it('restores the cached live workspace after viewing history', async () => {
    const { createChatWorkspacesStore } = await import('../../../src/renderer/src/stores/chat-workspaces')
    const live = summary({ id: 'live', title: '实时聊天', createdAt: '2026-08-16T02:00:00.000Z', shellCount: 1, live: true })
    const history = summary({ id: 'history', title: '历史聊天', createdAt: '2026-08-15T02:00:00.000Z', shellCount: 2 })
    const chatApi = api([live, history], [workspace(live), workspace(history)])
    const store = createChatWorkspacesStore(chatApi, { now: () => now })
    await store.load()

    await store.select('history')
    expect(store.state.liveChatId).toBe('live')
    await store.select('live')

    expect(store.state.selected).toEqual(workspace(live))
    expect(store.state.liveChatId).toBe('live')
    expect(chatApi.get).toHaveBeenCalledTimes(2)
  })

  it('selects an open workspace without rewriting the authoritative live chat', async () => {
    const { createChatWorkspacesStore } = await import('../../../src/renderer/src/stores/chat-workspaces')
    const chatA = summary({ id: 'chat-a', title: '聊天 A', createdAt: '2026-08-15T02:00:00.000Z', shellCount: 1, live: true })
    const chatB = summary({ id: 'chat-b', title: '聊天 B', createdAt: '2026-08-16T02:00:00.000Z', shellCount: 1, live: true })
    const openWorkspace = (chat: ChatSummary, sessionId: string) => workspace(chat, { shells: [{
      id: `association-${sessionId}`, chatId: chat.id, sessionId, historyId: `history-${sessionId}`,
      hostname: sessionId, title: sessionId, status: 'open', associatedAt: chat.createdAt,
    }] })
    const chatApi = api([chatB, chatA], [openWorkspace(chatB, 'session-b'), openWorkspace(chatA, 'session-a')])
    const store = createChatWorkspacesStore(chatApi, { now: () => now })
    await store.load()

    await store.select(chatA.id)

    expect(store.state.selectedId).toBe(chatA.id)
    expect(store.state.liveChatId).toBe(chatB.id)
  })
})

describe('durable chat workbench components', () => {
  it('keeps internal live-chat creation within the launch operation but rejects later user navigation', async () => {
    const { createWorkbenchOperationGate } = await import('../../../src/renderer/src/stores/chat-workspaces')
    const operations = createWorkbenchOperationGate()
    const launch = operations.begin()
    const openedSession = operations.capture()

    await Promise.resolve()
    expect(operations.isCurrent(launch)).toBe(true)
    expect(operations.isCurrent(openedSession)).toBe(true)

    operations.invalidate()
    expect(operations.isCurrent(launch)).toBe(false)
    expect(operations.isCurrent(openedSession)).toBe(false)
  })

  it('ignores an older saved-session open after a newer open completes first', async () => {
    const module = await import('../../../src/renderer/src/stores/chat-workspaces') as unknown as {
      createWorkbenchOperationGate(): ReturnType<typeof import('../../../src/renderer/src/stores/chat-workspaces')['createWorkbenchOperationGate']>
      runWorkbenchSessionOpen<T>(options: {
        gate: ReturnType<typeof import('../../../src/renderer/src/stores/chat-workspaces')['createWorkbenchOperationGate']>
        open(): Promise<T>
        attach(session: T, isCurrent: () => boolean): Promise<void>
        complete(): void
        fail(error: unknown): void
      }): Promise<void>
    }
    const operations = module.createWorkbenchOperationGate()
    const older = deferred<{ id: string }>()
    const newer = deferred<{ id: string }>()
    let activeSessionId: string | null = null
    let dialogOpen = true
    const errors: unknown[] = []
    const open = (pending: ReturnType<typeof deferred<{ id: string }>>) => module.runWorkbenchSessionOpen({
      gate: operations,
      open: () => pending.promise,
      attach: async (session, isCurrent) => {
        if (isCurrent()) activeSessionId = session.id
      },
      complete: () => { dialogOpen = false },
      fail: error => { errors.push(error) },
    })

    const olderOpening = open(older)
    const newerOpening = open(newer)
    newer.resolve({ id: 'session-newer' })
    await newerOpening
    expect(dialogOpen).toBe(false)
    operations.invalidate()
    dialogOpen = true
    older.resolve({ id: 'session-older' })
    await olderOpening

    expect(activeSessionId).toBe('session-newer')
    expect(dialogOpen).toBe(true)
    expect(errors).toEqual([])
  })

  it('keeps a newer connection modal open when an embedded direct connection finishes late', async () => {
    const module = await import('../../../src/renderer/src/stores/chat-workspaces') as unknown as {
      createWorkbenchOperationGate(): ReturnType<typeof import('../../../src/renderer/src/stores/chat-workspaces')['createWorkbenchOperationGate']>
      runWorkbenchSessionOpen<T>(options: {
        gate: ReturnType<typeof import('../../../src/renderer/src/stores/chat-workspaces')['createWorkbenchOperationGate']>
        open(): Promise<T>
        attach(session: T, isCurrent: () => boolean): Promise<void>
        complete(): void
        fail(error: unknown): void
      }): Promise<void>
    }
    const operations = module.createWorkbenchOperationGate()
    const pending = deferred<{ id: string }>()
    let connectionDialogOpen = false
    const errors: unknown[] = []
    const attach = vi.fn(async () => undefined)

    const opening = module.runWorkbenchSessionOpen({
      gate: operations,
      open: () => pending.promise,
      attach,
      complete: () => { connectionDialogOpen = false },
      fail: error => { errors.push(error) },
    })
    expect(connectionDialogOpen).toBe(false)
    operations.invalidate()
    connectionDialogOpen = true
    pending.resolve({ id: 'session-direct' })
    await opening

    expect(attach).not.toHaveBeenCalled()
    expect(connectionDialogOpen).toBe(true)
    expect(errors).toEqual([])

    const view = readFileSync(new URL('../../../src/renderer/src/views/WorkbenchView.vue', import.meta.url), 'utf8')
    const createConnection = view.slice(view.indexOf('function createConnection'), view.indexOf('function editSavedProfile'))
    expect(createConnection.indexOf('workbenchOperations.invalidate()')).toBeGreaterThanOrEqual(0)
    expect(createConnection.indexOf('workbenchOperations.invalidate()')).toBeLessThan(createConnection.indexOf('showConnection.value = true'))
    expect(view).toContain('function openSavedSessionsDialog(): void')
    expect(view).toContain('<SavedSessionsDialog')
    expect(view).not.toContain('@open-saved="openSavedSessionsDialog"')
  })

  it('keeps newer navigation and a reopened dialog when a saved session finishes late', async () => {
    const { createWorkbenchOperationGate, runWorkbenchSessionOpen } = await import('../../../src/renderer/src/stores/chat-workspaces') as unknown as {
      createWorkbenchOperationGate(): ReturnType<typeof import('../../../src/renderer/src/stores/chat-workspaces')['createWorkbenchOperationGate']>
      runWorkbenchSessionOpen<T>(options: {
        gate: ReturnType<typeof import('../../../src/renderer/src/stores/chat-workspaces')['createWorkbenchOperationGate']>
        open(): Promise<T>
        attach(session: T, isCurrent: () => boolean): Promise<void>
        complete(): void
        fail(error: unknown): void
      }): Promise<void>
    }
    const operations = createWorkbenchOperationGate()
    const pending = deferred<{ id: string }>()
    let selectedChat = 'history'
    let dialogOpen = true
    const errors: unknown[] = []

    const opening = runWorkbenchSessionOpen({
      gate: operations,
      open: () => pending.promise,
      attach: async (_session, isCurrent) => {
        if (isCurrent()) selectedChat = 'live'
      },
      complete: () => { dialogOpen = false },
      fail: error => { errors.push(error) },
    })
    operations.invalidate()
    operations.invalidate()
    pending.resolve({ id: 'session-late' })
    await opening

    expect(selectedChat).toBe('history')
    expect(dialogOpen).toBe(true)
    expect(errors).toEqual([])
  })

  it('keeps an existing per-chat pane layout when associations are restored', async () => {
    const module = await import('../../../src/renderer/src/stores/chat-workspaces') as unknown as {
      ensureWorkbenchShellView(
        views: Map<string, { visibleSessionIds: string[]; activeSessionId: string | null }>,
        chat: ChatWorkspace,
      ): void
    }
    const preserved = { visibleSessionIds: ['session-b'], activeSessionId: 'session-b' }
    const views = new Map([['chat-a', preserved]])
    const chat = workspace(summary({
      id: 'chat-a', title: '聊天 A', createdAt: '2026-08-16T02:00:00.000Z', shellCount: 2, live: true,
    }), { shells: [
      {
        id: 'association-a', chatId: 'chat-a', sessionId: 'session-a', historyId: 'history-a', hostname: 'host-a', title: 'host-a',
        status: 'open', associatedAt: '2026-08-16T02:01:00.000Z',
      },
      {
        id: 'association-b', chatId: 'chat-a', sessionId: 'session-b', historyId: 'history-b', hostname: 'host-b', title: 'host-b',
        status: 'open', associatedAt: '2026-08-16T02:02:00.000Z',
      },
    ] })

    module.ensureWorkbenchShellView(views, chat)

    expect(views.get(chat.id)).toBe(preserved)
    expect(views.get(chat.id)).toEqual({ visibleSessionIds: ['session-b'], activeSessionId: 'session-b' })
  })

  it('rebuilds an invalid per-chat pane layout from open associations', async () => {
    const { ensureWorkbenchShellView } = await import('../../../src/renderer/src/stores/chat-workspaces')
    const views = new Map([['chat-a', { visibleSessionIds: [] as string[], activeSessionId: null as string | null }]])
    const chat = workspace(summary({
      id: 'chat-a', title: '聊天 A', createdAt: '2026-08-16T02:00:00.000Z', shellCount: 1, live: true,
    }), { shells: [{
      id: 'association-a', chatId: 'chat-a', sessionId: 'session-a', historyId: 'history-a', hostname: 'host-a', title: 'host-a',
      status: 'open', associatedAt: '2026-08-16T02:01:00.000Z',
    }] })

    ensureWorkbenchShellView(views, chat)

    expect(views.get(chat.id)).toEqual({ visibleSessionIds: ['session-a'], activeSessionId: 'session-a' })
  })

  it('navigates to the authoritative owner before focusing a reusable session', async () => {
    const module = await import('../../../src/renderer/src/stores/chat-workspaces') as unknown as {
      focusOwnedWorkbenchSession<TWorkspace>(options: {
        sessionId: string
        resolve(sessionId: string): Promise<TWorkspace | null>
        selectChat(workspace: TWorkspace): Promise<void>
        selectSession(sessionId: string): boolean
      }): Promise<boolean>
    }
    const actions: string[] = []

    await expect(module.focusOwnedWorkbenchSession({
      sessionId: 'session-a',
      resolve: async sessionId => {
        actions.push(`resolve:${sessionId}`)
        return { id: 'chat-a' }
      },
      selectChat: async workspace => { actions.push(`chat:${workspace.id}`) },
      selectSession: sessionId => {
        actions.push(`session:${sessionId}`)
        return true
      },
    })).resolves.toBe(true)

    expect(actions).toEqual(['resolve:session-a', 'chat:chat-a', 'session:session-a'])
  })

  it('does not report a focused session when the current-chat ownership gate rejects it', async () => {
    const { focusOwnedWorkbenchSession } = await import('../../../src/renderer/src/stores/chat-workspaces')
    let selectedChatId = 'chat-b'
    const liveChatId = 'chat-b'

    await expect(focusOwnedWorkbenchSession({
      sessionId: 'session-a',
      resolve: async () => ({ id: 'chat-a' }),
      selectChat: async workspace => { selectedChatId = workspace.id },
      selectSession: () => selectedChatId === liveChatId,
    })).resolves.toBe(false)
  })

  it('does not focus a stale Bastion response after the user navigates away during ownership lookup', async () => {
    const { focusOwnedWorkbenchSession } = await import('../../../src/renderer/src/stores/chat-workspaces')
    const pending = deferred<{ id: string }>()
    let generation = 1
    const actions: string[] = []

    const focusing = focusOwnedWorkbenchSession({
      sessionId: 'session-a',
      resolve: async () => pending.promise,
      selectChat: async workspace => { actions.push(`chat:${workspace.id}`) },
      selectSession: sessionId => { actions.push(`session:${sessionId}`); return true },
      isCurrent: () => generation === 1,
    })
    generation = 2
    pending.resolve({ id: 'chat-a' })

    await expect(focusing).resolves.toBe(false)
    expect(actions).toEqual([])
  })

  it('does not focus a stale Bastion response after navigation changes during owner selection', async () => {
    const { focusOwnedWorkbenchSession } = await import('../../../src/renderer/src/stores/chat-workspaces')
    const selecting = deferred<void>()
    let generation = 1
    const actions: string[] = []

    const focusing = focusOwnedWorkbenchSession({
      sessionId: 'session-a',
      resolve: async () => ({ id: 'chat-a' }),
      selectChat: async workspace => { actions.push(`chat:${workspace.id}`); await selecting.promise },
      selectSession: sessionId => { actions.push(`session:${sessionId}`); return true },
      isCurrent: () => generation === 1,
    })
    await vi.waitFor(() => expect(actions).toEqual(['chat:chat-a']))
    generation = 2
    selecting.resolve(undefined)

    await expect(focusing).resolves.toBe(false)
    expect(actions).toEqual(['chat:chat-a'])
  })

  it('does not merge a stale Bastion ownership response into chat state', async () => {
    const { createChatWorkspacesStore, focusOwnedWorkbenchSession } = await import('../../../src/renderer/src/stores/chat-workspaces')
    const current = summary({ id: 'current', title: '当前聊天', createdAt: '2026-08-16T02:00:00.000Z' })
    const owner = summary({ id: 'owner', title: '会话所属聊天', createdAt: '2026-08-15T02:00:00.000Z', shellCount: 1, live: true })
    const ownerWorkspace = workspace(owner, { shells: [{
      id: 'association-1', chatId: owner.id, sessionId: 'session-a', historyId: 'history-1', hostname: 'host', title: 'host',
      status: 'open', associatedAt: '2026-08-16T02:01:00.000Z',
    }] })
    const pending = deferred<ChatSessionResolution>()
    const chatApi = api([current], [workspace(current)], 4, current.id)
    chatApi.resolveSession.mockImplementation(async () => pending.promise)
    const store = createChatWorkspacesStore(chatApi, { now: () => now })
    await store.load()
    let generation = 1

    const focusing = focusOwnedWorkbenchSession({
      sessionId: 'session-a',
      resolve: (sessionId, isCurrent) => store.resolveSession(sessionId, isCurrent),
      selectChat: async () => undefined,
      selectSession: () => true,
      isCurrent: () => generation === 1,
    })
    generation = 2
    pending.resolve({ revision: 5, sessionId: 'session-a', chat: ownerWorkspace, liveChatId: current.id })

    await expect(focusing).resolves.toBe(false)
    expect(store.workspace(owner.id)).toBeUndefined()
    expect(store.state.chats.map(chat => chat.id)).toEqual([current.id])
    expect(store.state.liveChatId).toBe(current.id)
  })

  it('does not commit a stale Bastion owner-chat selection', async () => {
    const { createChatWorkspacesStore, focusOwnedWorkbenchSession } = await import('../../../src/renderer/src/stores/chat-workspaces')
    const current = summary({ id: 'current', title: '当前聊天', createdAt: '2026-08-16T02:00:00.000Z', live: true })
    const owner = summary({ id: 'owner', title: '会话所属聊天', createdAt: '2026-08-15T02:00:00.000Z', shellCount: 1, live: true })
    const pending = deferred<ChatWorkspaceSnapshot>()
    const chatApi = api([current, owner], [workspace(current), workspace(owner)])
    chatApi.get.mockImplementation(async chatId => chatId === current.id
      ? { revision: 4, chat: workspace(current), liveChatId: current.id }
      : pending.promise)
    const store = createChatWorkspacesStore(chatApi, { now: () => now })
    await store.load()
    let generation = 1

    const focusing = focusOwnedWorkbenchSession({
      sessionId: 'session-a',
      resolve: async () => workspace(owner),
      selectChat: (chat, isCurrent) => store.select(chat.id, isCurrent),
      selectSession: () => true,
      isCurrent: () => generation === 1,
    })
    await vi.waitFor(() => expect(chatApi.get).toHaveBeenCalledWith(owner.id))
    generation = 2
    pending.resolve({ revision: 5, chat: workspace(owner), liveChatId: current.id })

    await expect(focusing).resolves.toBe(false)
    expect(store.state.selectedId).toBe(current.id)
    expect(store.state.selected?.id).toBe(current.id)
  })

  it('focuses an owner session through normal workspace selection', async () => {
    const { createChatWorkspacesStore, focusOwnedWorkbenchSession } = await import('../../../src/renderer/src/stores/chat-workspaces')
    const owner = summary({ id: 'chat-a', title: '聊天 A', createdAt: '2026-08-15T02:00:00.000Z', shellCount: 1 })
    const current = summary({ id: 'chat-b', title: '聊天 B', createdAt: '2026-08-16T02:00:00.000Z', live: true })
    const ownerWorkspace = workspace(owner, { shells: [{
      id: 'association-a', chatId: owner.id, sessionId: 'session-a', historyId: 'history-a', hostname: 'host-a', title: 'host-a',
      status: 'open', associatedAt: '2026-08-15T02:01:00.000Z',
    }] })
    const store = createChatWorkspacesStore(api([current, owner], [workspace(current), ownerWorkspace]), { now: () => now })
    await store.load()

    await expect(focusOwnedWorkbenchSession({
      sessionId: 'session-a',
      resolve: async () => ownerWorkspace,
      selectChat: chat => store.select(chat.id),
      selectSession: sessionId => store.state.liveChatId === current.id
        && store.state.selectedId === owner.id
        && store.state.selected?.shells.some(shell => shell.sessionId === sessionId) === true,
    })).resolves.toBe(true)

    expect(store.state.liveChatId).toBe(current.id)
    expect(store.state.selectedId).toBe(owner.id)
  })

  it('continues restoring later sessions after one ownership lookup fails', async () => {
    const module = await import('../../../src/renderer/src/stores/chat-workspaces') as unknown as {
      restoreWorkbenchSessionOwnership<TSession, TWorkspace>(options: {
        sessions: readonly TSession[]
        add(session: TSession): void
        resolve(session: TSession): Promise<TWorkspace | null>
        restore(workspace: TWorkspace): void
        bind(session: TSession): Promise<void>
      }): Promise<unknown[]>
    }
    const added: string[] = []
    const restored: string[] = []
    const bound: string[] = []

    const failures = await module.restoreWorkbenchSessionOwnership({
      sessions: ['session-a', 'session-b', 'session-c'],
      add: session => added.push(session),
      resolve: async session => {
        if (session === 'session-b') throw new Error('broken association')
        return session === 'session-a' ? 'chat-a' : null
      },
      restore: chat => restored.push(chat),
      bind: async session => { bound.push(session) },
    })

    expect(added).toEqual(['session-a', 'session-b', 'session-c'])
    expect(restored).toEqual(['chat-a'])
    expect(bound).toEqual(['session-c'])
    expect(failures).toMatchObject([{ session: 'session-b', error: expect.any(Error) }])
  })

  it('activates a fallback live workspace for an unowned startup session after history was selected', async () => {
    const { createChatWorkspacesStore, restoreWorkbenchSessionOwnership } = await import('../../../src/renderer/src/stores/chat-workspaces')
    const history = summary({ id: 'history', title: '历史聊天', createdAt: '2026-08-15T02:00:00.000Z' })
    const fallback = summary({ id: 'fallback-live', title: '恢复的实时聊天', createdAt: '2026-08-16T02:00:00.000Z', shellCount: 1, live: true })
    const fallbackWorkspace = workspace(fallback, { shells: [{
      id: 'association-startup', chatId: fallback.id, sessionId: 'session-startup', historyId: 'history-startup',
      hostname: 'startup-host', title: 'startup-host', status: 'open', associatedAt: '2026-08-16T02:01:00.000Z',
    }] })
    const store = createChatWorkspacesStore(api([history], [workspace(history)]), { now: () => now })
    await store.load()

    await restoreWorkbenchSessionOwnership({
      sessions: [{ id: 'session-startup' }],
      add: () => undefined,
      resolve: async () => null,
      restore: () => undefined,
      bind: async (_session, activate) => {
        store.merge({ revision: 5, chat: fallbackWorkspace, liveChatId: fallback.id })
        if (activate) await store.select(fallback.id)
      },
    })

    expect(store.state.liveChatId).toBe(fallback.id)
    expect(store.state.selectedId).toBe(fallback.id)
    expect(store.state.selected?.shells).toEqual([
      expect.objectContaining({ sessionId: 'session-startup', status: 'open' }),
    ])
  })

  it('gates every live session surface by current chat ownership', () => {
    const view = readFileSync(new URL('../../../src/renderer/src/views/WorkbenchView.vue', import.meta.url), 'utf8')
    const canvas = readFileSync(new URL('../../../src/renderer/src/components/workbench/ShellCanvas.vue', import.meta.url), 'utf8')

    expect(view).toContain(':sessions="sessions"')
    expect(view).toContain(':current-sessions="currentChatSessions"')
    expect(view).toContain('workbenchSessionAttachmentTarget(chatStore.state.selectedId, chatStore.state.liveChatId)')
    expect(view).toContain('if (!currentChatSessionIds.value.has(sessionId) || !store.byId(sessionId)) return')
    expect(view).toContain('const available = new Set(currentChatSessions.value.map(session => session.id))')
    expect(view).toContain('addSession(session, false)')
    expect(view).toContain('if (isCurrent() && store.byId(session.id)) select(session.id)')
    expect(canvas).toContain('const currentSessionIds = computed(() => new Set(props.currentSessions.map(session => session.id)))')
    expect(canvas).toContain('return currentSessionIds.value.has(sessionId) && displayedSessionIdSet.value.has(sessionId)')
  })

  it('pins a duplicate request to the chat captured before its async transport resolves', async () => {
    const { runWorkbenchSessionDuplicate } = await import('../../../src/renderer/src/stores/chat-workspaces') as typeof import('../../../src/renderer/src/stores/chat-workspaces')
    const pending = deferred<{ id: string }>()
    let selectedChatId = 'chat-a'
    const attached: Array<{ chatId: string; isCurrent: boolean }> = []

    const operation = runWorkbenchSessionDuplicate({
      sessionId: 'session-a',
      targetChatId: selectedChatId,
      duplicate: async (_sessionId, chatId) => {
        expect(chatId).toBe('chat-a')
        return pending.promise
      },
      attach: async (_session, chatId, isCurrent) => {
        attached.push({ chatId, isCurrent: isCurrent() })
      },
      isCurrent: () => selectedChatId === 'chat-a',
    })

    selectedChatId = 'chat-b'
    pending.resolve({ id: 'session-copy' })
    await operation

    expect(attached).toEqual([{ chatId: 'chat-a', isCurrent: false }])
    const view = readFileSync(new URL('../../../src/renderer/src/views/WorkbenchView.vue', import.meta.url), 'utf8')
    expect(view).toContain('const targetChatId = activeWorkbenchChatId.value')
    expect(view).toContain('runWorkbenchSessionDuplicate({')
    expect(view).toContain('const reconnectIsCurrent = () => chatStore.state.selectedId === targetChatId')
  })

  it('keeps a reconnect attached to its initiating chat when navigation changes while it is pending', async () => {
    const module = await import('../../../src/renderer/src/stores/chat-workspaces') as unknown as {
      runWorkbenchSessionReconnect<TSession>(options: {
        targetChatId: string
        reconnect(): Promise<TSession>
        attach(session: TSession, chatId: string, isCurrent: () => boolean): Promise<void>
        isCurrent(): boolean
      }): Promise<void>
    }
    const pending = deferred<{ id: string }>()
    let selectedChatId = 'chat-a'
    const attached: Array<{ chatId: string; isCurrent: boolean }> = []

    const reconnecting = module.runWorkbenchSessionReconnect({
      targetChatId: selectedChatId,
      reconnect: async () => pending.promise,
      attach: async (_session, chatId, isCurrent) => {
        attached.push({ chatId, isCurrent: isCurrent() })
      },
      isCurrent: () => selectedChatId === 'chat-a',
    })

    selectedChatId = 'chat-b'
    pending.resolve({ id: 'session-reconnected' })
    await reconnecting

    expect(attached).toEqual([{ chatId: 'chat-a', isCurrent: false }])
  })

  it('guards a direct reconnect continuation with the chat captured before awaiting', () => {
    const view = readFileSync(new URL('../../../src/renderer/src/views/WorkbenchView.vue', import.meta.url), 'utf8')
    const reconnect = view.slice(view.indexOf('async function reconnectShell'), view.indexOf('async function refreshHistoryPlayback'))

    expect(reconnect).toContain('const targetChatId = chatStore.state.selectedId')
    expect(reconnect).toContain('const isTargetCurrent = () => chatStore.state.selectedId === targetChatId')
    expect(reconnect).toContain('await runWorkbenchSessionReconnect({')
    expect(reconnect).toContain('workbenchReconnectAttachmentTarget(session.chatId, chatId)')
    expect(reconnect).toContain('attach: (session, chatId, isCurrent) => attachSession(session, true, isCurrent, workbenchReconnectAttachmentTarget(session.chatId, chatId))')
    expect(reconnect).toContain('if (isTargetCurrent()) closeShellHistory()')
    expect(reconnect).not.toContain('attachSession(session, true, () => true, session.chatId)')
  })

  it('gates Bastion launch completion and cleanup by the current workbench operation', () => {
    const view = readFileSync(new URL('../../../src/renderer/src/views/WorkbenchView.vue', import.meta.url), 'utf8')

    expect(view).toContain('if (!workbenchOperations.isCurrent(operationGeneration)) return')
    expect(view).toContain('if (workbenchOperations.isCurrent(operationGeneration)) bastionLoading.value = false')
    expect(view).toMatch(/bastionLoading\.value = false\r?\n {2}showConnection\.value = false/)
  })

  it('clears superseded Bastion loading before opening a modal or direct session', () => {
    const view = readFileSync(new URL('../../../src/renderer/src/views/WorkbenchView.vue', import.meta.url), 'utf8')
    const connect = view.slice(view.indexOf('async function connect'), view.indexOf('function createConnection'))
    const createConnection = view.slice(view.indexOf('function createConnection'), view.indexOf('function editSavedProfile'))

    expect(connect.indexOf('bastionLoading.value = false')).toBeGreaterThanOrEqual(0)
    expect(connect.indexOf('bastionLoading.value = false')).toBeLessThan(connect.indexOf('runWorkbenchSessionOpen'))
    expect(createConnection.indexOf('bastionLoading.value = false')).toBeGreaterThanOrEqual(0)
    expect(createConnection.indexOf('bastionLoading.value = false')).toBeLessThan(createConnection.indexOf('showConnection.value = true'))
  })

  it('uses one atomic batch request before removing a chat with running sessions', () => {
    const view = readFileSync(new URL('../../../src/renderer/src/views/WorkbenchView.vue', import.meta.url), 'utf8')

    expect(view).toContain('window.terminalAgent.chats.transferSessions({')
    expect(view).toContain('sourceChatId: chatId')
    expect(view).not.toContain('for (const sessionId of sessionIds)')
  })

  it('creates a missing fallback only inside the atomic transfer request', () => {
    const view = readFileSync(new URL('../../../src/renderer/src/views/WorkbenchView.vue', import.meta.url), 'utf8')
    const removeChat = view.slice(view.indexOf('async function removeChat'), view.indexOf('async function attachSession'))

    expect(removeChat).not.toContain('await createChat(false)')
    expect(removeChat).toContain('...(target ? { targetChatId: target.id } : {})')
    expect(removeChat).toContain('await selectChat(snapshot.chat.id, false, isCurrent)')
  })

  it('abandons stale remove recovery after newer workbench navigation', () => {
    const view = readFileSync(new URL('../../../src/renderer/src/views/WorkbenchView.vue', import.meta.url), 'utf8')
    const removeChat = view.slice(view.indexOf('async function removeChat'), view.indexOf('async function attachSession'))

    expect(removeChat).toContain('const operationGeneration = workbenchOperations.begin()')
    expect(removeChat).toContain('const isCurrent = () => workbenchOperations.isCurrent(operationGeneration)')
    expect(removeChat).toContain('await selectChat(target.id, false, isCurrent)')
    expect(removeChat).toMatch(/transferSessions\([\s\S]*?\)\r?\n {6}if \(!isCurrent\(\)\) return/)
    expect(removeChat).toContain('await chatStore.remove(chatId, isCurrent)')
    expect(removeChat).toMatch(/await chatStore\.remove\(chatId, isCurrent\)\r?\n {4}if \(!isCurrent\(\)\) return/)
    expect(removeChat).toMatch(/catch \(error\) \{\r?\n {4}if \(!isCurrent\(\)\) return/)
  })

  it('atomically binds a generic opened event without making it navigate', () => {
    const view = readFileSync(new URL('../../../src/renderer/src/views/WorkbenchView.vue', import.meta.url), 'utf8')
    const attachSession = view.slice(view.indexOf('async function attachSession'), view.indexOf('async function close('))
    const openedHandler = view.slice(view.indexOf('unsubscribeOpened ='), view.indexOf('unsubscribeUpdated ='))

    expect(view).toContain('const bindingSessions = new Map<string, Promise<ChatWorkspace>>()')
    expect(attachSession).toContain('let binding = bindingSessions.get(session.id)')
    expect(attachSession).toContain('await chatStore.waitForPendingCreate()')
    expect(attachSession).toContain('const workspace = await binding')
    expect(view).toContain("shell.status === 'open' && shell.sessionId")
    expect(attachSession).toContain('const chatId = activeWorkbenchChatId.value ?? crypto.randomUUID()')
    expect(attachSession).not.toContain('ensureLiveChat')
    expect(attachSession).toContain('await selectChat(workspace.id, false, isCurrent)')
    expect(attachSession).toContain('(activate || !chatStore.state.selectedId) && isCurrent()')
    expect(openedHandler).toContain('const visibleLiveChatId = isLiveChat.value ? chatStore.state.selectedId : null')
    expect(openedHandler).toContain('chatStore.state.selectedId === capturedTargetChatId')
    expect(openedHandler).toContain('handleOpenedSession(session)')
  })

  it('captures direct and bastion attachment targets before asynchronous open completes', () => {
    const view = readFileSync(new URL('../../../src/renderer/src/views/WorkbenchView.vue', import.meta.url), 'utf8')
    const connect = view.slice(view.indexOf('async function connect'), view.indexOf('function createConnection'))
    const bastion = view.slice(view.indexOf('async function launchBastion'), view.indexOf('function selectPrivateKey'))

    expect(connect).toContain('const targetChatId = activeWorkbenchChatId.value')
    expect(connect).toContain('targetChatId,')
    expect(connect).toContain('capturedTargetChatId')
    expect(bastion).toContain('const targetChatId = activeWorkbenchChatId.value')
    expect(bastion).toContain('attachSession(session, true, () => workbenchOperations.isCurrent(operationGeneration), (session as SessionView & { chatId?: string }).chatId ?? targetChatId ?? undefined)')
  })

  it('keeps an opened event on its captured task when selection changes during the open', async () => {
    const { workbenchOpenedAttachmentTarget } = await import('../../../src/renderer/src/stores/chat-workspaces')
    let selected = 'history-task'
    const captured = workbenchOpenedAttachmentTarget(undefined, selected, selected)
    selected = 'other-task'

    expect(workbenchOpenedAttachmentTarget(undefined, captured, selected)).toBe('history-task')
  })

  it('starts the workbench on a fresh task after restoring persisted Shell ownership', () => {
    const view = readFileSync(new URL('../../../src/renderer/src/views/WorkbenchView.vue', import.meta.url), 'utf8')
    const initialize = view.slice(view.indexOf('async function initializeWorkbench'), view.indexOf('function restoreAssociatedShellView'))

    expect(initialize).toContain('initializeWorkbenchTask({')
    expect(initialize).toContain('load: () => chatStore.load()')
    expect(initialize).toContain('restore: async () =>')
    expect(initialize).toContain('create: () => createChat(false)')
  })

  it('makes the left sidebar a task-only navigation surface with task actions', () => {
    const source = readFileSync(new URL('../../../src/renderer/src/components/workbench/WorkbenchSessionSidebar.vue', import.meta.url), 'utf8')

    expect(source).toContain('ChatSummary')
    expect(source).toContain("create: []")
    expect(source).toContain("select: [chatId: string]")
    expect(source).toContain("remove: [chatId: string]")
    expect(source).toContain('renameTask')
    expect(source).toContain('pinTask')
    expect(source).toContain('unpinTask')
    expect(source).toContain('暂无任务')
    expect(source).toContain('input?.select()')
    expect(source).not.toContain('SessionView')
    expect(source).not.toContain('新建 SSH 连接')
  })

  it('shows the selected durable title while the live workspace reports current Shell count', () => {
    const view = readFileSync(new URL('../../../src/renderer/src/views/WorkbenchView.vue', import.meta.url), 'utf8')
    const shell = readFileSync(new URL('../../../src/renderer/src/components/workbench/WorkbenchShell.vue', import.meta.url), 'utf8')

    expect(view).toContain(':current-chat-title="chatStore.state.selected?.title')
    expect(view).toContain(':current-chat-shell-count="isLiveChat ? currentChatSessions.length : 0"')
    expect(view).toContain(':shell-count="isLiveChat ? currentChatSessions.length')
    expect(view).toContain(':shell-count="isLiveChat ? currentChatSessions.length : 0"')
    expect(shell).toContain('{{ currentChatTitle }}')
    expect(shell).toContain('{{ currentChatShellCount }} 个 Shell')
    expect(view).not.toContain('sessions.length }} 个 Shell')
  })

})
