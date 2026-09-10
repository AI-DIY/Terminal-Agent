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

  it('passes user content and streamed model output through unchanged', async () => {
    const temporaryPath = `tmp:${['C:', 'synthetic', 'AppData', 'Local', 'Temp', 'access', 'profile.conf'].join('\\')}`
    const tokenLike = `sk-proj-${'A'.repeat(32)}`
    const appendMessage = vi.fn(async (input: { requestId: string; role?: string; state?: string; content?: string }) => ({ messageId: input.requestId }))
    const events: ChatRuntimeEvent[] = []
    const runtime = new ChatRuntime({
      appendMessage,
      getContext: vi.fn(async () => [{ role: 'user' as const, content: 'hello' }]),
      stream: vi.fn(async (_settings, _messages, onDelta) => { onDelta(`result ${temporaryPath} `); onDelta(tokenLike) }),
      resolveModel: vi.fn(async () => ({ endpoint: 'http://model', model: 'm', contextLimit: 100, apiKey: null })),
    })
    await runtime.send({ chatId: 'c1', runId: '11111111-1111-4111-8111-111111111111', content: `check ${temporaryPath}` }, event => events.push(event))
    const serialized = JSON.stringify(events) + JSON.stringify(appendMessage.mock.calls)
    const decoded = JSON.parse(`[${serialized.replace('][', ',')}]`)
    expect(JSON.stringify(decoded)).toContain(tokenLike)
    expect(events.some(event => event.kind === 'chat:delta' && event.content.includes(temporaryPath))).toBe(true)
    expect(appendMessage.mock.calls.some(([request]) => request.content === `check ${temporaryPath}`)).toBe(true)
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

  it('persists token-looking user input unchanged before model execution', async () => {
    const appendMessage = vi.fn(async (input: { requestId: string; role?: string }) => ({ messageId: input.requestId }))
    const secret = 'glpat-' + '0'.repeat(20)
    const runtime = new ChatRuntime({
      appendMessage,
      getContext: vi.fn(async () => [{ role: 'user' as const, content: 'hello' }]),
      stream: vi.fn(async () => undefined),
      resolveModel: vi.fn(async () => ({ endpoint: 'http://model', model: 'm', contextLimit: 100, apiKey: null })),
    })
    await runtime.send({ chatId: 'c1', runId: '44444444-4444-4444-8444-444444444444', content: `please use ${secret}` }, () => undefined)
    expect(appendMessage.mock.calls[0]?.[0]).toMatchObject({ content: `please use ${secret}` })
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

  it('publishes transient structured progress and no deltas before the final JSON event', async () => {
    const events: ChatRuntimeEvent[] = []
    const runtime = new ChatRuntime({
      appendMessage: vi.fn(async (input: { requestId: string }) => ({ messageId: input.requestId })),
      getContext: vi.fn(async () => ({ messages: [{ role: 'user' as const, content: 'check' }], hasImages: false, availableHostnames: ['web-02'] })),
      resolveModel: vi.fn(async () => ({ endpoint: 'http://model', model: 'm', contextLimit: 100, apiKey: null })),
      runStructured: vi.fn(async () => ({ version: 1 as const, reply: '完成', plan: null })),
      stream: vi.fn(async () => undefined),
    })
    await runtime.send({ chatId: 'c1', runId: '77777777-7777-4777-8777-777777777777', content: 'check' }, event => events.push(event))
    expect(events.some(event => event.kind === 'chat:progress')).toBe(true)
    expect(events.some(event => event.kind === 'chat:delta')).toBe(false)
    expect(events.at(-1)).toMatchObject({ kind: 'chat:completed', content: '{"version":1,"reply":"完成","plan":null}' })
  })

  it('passes the ordered shell display context into structured generation', async () => {
    const availableShells = [{ hostname: 'web-01', title: '生产终端', displayLabel: 'web-01 #1', ordinal: 1 }]
    const runStructured = vi.fn(async (_settings: unknown, input: { availableHostnames: string[]; availableShells?: typeof availableShells }) => {
      expect(input.availableHostnames).toEqual(['web-01'])
      expect(input.availableShells).toEqual(availableShells)
      return { version: 1 as const, reply: '完成', plan: null }
    })
    const runtime = new ChatRuntime({
      appendMessage: vi.fn(async (input: { requestId: string }) => ({ messageId: input.requestId })),
      getContext: vi.fn(async () => ({ messages: [{ role: 'user' as const, content: 'check' }], hasImages: false, availableHostnames: ['web-01'], availableShells })),
      resolveModel: vi.fn(async () => ({ endpoint: 'http://model', model: 'm', contextLimit: 100, apiKey: null })),
      runStructured,
      stream: vi.fn(async () => undefined),
    })

    await runtime.send({ chatId: 'c1', runId: '78787878-7878-4787-8787-787878787878', content: 'check' }, () => undefined)

    expect(runStructured).toHaveBeenCalledTimes(1)
  })

  it('forwards the selected SSH connection ids to context construction', async () => {
    const getContext = vi.fn(async () => ({
      messages: [{ role: 'user' as const, content: 'check' }],
      hasImages: false,
      availableHostnames: [],
    }))
    const runtime = new ChatRuntime({
      appendMessage: vi.fn(async (input: { requestId: string }) => ({ messageId: input.requestId })),
      getContext,
      resolveModel: vi.fn(async () => ({ endpoint: 'http://model', model: 'm', contextLimit: 100, apiKey: null })),
      stream: vi.fn(async () => undefined),
    })

    await runtime.send({
      chatId: 'c1',
      runId: '79797979-7979-4797-8797-797979797979',
      content: 'check',
      sshContextLines: 240,
      sshContextSessionIds: ['alternate'],
    }, () => undefined)

    expect(getContext).toHaveBeenCalledWith('c1', { sshContextLines: 240, sshContextSessionIds: ['alternate'] })
  })

  it('continues from approved-plan output with selected SSH context without persisting a synthetic user message', async () => {
    const appendMessage = vi.fn(async (input: { requestId: string; role?: string }) => ({ messageId: input.requestId }))
    const getContext = vi.fn(async () => ({
      messages: [{ role: 'user' as const, content: '历史任务：检查服务状态。' }],
      hasImages: false,
      availableHostnames: ['web-01'],
    }))
    const runStructured = vi.fn(async (_settings: unknown, input: { messages: Array<{ role: string; content: string }>; skillIds?: string[] }) => {
      expect(input.messages).toContainEqual({ role: 'user', content: '历史任务：检查服务状态。' })
      expect(input.messages.at(-1)?.content).toContain('用户已经确认并发送此前执行计划')
      expect(input.skillIds).toEqual(['security-review'])
      return { version: 1 as const, reply: '已收到 SSH 返回结果。', plan: null }
    })
    const runtime = new ChatRuntime({
      appendMessage,
      getContext,
      resolveModel: vi.fn(async () => ({ endpoint: 'http://model', model: 'm', contextLimit: 10_000, apiKey: null })),
      runStructured,
      stream: vi.fn(async () => undefined),
    })
    const events: ChatRuntimeEvent[] = []

    await expect(runtime.continueAfterPlanResult({
      chatId: 'c1',
      sshContextLines: 125,
      sshContextSessionIds: ['primary', 'alternate'],
      skillIds: ['security-review'],
    }, event => events.push(event))).resolves.toBe(true)

    expect(getContext).toHaveBeenCalledWith('c1', {
      sshContextLines: 125,
      sshContextSessionIds: ['primary', 'alternate'],
      skillIds: ['security-review'],
    })
    expect(appendMessage.mock.calls.map(([request]) => request).filter(request => request.role === 'user')).toEqual([])
    expect(events[0]).toMatchObject({ kind: 'chat:auto-started', chatId: 'c1' })
    expect(events.at(-1)).toMatchObject({ kind: 'chat:completed', content: '{"version":1,"reply":"已收到 SSH 返回结果。","plan":null}' })
  })

  it('does not let an idle-only automatic turn supersede an active user run', async () => {
    const userRunStarted = deferred<void>()
    const releaseUserRun = deferred<void>()
    const runStructured = vi.fn(async (_settings: unknown, input: { messages: Array<{ role: string; content: string }> }) => {
      if (input.messages.at(-1)?.content === '用户请求') {
        userRunStarted.resolve()
        await releaseUserRun.promise
      }
      return { version: 1 as const, reply: '完成', plan: null }
    })
    const runtime = new ChatRuntime({
      appendMessage: vi.fn(async (input: { requestId: string; role?: string }) => ({ messageId: input.requestId })),
      getContext: vi.fn(async () => ({ messages: [{ role: 'user' as const, content: '用户请求' }], hasImages: false, availableHostnames: [] })),
      resolveModel: vi.fn(async () => ({ endpoint: 'http://model', model: 'm', contextLimit: 10_000, apiKey: null })),
      runStructured,
      stream: vi.fn(async () => undefined),
    })
    // Invoke the automatic turn first, then enter the user turn before the
    // automatic send resumes from its initial async boundary. The user epoch
    // must make the automatic request return without taking ownership.
    const auto = runtime.continueAfterPlanResult({ chatId: 'c1' }, () => undefined)
    const user = runtime.send({ chatId: 'c1', runId: 'user-run', content: '用户请求' }, () => undefined)
    await userRunStarted
    await expect(auto).resolves.toBe(false)
    releaseUserRun.resolve()
    await user
    expect(runStructured).toHaveBeenCalledTimes(1)
  })

  it('forwards enabled product skills to structured generation', async () => {
    const getContext = vi.fn(async () => ({
      messages: [{ role: 'user' as const, content: 'check' }],
      hasImages: false,
      availableHostnames: [],
    }))
    const runStructured = vi.fn(async (_settings: unknown, input: { skillIds?: string[] }) => {
      expect(input.skillIds).toEqual(['security-review'])
      return { version: 1 as const, reply: 'done', plan: null }
    })
    const runtime = new ChatRuntime({
      appendMessage: vi.fn(async (input: { requestId: string }) => ({ messageId: input.requestId })),
      getContext,
      resolveModel: vi.fn(async () => ({ endpoint: 'http://model', model: 'm', contextLimit: 100, apiKey: null })),
      runStructured,
      stream: vi.fn(async () => undefined),
    })

    await runtime.send({
      chatId: 'c1',
      runId: '89898989-8989-4898-8898-898989898989',
      content: 'check',
      skillIds: ['security-review'],
    }, () => undefined)

    expect(getContext).toHaveBeenCalledWith('c1', { sshContextLines: undefined, skillIds: ['security-review'] })
    expect(runStructured).toHaveBeenCalledOnce()
  })

  it('forwards an explicit dynamic Skill and its run-scoped local bridge without requiring an online Shell', async () => {
    const document = {
      id: 'query-system-inspection',
      name: 'query-system-inspection',
      description: 'Queries a local source.',
      content: '---\nname: query-system-inspection\ndescription: Queries a local source.\n---',
    }
    const loadSkill = vi.fn().mockResolvedValue(document)
    const runSkillCommand = vi.fn()
    const getContext = vi.fn(async () => ({
      messages: [{ role: 'user' as const, content: 'query e0074566' }],
      hasImages: false,
      availableHostnames: [],
      selectedSkillIds: ['query-system-inspection'],
      skillCatalog: [{ id: 'query-system-inspection', name: 'query-system-inspection', description: document.description, enabled: true }],
    }))
    const runStructured = vi.fn(async (_settings: unknown, input: {
      selectedSkillIds?: string[]
      skillCatalog?: Array<{ id: string }>
      skillRuntime?: { loadSkill(id: string): Promise<unknown> }
      availableHostnames: string[]
    }) => {
      expect(input.availableHostnames).toEqual([])
      expect(input.selectedSkillIds).toEqual(['query-system-inspection'])
      expect(input.skillCatalog).toEqual([{ id: 'query-system-inspection', name: 'query-system-inspection', description: document.description, enabled: true }])
      await expect(input.skillRuntime?.loadSkill('query-system-inspection')).resolves.toEqual(document)
      return { version: 1 as const, reply: 'done', plan: null }
    })
    const runtime = new ChatRuntime({
      appendMessage: vi.fn(async (input: { requestId: string }) => ({ messageId: input.requestId })),
      getContext,
      resolveModel: vi.fn(async () => ({ endpoint: 'http://model', model: 'm', contextLimit: 100, apiKey: null })),
      runStructured,
      stream: vi.fn(async () => undefined),
      skillRuntime: { loadSkill, readSkillFile: vi.fn(), runSkillCommand },
    })

    await runtime.send({
      chatId: 'c1',
      runId: '78787878-7878-4787-8787-787878787878',
      content: 'query e0074566',
      selectedSkillIds: ['query-system-inspection'],
    }, () => undefined)

    expect(getContext).toHaveBeenCalledWith('c1', {
      sshContextLines: undefined,
      selectedSkillIds: ['query-system-inspection'],
    })
    expect(loadSkill).toHaveBeenCalledWith('query-system-inspection', undefined)
    expect(runSkillCommand).not.toHaveBeenCalled()
  })

  it('uses structured generation for Ollama instead of exposing raw stream deltas', async () => {
    const events: ChatRuntimeEvent[] = []
    const runStructured = vi.fn(async () => ({ version: 1 as const, reply: 'Ollama 完成', plan: null }))
    const stream = vi.fn(async (_settings: unknown, _messages: unknown, onDelta: (content: string) => void) => {
      onDelta('raw ollama delta')
    })
    const runtime = new ChatRuntime({
      appendMessage: vi.fn(async (input: { requestId: string }) => ({ messageId: input.requestId })),
      getContext: vi.fn(async () => ({ messages: [{ role: 'user' as const, content: 'check' }], hasImages: false, availableHostnames: [] })),
      resolveModel: vi.fn(async () => ({ provider: 'ollama' as const, endpoint: 'http://model', model: 'm', contextLimit: 100, apiKey: null })),
      runStructured,
      stream,
    })

    await runtime.send({ chatId: 'c1', runId: '79797979-7979-4797-8797-797979797979', content: 'check' }, event => events.push(event))

    expect(runStructured).toHaveBeenCalledTimes(1)
    expect(stream).not.toHaveBeenCalled()
    expect(events.some(event => event.kind === 'chat:delta')).toBe(false)
    expect(events.at(-1)).toMatchObject({ kind: 'chat:completed', content: '{"version":1,"reply":"Ollama 完成","plan":null}' })
  })

  it('does not fall back to raw deltas when structured generation fails', async () => {
    const events: ChatRuntimeEvent[] = []
    const runStructured = vi.fn(async () => { throw new Error('structured unavailable') })
    const stream = vi.fn(async (_settings: unknown, _messages: unknown, onDelta: (content: string) => void) => {
      onDelta('raw fallback')
    })
    const runtime = new ChatRuntime({
      appendMessage: vi.fn(async (input: { requestId: string }) => ({ messageId: input.requestId })),
      getContext: vi.fn(async () => ({ messages: [{ role: 'user' as const, content: 'check' }], hasImages: false, availableHostnames: [] })),
      resolveModel: vi.fn(async () => ({ provider: 'ollama' as const, endpoint: 'http://model', model: 'm', contextLimit: 100, apiKey: null })),
      runStructured,
      stream,
    })

    await runtime.send({ chatId: 'c1', runId: '80808080-8080-4808-8808-808080808080', content: 'check' }, event => events.push(event))

    expect(runStructured).toHaveBeenCalledTimes(1)
    expect(stream).not.toHaveBeenCalled()
    expect(events.some(event => event.kind === 'chat:delta')).toBe(false)
    expect(events.at(-1)).toMatchObject({ kind: 'chat:error', retryable: true })
  })

  it('keeps the compaction lock through summary persistence before starting a new send', async () => {
    const persistence = deferred<{ persisted: true }>()
    let persistenceStarted!: () => void
    const persistenceBegan = new Promise<void>(resolve => { persistenceStarted = resolve })
    const calls: string[] = []
    const runStructured = vi.fn(async (_settings: unknown, input: { messages: Array<{ content?: unknown }> }) => {
      const isCompaction = input.messages.some(message => typeof message.content === 'string' && message.content.includes('上下文压缩'))
      calls.push(isCompaction ? 'compact' : 'send')
      return { version: 1 as const, reply: isCompaction ? '任务摘要' : '新回复', plan: null }
    })
    const appendMessage = vi.fn(async (request: { requestId: string }) => ({ messageId: request.requestId }))
    const runtime = new ChatRuntime({
      appendMessage,
      getContext: vi.fn(async () => [{ role: 'user' as const, content: '历史问题' }]),
      resolveModel: vi.fn(async () => ({ endpoint: 'http://model', model: 'm', contextLimit: 1000, apiKey: null })),
      runStructured,
      stream: vi.fn(async () => undefined),
    })

    const compacting = runtime.compactAndPersist(
      { requestId: 'compact-lock-1', chatId: 'c1' },
      async summary => {
        expect(summary).toBe('任务摘要')
        persistenceStarted()
        return persistence.promise
      },
    )
    await persistenceBegan

    const sending = runtime.send({ chatId: 'c1', runId: '90909090-9090-4090-8090-909090909090', content: '新请求' }, () => undefined)
    await Promise.resolve()
    expect(calls).toEqual(['compact'])
    expect(appendMessage.mock.calls.some(([request]) => request.requestId === '90909090-9090-4090-8090-909090909090:user')).toBe(false)

    persistence.resolve({ persisted: true })
    await expect(compacting).resolves.toEqual({ persisted: true })
    await expect(sending).resolves.toBeUndefined()
    expect(calls).toEqual(['compact', 'send'])
  })

  it('serializes concurrent compactions for one chat while allowing independent chats to proceed', async () => {
    const firstSummary = deferred<void>()
    let sameChatCalls = 0
    let otherChatCalls = 0
    const runStructured = vi.fn(async (_settings: unknown, input: { messages: Array<{ content?: unknown }> }) => {
      const chatMarker = input.messages.find(message => message.content === 'same-chat' || message.content === 'other-chat')?.content
      if (chatMarker === 'same-chat') {
        const ordinal = ++sameChatCalls
        if (ordinal === 1) await firstSummary.promise
        return { version: 1 as const, reply: `same-${ordinal}`, plan: null }
      }
      otherChatCalls += 1
      return { version: 1 as const, reply: 'other-1', plan: null }
    })
    const runtime = new ChatRuntime({
      appendMessage: vi.fn(async (request: { requestId: string }) => ({ messageId: request.requestId })),
      getContext: vi.fn(async chatId => [{ role: 'user' as const, content: chatId }]),
      resolveModel: vi.fn(async () => ({ endpoint: 'http://model', model: 'm', contextLimit: 1000, apiKey: null })),
      runStructured,
      stream: vi.fn(async () => undefined),
    })

    const first = runtime.compact({ requestId: 'compact-one', chatId: 'same-chat' })
    await vi.waitFor(() => expect(sameChatCalls).toBe(1))
    const second = runtime.compact({ requestId: 'compact-two', chatId: 'same-chat' })
    const independent = runtime.compact({ requestId: 'compact-three', chatId: 'other-chat' })
    await vi.waitFor(() => expect(otherChatCalls).toBe(1))
    firstSummary.resolve()
    await expect(independent).resolves.toBe('other-1')
    await expect(first).resolves.toBe('same-1')
    await expect(second).resolves.toBe('same-2')
    expect(sameChatCalls).toBe(2)
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
