import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { ChatRepository } from '../../src/main/chat/chat-repository'
import { ChatRuntime, type ChatRuntimeEvent } from '../../src/main/chat/chat-runtime'
import { buildChatContext } from '../../src/main/chat/chat-context-builder'

describe('global chat integration', () => {
  it('streams model output unchanged through a real repository and restores it after reload', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-chat-integration-'))
    try {
      const path = join(directory, 'chat-workspaces.json')
      const repository = new ChatRepository(path, { createId: (() => { let n = 0; return () => `message-${++n}` })() })
      const chat = (await repository.create({ requestId: 'create-integration' })).value
      const events: ChatRuntimeEvent[] = []
      const genericOpenAiToken = 'sk-' + 'A'.repeat(32)
      const runtime = new ChatRuntime({
        appendMessage: async request => ({ messageId: (await repository.appendMessage(request)).value.messages.at(-1)?.id }),
        updateMessage: request => repository.updateMessage(request),
        getRetryMessageId: (chatId, content) => repository.findRetryMessage(chatId, content),
        getContext: async chatId => {
          const workspace = await repository.get(chatId)
          return buildChatContext({ messages: workspace.messages })
        },
        resolveModel: async () => ({ endpoint: 'fake://model', model: 'fake', contextLimit: 4_000, apiKey: null }),
        stream: async (_settings, _messages, onDelta) => {
          onDelta('你好')
          onDelta('，世界')
          onDelta(' glpat-' + '0'.repeat(20))
          onDelta(' ' + genericOpenAiToken.slice(0, 3))
          onDelta(genericOpenAiToken.slice(3, 14))
          onDelta(genericOpenAiToken.slice(14) + ' done')
        },
      })

      await runtime.send({ chatId: chat.id, runId: '77777777-7777-4777-8777-777777777777', content: 'say hello' }, event => events.push(event))
      expect(events.some(event => event.kind === 'chat:delta' && event.content.includes('你好'))).toBe(true)
      expect(events.some(event => event.kind === 'chat:completed')).toBe(true)
      expect(JSON.stringify(events)).toContain(genericOpenAiToken)
      const restarted = new ChatRepository(path)
      const restored = await restarted.get(chat.id)
      expect(restored.messages).toHaveLength(2)
      expect(restored.messages[0]).toMatchObject({ role: 'user', content: 'say hello', state: 'complete' })
      expect(restored.messages[1]).toMatchObject({ role: 'assistant', state: 'complete' })
      expect(JSON.stringify(restored)).toContain('glpat-')
      expect(JSON.stringify(restored)).toContain(genericOpenAiToken)
      expect(JSON.parse(await readFile(path, 'utf8')).messages).toHaveLength(2)
      await expect(readFile(path, 'utf8')).resolves.toContain(genericOpenAiToken)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.each(['user append', 'model resolution', 'context loading'] as const)('durably restores a non-retryable cancellation when cancelled during %s before streaming starts', async phase => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-chat-pre-placeholder-cancel-'))
    try {
      const path = join(directory, 'chat-workspaces.json')
      const repository = new ChatRepository(path, { createId: (() => { let n = 0; return () => `message-${++n}` })() })
      const chat = (await repository.create({ requestId: `create-pre-placeholder-${phase}` })).value
      const block = deferred<void>()
      let signalBlockedStage!: () => void
      const blockedStage = new Promise<void>(resolve => { signalBlockedStage = resolve })
      const appendMessage = async (request: { requestId: string; chatId: string; role: 'user' | 'assistant'; content: string; state: 'complete' | 'streaming' | 'error' }) => {
        if (phase === 'user append' && request.role === 'user') {
          signalBlockedStage()
          await block.promise
        }
        return { messageId: (await repository.appendMessage(request)).value.messages.at(-1)?.id }
      }
      const resolveModel = async () => {
        if (phase === 'model resolution') {
          signalBlockedStage()
          await block.promise
        }
        return { endpoint: 'fake://model', model: 'fake', contextLimit: 4_000, apiKey: null }
      }
      const getContext = async (chatId: string) => {
        if (phase === 'context loading') {
          signalBlockedStage()
          await block.promise
        }
        return buildChatContext({ messages: (await repository.get(chatId)).messages })
      }
      const events: ChatRuntimeEvent[] = []
      const stream = async () => undefined
      const runtime = new ChatRuntime({ appendMessage, updateMessage: request => repository.updateMessage(request), getContext, resolveModel, stream })
      const runId = `pre-placeholder-${phase.replace(' ', '-')}`

      const sending = runtime.send({ chatId: chat.id, runId, content: 'cancel before placeholder' }, event => events.push(event))
      await blockedStage
      const cancelling = runtime.cancel(chat.id)
      block.resolve()
      await Promise.all([sending, cancelling])

      const restored = await new ChatRepository(path).get(chat.id)
      const cancelled = restored.messages.find(message => message.role === 'assistant' && message.content === '已取消。')
      expect(restored.messages).toContainEqual(expect.objectContaining({ role: 'user', content: 'cancel before placeholder', state: 'complete' }))
      expect(cancelled).toMatchObject({ role: 'assistant', state: 'error', retryable: false })
      expect(events).toContainEqual({ kind: 'chat:error', chatId: chat.id, runId, messageId: cancelled?.id ?? '', error: '已取消。', retryable: false })
      await expect(new ChatRepository(path).findRetryMessage(chat.id, 'cancel before placeholder')).resolves.toBeUndefined()
      expect(await readFile(path, 'utf8')).toContain('已取消。')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('retries a persisted assistant error without duplicating the user message', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-chat-retry-integration-'))
    try {
      const path = join(directory, 'chat-workspaces.json')
      const repository = new ChatRepository(path, { createId: (() => { let n = 0; return () => `message-${++n}` })() })
      const chat = (await repository.create({ requestId: 'create-retry-integration' })).value
      let attempts = 0
      const runtime = new ChatRuntime({
        appendMessage: async request => ({ messageId: (await repository.appendMessage(request)).value.messages.at(-1)?.id }),
        updateMessage: request => repository.updateMessage(request),
        getRetryMessageId: (chatId, content) => repository.findRetryMessage(chatId, content),
        getContext: async chatId => buildChatContext({ messages: (await repository.get(chatId)).messages }),
        resolveModel: async () => ({ endpoint: 'fake://model', model: 'fake', contextLimit: 4_000, apiKey: null }),
        stream: async () => { attempts += 1; if (attempts === 1) throw new Error('network unavailable') },
      })
      const firstEvents: ChatRuntimeEvent[] = []
      await runtime.send({ chatId: chat.id, runId: '88888888-8888-4888-8888-888888888888', content: 'retry this' }, event => firstEvents.push(event))
      expect(firstEvents.some(event => event.kind === 'chat:error' && event.retryable)).toBe(true)
      await expect(repository.findRetryMessage(chat.id, 'retry this')).resolves.toBeDefined()
      await runtime.send({ chatId: chat.id, runId: '99999999-9999-4999-8999-999999999999', content: 'retry this', retry: true }, () => undefined)
      const restored = await new ChatRepository(path).get(chat.id)
      expect(restored.messages.filter(message => message.role === 'user')).toHaveLength(1)
      expect(restored.messages.at(-1)).toMatchObject({ role: 'assistant', state: 'complete' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('persists the retry user before calling the model when the initial user write failed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-chat-retry-user-persistence-'))
    try {
      const path = join(directory, 'chat-workspaces.json')
      const repository = new ChatRepository(path, { createId: (() => { let n = 0; return () => `message-${++n}` })() })
      const chat = (await repository.create({ requestId: 'create-retry-user-persistence' })).value
      const firstRunId = '12121212-1212-4121-8121-121212121212'
      const retryRunId = '13131313-1313-4131-8131-131313131313'
      let rejectInitialUser = true
      let modelCalls = 0
      const appendRequests: Array<{ requestId: string; role: 'user' | 'assistant'; content: string; state: 'complete' | 'streaming' | 'error' }> = []
      const modelContexts: Array<readonly { role: string; content: string }[]> = []
      const resolveModel = async () => {
        modelCalls += 1
        return { endpoint: 'fake://model', model: 'fake', contextLimit: 4_000, apiKey: null }
      }
      const runtime = new ChatRuntime({
        appendMessage: async request => {
          appendRequests.push(request)
          if (request.role === 'user' && rejectInitialUser) {
            rejectInitialUser = false
            throw new Error('synthetic initial user storage error')
          }
          return { messageId: (await repository.appendMessage(request)).value.messages.at(-1)?.id }
        },
        updateMessage: request => repository.updateMessage(request),
        getRetryMessageId: (chatId, content) => repository.findRetryMessage(chatId, content),
        getContext: async chatId => buildChatContext({ messages: (await repository.get(chatId)).messages }),
        resolveModel,
        stream: async (_settings, messages, onDelta) => {
          modelContexts.push(messages)
          onDelta('recovered after durable retry user')
        },
      })

      await runtime.send({ chatId: chat.id, runId: firstRunId, content: 'retry after user storage failure' }, () => undefined)
      await runtime.send({ chatId: chat.id, runId: retryRunId, content: 'retry after user storage failure', retry: true }, () => undefined)

      const restored = await new ChatRepository(path).get(chat.id)
      const users = appendRequests.filter(request => request.role === 'user')
      expect(users).toEqual([
        expect.objectContaining({ requestId: `${firstRunId}:user`, content: 'retry after user storage failure' }),
        expect.objectContaining({ requestId: `${retryRunId}:user`, content: 'retry after user storage failure' }),
      ])
      expect(modelCalls).toBe(1)
      expect(modelContexts).toHaveLength(1)
      expect(modelContexts[0]).toContainEqual(expect.objectContaining({ role: 'user', content: 'retry after user storage failure' }))
      expect(restored.messages).toEqual([
        expect.objectContaining({ role: 'assistant', state: 'error', content: '聊天暂时无法保存，请稍后重试。' }),
        expect.objectContaining({ role: 'user', state: 'complete', content: 'retry after user storage failure' }),
        expect.objectContaining({ role: 'assistant', state: 'complete', content: 'recovered after durable retry user' }),
      ])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('does not write a late callback from a superseded provider run to the durable chat', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-chat-superseded-run-'))
    try {
      const path = join(directory, 'chat-workspaces.json')
      const repository = new ChatRepository(path, { createId: (() => { let n = 0; return () => `message-${++n}` })() })
      const chat = (await repository.create({ requestId: 'create-superseded-run' })).value
      const events: ChatRuntimeEvent[] = []
      let releaseOldRun: (() => void) | undefined
      let oldCallback: ((content: string) => void) | undefined
      let signalOldRunStarted: (() => void) | undefined
      const oldRunStarted = new Promise<void>(resolve => { signalOldRunStarted = resolve })
      const oldRunCanFinish = new Promise<void>(resolve => { releaseOldRun = resolve })
      let streamCount = 0
      const runtime = new ChatRuntime({
        appendMessage: async request => ({ messageId: (await repository.appendMessage(request)).value.messages.at(-1)?.id }),
        updateMessage: request => repository.updateMessage(request),
        getContext: async chatId => buildChatContext({ messages: (await repository.get(chatId)).messages }),
        resolveModel: async () => ({ endpoint: 'fake://model', model: 'fake', contextLimit: 4_000, apiKey: null }),
        stream: async (_settings, _messages, onDelta) => {
          streamCount += 1
          if (streamCount === 1) {
            oldCallback = onDelta
            signalOldRunStarted?.()
            await oldRunCanFinish
            return
          }
          onDelta('fresh response')
        },
      })

      const staleRunId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      const activeRunId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      const staleRun = runtime.send({ chatId: chat.id, runId: staleRunId, content: 'old request' }, event => events.push(event))
      await oldRunStarted
      await runtime.send({ chatId: chat.id, runId: activeRunId, content: 'new request' }, event => events.push(event))
      oldCallback?.('late stale result')
      releaseOldRun?.()
      await staleRun

      const serialized = JSON.stringify(await new ChatRepository(path).get(chat.id)) + await readFile(path, 'utf8')
      expect(JSON.stringify(events)).not.toContain(staleRunId)
      expect(serialized).not.toContain('late stale result')
      expect(JSON.stringify(events)).toContain(activeRunId)
      expect(serialized).toContain('fresh response')
      expect((await new ChatRepository(path).get(chat.id)).messages.some(message => message.state === 'streaming')).toBe(false)
      expect((await new ChatRepository(path).get(chat.id)).messages).toContainEqual(expect.objectContaining({ role: 'assistant', content: '已取消。', state: 'error' }))
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}
