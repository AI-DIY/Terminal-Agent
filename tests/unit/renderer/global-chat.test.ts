import { describe, expect, it, vi } from 'vitest'
import { createGlobalChatStore } from '../../../src/renderer/src/stores/global-chat'

function api() {
  return {
    send: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    onEvent: vi.fn(() => () => undefined),
  }
}

describe('global chat store', () => {
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

  it('surfaces a terminal status when durable cancellation fails', async () => {
    const transport = api()
    transport.cancel.mockRejectedValueOnce(new Error('disk full'))
    const store = createGlobalChatStore(transport)
    store.beginRun('c1', 'r1')
    store.apply({ kind: 'chat:progress', chatId: 'c1', runId: 'r1', stage: 'thinking' })

    await store.cancel('c1')
    expect(store.state.runs.c1).toBeNull()
    expect(store.state.progress.c1).toBeNull()
    expect(store.state.errors.c1).toBe('取消状态未能保存，请重新加载后确认。')
    expect(store.canRetry('c1')).toBe(false)
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
