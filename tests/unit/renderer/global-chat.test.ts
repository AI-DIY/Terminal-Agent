import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { ChatWorkspaceSnapshot } from '../../../src/shared/contracts'
import { shouldInsertNewlineOnModifiedEnter, shouldSendOnPlainEnter } from '../../../src/renderer/src/components/chat/chat-composer-shortcuts'
import { createGlobalChatStore, hasVisibleAssistantError } from '../../../src/renderer/src/stores/global-chat'
import { runChatActionWithSkillGate } from '../../../src/renderer/src/stores/skill-capability'

function api() {
  return {
    send: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    onEvent: vi.fn(() => () => undefined),
  }
}

describe('global chat store', () => {
  it('identifies an assistant error already rendered in the message list', () => {
    const messages = [
      { role: 'user' as const, content: 'request', state: 'complete' as const },
      { role: 'assistant' as const, content: '已取消。', state: 'error' as const },
    ]

    expect(hasVisibleAssistantError(messages, '已取消。')).toBe(true)
    expect(hasVisibleAssistantError(messages, '另一个错误')).toBe(false)
  })

  it('does not suppress a standalone error for matching non-error message content', () => {
    const error = '取消状态未能保存，请重新加载后确认。'

    expect(hasVisibleAssistantError([{ role: 'user', content: error, state: 'complete' }], error)).toBe(false)
    expect(hasVisibleAssistantError([{ role: 'assistant', content: error, state: 'complete' }], error)).toBe(false)
    expect(hasVisibleAssistantError([{ role: 'assistant', content: error, state: 'streaming' }], error)).toBe(false)
    expect(hasVisibleAssistantError([], error)).toBe(false)
  })

  it('announces newly delivered error events without reannouncing hydrated history', () => {
    const store = createGlobalChatStore(api())
    const announcements: Array<{ chatId: string; content: string }> = []
    store.onErrorAnnouncement(announcement => announcements.push(announcement))

    store.hydrate('c1', [
      { id: 'saved', role: 'assistant', content: '历史错误', state: 'error', retryable: false },
    ])
    expect(announcements).toEqual([])

    store.beginRun('c1', 'r1')
    store.apply({ kind: 'chat:error', chatId: 'c1', runId: 'r1', messageId: 'm1', error: '新的运行时错误', retryable: false })
    expect(announcements).toEqual([{ chatId: 'c1', content: '新的运行时错误' }])

    store.hydrate('c1', [
      { id: 'saved', role: 'assistant', content: '新的运行时错误', state: 'error', retryable: false },
    ])
    expect(announcements).toEqual([{ chatId: 'c1', content: '新的运行时错误' }])
  })

  it('announces newly completed assistant replies without reannouncing hydrated history', () => {
    const store = createGlobalChatStore(api())
    const announcements: Array<{ chatId: string; content: string }> = []
    store.onAssistantAnnouncement(announcement => announcements.push(announcement))

    store.hydrate('c1', [
      { id: 'saved', role: 'assistant', content: '历史回复', state: 'complete' },
    ])
    expect(announcements).toEqual([])

    store.beginRun('c1', 'r1')
    store.apply({ kind: 'chat:completed', chatId: 'c1', runId: 'r1', messageId: 'm1', content: '{"version":1,"reply":"新的回复","plan":null}' })
    expect(announcements).toEqual([{ chatId: 'c1', content: '{"version":1,"reply":"新的回复","plan":null}' }])

    store.hydrate('c1', [
      { id: 'saved', role: 'assistant', content: '新的回复', state: 'complete' },
    ])
    expect(announcements).toEqual([{ chatId: 'c1', content: '{"version":1,"reply":"新的回复","plan":null}' }])
  })

  it('uses pre-mounted current-task live announcers while preserving visible task-scoped errors', () => {
    const panel = readFileSync(new URL('../../../src/renderer/src/components/chat/GlobalChatPanel.vue', import.meta.url), 'utf8')

    expect(panel).toContain("const disposeErrorAnnouncement = store.onErrorAnnouncement(announcement => {")
    expect(panel).toContain('if (announcement.chatId !== chatId.value) return')
    expect(panel).toContain("const disposeAssistantAnnouncement = store.onAssistantAnnouncement(announcement => {")
    expect(panel).toMatch(/if \(announcement\.chatId !== chatId\.value\) return\r?\n[ ]{2}announceAssistantResponse\(assistantReply\(announcement\.content\)\)/)
    expect(panel).toContain('<div class="messages">')
    expect(panel).not.toContain(':aria-live="message.role === \'assistant\' && message.state !== \'error\' ? \'polite\' : undefined"')
    expect(panel).toContain('<p class="visually-hidden-alert" role="status" aria-live="polite" aria-atomic="true"><span :key="assistantResponse?.id">{{ assistantResponse?.content ?? \'\' }}</span></p>')
    expect(panel).toContain('<p class="visually-hidden-alert" role="alert" aria-atomic="true"><span :key="assertiveError?.id">{{ assertiveError?.content ?? \'\' }}</span></p>')
    expect(panel).toContain('if (!error || hasVisibleAssistantError(messages.value, error)) return \'\'')
    expect(panel).toContain('const actionErrors = reactive<Record<string, string>>({})')
    expect(panel).toContain('const actionError = computed(() => chatId.value ? actionErrors[chatId.value] ?? \'\' : \'\')')
    expect(panel).toContain('function reportActionError(actionChatId: string, error: unknown, fallback: string): void {')
    expect(panel).toContain('if (actionChatId !== chatId.value) return')
    expect(panel).toContain('<p v-if="standaloneError" class="error">{{ standaloneError }}</p>')
    expect(panel).toContain('<p v-if="actionError" class="error">{{ actionError }}</p>')
    expect(panel).not.toContain('<p v-if="standaloneError" class="error" role="alert">')
    expect(panel).not.toContain('<p v-if="actionError" class="error" role="alert">')
  })

  it('sends only plain Enter and leaves modified or composing Enter for textarea newlines', () => {
    const plainEnter = { key: 'Enter', isComposing: false, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false }

    expect(shouldSendOnPlainEnter(plainEnter)).toBe(true)
    expect(shouldSendOnPlainEnter({ ...plainEnter, isComposing: true })).toBe(false)
    expect(shouldSendOnPlainEnter({ ...plainEnter, shiftKey: true })).toBe(false)
    expect(shouldSendOnPlainEnter({ ...plainEnter, ctrlKey: true })).toBe(false)
    expect(shouldSendOnPlainEnter({ ...plainEnter, altKey: true })).toBe(false)
    expect(shouldSendOnPlainEnter({ ...plainEnter, metaKey: true })).toBe(false)
    expect(shouldSendOnPlainEnter({ ...plainEnter, key: 'a' })).toBe(false)

    expect(shouldInsertNewlineOnModifiedEnter({ ...plainEnter, shiftKey: true })).toBe(true)
    expect(shouldInsertNewlineOnModifiedEnter({ ...plainEnter, ctrlKey: true })).toBe(true)
    expect(shouldInsertNewlineOnModifiedEnter({ ...plainEnter, altKey: true })).toBe(true)
    expect(shouldInsertNewlineOnModifiedEnter({ ...plainEnter, shiftKey: true, isComposing: true })).toBe(false)
    expect(shouldInsertNewlineOnModifiedEnter({ ...plainEnter, shiftKey: true, metaKey: true })).toBe(false)

    const panel = readFileSync(new URL('../../../src/renderer/src/components/chat/GlobalChatPanel.vue', import.meta.url), 'utf8')
    expect(panel).toContain('shouldInsertNewlineOnModifiedEnter(event)')
    expect(panel).toContain('function onKeydown(event: KeyboardEvent): void {')
  })

  it('renders active progress as an independent assistant-side status item', async () => {
    const transport = api()
    const store = createGlobalChatStore(transport)

    await store.send('task-a', 'first question')
    await store.send('task-b', 'second question')
    const taskARunId = store.state.runs['task-a']!
    const taskBRunId = store.state.runs['task-b']!
    const taskAUserMessageId = store.state.messages['task-a']![0].id
    const taskBUserMessageId = store.state.messages['task-b']![0].id

    store.apply({ kind: 'chat:progress', chatId: 'task-a', runId: taskARunId, stage: 'thinking' })
    store.apply({ kind: 'chat:progress', chatId: 'task-b', runId: taskBRunId, stage: 'executing' })

    expect(store.state.runUserMessageIds).toMatchObject({
      'task-a': taskAUserMessageId,
      'task-b': taskBUserMessageId,
    })
    expect(store.state.progress).toMatchObject({ 'task-a': 'thinking', 'task-b': 'executing' })

    store.apply({ kind: 'chat:completed', chatId: 'task-a', runId: taskARunId, messageId: 'answer-a', content: 'done' })
    expect(store.state.runUserMessageIds['task-a']).toBeNull()
    expect(store.state.runUserMessageIds['task-b']).toBe(taskBUserMessageId)

    const panel = readFileSync(new URL('../../../src/renderer/src/components/chat/GlobalChatPanel.vue', import.meta.url), 'utf8')
    expect(panel).not.toContain('const runUserMessageId = computed(')
    expect(panel).toContain('<article v-if="progress" class="message assistant progress-message">')
    expect(panel).toContain('<section class="progress-item" role="status" aria-live="polite"')
    expect(panel).toContain('<i /><i /><i /><i />')
    expect(panel).toContain('container-type: inline-size')
    expect(panel).toContain('box-sizing: border-box; width: fit-content')
    expect(panel).toContain('.execution-plan[data-status="partially_executed"]')
    expect(panel).not.toContain("message.role === 'user' && message.id === runUserMessageId")
    expect(panel).not.toContain('<span v-if="running" role="status">正在生成回复</span>')
  })

  it('provides a safe, expandable context-details control from shared usage estimates', () => {
    const panel = readFileSync(new URL('../../../src/renderer/src/components/chat/GlobalChatPanel.vue', import.meta.url), 'utf8')

    expect(panel).toContain("import { estimateChatMessages } from '../../../../shared/chat-token-estimator'")
    expect(panel).toContain('const contextUsed = computed(() => estimateChatMessages(messages.value))')
    expect(panel).toContain('function toggleContextDetails(): void')
    expect(panel).toContain('class="context-toggle"')
    expect(panel).toContain(':aria-expanded="contextDetailsExpanded"')
    expect(panel).toContain('aria-controls="chat-context-details"')
    expect(panel).toContain('v-if="contextDetailsExpanded" id="chat-context-details"')
    expect(panel).not.toContain('立即压缩')
    expect(panel).toContain('function compactContext(): Promise<void>')
    expect(panel).toContain('store.state.compacting[chatId.value]')
  })

  it('keeps transcript cards compact while preserving readable context details', () => {
    const panel = readFileSync(new URL('../../../src/renderer/src/components/chat/GlobalChatPanel.vue', import.meta.url), 'utf8')
    const compactOverride = panel.slice(panel.indexOf('/* Prototype-aligned AI transcript surfaces.'))

    expect(compactOverride).toContain('.messages { padding: 9px 10px 12px;')
    expect(compactOverride).toContain('.message + .message { margin-top: 5px; }')
    expect(compactOverride).toContain('.message-meta strong { font-size: 10px; }')
    expect(compactOverride).toContain('.message p { font-size: 10px; line-height: 1.5; }')
    expect(compactOverride).toContain('.plan-head.plan-heading strong { font-size: 11px; }')
    expect(compactOverride).toContain('.plan-command code { padding: 6px 7px;')
    expect(compactOverride).toContain('.progress-item { min-height: 52px; padding: 8px 9px;')
    expect(compactOverride).toContain('.thinking-copy strong { color: var(--accent); font-size: 11px;')
    expect(compactOverride).toContain('.context-meter-details .context-meter-foot { font-size: 8.5px; }')
    expect(compactOverride).toContain('.context-meter-details .ssh-context-setting { font-size: 9px; }')
    expect(compactOverride).toContain('.context-meter-details .context-host-setting-head,.context-meter-details .context-host-option,.context-meter-details .context-host-empty,.context-meter-details .context-error { font-size: 9px; }')
  })

  it('coalesces streaming transcript auto-scroll work into an animation frame', () => {
    const panel = readFileSync(new URL('../../../src/renderer/src/components/chat/GlobalChatPanel.vue', import.meta.url), 'utf8')

    expect(panel).toContain('let scrollFrame: number | undefined')
    expect(panel).toContain('let scrollPending = false')
    expect(panel).toContain('window.requestAnimationFrame(update)')
    expect(panel).toContain('window.cancelAnimationFrame(scrollFrame)')
  })

  it('memoizes unchanged transcript cards while the composer is receiving input', () => {
    const panel = readFileSync(new URL('../../../src/renderer/src/components/chat/GlobalChatPanel.vue', import.meta.url), 'utf8')

    expect(panel).toContain('v-memo="[message.id, message.role, message.content, message.state, message.retryable, message.messageType, message.executionPlan, props.chat?.shells, props.sessionBusy, stepDraftRevision, planActionRevision]"')
  })

  it('blocks sends and coalesces duplicate compaction requests while preserving the draft', async () => {
    const compactResponse = deferred<ChatWorkspaceSnapshot>()
    const transport = {
      ...api(),
      compact: vi.fn(() => compactResponse.promise),
    }
    const store = createGlobalChatStore(transport)
    store.setDraft('c1', 'queued while compacting')

    const first = store.compact('c1')
    const second = store.compact('c1')
    expect(store.state.compacting.c1).toBe(true)

    await store.send('c1', store.draft('c1'))
    expect(transport.send).not.toHaveBeenCalled()
    expect(store.draft('c1')).toBe('queued while compacting')
    expect(transport.compact).toHaveBeenCalledOnce()

    compactResponse.resolve({
      revision: 2,
      chat: {
        id: 'c1',
        title: '任务',
        titleState: 'new',
        pinnedAt: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        shellCount: 0,
        mode: 'copilot',
        live: true,
        messages: [
          { id: 'u1', chatId: 'c1', role: 'user', content: '历史', createdAt: '2026-01-01T00:00:00.000Z', state: 'complete' },
          { id: 'summary', chatId: 'c1', role: 'system', content: '摘要', createdAt: '2026-01-01T00:00:00.000Z', state: 'complete', messageType: 'context_summary' },
        ],
        shells: [],
      },
      liveChatId: 'c1',
    })
    await expect(first).resolves.toMatchObject({ revision: 2 })
    await expect(second).resolves.toMatchObject({ revision: 2 })
    expect(store.state.compacting.c1).toBe(false)
    expect(store.state.messages.c1).toEqual([{ id: 'u1', role: 'user', content: '历史', state: 'complete' }])
  })

  it('clears the compaction guard after an IPC failure so a later send can proceed', async () => {
    const transport = {
      ...api(),
      compact: vi.fn(async () => { throw new Error('network unavailable') }),
    }
    const store = createGlobalChatStore(transport)
    store.setDraft('c1', 'retry after failure')

    await expect(store.compact('c1')).rejects.toThrow('network unavailable')
    expect(store.state.compacting.c1).toBe(false)
    await store.send('c1', store.draft('c1'))
    expect(transport.send).toHaveBeenCalledWith(expect.objectContaining({ content: 'retry after failure' }))
  })

  it('keeps drafts per task and applies only matching stream events', () => {
    const transport = api()
    const store = createGlobalChatStore(transport)
    store.setDraft('c1', 'hello')
    store.setDraft('c2', 'world')
    store.beginRun('c1', 'r1')
    store.apply({ kind: 'chat:delta', chatId: 'c1', runId: 'r1', messageId: 'm1', content: 'A ' })
    store.apply({ kind: 'chat:delta', chatId: 'c1', runId: 'old', messageId: 'old', content: 'OLD' })

    expect(store.state.drafts).toEqual({ c1: 'hello', c2: 'world' })
    expect(store.state.messages.c1).toEqual([{ id: 'm1', role: 'assistant', content: 'A ', state: 'streaming' }])
  })

  it('shares only unsent drafts across remounted stores and clears them on send or empty input', async () => {
    const transport = api()
    const first = createGlobalChatStore(transport)
    first.setDraft('c1', 'draft across settings')

    const remounted = createGlobalChatStore(transport)
    expect(remounted.draft('c1')).toBe('draft across settings')
    expect(remounted.state.messages).toEqual({})
    expect(remounted.state.runs).toEqual({})

    await remounted.send('c1', remounted.draft('c1'))
    expect(first.draft('c1')).toBe('')
    expect(first.state.messages).toEqual({})
    expect(first.state.runs).toEqual({})

    first.setDraft('c1', 'clear me')
    first.setDraft('c1', '')
    expect(remounted.draft('c1')).toBe('')
  })

  it('passes model-facing drafts, history, deltas, and completions through unchanged', async () => {
    const transport = api()
    const store = createGlobalChatStore(transport)
    const content = `token=sk-proj-${'A'.repeat(32)} path=C:\\temp\\agent\\profile.conf`

    store.setDraft('draft', content)
    expect(store.draft('draft')).toBe(content)
    await store.send('draft', content)
    store.hydrate('history', [{ id: 'saved', role: 'user', content, state: 'complete' }])
    store.beginRun('stream', 'run-1')
    store.apply({ kind: 'chat:delta', chatId: 'stream', runId: 'run-1', messageId: 'assistant', content })
    store.apply({ kind: 'chat:completed', chatId: 'stream', runId: 'run-1', messageId: 'assistant', content })

    expect(store.draft('draft')).toBe('')
    expect(transport.send).toHaveBeenCalledWith(expect.objectContaining({ content }))
    expect(store.state.messages.draft?.[0]?.content).toBe(content)
    expect(store.state.messages.history?.[0]?.content).toBe(content)
    expect(store.state.messages.stream?.[0]).toMatchObject({ content, state: 'complete' })
  })

  it('exposes retry for a failed run without adding another user message', async () => {
    const transport = api()
    const store = createGlobalChatStore(transport)
    await store.send('c1', 'retry me')
    const runId = store.state.runs.c1!
    store.apply({ kind: 'chat:error', chatId: 'c1', runId, messageId: 'm1', error: 'timeout', retryable: true })
    await store.retry('c1')

    expect(transport.send).toHaveBeenCalledTimes(2)
    expect(store.state.messages.c1.filter(message => message.role === 'user')).toHaveLength(1)
    expect(transport.send).toHaveBeenLastCalledWith(expect.objectContaining({ content: 'retry me', retry: true }))
    expect(store.state.runUserMessageIds.c1).toBe(store.state.messages.c1.find(message => message.role === 'user')?.id)
  })

  it('hydrates retry state from persisted user and assistant messages', async () => {
    const transport = api()
    const store = createGlobalChatStore(transport)
    store.hydrate('c1', [
      { id: 'user', role: 'user', content: 'persisted request', state: 'complete' },
      { id: 'assistant', role: 'assistant', content: 'failed', state: 'error', retryable: true },
    ])

    expect(store.canRetry('c1')).toBe(true)
    await store.retry('c1')
    expect(transport.send).toHaveBeenCalledWith(expect.objectContaining({ content: 'persisted request', retry: true }))
  })

  it('does not retry terminal cancellation while keeping historical tasks interactive', async () => {
    const transport = api()
    const store = createGlobalChatStore(transport)
    store.hydrate('cancelled', [
      { id: 'user', role: 'user', content: 'cancelled question', state: 'complete' },
      { id: 'assistant', role: 'assistant', content: '已取消。', state: 'error', retryable: false },
    ])
    // The third argument is retained only for compatibility with older
    // renderer callers; historical tasks now use the same interactive chat
    // surface as the live task.
    store.hydrate('history', [{ id: 'saved', role: 'user', content: 'history request', state: 'complete' }], true)

    await store.retry('cancelled')
    await store.send('history', 'new request')
    expect(transport.send).toHaveBeenCalledTimes(1)
    expect(transport.send).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'history', content: 'new request' }))
    expect(store.canRetry('cancelled')).toBe(false)
  })

  it('rejects events whose message id does not belong to the active run', () => {
    const store = createGlobalChatStore(api())
    store.beginRun('c1', 'r1')
    store.apply({ kind: 'chat:delta', chatId: 'c1', runId: 'r1', messageId: 'm1', content: 'first ' })
    store.apply({ kind: 'chat:completed', chatId: 'c1', runId: 'r1', messageId: 'wrong-message', content: 'wrong' })

    expect(store.state.messages.c1).toEqual([{ id: 'm1', role: 'assistant', content: 'first ', state: 'streaming' }])
  })

  it('uses completed content authoritatively after streamed deltas', () => {
    const store = createGlobalChatStore(api())
    store.beginRun('c1', 'r1')
    store.apply({ kind: 'chat:delta', chatId: 'c1', runId: 'r1', messageId: 'm1', content: 'partial ' })
    store.apply({ kind: 'chat:completed', chatId: 'c1', runId: 'r1', messageId: 'm1', content: 'complete content' })

    expect(store.state.messages.c1).toEqual([{ id: 'm1', role: 'assistant', content: 'complete content', state: 'complete' }])
    expect(store.state.runs.c1).toBeNull()
  })

  it('clears transient progress as soon as streamed assistant output begins', () => {
    const store = createGlobalChatStore(api())
    store.beginRun('c1', 'r1')
    store.apply({ kind: 'chat:progress', chatId: 'c1', runId: 'r1', stage: 'thinking' })
    store.apply({ kind: 'chat:delta', chatId: 'c1', runId: 'r1', messageId: 'm1', content: '开始输出' })

    expect(store.state.progress.c1).toBeNull()
    expect(store.state.messages.c1?.[0]).toMatchObject({ content: '开始输出', role: 'assistant' })
  })

  it('rejects ordinary stale events after hydration invalidates a run', () => {
    const store = createGlobalChatStore(api())
    store.beginRun('c1', 'stale-run')
    store.hydrate('c1', [
      { id: 'saved-user', role: 'user', content: 'saved question', state: 'complete' },
      { id: 'saved-answer', role: 'assistant', content: 'saved answer', state: 'complete' },
    ])
    store.apply({ kind: 'chat:delta', chatId: 'c1', runId: 'stale-run', messageId: 'stale', content: 'stale delta' })
    store.apply({ kind: 'chat:error', chatId: 'c1', runId: 'stale-run', messageId: 'stale', error: 'stale error', retryable: true })

    expect(store.state.messages.c1.map(message => message.content)).toEqual(['saved question', 'saved answer'])
    expect(store.state.errors.c1).toBe('')
  })

  it('clears a cancelled run immediately and accepts its authoritative cancellation event', async () => {
    const transport = api()
    const store = createGlobalChatStore(transport)
    store.beginRun('c1', 'r1')
    store.apply({ kind: 'chat:delta', chatId: 'c1', runId: 'r1', messageId: 'm1', content: 'partial' })

    await store.cancel('c1')
    store.apply({ kind: 'chat:error', chatId: 'c1', runId: 'r1', messageId: 'm1', error: '已取消。', retryable: false })

    expect(transport.cancel).toHaveBeenCalledWith('c1')
    expect(store.state.runs.c1).toBeNull()
    expect(store.state.messages.c1?.[0]).toMatchObject({ content: '已取消。', state: 'error' })
  })

  it('projects a structured error event when no assistant delta was published', () => {
    const store = createGlobalChatStore(api())
    store.beginRun('c1', 'r1')
    store.apply({ kind: 'chat:error', chatId: 'c1', runId: 'r1', messageId: 'm1', error: '已取消。', retryable: false })

    expect(store.state.messages.c1).toEqual([
      expect.objectContaining({ id: 'm1', role: 'assistant', content: '已取消。', state: 'error', retryable: false }),
    ])
  })

  it('surfaces a terminal status when durable cancellation fails', async () => {
    const transport = api()
    transport.cancel.mockRejectedValueOnce(new Error('disk full'))
    const store = createGlobalChatStore(transport)
    const announcements: Array<{ chatId: string; content: string }> = []
    store.onErrorAnnouncement(announcement => announcements.push(announcement))
    store.beginRun('c1', 'r1')
    store.apply({ kind: 'chat:progress', chatId: 'c1', runId: 'r1', stage: 'thinking' })

    await store.cancel('c1')
    expect(store.state.runs.c1).toBeNull()
    expect(store.state.progress.c1).toBeNull()
    expect(store.state.errors.c1).toBe('取消状态未能保存，请重新加载后确认。')
    expect(store.canRetry('c1')).toBe(false)
    expect(announcements).toEqual([{ chatId: 'c1', content: '取消状态未能保存，请重新加载后确认。' }])
  })

  it('subscribes once and disposes the event listener', () => {
    const transport = api()
    const unsubscribe = vi.fn()
    transport.onEvent.mockReturnValue(unsubscribe)
    const store = createGlobalChatStore(transport)

    store.dispose()
    expect(transport.onEvent).toHaveBeenCalledOnce()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('keeps structured progress transient and projects completed plans and audits', () => {
    const store = createGlobalChatStore(api())
    store.beginRun('c1', 'r1')
    store.apply({ kind: 'chat:progress', chatId: 'c1', runId: 'r1', stage: 'thinking' })
    expect(store.state.progress.c1).toBe('thinking')

    const plan = {
      id: 'EP-1', title: '检查服务', status: 'pending_review' as const,
      steps: [{ id: 'step-1', target: 'web-02', explanation: '查看状态', originalCommand: 'systemctl status api', sendState: 'pending' as const }],
    }
    store.apply({ kind: 'chat:completed', chatId: 'c1', runId: 'r1', messageId: 'm1', content: '{"version":1,"reply":"准备执行","plan":null}', executionPlan: plan })
    expect(store.state.progress.c1).toBeNull()
    expect(store.state.messages.c1?.[0]?.executionPlan).toEqual(plan)

    store.hydrate('c2', [{ id: 'audit', role: 'user', content: '【执行审计】计划 EP-1 已发送。', state: 'complete', messageType: 'execution_audit' }])
    expect(store.state.messages.c2?.[0]?.messageType).toBe('execution_audit')
  })

  it('syncs durable plan state without replacing the active transcript or draft', () => {
    const store = createGlobalChatStore(api())
    const pendingPlan = {
      id: 'EP-1', title: '检查服务', status: 'pending_review' as const,
      steps: [{ id: 'step-1', target: 'web-02', explanation: '查看状态', originalCommand: 'systemctl status api', sendState: 'pending' as const }],
    }
    store.hydrate('c1', [{
      id: 'plan-message', role: 'assistant', content: '本地保留的回复', state: 'complete', executionPlan: pendingPlan,
    }])
    store.setDraft('c1', '不要覆盖这个草稿')
    store.beginRun('c1', 'run-1')

    store.syncExecutionPlans('c1', [
      {
        id: 'plan-message',
        executionPlan: {
          ...pendingPlan,
          status: 'execution_failed',
          steps: [{ ...pendingPlan.steps[0], sendState: 'not_sent', failure: '计划执行过程中发生未预期错误' }],
        },
      },
      { id: 'later-message' },
    ])

    expect(store.state.messages.c1).toEqual([expect.objectContaining({
      id: 'plan-message',
      content: '本地保留的回复',
      executionPlan: expect.objectContaining({ status: 'execution_failed', steps: [expect.objectContaining({ sendState: 'not_sent' })] }),
    })])
    expect(store.draft('c1')).toBe('不要覆盖这个草稿')
    expect(store.state.runs.c1).toBe('run-1')
  })

  it('keeps Skill progress run-scoped and clears cards on terminal chat events', () => {
    const store = createGlobalChatStore(api())
    const invocationId = '550e8400-e29b-41d4-a716-446655440000'
    store.beginRun('c1', '550e8400-e29b-41d4-a716-446655440001')
    store.apply({
      kind: 'chat:skill', chatId: 'c1', runId: '550e8400-e29b-41d4-a716-446655440001', invocationId,
      skillId: 'echo-hello', stage: 'loading', detail: '加载中',
    })
    expect(store.state.skillEvents.c1).toHaveLength(1)

    // A delayed event from a superseded run cannot resurrect a card.
    store.apply({
      kind: 'chat:skill', chatId: 'c1', runId: '550e8400-e29b-41d4-a716-446655440002', invocationId,
      skillId: 'echo-hello', stage: 'executing', detail: '执行中',
    })
    expect(store.state.skillEvents.c1).toHaveLength(1)

    store.apply({
      kind: 'chat:error', chatId: 'c1', runId: '550e8400-e29b-41d4-a716-446655440001', messageId: 'm1', error: '已取消。', retryable: false,
    })
    expect(store.state.skillEvents.c1).toBeUndefined()
  })

  it('renders plan targets from the same user-facing Shell labels as the terminal', () => {
    const panel = readFileSync(new URL('../../../src/renderer/src/components/chat/GlobalChatPanel.vue', import.meta.url), 'utf8')

    expect(panel).toContain('function planTargetLabel(target: string)')
    expect(panel).toContain('{{ planTargetLabel(step.target) }}')
    expect(panel).toContain("import { planTargetLabelForShells } from './plan-target-label'")
    expect(panel).toContain('return planTargetLabelForShells(target, shells)')
    expect(panel).not.toContain('个在线 SSH')
  })

  it('keeps original commands visible and exposes per-step edit/delete actions before one-step confirmation', () => {
    const panel = readFileSync(new URL('../../../src/renderer/src/components/chat/GlobalChatPanel.vue', import.meta.url), 'utf8')
    const executePlan = panel.slice(panel.indexOf('async function executePlan'), panel.indexOf('onMounted(()'))

    expect(panel).toContain('<span>原始命令</span>')
    expect(panel).toContain('<span>修改后命令（可编辑）</span>')
    expect(panel).toContain('aria-label="删除命令"')
    expect(panel).toContain('@click="removeStep(message.id, step.id)"')
    expect(panel).toContain('store.syncExecutionPlans(id, messages)')
    expect(panel).toContain('停止后续执行')
    expect(panel).toContain('function stepSendStateLabel(state: string)')
    expect(panel).toContain('class="plan-step-failure"')
    expect(executePlan).toContain('for (const step of plan.steps)')
    expect(executePlan).toContain('await editStep(messageId, step.id, command)')
    expect(executePlan).toContain('await runChatActionWithSkillGate(props.skillsAvailable, enabledSkillIds.value, skillIds => (')
    expect(executePlan).toContain('store.executePlan(actionChatId, messageId, selectedContextSessionIds.value, skillIds)')
    expect(executePlan.indexOf('store.executePlan')).toBeGreaterThan(executePlan.indexOf('await editStep'))
    expect(executePlan).not.toContain('window.confirm')
  })

  it('keeps each pending-plan delete control beside and vertically centered on its editable command', () => {
    const panel = readFileSync(new URL('../../../src/renderer/src/components/chat/GlobalChatPanel.vue', import.meta.url), 'utf8')
    const editorStart = panel.indexOf('<div v-if="message.executionPlan.status === \'pending_review\'" class="plan-command-editor">')
    const staticCommandStart = panel.indexOf('<label v-else class="plan-command">', editorStart)
    const editorMarkup = panel.slice(editorStart, staticCommandStart)
    const editorRule = /\.plan-command-editor\s*\{([^}]*)\}/.exec(panel)?.[1] ?? ''
    const editorActionsRule = /\.plan-command-editor \.plan-step-actions\s*\{([^}]*)\}/.exec(panel)?.[1] ?? ''
    const deleteRule = /\.delete-plan-step\s*\{([^}]*)\}/.exec(panel)?.[1] ?? ''

    expect(editorStart).toBeGreaterThan(-1)
    expect(staticCommandStart).toBeGreaterThan(editorStart)
    expect(editorMarkup).toContain('<label class="plan-command">')
    expect(editorMarkup.indexOf('textarea class="plan-edit-input"')).toBeGreaterThan(-1)
    expect(editorMarkup.indexOf('<div class="plan-step-actions">')).toBeGreaterThan(editorMarkup.indexOf('textarea class="plan-edit-input"'))
    expect(editorMarkup.indexOf('class="icon-button delete-plan-step"')).toBeGreaterThan(editorMarkup.indexOf('<div class="plan-step-actions">'))
    expect(panel).not.toContain('<div v-if="message.executionPlan.status === \'pending_review\'" class="plan-step-actions">')

    expect(editorRule).toContain('display: grid')
    expect(editorRule).toContain('grid-template-columns: minmax(0, 1fr) 27px')
    expect(editorRule).toContain('align-items: center')
    expect(editorActionsRule).toContain('align-self: center')
    expect(editorActionsRule).toContain('justify-self: end')
    expect(deleteRule).toContain('border-color: var(--amber-line)')
    expect(deleteRule).toContain('background: var(--amber-soft)')
    expect(deleteRule).toContain('color: var(--amber)')
  })

  it('passes selected SSH connections and enabled skills with sends and compaction', async () => {
    const transport = { ...api(), compact: vi.fn(async () => ({
      revision: 1,
      chat: { id: 'c1', messages: [] },
      liveChatId: 'c1',
    })) }
    const store = createGlobalChatStore(transport)
    store.setSshContextSessionIds('c1', ['primary', 'alternate'])
    await store.send('c1', 'check', undefined, ['security-review'])
    expect(transport.send).toHaveBeenCalledWith(expect.objectContaining({ sshContextSessionIds: ['primary', 'alternate'], skillIds: ['security-review'] }))
    store.hydrate('c1', [{ id: 'u', role: 'user', content: 'check', state: 'complete' }])
    await store.compact('c1', undefined, ['security-review'])
    expect(transport.compact).toHaveBeenCalledWith(expect.objectContaining({ sshContextSessionIds: ['primary', 'alternate'], skillIds: ['security-review'] }))
  })

  it('passes confirmed-plan SSH context to the main process and accepts a trusted automatic run start', async () => {
    const snapshot = {
      revision: 1,
      chat: { id: 'c1', messages: [] },
      liveChatId: 'c1',
    } as unknown as ChatWorkspaceSnapshot
    const transport = {
      ...api(),
      plans: {
        editStep: vi.fn(async () => snapshot),
        removeStep: vi.fn(async () => snapshot),
        cancel: vi.fn(async () => snapshot),
        execute: vi.fn(async () => snapshot),
      },
    }
    const store = createGlobalChatStore(transport)
    store.setSshContextLines(125)
    store.setSshContextSessionIds('c1', ['primary', 'alternate'])

    await store.executePlan('c1', 'plan-message', undefined, ['security-review'])
    expect(transport.plans.execute).toHaveBeenCalledWith(expect.objectContaining({
      chatId: 'c1',
      messageId: 'plan-message',
      sshContextLines: 125,
      sshContextSessionIds: ['primary', 'alternate'],
      skillIds: ['security-review'],
    }))

    store.apply({ kind: 'chat:auto-started', chatId: 'c1', runId: '550e8400-e29b-41d4-a716-446655440000' })
    store.apply({ kind: 'chat:progress', chatId: 'c1', runId: '550e8400-e29b-41d4-a716-446655440000', stage: 'thinking' })
    expect(store.state.runs.c1).toBe('550e8400-e29b-41d4-a716-446655440000')
    expect(store.state.runUserMessageIds.c1).toBeNull()
    expect(store.state.progress.c1).toBe('thinking')

    store.beginRun('c1', 'manual-run')
    store.apply({ kind: 'chat:auto-started', chatId: 'c1', runId: '660e8400-e29b-41d4-a716-446655440000' })
    expect(store.state.runs.c1).toBe('manual-run')

    const panel = readFileSync(new URL('../../../src/renderer/src/components/chat/GlobalChatPanel.vue', import.meta.url), 'utf8')
    expect(panel).toContain('store.executePlan(actionChatId, messageId, selectedContextSessionIds.value, skillIds)')
    expect(panel).toContain('runChatActionWithSkillGate(props.skillsAvailable, enabledSkillIds.value, skillIds => (')
  })

  it('sends empty skill IDs through both chat actions while the renderer gate is disabled', async () => {
    const transport = { ...api(), compact: vi.fn(async () => ({
      revision: 1,
      chat: { id: 'c1', messages: [] },
      liveChatId: 'c1',
    })) }
    const store = createGlobalChatStore(transport)
    const locallyEnabled = ['teleagent-operations', 'security-review'] as const

    await runChatActionWithSkillGate(false, locallyEnabled, skillIds => (
      store.send('c1', 'check', undefined, skillIds)
    ))
    expect(transport.send).toHaveBeenCalledWith(expect.objectContaining({ skillIds: [] }))

    store.hydrate('c1', [{ id: 'u', role: 'user', content: 'check', state: 'complete' }])
    await runChatActionWithSkillGate(false, locallyEnabled, skillIds => (
      store.compact('c1', undefined, skillIds)
    ))
    expect(transport.compact).toHaveBeenCalledWith(expect.objectContaining({ skillIds: [] }))
  })

  it('keeps SSH context opt-in until the user explicitly checks a host', () => {
    const panel = readFileSync(new URL('../../../src/renderer/src/components/chat/GlobalChatPanel.vue', import.meta.url), 'utf8')

    expect(panel).toContain("import { chatContextSessionsAreResolved, normalizeChatContextSessionIds } from '../../../../shared/chat-context-selection'")
    expect(panel).toContain('watch([chatId, associatedContextSessionIds, contextSessionRows], () => {')
    expect(panel).toContain('if (!chatContextSessionsAreResolved(')
    expect(panel).toContain('if (current === undefined && associatedContextSessionIds.value.size === 0) return')
    expect(panel).toContain('persistedContextSelections[id] = []')
    expect(panel).toContain("terminal-agent.ai-context-session-ids.v2")
    expect(panel).toContain('return normalizeChatContextSessionIds(contextSessionRows.value, requested ?? [])')
    expect(panel).not.toContain('defaultChatContextSessionIds(contextSessionRows.value)')
  })

  it('offers safe new-session and session-switch controls in the AI workspace header', () => {
    const panel = readFileSync(new URL('../../../src/renderer/src/components/chat/GlobalChatPanel.vue', import.meta.url), 'utf8')

    expect(panel).toContain("newSession: []")
    expect(panel).toContain("switchSession: [chatId: string]")
    expect(panel).toContain('const canCreateConversationSession = computed(() => messages.value.length > 0')
    expect(panel).toContain('aria-label="新建会话"')
    expect(panel).toContain('aria-label="切换会话"')
    expect(panel).toContain('v-for="session in conversationSessions"')
    expect(panel).toContain('emit(\'newSession\')')
    expect(panel).toContain('emit(\'switchSession\', targetChatId)')
    expect(panel).toContain('defineExpose({ hydrateConversation })')
    expect(panel).toContain("store.hydrate(id, messages, false)")
    expect(panel).not.toContain('void window.terminalAgent.chats.get(id)')
    expect(panel).not.toContain('watch(() => props.conversationSessionVersion')
    expect(panel).toContain("store.setDraft(id, '')")
    expect(panel).toContain('store.setPendingImages(id, [])')
    expect(panel).toContain('if (!actionChatId || props.sessionBusy) return')
  })

  it('composes text-only content while retaining old image records for hydration', () => {
    const store = createGlobalChatStore(api())
    store.setDraft('c1', '  hello  ')
    store.setPendingImages('c1', [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }])
    expect(store.composeUserContent('c1')).toBe('hello')
    store.hydrate('c1', [{ id: 'old', role: 'user', content: [{ type: 'text', text: 'old' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }], state: 'complete' }])
    expect(Array.isArray(store.state.messages.c1?.[0]?.content)).toBe(true)
  })

  it('does not send image parts through direct send or retry APIs', async () => {
    const transport = api()
    const store = createGlobalChatStore(transport)
    await store.send('c1', [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }])
    expect(transport.send).not.toHaveBeenCalled()

    store.hydrate('c2', [
      { id: 'user', role: 'user', content: [{ type: 'text', text: 'old' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }], state: 'complete' },
      { id: 'assistant', role: 'assistant', content: 'failed', state: 'error', retryable: true },
    ])
    await store.retry('c2')
    expect(transport.send).not.toHaveBeenCalled()
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}
