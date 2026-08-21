import { describe, expect, it, vi } from 'vitest'
import { ChatRuntime } from '../../../src/main/chat/chat-runtime'
import type { ChatRuntimeEvent } from '../../../src/main/chat/chat-runtime'

describe('chat runtime', () => {
  it('rejects a pre-placeholder cancellation persistence failure without publishing a provisional message id', async () => {
    const runId = '30303030-3030-4030-8030-303030303030'
    const model = deferred<{ endpoint: string; model: string; contextLimit: number; apiKey: null }>()
    let signalModelResolution!: () => void
    const modelResolutionStarted = new Promise<void>(resolve => { signalModelResolution = resolve })
    const appendMessage = vi.fn(async (request: { role: 'user' | 'assistant' }) => {
      if (request.role === 'user') return { messageId: 'durable-user' }
      throw new Error('synthetic storage error')
    })
    const events: ChatRuntimeEvent[] = []
    const runtime = new ChatRuntime({
      appendMessage,
      getContext: vi.fn(async () => [{ role: 'user' as const, content: 'question' }]),
      resolveModel: vi.fn(async () => {
        signalModelResolution()
        return model.promise
      }),
      stream: vi.fn(async () => undefined),
    })

    const sending = runtime.send({ chatId: 'c1', runId, content: 'question' }, event => events.push(event))
    await modelResolutionStarted
    const cancelling = runtime.cancel('c1')
    model.resolve({ endpoint: 'http://model', model: 'm', contextLimit: 100, apiKey: null })

    await expect(cancelling).rejects.toThrow('聊天暂时无法保存，请稍后重试。')
    await expect(settlesWithin(sending)).resolves.toBeUndefined()
    expect(events).toEqual([])
    expect(appendMessage).toHaveBeenCalledWith(expect.objectContaining({ role: 'user', content: 'question', state: 'complete' }))
    expect(appendMessage).toHaveBeenCalledWith(expect.objectContaining({ role: 'assistant', content: '已取消。', state: 'error' }))
  })

  it('cancels the previous run in the same chat and publishes scoped deltas', async () => {
    const aborts: AbortSignal[] = []
    const events: ChatRuntimeEvent[] = []
    let signalFirstStream!: () => void
    const firstStreamStarted = new Promise<void>(resolve => { signalFirstStream = resolve })
    const runtime = new ChatRuntime({
      appendMessage: vi.fn(async (input: { requestId: string }) => ({ messageId: input.requestId })),
      getContext: vi.fn(async () => [{ role: 'user' as const, content: 'hello' }]),
      stream: vi.fn(async (_settings: unknown, _messages: unknown, onDelta: (text: string) => void, _format: unknown, signal: AbortSignal) => {
        aborts.push(signal)
        if (aborts.length === 1) signalFirstStream()
        await new Promise(resolve => setTimeout(resolve, 5))
        if (signal.aborted) return
        onDelta('ok')
      }),
      resolveModel: vi.fn(async () => ({ endpoint: 'http://model', model: 'm', contextLimit: 100, apiKey: null })),
    })
    const publish = (event: ChatRuntimeEvent) => events.push(event)
    const first = runtime.send({ chatId: 'c1', runId: 'r1', content: 'first' }, publish)
    await firstStreamStarted
    await runtime.send({ chatId: 'c1', runId: 'r2', content: 'second' }, publish)
    await first
    expect(aborts[0].aborted).toBe(true)
    expect(events.every(event => event.chatId === 'c1')).toBe(true)
    expect(events.some(event => event.runId === 'r2' && event.kind === 'chat:completed')).toBe(true)
  })

  it('does not call the provider when a run is superseded during initial user persistence', async () => {
    const firstRunId = '35353535-3535-4535-8535-353535353535'
    const secondRunId = '36363636-3636-4636-8636-363636363636'
    const firstUserAppend = deferred<{ messageId?: string }>()
    let signalFirstUserAppend!: () => void
    const firstUserAppendStarted = new Promise<void>(resolve => { signalFirstUserAppend = resolve })
    const appendMessage = vi.fn((input: { requestId: string; role?: string }) => {
      if (input.requestId === `${firstRunId}:user`) {
        signalFirstUserAppend()
        return firstUserAppend.promise
      }
      return Promise.resolve({ messageId: input.requestId })
    })
    const stream = vi.fn(async (_settings: unknown, _messages: unknown, onDelta: (content: string) => void) => { onDelta('second response') })
    const events: ChatRuntimeEvent[] = []
    const runtime = new ChatRuntime({
      appendMessage,
      getContext: vi.fn(async () => [{ role: 'user' as const, content: 'hello' }]),
      stream,
      resolveModel: vi.fn(async () => ({ endpoint: 'http://model', model: 'm', contextLimit: 100, apiKey: null })),
    })

    const first = runtime.send({ chatId: 'c1', runId: firstRunId, content: 'first' }, event => events.push(event))
    await firstUserAppendStarted
    await runtime.send({ chatId: 'c1', runId: secondRunId, content: 'second' }, event => events.push(event))
    firstUserAppend.resolve({ messageId: `${firstRunId}:user` })
    await first

    expect(stream).toHaveBeenCalledTimes(1)
    expect(events.some(event => event.runId === firstRunId)).toBe(false)
    expect(appendMessage.mock.calls
      .map(([request]) => request)
      .filter(request => request.requestId.startsWith(`${firstRunId}:assistant`)))
      .toEqual([expect.objectContaining({ requestId: `${firstRunId}:assistant:superseded`, content: '已取消。', state: 'error' })])
    expect(events).toContainEqual(expect.objectContaining({ kind: 'chat:completed', runId: secondRunId }))
  })

  it('redacts model credentials before publishing or persisting the assistant response', async () => {
    const appendMessage = vi.fn(async (input: { requestId: string; role?: string; state?: string }) => ({ messageId: input.requestId }))
    const events: ChatRuntimeEvent[] = []
    const runtime = new ChatRuntime({
      appendMessage,
      getContext: vi.fn(async () => [{ role: 'user' as const, content: 'hello' }]),
      stream: vi.fn(async (_settings, _messages, onDelta) => { onDelta('result sk-proj-secret-token ') }),
      resolveModel: vi.fn(async () => ({ endpoint: 'http://model', model: 'm', contextLimit: 100, apiKey: null })),
    })
    await runtime.send({ chatId: 'c1', runId: '11111111-1111-4111-8111-111111111111', content: 'check' }, event => events.push(event))
    expect(JSON.stringify(events)).not.toContain('sk-proj-secret-token')
    expect(JSON.stringify(appendMessage.mock.calls)).not.toContain('sk-proj-secret-token')
  })

  it('redacts credential families and bearer prefixes when values arrive across stream chunks', async () => {
    const appendMessage = vi.fn(async (input: { requestId: string; role?: string }) => ({ messageId: input.requestId }))
    const events: ChatRuntimeEvent[] = []
    const credentials = [
      'glpat-' + '0'.repeat(20),
      'npm_' + '0'.repeat(36),
      'xoxb-' + '0'.repeat(10) + '-' + '0'.repeat(10) + '-' + '0'.repeat(12),
      'sk_live_' + '0'.repeat(24),
      'rk_live_' + '0'.repeat(24),
      'dckr_pat_' + '0'.repeat(36),
      'ASIA' + '0'.repeat(16),
      'A'.repeat(40),
    ]
    const runtime = new ChatRuntime({
      appendMessage,
      getContext: vi.fn(async () => [{ role: 'user' as const, content: 'hello' }]),
      stream: vi.fn(async (_settings, _messages, onDelta) => {
        onDelta('中文增量')
        for (const credential of credentials) {
          onDelta(' Bearer ')
          onDelta(credential.slice(0, 4))
          onDelta(credential.slice(4) + ' ')
        }
      }),
      resolveModel: vi.fn(async () => ({ endpoint: 'http://model', model: 'm', contextLimit: 100, apiKey: null })),
    })
    await runtime.send({ chatId: 'c1', runId: '33333333-3333-4333-8333-333333333333', content: 'check' }, event => events.push(event))
    const serialized = JSON.stringify(events) + JSON.stringify(appendMessage.mock.calls)
    for (const credential of credentials) expect(serialized).not.toContain(credential)
    expect(events.some(event => event.kind === 'chat:delta' && event.content.includes('中文增量'))).toBe(true)
  })

  it('holds a bare 40-character credential until the next chunk instead of publishing its prefix', async () => {
    const appendMessage = vi.fn(async (input: { requestId: string; role?: string }) => ({ messageId: input.requestId }))
    const events: ChatRuntimeEvent[] = []
    const credential = 'A'.repeat(40)
    const leakedPrefix = credential.slice(0, 19)
    const runtime = new ChatRuntime({
      appendMessage,
      getContext: vi.fn(async () => [{ role: 'user' as const, content: 'hello' }]),
      stream: vi.fn(async (_settings, _messages, onDelta) => {
        onDelta('output: ')
        onDelta(leakedPrefix)
        onDelta(credential.slice(19) + ' ')
      }),
      resolveModel: vi.fn(async () => ({ endpoint: 'http://model', model: 'm', contextLimit: 100, apiKey: null })),
    })

    await runtime.send({ chatId: 'c1', runId: '77777777-7777-4777-8777-777777777777', content: 'check' }, event => events.push(event))

    const serialized = JSON.stringify(events) + JSON.stringify(appendMessage.mock.calls)
    expect(serialized).not.toContain(leakedPrefix)
    expect(serialized).not.toContain(credential)
    expect(serialized).toContain('[REDACTED SENSITIVE CONTENT]')
  })

  it('redacts a split OpenAI sk-proj token before it reaches chat events or persisted assistant content', async () => {
    const appendMessage = vi.fn(async (input: { requestId: string; role?: string }) => ({ messageId: input.requestId }))
    const events: ChatRuntimeEvent[] = []
    const token = 'sk-proj-' + '0'.repeat(32)
    const runtime = new ChatRuntime({
      appendMessage,
      getContext: vi.fn(async () => [{ role: 'user' as const, content: 'hello' }]),
      stream: vi.fn(async (_settings, _messages, onDelta) => {
        onDelta('output: ')
        onDelta(token.slice(0, 5))
        onDelta(token.slice(5, 14))
        onDelta(token.slice(14) + ' done')
      }),
      resolveModel: vi.fn(async () => ({ endpoint: 'http://model', model: 'm', contextLimit: 100, apiKey: null })),
    })

    await runtime.send({ chatId: 'c1', runId: '12121212-1212-4121-8121-121212121212', content: 'check' }, event => events.push(event))

    const serialized = JSON.stringify(events) + JSON.stringify(appendMessage.mock.calls)
    expect(serialized).not.toContain(token)
    expect(serialized).toContain('[REDACTED SENSITIVE CONTENT]')
  })

  it.each([
    ['one delta', (firstToken: string, secondToken: string, onDelta: (content: string) => void) => onDelta(`output ${firstToken} then ${secondToken} done`)],
    ['separate deltas', (firstToken: string, secondToken: string, onDelta: (content: string) => void) => {
      onDelta(`output ${firstToken} then `)
      onDelta(secondToken.slice(0, 13))
      onDelta(`${secondToken.slice(13)} done`)
    }],
  ])('redacts every simulated OpenAI project credential from %s before events or persistence', async (_delivery, deliver) => {
    const appendMessage = vi.fn(async (input: { requestId: string; role?: string; content?: string }) => ({ messageId: input.requestId }))
    const updateMessage = vi.fn(async (input: { requestId: string; chatId: string; messageId: string; content: string; state: 'streaming' | 'complete' | 'error' }) => { void input })
    const events: ChatRuntimeEvent[] = []
    const firstToken = 'sk-proj-' + 'A'.repeat(32)
    const secondToken = 'sk-proj-' + 'B'.repeat(32)
    const runtime = new ChatRuntime({
      appendMessage,
      updateMessage,
      getContext: vi.fn(async () => [{ role: 'user' as const, content: 'hello' }]),
      stream: vi.fn(async (_settings, _messages, onDelta) => { deliver(firstToken, secondToken, onDelta) }),
      resolveModel: vi.fn(async () => ({ endpoint: 'http://model', model: 'm', contextLimit: 100, apiKey: null })),
    })

    await runtime.send({ chatId: 'c1', runId: '16161616-1616-4161-8161-161616161616', content: 'check' }, event => events.push(event))

    const assistantWrites = [
      ...appendMessage.mock.calls.map(([input]) => input).filter(input => input.role === 'assistant'),
      ...updateMessage.mock.calls.map(([input]) => input),
    ]
    const deltas = events.filter((event): event is Extract<ChatRuntimeEvent, { kind: 'chat:delta' }> => event.kind === 'chat:delta')
    const completed = events.filter((event): event is Extract<ChatRuntimeEvent, { kind: 'chat:completed' }> => event.kind === 'chat:completed')
    for (const token of [firstToken, secondToken]) {
      expect(deltas.every(event => !event.content.includes(token))).toBe(true)
      expect(completed.every(event => !event.content.includes(token))).toBe(true)
      expect(assistantWrites.every(write => !write.content?.includes(token))).toBe(true)
    }
  })

  it('redacts a generic OpenAI token in a single streamed delta before publishing or persisting it', async () => {
    const appendMessage = vi.fn(async (input: { requestId: string; role?: string; content?: string }) => ({ messageId: input.requestId }))
    const updateMessage = vi.fn(async (input: { requestId: string; chatId: string; messageId: string; content: string; state: 'streaming' | 'complete' | 'error' }) => { void input })
    const events: ChatRuntimeEvent[] = []
    const genericOpenAiToken = 'sk-' + 'A'.repeat(32)
    const runtime = new ChatRuntime({
      appendMessage,
      updateMessage,
      getContext: vi.fn(async () => [{ role: 'user' as const, content: 'hello' }]),
      stream: vi.fn(async (_settings, _messages, onDelta) => { onDelta(`ordinary text ${genericOpenAiToken} tail`) }),
      resolveModel: vi.fn(async () => ({ endpoint: 'http://model', model: 'm', contextLimit: 100, apiKey: null })),
    })

    await runtime.send({ chatId: 'c1', runId: '13131313-1313-4131-8131-131313131313', content: 'check' }, event => events.push(event))

    const assistantWrites = [
      ...appendMessage.mock.calls.map(([input]) => input).filter(input => input.role === 'assistant'),
      ...updateMessage.mock.calls.map(([input]) => input),
    ]
    const deltas = events.filter((event): event is Extract<ChatRuntimeEvent, { kind: 'chat:delta' }> => event.kind === 'chat:delta')
    const completed = events.filter((event): event is Extract<ChatRuntimeEvent, { kind: 'chat:completed' }> => event.kind === 'chat:completed')
    expect(deltas.some(event => event.content.includes('ordinary text'))).toBe(true)
    expect(deltas.some(event => event.content.includes('[REDACTED SENSITIVE CONTENT]'))).toBe(true)
    expect(deltas.every(event => !event.content.includes(genericOpenAiToken))).toBe(true)
    expect(completed.every(event => !event.content.includes(genericOpenAiToken))).toBe(true)
    expect(assistantWrites.every(write => !write.content?.includes(genericOpenAiToken))).toBe(true)
  })

  it('redacts a generic OpenAI token whose prefix and body arrive in separate deltas', async () => {
    const appendMessage = vi.fn(async (input: { requestId: string; role?: string; content?: string }) => ({ messageId: input.requestId }))
    const updateMessage = vi.fn(async (input: { requestId: string; chatId: string; messageId: string; content: string; state: 'streaming' | 'complete' | 'error' }) => { void input })
    const events: ChatRuntimeEvent[] = []
    const genericOpenAiToken = 'sk-' + 'A'.repeat(32)
    const runtime = new ChatRuntime({
      appendMessage,
      updateMessage,
      getContext: vi.fn(async () => [{ role: 'user' as const, content: 'hello' }]),
      stream: vi.fn(async (_settings, _messages, onDelta) => {
        onDelta('ordinary text ')
        onDelta('sk-')
        onDelta('A'.repeat(32) + ' tail')
      }),
      resolveModel: vi.fn(async () => ({ endpoint: 'http://model', model: 'm', contextLimit: 100, apiKey: null })),
    })

    await runtime.send({ chatId: 'c1', runId: '14141414-1414-4141-8141-141414141414', content: 'check' }, event => events.push(event))

    const assistantWrites = [
      ...appendMessage.mock.calls.map(([input]) => input).filter(input => input.role === 'assistant'),
      ...updateMessage.mock.calls.map(([input]) => input),
    ]
    const deltas = events.filter((event): event is Extract<ChatRuntimeEvent, { kind: 'chat:delta' }> => event.kind === 'chat:delta')
    const completed = events.filter((event): event is Extract<ChatRuntimeEvent, { kind: 'chat:completed' }> => event.kind === 'chat:completed')
    expect(deltas.some(event => event.content.includes('ordinary text'))).toBe(true)
    expect(deltas.some(event => event.content.includes('[REDACTED SENSITIVE CONTENT]'))).toBe(true)
    expect(deltas.every(event => !event.content.includes(genericOpenAiToken))).toBe(true)
    expect(completed.every(event => !event.content.includes(genericOpenAiToken))).toBe(true)
    expect(assistantWrites.every(write => !write.content?.includes(genericOpenAiToken))).toBe(true)
  })

  it('redacts an adjacent generic OpenAI token before persisting the user message', async () => {
    const appendMessage = vi.fn(async (input: { requestId: string; role?: string; content?: string }) => ({ messageId: input.requestId }))
    const events: ChatRuntimeEvent[] = []
    const genericOpenAiToken = 'sk-' + 'A'.repeat(32)
    const adjacentValue = `prefixX${genericOpenAiToken}`
    const runtime = new ChatRuntime({
      appendMessage,
      getContext: vi.fn(async () => [{ role: 'user' as const, content: 'hello' }]),
      stream: vi.fn(async (_settings, _messages, onDelta) => { onDelta('safe response') }),
      resolveModel: vi.fn(async () => ({ endpoint: 'http://model', model: 'm', contextLimit: 100, apiKey: null })),
    })

    await runtime.send({ chatId: 'c1', runId: '15151515-1515-4151-8151-151515151515', content: adjacentValue }, event => events.push(event))

    const userWrites = appendMessage.mock.calls.map(([input]) => input).filter(input => input.role === 'user')
    expect(userWrites.every(write => !write.content?.includes(genericOpenAiToken))).toBe(true)
    expect(events.every(event => JSON.stringify(event).includes(genericOpenAiToken) === false)).toBe(true)
  })

  it.each(['/', '+', '='])('redacts a 40-character Base64 credential ending in %s before publishing or persisting streamed output', async ending => {
    const appendMessage = vi.fn(async (input: { requestId: string; role?: string; content?: string }) => ({ messageId: input.requestId }))
    const updateMessage = vi.fn(async (input: { requestId: string; chatId: string; messageId: string; content: string; state: 'streaming' | 'complete' | 'error' }) => { void input })
    const events: ChatRuntimeEvent[] = []
    const base64Credential = 'A'.repeat(39) + ending
    const runtime = new ChatRuntime({
      appendMessage,
      updateMessage,
      getContext: vi.fn(async () => [{ role: 'user' as const, content: 'hello' }]),
      stream: vi.fn(async (_settings, _messages, onDelta) => {
        if (ending === '/') {
          onDelta('result ')
          onDelta(base64Credential.slice(0, 20))
          onDelta(base64Credential.slice(20) + ' tail')
        } else {
          onDelta(`result ${base64Credential} tail`)
        }
      }),
      resolveModel: vi.fn(async () => ({ endpoint: 'http://model', model: 'm', contextLimit: 100, apiKey: null })),
    })

    await runtime.send({ chatId: 'c1', runId: ending === '/' ? '32323232-3232-4232-8232-323232323232' : ending === '+' ? '33333333-3333-4333-8333-333333333334' : '34343434-3434-4434-8434-343434343434', content: 'check' }, event => events.push(event))

    const assistantWrites = [
      ...appendMessage.mock.calls.map(([input]) => input).filter(input => input.role === 'assistant'),
      ...updateMessage.mock.calls.map(([input]) => input),
    ]
    expect(events.every(event => JSON.stringify(event).includes(base64Credential) === false)).toBe(true)
    expect(assistantWrites.every(write => !write.content?.includes(base64Credential))).toBe(true)
    expect(events.some(event => event.kind === 'chat:delta' && event.content.includes('[REDACTED SENSITIVE CONTENT]'))).toBe(true)
  })

  it('redacts 44-character padded and longer Base64-like user input before persistence and model context', async () => {
    const appendedUserContent: string[] = []
    const contextSnapshots: unknown[] = []
    const providerMessages: unknown[] = []
    const appendMessage = vi.fn(async (input: { requestId: string; role?: string; content?: string }) => {
      if (input.role === 'user') appendedUserContent.push(input.content ?? '')
      return { messageId: input.requestId }
    })
    const getContext = vi.fn(async () => {
      const context = [{ role: 'user' as const, content: appendedUserContent.at(-1) ?? '' }]
      contextSnapshots.push(context)
      return context
    })
    const stream = vi.fn(async (_settings, messages) => { providerMessages.push(messages) })
    const runtime = new ChatRuntime({
      appendMessage,
      getContext,
      stream,
      resolveModel: vi.fn(async () => ({ endpoint: 'http://model', model: 'm', contextLimit: 100, apiKey: null })),
    })
    const paddedCredential = 'A'.repeat(43) + '='
    const extendedCredential = 'A'.repeat(45) + '+/='

    for (const credential of [paddedCredential, extendedCredential]) {
      await runtime.send({ chatId: `user-${credential.length}`, runId: `31313131-3131-4131-8131-${credential.length.toString().padStart(12, '0')}`, content: `use ${credential}` }, () => undefined)
      expect(JSON.stringify(appendedUserContent).includes(credential)).toBe(false)
      expect(JSON.stringify(contextSnapshots).includes(credential)).toBe(false)
      expect(JSON.stringify(providerMessages).includes(credential)).toBe(false)
    }
  })

  it('redacts 44-character padded and longer Base64-like assistant output across stream deltas', async () => {
    const appendMessage = vi.fn(async (input: { requestId: string; role?: string; content?: string }) => ({ messageId: input.requestId }))
    const updateMessage = vi.fn(async (input: { requestId: string; chatId: string; messageId: string; content: string; state: 'streaming' | 'complete' | 'error' }) => { void input })
    const paddedCredential = 'A'.repeat(43) + '='
    const extendedCredential = 'A'.repeat(45) + '+/='

    for (const credential of [paddedCredential, extendedCredential]) {
      const events: ChatRuntimeEvent[] = []
      const runtime = new ChatRuntime({
        appendMessage,
        updateMessage,
        getContext: vi.fn(async () => [{ role: 'user' as const, content: 'hello' }]),
        stream: vi.fn(async (_settings, _messages, onDelta) => {
          onDelta('result ')
          onDelta(credential.slice(0, 20))
          onDelta(credential.slice(20))
          onDelta(' tail')
        }),
        resolveModel: vi.fn(async () => ({ endpoint: 'http://model', model: 'm', contextLimit: 100, apiKey: null })),
      })

      await runtime.send({ chatId: `assistant-${credential.length}`, runId: `41414141-4141-4141-8141-${credential.length.toString().padStart(12, '0')}`, content: 'check' }, event => events.push(event))

      const assistantWrites = [
        ...appendMessage.mock.calls.map(([input]) => input).filter(input => input.role === 'assistant'),
        ...updateMessage.mock.calls.map(([input]) => input),
      ]
      expect(events.every(event => JSON.stringify(event).includes(credential) === false)).toBe(true)
      expect(assistantWrites.every(write => write.content?.includes(credential) === false)).toBe(true)
    }
  })

  it('redacts synthetic temporary and private-key user paths before persistence or model context', async () => {
    const persistedUsers: string[] = []
    const contexts: unknown[] = []
    const providerMessages: unknown[] = []
    const appendMessage = vi.fn(async (input: { requestId: string; role?: string; content?: string }) => {
      if (input.role === 'user') persistedUsers.push(input.content ?? '')
      return { messageId: input.requestId }
    })
    const getContext = vi.fn(async () => {
      const context = [{ role: 'user' as const, content: persistedUsers.at(-1) ?? '' }]
      contexts.push(context)
      return context
    })
    const stream = vi.fn(async (_settings, messages) => { providerMessages.push(messages) })
    const runtime = new ChatRuntime({
      appendMessage,
      getContext,
      stream,
      resolveModel: vi.fn(async () => ({ endpoint: 'http://model', model: 'm', contextLimit: 100, apiKey: null })),
    })
    const temporaryPath = `tmp:${['C:', 'synthetic', 'AppData', 'Local', 'Temp', 'access', 'profile.conf'].join('\\')}`
    const privateKeyPath = ['C:', 'synthetic', '.ssh', 'id_rsa'].join('\\')

    for (const [index, path] of [temporaryPath, privateKeyPath].entries()) {
      await runtime.send({ chatId: `user-path-${index}`, runId: `51515151-5151-4151-8151-${index.toString().padStart(12, '0')}`, content: `use ${path}` }, () => undefined)
      expect(persistedUsers.some(content => content.includes(path))).toBe(false)
      expect(contexts.some(context => chatMessagesContain(context, path))).toBe(false)
      expect(providerMessages.some(messages => chatMessagesContain(messages, path))).toBe(false)
    }
  })

  it('redacts wildcard .ssh id_* paths from runtime events, assistant persistence, and model context', async () => {
    const customIdentity = '/home/synthetic/.ssh/id_custom'
    const persistedUsers: string[] = []
    const contexts: unknown[] = []
    const providerMessages: unknown[] = []
    const appendMessage = vi.fn(async (input: { requestId: string; role?: string; content?: string }) => {
      if (input.role === 'user') persistedUsers.push(input.content ?? '')
      return { messageId: input.requestId }
    })
    const updateMessage = vi.fn(async (input: { requestId: string; chatId: string; messageId: string; content: string; state: 'streaming' | 'complete' | 'error' }) => { void input })
    const getContext = vi.fn(async () => {
      const context = [{ role: 'user' as const, content: persistedUsers.at(-1) ?? '' }]
      contexts.push(context)
      return context
    })
    const stream = vi.fn(async (_settings, messages, onDelta) => {
      providerMessages.push(messages)
      onDelta(`result ${customIdentity}`)
      onDelta(' ')
    })
    const events: ChatRuntimeEvent[] = []
    const runtime = new ChatRuntime({
      appendMessage,
      updateMessage,
      getContext,
      stream,
      resolveModel: vi.fn(async () => ({ endpoint: 'http://model', model: 'm', contextLimit: 100, apiKey: null })),
    })

    await runtime.send({ chatId: 'wildcard-identity', runId: 'wildcard-identity-run', content: `use ${customIdentity}` }, event => events.push(event))

    const assistantWrites = [
      ...appendMessage.mock.calls.map(([input]) => input).filter(input => input.role === 'assistant'),
      ...updateMessage.mock.calls.map(([input]) => input),
    ]
    expect(JSON.stringify(events)).not.toContain(customIdentity)
    expect(JSON.stringify(assistantWrites)).not.toContain(customIdentity)
    expect(JSON.stringify(contexts)).not.toContain(customIdentity)
    expect(JSON.stringify(providerMessages)).not.toContain(customIdentity)
  })

  it('redacts synthetic temporary single-delta and private-key split assistant paths before events or persistence', async () => {
    const temporaryPath = `tmp:${['C:', 'synthetic', 'AppData', 'Local', 'Temp', 'access', 'profile.conf'].join('\\')}`
    const privateKeyPath = ['C:', 'synthetic', '.ssh', 'id_rsa'].join('\\')
    const deliveries = [
      { path: temporaryPath, deliver: (onDelta: (content: string) => void) => onDelta(`single ${temporaryPath} tail`) },
      { path: privateKeyPath, deliver: (onDelta: (content: string) => void) => {
        const split = privateKeyPath.lastIndexOf('rsa')
        onDelta('split ')
        onDelta(privateKeyPath.slice(0, split))
        onDelta(`${privateKeyPath.slice(split)} tail`)
      } },
    ]

    for (const [index, { path, deliver }] of deliveries.entries()) {
      const appendMessage = vi.fn(async (input: { requestId: string; role?: string; content?: string }) => ({ messageId: input.requestId }))
      const updateMessage = vi.fn(async (input: { requestId: string; chatId: string; messageId: string; content: string; state: 'streaming' | 'complete' | 'error' }) => { void input })
      const events: ChatRuntimeEvent[] = []
      const runtime = new ChatRuntime({
        appendMessage,
        updateMessage,
        getContext: vi.fn(async () => [{ role: 'user' as const, content: 'hello' }]),
        stream: vi.fn(async (_settings, _messages, onDelta) => { deliver(onDelta) }),
        resolveModel: vi.fn(async () => ({ endpoint: 'http://model', model: 'm', contextLimit: 100, apiKey: null })),
      })

      await runtime.send({ chatId: `assistant-path-${index}`, runId: `61616161-6161-4161-8161-${index.toString().padStart(12, '0')}`, content: 'check' }, event => events.push(event))

      const assistantWrites = [
        ...appendMessage.mock.calls.map(([input]) => input).filter(input => input.role === 'assistant'),
        ...updateMessage.mock.calls.map(([input]) => input),
      ]
      expect(events.every(event => chatEventText(event).includes(path) === false)).toBe(true)
      expect(assistantWrites.every(write => write.content?.includes(path) === false)).toBe(true)
    }
  })

  it('does not release partial sensitive filesystem paths split across JSON and Markdown punctuation', async () => {
    const temporaryPath = ['C:', 'synthetic', 'AppData', 'Local', 'Temp', 'AccessClient', 'profile.conf'].join('\\')
    const paths = [
      { path: ['C:', 'synthetic', '.ssh', 'id_rsa'].join('\\'), opening: 'JSON {"path":"', closing: '"} ' },
      { path: ['C:', 'synthetic', 'keys', 'identity.pem'].join('\\'), opening: 'Markdown **"', closing: '"** ' },
      { path: ['C:', 'synthetic', 'keys', 'identity.ppk'].join('\\'), opening: 'JSON {"path":"', closing: '"} ' },
      { path: ['C:', 'synthetic', 'keys', 'identity.key'].join('\\'), opening: 'Markdown **"', closing: '"** ' },
      { path: temporaryPath, opening: 'JSON {"path":"', closing: '"} ' },
      { path: `tmp:${temporaryPath}`, opening: 'Markdown **"', closing: '"** ' },
    ]
    const persisted = new Map<string, string>()
    const appendMessage = vi.fn(async (input: { requestId: string; role?: string; content?: string }) => {
      if (input.role === 'assistant') persisted.set(input.requestId, input.content ?? '')
      return { messageId: input.requestId }
    })
    const updateMessage = vi.fn(async (input: { messageId: string; content: string }) => { persisted.set(input.messageId, input.content) })
    const events: ChatRuntimeEvent[] = []
    const runtime = new ChatRuntime({
      appendMessage,
      updateMessage,
      getContext: vi.fn(async () => [{ role: 'user' as const, content: 'hello' }]),
      stream: vi.fn(async (_settings, _messages, onDelta) => {
        for (const { path, opening, closing } of paths) {
          const split = Math.max(1, Math.floor(path.length / 2))
          onDelta(`response ${opening}${path.slice(0, split)}`)
          onDelta(`${path.slice(split)}${closing}`)
        }
      }),
      resolveModel: vi.fn(async () => ({ endpoint: 'http://model', model: 'm', contextLimit: 100, apiKey: null })),
    })

    await runtime.send({ chatId: 'punctuation-paths', runId: '71717171-7171-4171-8171-717171717171', content: 'check' }, event => events.push(event))

    const deltas = events.filter((event): event is Extract<ChatRuntimeEvent, { kind: 'chat:delta' }> => event.kind === 'chat:delta')
    const completed = events.find((event): event is Extract<ChatRuntimeEvent, { kind: 'chat:completed' }> => event.kind === 'chat:completed')
    const assistantWrites = [
      ...appendMessage.mock.calls.map(([input]) => input).filter(input => input.role === 'assistant'),
      ...updateMessage.mock.calls.map(([input]) => input),
    ]
    for (const { path } of paths) {
      const partial = path.slice(0, Math.max(1, Math.floor(path.length / 2)))
      expect(deltas.every(event => !event.content.includes(path))).toBe(true)
      expect(deltas.every(event => !event.content.includes(partial))).toBe(true)
      expect(assistantWrites.every(write => !write.content?.includes(path) && !write.content?.includes(partial))).toBe(true)
      expect(completed?.content).not.toContain(path)
      expect(completed?.content).not.toContain(partial)
      expect([...persisted.values()].every(content => !content.includes(path) && !content.includes(partial))).toBe(true)
    }
    expect(completed?.content).toContain('[REDACTED SENSITIVE CONTENT]')
  })

  it('redacts credentials split across punctuation, JSON, Markdown, and adjacent Chinese text', async () => {
    const appendMessage = vi.fn(async (input: { requestId: string; role?: string; state?: string; content?: string }) => ({ messageId: input.requestId }))
    const events: ChatRuntimeEvent[] = []
    const token = 'sk-proj-' + '0'.repeat(32)
    const runtime = new ChatRuntime({
      appendMessage,
      getContext: vi.fn(async () => [{ role: 'user' as const, content: 'hello' }]),
      stream: vi.fn(async (_settings, _messages, onDelta) => {
        onDelta('结果：**凭据** {"value":"(sk-')
        onDelta('proj-' + '0'.repeat(32) + '"}，后续')
      }),
      resolveModel: vi.fn(async () => ({ endpoint: 'http://model', model: 'm', contextLimit: 100, apiKey: null })),
    })

    await runtime.send({ chatId: 'c1', runId: '23232323-2323-4232-8232-232323232323', content: 'check' }, event => events.push(event))

    const serialized = JSON.stringify(events) + JSON.stringify(appendMessage.mock.calls)
    expect(serialized).not.toContain(token)
    expect(serialized).toContain('[REDACTED SENSITIVE CONTENT]')
    expect(serialized).toContain('结果')
    expect(serialized).toContain('后续')
  })

  it.each([
    ['a JSON-quoted .ssh identity path', ['C:', 'synthetic', '.ssh', 'id_ed25519'].join('\\'), 'JSON {"path":"', '"} '],
    ['a Markdown-quoted .pem path', ['C:', 'synthetic', 'keys', 'identity.pem'].join('\\'), 'Markdown **"', '"** '],
    ['a JSON-quoted .ppk path', ['C:', 'synthetic', 'keys', 'identity.ppk'].join('\\'), 'JSON {"path":"', '"} '],
    ['a Markdown-quoted .key path', ['C:', 'synthetic', 'keys', 'identity.key'].join('\\'), 'Markdown **"', '"** '],
    ['a JSON-quoted tmp reference', `tmp:${['C:', 'synthetic', 'AppData', 'Local', 'Temp', 'AccessClient', 'profile.conf'].join('\\')}`, 'JSON {"path":"', '"} '],
    ['a Markdown-quoted Windows Temp AccessClient path', ['C:', 'synthetic', 'AppData', 'Local', 'Temp', 'AccessClient', 'profile.conf'].join('\\'), 'Markdown **"', '"** '],
    ['a JSON-quoted one-character OpenAI project prefix', 'sk-proj-' + 'A'.repeat(32), 'JSON {"key":"', '"} '],
    ['a Markdown-quoted dynamic Base64-like value', 'A'.repeat(43) + '=', 'Markdown **"', '"** '],
  ])('does not publish, persist, complete, or reconstruct any boundary of %s', async (_description, value, opening, closing) => {
    const appendMessage = vi.fn(async (input: { requestId: string; role?: string; content?: string }) => ({ messageId: input.requestId }))
    const updateMessage = vi.fn(async (input: { requestId: string; chatId: string; messageId: string; content: string; state: 'streaming' | 'complete' | 'error' }) => { void input })
    const events: ChatRuntimeEvent[] = []
    const fragmentsAfterEachPrefix: Array<{ prefix: string; emitted: string }> = []
    const runtime = new ChatRuntime({
      appendMessage,
      updateMessage,
      getContext: vi.fn(async () => [{ role: 'user' as const, content: 'hello' }]),
      stream: vi.fn(async (_settings, _messages, onDelta) => {
        for (let cut = 1; cut < value.length; cut += 1) {
          const prefix = value.slice(0, cut)
          const eventCount = events.length
          onDelta(`${opening}${prefix}`)
          fragmentsAfterEachPrefix.push({
            prefix,
            emitted: events.slice(eventCount).filter((event): event is Extract<ChatRuntimeEvent, { kind: 'chat:delta' }> => event.kind === 'chat:delta').map(event => event.content).join(''),
          })
          onDelta(`${value.slice(cut)}${closing}`)
        }
      }),
      resolveModel: vi.fn(async () => ({ endpoint: 'http://model', model: 'm', contextLimit: 100, apiKey: null })),
    })

    await runtime.send({ chatId: `all-boundaries-${value.length}`, runId: `all-boundaries-${value.length}`, content: 'check' }, event => events.push(event))

    const deltas = events.filter((event): event is Extract<ChatRuntimeEvent, { kind: 'chat:delta' }> => event.kind === 'chat:delta')
    const completed = events.filter((event): event is Extract<ChatRuntimeEvent, { kind: 'chat:completed' }> => event.kind === 'chat:completed')
    const assistantWrites = [
      ...appendMessage.mock.calls.map(([input]) => input).filter(input => input.role === 'assistant'),
      ...updateMessage.mock.calls.map(([input]) => input),
    ]
    expect(fragmentsAfterEachPrefix.every(({ prefix, emitted }) => !emitted.endsWith(prefix))).toBe(true)
    expect(deltas.map(event => event.content).join('')).not.toContain(value)
    expect(deltas.every(event => !event.content.includes(value))).toBe(true)
    expect(completed.every(event => !event.content.includes(value))).toBe(true)
    expect(assistantWrites.every(write => !write.content?.includes(value))).toBe(true)
    expect(events.find((event): event is Extract<ChatRuntimeEvent, { kind: 'chat:completed' }> => event.kind === 'chat:completed')?.content).toContain('[REDACTED SENSITIVE CONTENT]')
  })

  it('persists and publishes a safe non-retryable cancellation when the provider resolves after abort', async () => {
    const appendMessage = vi.fn(async (input: { requestId: string; role?: string; state?: string }) => ({ messageId: input.requestId }))
    const updateMessage = vi.fn(async () => undefined)
    let release!: () => void
    let started!: () => void
    const startedPromise = new Promise<void>(resolve => { started = resolve })
    const streamDone = new Promise<void>(resolve => { release = resolve })
    const events: ChatRuntimeEvent[] = []
    const runtime = new ChatRuntime({
      appendMessage,
      updateMessage,
      getContext: vi.fn(async () => [{ role: 'user' as const, content: 'hello' }]),
      stream: vi.fn(async () => {
        started()
        await streamDone
      }),
      resolveModel: vi.fn(async () => ({ endpoint: 'http://model', model: 'm', contextLimit: 100, apiKey: null })),
    })

    const pending = runtime.send({ chatId: 'c1', runId: '24242424-2424-4242-8242-242424242424', content: 'cancel me' }, event => events.push(event))
    await startedPromise
    runtime.cancel('c1')
    release()
    await pending

    expect(updateMessage).toHaveBeenCalledWith(expect.objectContaining({ content: '已取消。', state: 'error', retryable: false }))
    expect(events).toContainEqual(expect.objectContaining({ kind: 'chat:error', error: '已取消。', retryable: false }))
  })

  it.each(['user append', 'model resolution', 'context loading'] as const)('persists and publishes an authoritative cancellation when cancelled during %s before the streaming placeholder exists', async phase => {
    const runId = `pre-placeholder-${phase.replace(' ', '-')}`
    const block = deferred<void>()
    let signalBlockedStage!: () => void
    const blockedStage = new Promise<void>(resolve => { signalBlockedStage = resolve })
    const appendMessage = vi.fn(async (input: { requestId: string; role: 'user' | 'assistant'; content: string; state: 'complete' | 'streaming' | 'error' }) => {
      if (phase === 'user append' && input.role === 'user') {
        signalBlockedStage()
        await block.promise
      }
      return { messageId: `durable:${input.requestId}` }
    })
    const resolveModel = vi.fn(async () => {
      if (phase === 'model resolution') {
        signalBlockedStage()
        await block.promise
      }
      return { endpoint: 'http://model', model: 'm', contextLimit: 100, apiKey: null }
    })
    const getContext = vi.fn(async () => {
      if (phase === 'context loading') {
        signalBlockedStage()
        await block.promise
      }
      return [{ role: 'user' as const, content: 'hello' }]
    })
    const stream = vi.fn(async () => undefined)
    const events: ChatRuntimeEvent[] = []
    const runtime = new ChatRuntime({ appendMessage, getContext, resolveModel, stream })

    const sending = runtime.send({ chatId: 'c1', runId, content: 'cancel before stream' }, event => events.push(event))
    await blockedStage
    const cancelling = runtime.cancel('c1')
    block.resolve()
    await Promise.all([sending, cancelling])

    const cancellationWrite = appendMessage.mock.calls
      .map(([request]) => request)
      .filter(request => request.role === 'assistant' && request.state === 'error')
    expect(cancellationWrite).toEqual([expect.objectContaining({ requestId: `${runId}:assistant:cancel`, content: '已取消。', state: 'error' })])
    expect(appendMessage.mock.calls.some(([request]) => request.role === 'assistant' && request.state === 'streaming')).toBe(false)
    expect(events).toContainEqual({ kind: 'chat:error', chatId: 'c1', runId, messageId: `durable:${runId}:assistant:cancel`, error: '已取消。', retryable: false })
    expect(stream).not.toHaveBeenCalled()
  })

  it('maps an initial user persistence failure to a safe retryable chat error', async () => {
    const events: ChatRuntimeEvent[] = []
    const secret = 'repository secret sk-proj-' + '0'.repeat(32)
    const runtime = new ChatRuntime({
      appendMessage: vi.fn(async () => { throw new Error(secret) }),
      getContext: vi.fn(async () => [{ role: 'user' as const, content: 'hello' }]),
      stream: vi.fn(async () => undefined),
      resolveModel: vi.fn(async () => ({ endpoint: 'http://model', model: 'm', contextLimit: 100, apiKey: null })),
    })

    await runtime.send({ chatId: 'c1', runId: '25252525-2525-4252-8252-252525252525', content: 'check' }, event => events.push(event))

    const serialized = JSON.stringify(events)
    expect(events).toContainEqual(expect.objectContaining({ kind: 'chat:error', retryable: true }))
    expect(serialized).not.toContain(secret)
    const error = events.find((event): event is Extract<ChatRuntimeEvent, { kind: 'chat:error' }> => event.kind === 'chat:error')
    expect(error?.error).toBe('聊天暂时无法保存，请稍后重试。')
    expect(error?.messageId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  })

  it('drops callbacks from a superseded provider run that ignores abort', async () => {
    const appendMessage = vi.fn(async (input: { requestId: string }) => ({ messageId: input.requestId }))
    const updateMessage = vi.fn<(input: { requestId: string; chatId: string; messageId: string; content: string; state: 'streaming' | 'complete' | 'error' }) => Promise<unknown>>(async () => undefined)
    const events: ChatRuntimeEvent[] = []
    let releaseOldRun: (() => void) | undefined
    let oldCallback: ((content: string) => void) | undefined
    let signalOldRunStarted: (() => void) | undefined
    const oldRunStarted = new Promise<void>(resolve => { signalOldRunStarted = resolve })
    const oldRunCanFinish = new Promise<void>(resolve => { releaseOldRun = resolve })
    let streamCount = 0
    const runtime = new ChatRuntime({
      appendMessage,
      updateMessage,
      getContext: vi.fn(async () => [{ role: 'user' as const, content: 'hello' }]),
      stream: vi.fn(async (_settings, _messages, onDelta) => {
        streamCount += 1
        if (streamCount === 1) {
          oldCallback = onDelta
          signalOldRunStarted?.()
          await oldRunCanFinish
          return
        }
        onDelta('new result')
      }),
      resolveModel: vi.fn(async () => ({ endpoint: 'http://model', model: 'm', contextLimit: 100, apiKey: null })),
    })

    const staleRun = runtime.send({ chatId: 'c1', runId: '13131313-1313-4131-8131-131313131313', content: 'old request' }, event => events.push(event))
    await oldRunStarted
    await runtime.send({ chatId: 'c1', runId: '14141414-1414-4141-8141-141414141414', content: 'new request' }, event => events.push(event))
    oldCallback?.('late stale result')
    releaseOldRun?.()
    await staleRun

    expect(events.filter(event => event.runId === '13131313-1313-4131-8131-131313131313')).toHaveLength(0)
    const oldRunUpdates = updateMessage.mock.calls
      .map(([request]) => request)
      .filter(request => request.requestId.includes('13131313-1313-4131-8131-131313131313'))
    expect(oldRunUpdates).toEqual([expect.objectContaining({ content: '已取消。', state: 'error' })])
    expect(events).toContainEqual(expect.objectContaining({ kind: 'chat:completed', runId: '14141414-1414-4141-8141-141414141414' }))
  })

  it('does not publish or retain a completion from a run superseded during its final assistant write', async () => {
    const oldRunId = '37373737-3737-4737-8737-373737373737'
    const newRunId = '38383838-3838-4838-8838-383838383838'
    const persisted = new Map<string, { content: string; state: 'streaming' | 'complete' | 'error' }>()
    let releaseOldCompletion!: () => void
    let signalOldCompletion!: () => void
    const oldCompletionStarted = new Promise<void>(resolve => { signalOldCompletion = resolve })
    const oldCompletionCanFinish = new Promise<void>(resolve => { releaseOldCompletion = resolve })
    let streamCount = 0
    const appendMessage = vi.fn(async (request: { requestId: string; role: 'user' | 'assistant'; content: string; state: 'complete' | 'streaming' | 'error' }) => {
      if (request.role === 'assistant') persisted.set(request.requestId, { content: request.content, state: request.state })
      return { messageId: request.requestId }
    })
    const updateMessage = vi.fn(async (request: { requestId: string; chatId: string; messageId: string; content: string; state: 'streaming' | 'complete' | 'error' }) => {
      if (request.requestId === `${oldRunId}:assistant:complete`) {
        signalOldCompletion()
        await oldCompletionCanFinish
      }
      persisted.set(request.messageId, { content: request.content, state: request.state })
    })
    const events: ChatRuntimeEvent[] = []
    const runtime = new ChatRuntime({
      appendMessage,
      updateMessage,
      getContext: vi.fn(async () => [{ role: 'user' as const, content: 'hello' }]),
      stream: vi.fn(async (_settings, _messages, onDelta) => {
        streamCount += 1
        onDelta(streamCount === 1 ? 'old response' : 'new response')
      }),
      resolveModel: vi.fn(async () => ({ endpoint: 'http://model', model: 'm', contextLimit: 100, apiKey: null })),
    })

    const staleRun = runtime.send({ chatId: 'c1', runId: oldRunId, content: 'old request' }, event => events.push(event))
    await oldCompletionStarted
    const activeRun = runtime.send({ chatId: 'c1', runId: newRunId, content: 'new request' }, event => events.push(event))
    await Promise.resolve()
    releaseOldCompletion()
    await Promise.all([staleRun, activeRun])

    expect(events.some(event => event.runId === oldRunId && event.kind === 'chat:completed')).toBe(false)
    expect(updateMessage).toHaveBeenCalledWith(expect.objectContaining({ requestId: `${oldRunId}:assistant:superseded` }))
    expect(persisted.get(`${oldRunId}:assistant:streaming`)).toEqual({ content: '已取消。', state: 'error' })
    expect(events).toContainEqual(expect.objectContaining({ runId: newRunId, kind: 'chat:completed' }))
  })

  it('redacts sensitive user input before any persistence request', async () => {
    const appendMessage = vi.fn(async (input: { requestId: string; role?: string }) => ({ messageId: input.requestId }))
    const secret = 'glpat-' + '0'.repeat(20)
    const runtime = new ChatRuntime({
      appendMessage,
      getContext: vi.fn(async () => [{ role: 'user' as const, content: 'hello' }]),
      stream: vi.fn(async () => undefined),
      resolveModel: vi.fn(async () => ({ endpoint: 'http://model', model: 'm', contextLimit: 100, apiKey: null })),
    })
    await runtime.send({ chatId: 'c1', runId: '44444444-4444-4444-8444-444444444444', content: `please use ${secret}` }, () => undefined)
    expect(JSON.stringify(appendMessage.mock.calls)).not.toContain(secret)
    expect(appendMessage.mock.calls[0]?.[0]).toMatchObject({ content: expect.stringContaining('[REDACTED SENSITIVE CONTENT]') })
  })

  it('maps sensitive provider errors to a safe retryable chat error', async () => {
    const appendMessage = vi.fn(async (input: { requestId: string }) => ({ messageId: input.requestId }))
    const events: ChatRuntimeEvent[] = []
    const secret = 'dckr_pat_' + '0'.repeat(36)
    const runtime = new ChatRuntime({
      appendMessage,
      getContext: vi.fn(async () => [{ role: 'user' as const, content: 'hello' }]),
      stream: vi.fn(async () => { throw new Error(`upstream ${secret}`) }),
      resolveModel: vi.fn(async () => ({ endpoint: 'http://model', model: 'm', contextLimit: 100, apiKey: null })),
    })
    await runtime.send({ chatId: 'c1', runId: '55555555-5555-4555-8555-555555555555', content: 'check' }, event => events.push(event))
    const serialized = JSON.stringify(events) + JSON.stringify(appendMessage.mock.calls)
    expect(serialized).not.toContain(secret)
    expect(events).toContainEqual(expect.objectContaining({ kind: 'chat:error', retryable: true }))
    expect(events).toContainEqual(expect.objectContaining({ kind: 'chat:error', messageId: '55555555-5555-4555-8555-555555555555:assistant:streaming' }))
  })

  it.each([
    ['a simulated AccessClient temporary path', 'AccessClient temporary file: C:\\simulated-user\\AppData\\Local\\Temp\\session.conf'],
    ['representative terminal output', 'remote shell output: Linux node-17 kernel 6.1.0 cwd=/srv/ops'],
  ])('does not persist or publish raw unknown provider errors containing %s', async (_source, rawProviderError) => {
    const appendMessage = vi.fn(async (input: { requestId: string; role?: string; content?: string }) => ({ messageId: input.requestId }))
    const updateMessage = vi.fn(async (input: { requestId: string; chatId: string; messageId: string; content: string; state: 'streaming' | 'complete' | 'error' }) => { void input })
    const events: ChatRuntimeEvent[] = []
    const runtime = new ChatRuntime({
      appendMessage,
      updateMessage,
      getContext: vi.fn(async () => [{ role: 'user' as const, content: 'hello' }]),
      stream: vi.fn(async () => { throw new Error(rawProviderError) }),
      resolveModel: vi.fn(async () => ({ endpoint: 'http://model', model: 'm', contextLimit: 100, apiKey: null })),
    })

    await runtime.send({ chatId: 'c1', runId: '56565656-5656-4565-8565-565656565656', content: 'check' }, event => events.push(event))

    const assistantWrites = [
      ...appendMessage.mock.calls.map(([input]) => input).filter(input => input.role === 'assistant'),
      ...updateMessage.mock.calls.map(([input]) => input),
    ]
    const errors = events.filter((event): event is Extract<ChatRuntimeEvent, { kind: 'chat:error' }> => event.kind === 'chat:error')
    expect(JSON.stringify(assistantWrites)).not.toContain(rawProviderError)
    expect(JSON.stringify(events)).not.toContain(rawProviderError)
    expect(errors).toContainEqual(expect.objectContaining({ error: '聊天运行失败，请检查模型连接后重试。', retryable: true }))
  })

  it('updates the original streaming record into an error instead of appending a second error record', async () => {
    const appendMessage = vi.fn(async (input: { requestId: string; role?: string; state?: string }) => ({ messageId: input.requestId }))
    const updateMessage = vi.fn(async () => undefined)
    const runtime = new ChatRuntime({
      appendMessage,
      updateMessage,
      getContext: vi.fn(async () => [{ role: 'user' as const, content: 'hello' }]),
      stream: vi.fn(async () => { throw new Error('network unavailable') }),
      resolveModel: vi.fn(async () => ({ endpoint: 'http://model', model: 'm', contextLimit: 100, apiKey: null })),
    })
    await runtime.send({ chatId: 'c1', runId: '66666666-6666-4666-8666-666666666666', content: 'check' }, () => undefined)
    expect(updateMessage).toHaveBeenCalledWith(expect.objectContaining({ state: 'error' }))
    expect(appendMessage.mock.calls.filter(([request]) => request.role === 'assistant' && request.state === 'error')).toHaveLength(0)
  })

  it('reuses the persisted retryable assistant error record on retry', async () => {
    const appendMessage = vi.fn(async (input: { requestId: string; role?: string }) => ({ messageId: input.requestId }))
    const updateMessage = vi.fn(async () => undefined)
    const runtime = new ChatRuntime({
      appendMessage,
      updateMessage,
      getRetryMessageId: vi.fn(async () => 'previous-error'),
      getContext: vi.fn(async () => [{ role: 'user' as const, content: 'hello' }]),
      stream: vi.fn(async (_settings, _messages, onDelta) => onDelta('recovered')),
      resolveModel: vi.fn(async () => ({ endpoint: 'http://model', model: 'm', contextLimit: 100, apiKey: null })),
    })
    await runtime.send({ chatId: 'c1', runId: 'abababab-abab-4bab-8bab-abababababab', content: 'check', retry: true }, () => undefined)
    expect(updateMessage).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'previous-error', state: 'streaming' }))
    expect(updateMessage).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'previous-error', state: 'complete', content: 'recovered' }))
    expect(appendMessage.mock.calls.filter(([request]) => request.role === 'assistant')).toHaveLength(0)
  })

  it('persists a recoverable streaming assistant message and marks timeout as retryable error', async () => {
    const appendMessage = vi.fn(async (input: { requestId: string; content: string; state: string }) => ({ messageId: input.requestId }))
    const updateMessage = vi.fn(async (input: { requestId: string; chatId: string; messageId: string; content: string; state: 'streaming' | 'complete' | 'error' }) => { void input })
    const runtime = new ChatRuntime({
      appendMessage,
      updateMessage,
      getContext: vi.fn(async () => [{ role: 'user' as const, content: 'hello' }]),
      stream: vi.fn(async (_settings, _messages, onDelta) => { onDelta('partial '); await new Promise(resolve => setTimeout(resolve, 20)) }),
      resolveModel: vi.fn(async () => ({ endpoint: 'http://model', model: 'm', contextLimit: 100, apiKey: null })),
      timeoutMs: 1,
    })
    const events: ChatRuntimeEvent[] = []
    await runtime.send({ chatId: 'c1', runId: '22222222-2222-4222-8222-222222222222', content: 'check' }, event => events.push(event))
    expect(appendMessage.mock.calls.some(([input]) => input.state === 'streaming')).toBe(true)
    expect(updateMessage.mock.calls.some(([input]) => input.state === 'error')).toBe(true)
    expect(updateMessage.mock.calls.some(([input]) => input.state === 'streaming')).toBe(true)
    expect(events.some(event => event.kind === 'chat:error' && event.retryable)).toBe(true)
    expect(events).toContainEqual(expect.objectContaining({ kind: 'chat:error', messageId: '22222222-2222-4222-8222-222222222222:assistant:streaming' }))
  })

  it('returns after timeout when a provider ignores abort and converges the assistant message to a retryable error', async () => {
    const appendMessage = vi.fn(async (input: { requestId: string; content: string; state: string }) => ({ messageId: input.requestId }))
    const updateMessage = vi.fn(async (input: { requestId: string; chatId: string; messageId: string; content: string; state: 'streaming' | 'complete' | 'error' }) => { void input })
    const events: ChatRuntimeEvent[] = []
    const runtime = new ChatRuntime({
      appendMessage,
      updateMessage,
      getContext: vi.fn(async () => [{ role: 'user' as const, content: 'hello' }]),
      stream: vi.fn(async () => await new Promise<void>(() => undefined)),
      resolveModel: vi.fn(async () => ({ endpoint: 'http://model', model: 'm', contextLimit: 100, apiKey: null })),
      timeoutMs: 1,
    })

    await expect(settlesWithin(runtime.send({ chatId: 'c1', runId: '28282828-2828-4282-8282-282828282828', content: 'timeout' }, event => events.push(event)))).resolves.toBeUndefined()

    expect(updateMessage).toHaveBeenCalledWith(expect.objectContaining({ content: '聊天请求超时。', state: 'error' }))
    expect(events).toContainEqual(expect.objectContaining({ kind: 'chat:error', error: '聊天请求超时。', retryable: true }))
  })

  it('returns from cancel when a provider ignores abort and converges the assistant message to a non-retryable error', async () => {
    const appendMessage = vi.fn(async (input: { requestId: string; content: string; state: string }) => ({ messageId: input.requestId }))
    const updateMessage = vi.fn(async (input: { requestId: string; chatId: string; messageId: string; content: string; state: 'streaming' | 'complete' | 'error' }) => { void input })
    const events: ChatRuntimeEvent[] = []
    let streamStarted!: () => void
    const started = new Promise<void>(resolve => { streamStarted = resolve })
    const runtime = new ChatRuntime({
      appendMessage,
      updateMessage,
      getContext: vi.fn(async () => [{ role: 'user' as const, content: 'hello' }]),
      stream: vi.fn(async () => { streamStarted(); await new Promise<void>(() => undefined) }),
      resolveModel: vi.fn(async () => ({ endpoint: 'http://model', model: 'm', contextLimit: 100, apiKey: null })),
    })

    const sending = runtime.send({ chatId: 'c1', runId: '29292929-2929-4292-8292-292929292929', content: 'cancel' }, event => events.push(event))
    await started
    await expect(settlesWithin(runtime.cancel('c1'))).resolves.toBeUndefined()
    await expect(settlesWithin(sending)).resolves.toBeUndefined()

    expect(updateMessage).toHaveBeenCalledWith(expect.objectContaining({ content: '已取消。', state: 'error' }))
    expect(events).toContainEqual(expect.objectContaining({ kind: 'chat:error', error: '已取消。', retryable: false }))
  })

  it('still publishes a retryable timeout when the streaming record update fails', async () => {
    const appendMessage = vi.fn(async (input: { requestId: string; state: string }) => ({ messageId: input.requestId }))
    const updateMessage = vi.fn(async () => { throw new Error('disk full') })
    const events: ChatRuntimeEvent[] = []
    const runtime = new ChatRuntime({
      appendMessage,
      updateMessage,
      getContext: vi.fn(async () => [{ role: 'user' as const, content: 'hello' }]),
      stream: vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, 20)) }),
      resolveModel: vi.fn(async () => ({ endpoint: 'http://model', model: 'm', contextLimit: 100, apiKey: null })),
      timeoutMs: 1,
    })

    await expect(runtime.send({ chatId: 'c1', runId: '26262626-2626-4262-8262-262626262626', content: 'timeout' }, event => events.push(event))).resolves.toBeUndefined()
    expect(events).toContainEqual(expect.objectContaining({ kind: 'chat:error', retryable: true, error: '聊天请求超时。' }))
  })

  it('still publishes a retryable timeout when the fallback error append fails', async () => {
    let appendCount = 0
    const appendMessage = vi.fn(async () => {
      appendCount += 1
      if (appendCount <= 2) return { messageId: undefined }
      throw new Error('disk full')
    })
    const events: ChatRuntimeEvent[] = []
    const runtime = new ChatRuntime({
      appendMessage,
      getContext: vi.fn(async () => [{ role: 'user' as const, content: 'hello' }]),
      stream: vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, 20)) }),
      resolveModel: vi.fn(async () => ({ endpoint: 'http://model', model: 'm', contextLimit: 100, apiKey: null })),
      timeoutMs: 1,
    })

    await expect(runtime.send({ chatId: 'c1', runId: '27272727-2727-4272-8272-272727272727', content: 'timeout' }, event => events.push(event))).resolves.toBeUndefined()
    expect(events).toContainEqual(expect.objectContaining({ kind: 'chat:error', retryable: true, error: '聊天请求超时。' }))
  })
})

async function settlesWithin<T>(promise: Promise<T>, timeoutMs = 100): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('operation did not settle')), timeoutMs) }),
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}

function chatMessagesContain(value: unknown, path: string): boolean {
  return Array.isArray(value) && value.some(message => typeof message === 'object' && message !== null && 'content' in message && typeof message.content === 'string' && message.content.includes(path))
}

function chatEventText(event: ChatRuntimeEvent): string {
  return event.kind === 'chat:error' ? event.error : event.content
}
