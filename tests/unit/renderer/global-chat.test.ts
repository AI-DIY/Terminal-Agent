import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { shouldSendOnPlainEnter } from '../../../src/renderer/src/components/chat/chat-composer-shortcuts'
import { createGlobalChatStore, hasVisibleAssistantError } from '../../../src/renderer/src/stores/global-chat'

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

    const panel = readFileSync(new URL('../../../src/renderer/src/components/chat/GlobalChatPanel.vue', import.meta.url), 'utf8')
    expect(panel).toContain('function onKeydown(event: KeyboardEvent): void { if (shouldSendOnPlainEnter(event)) { event.preventDefault(); send() } }')
  })

  it('anchors active progress below the user message that started the matching task run', async () => {
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
    expect(panel).toContain("const runUserMessageId = computed(() => chatId.value ? store.state.runUserMessageIds[chatId.value] ?? null : null)")
    expect(panel).toContain("v-if=\"message.role === 'user' && message.id === runUserMessageId && progress\"")
    expect(panel).not.toContain('<section v-if="progress" class="progress-item"')
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

  it('does not retry terminal cancellation or read-only history', async () => {
    const transport = api()
    const store = createGlobalChatStore(transport)
    store.hydrate('cancelled', [
      { id: 'user', role: 'user', content: 'cancelled question', state: 'complete' },
      { id: 'assistant', role: 'assistant', content: '已取消。', state: 'error', retryable: false },
    ])
    store.hydrate('history', [{ id: 'saved', role: 'user', content: 'read only', state: 'complete' }], true)

    await store.retry('cancelled')
    await store.send('history', 'new request')
    expect(transport.send).not.toHaveBeenCalled()
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

  it('renders plan targets from the same user-facing Shell labels as the terminal', () => {
    const panel = readFileSync(new URL('../../../src/renderer/src/components/chat/GlobalChatPanel.vue', import.meta.url), 'utf8')

    expect(panel).toContain('function planTargetLabel(target: string)')
    expect(panel).toContain('{{ planTargetLabel(step.target) }}')
    expect(panel).toContain('hostnameDisplayLabels')
    expect(panel).toContain('个在线 SSH')
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
