import { describe, expect, it, vi } from 'vitest'
import { createGlobalChatStore } from '../../../src/renderer/src/stores/global-chat'

describe('global chat store', () => {
  it('keeps drafts per chat and applies only matching stream events', () => {
    const api = { send: vi.fn(), cancel: vi.fn(), onEvent: vi.fn(() => () => undefined) }
    const store = createGlobalChatStore(api)
    store.setDraft('c1', 'hello')
    store.setDraft('c2', 'world')
    store.beginRun('c1', 'r1')
    store.apply({ kind: 'chat:delta', chatId: 'c1', runId: 'r1', messageId: 'm1', content: 'A ' })
    store.apply({ kind: 'chat:delta', chatId: 'c1', runId: 'r0', messageId: 'old', content: 'OLD' })
    expect(store.state.drafts).toEqual({ c1: 'hello', c2: 'world' })
    expect(store.state.messages.c1).toEqual([{ id: 'm1', role: 'assistant', content: 'A ', state: 'streaming' }])
  })

  it('exposes retry for a failed run without adding another user message', async () => {
    const api = { send: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined), onEvent: vi.fn(() => () => undefined) }
    const store = createGlobalChatStore(api)
    store.setDraft('c1', 'retry me')
    await store.send('c1', 'retry me')
    store.apply({ kind: 'chat:error', chatId: 'c1', runId: store.state.runs.c1!, messageId: 'm1', error: 'timeout', retryable: true })
    await store.retry('c1')
    expect(api.send).toHaveBeenCalledTimes(2)
    expect(store.state.messages.c1.filter(message => message.role === 'user')).toHaveLength(1)
  })

  it('does not retry a terminal cancellation received live or restored from legacy history', async () => {
    const api = { send: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined), onEvent: vi.fn(() => () => undefined) }
    const store = createGlobalChatStore(api)

    await store.send('live', 'cancelled question')
    store.apply({ kind: 'chat:error', chatId: 'live', runId: store.state.runs.live!, messageId: 'live-cancelled', error: '已取消。', retryable: false })
    await store.retry('live')

    store.hydrate('reloaded', [
      { id: 'saved-user', role: 'user', content: 'cancelled question', state: 'complete' },
      { id: 'saved-cancelled', role: 'assistant', content: '已取消。', state: 'error' },
    ])
    await store.retry('reloaded')

    expect(api.send).toHaveBeenCalledTimes(1)
    expect(store.state.errors.live).toBe('已取消。')
    expect(store.state.errors.reloaded).toBe('已取消。')
  })

  it('rehydrates retry content from persisted user/error messages and clears error after completion', async () => {
    const api = { send: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined), onEvent: vi.fn(() => () => undefined) }
    const store = createGlobalChatStore(api)
    store.hydrate('c1', [
      { id: 'u1', role: 'user', content: 'saved question', state: 'complete' },
      { id: 'a1', role: 'assistant', content: 'temporary failure', state: 'error' },
    ])
    expect(store.state.errors.c1).toBeTruthy()
    await store.retry('c1')
    const retry = api.send.mock.calls.at(0)?.at(0) as { runId: string } | undefined
    expect(retry).toBeDefined()
    store.apply({ kind: 'chat:completed', chatId: 'c1', runId: retry!.runId, messageId: 'a2', content: 'recovered' })
    expect(api.send).toHaveBeenCalledWith(expect.objectContaining({ content: 'saved question', retry: true }))
    expect(store.state.errors.c1).toBe('')
  })

  it('keeps a historical assistant error in history without surfacing or retrying it after a newer completed exchange', async () => {
    const api = { send: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined), onEvent: vi.fn(() => () => undefined) }
    const store = createGlobalChatStore(api)
    store.hydrate('c1', [
      { id: 'u1', role: 'user', content: 'first question', state: 'complete' },
      { id: 'a1', role: 'assistant', content: 'historical failure', state: 'error' },
      { id: 'u2', role: 'user', content: 'newer question', state: 'complete' },
      { id: 'a2', role: 'assistant', content: 'newer answer', state: 'complete' },
    ])

    expect(store.state.messages.c1).toContainEqual(expect.objectContaining({ id: 'a1', content: 'historical failure', state: 'error' }))
    expect(store.state.errors.c1).toBe('')
    await store.retry('c1')
    expect(api.send).not.toHaveBeenCalled()
    expect(store.state.messages.c1).toContainEqual(expect.objectContaining({ id: 'a1', content: 'historical failure', state: 'error' }))
  })

  it('does not retry a read-only history chat or expose a retry run', async () => {
    const api = { send: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined), onEvent: vi.fn(() => () => undefined) }
    const store = createGlobalChatStore(api)
    store.hydrate('history-1', [
      { id: 'u1', role: 'user', content: 'saved question', state: 'complete' },
      { id: 'a1', role: 'assistant', content: 'temporary failure', state: 'error' },
    ], true)

    await store.retry('history-1')

    expect(api.send).not.toHaveBeenCalled()
    expect(store.state.runs['history-1']).toBeNull()
  })

  it('rejects events whose message id does not belong to the active run', () => {
    const api = { send: vi.fn(), cancel: vi.fn(), onEvent: vi.fn(() => () => undefined) }
    const store = createGlobalChatStore(api)
    store.beginRun('c1', 'r1')
    store.apply({ kind: 'chat:delta', chatId: 'c1', runId: 'r1', messageId: 'm1', content: 'first ' })
    store.apply({ kind: 'chat:completed', chatId: 'c1', runId: 'r1', messageId: 'wrong-message', content: 'wrong' })
    expect(store.state.messages.c1).toEqual([{ id: 'm1', role: 'assistant', content: 'first ', state: 'streaming' }])
  })

  it('does not place sensitive input in renderer state or the IPC request', async () => {
    const api = { send: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined), onEvent: vi.fn(() => () => undefined) }
    const store = createGlobalChatStore(api)
    const secret = 'npm_' + '0'.repeat(36)
    await store.send('c1', `use ${secret}`)
    expect(JSON.stringify(store.state)).not.toContain(secret)
    expect(JSON.stringify(api.send.mock.calls)).not.toContain(secret)
  })

  it('redacts OpenAI project tokens before putting input in renderer state or IPC', async () => {
    const api = { send: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined), onEvent: vi.fn(() => () => undefined) }
    const store = createGlobalChatStore(api)
    const secret = 'sk-proj-' + '0'.repeat(32)
    await store.send('c1', `use ${secret}`)
    expect(JSON.stringify(store.state)).not.toContain(secret)
    expect(JSON.stringify(api.send.mock.calls)).not.toContain(secret)
    expect(store.state.messages.c1?.[0]?.content).toContain('[REDACTED SENSITIVE CONTENT]')
  })

  it('redacts natural-language credentials and JWT-style strings before renderer state or IPC', async () => {
    const api = { send: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined), onEvent: vi.fn(() => () => undefined) }
    const store = createGlobalChatStore(api)
    const jwt = `eyJ${'A'.repeat(12)}.${'B'.repeat(8)}.${'C'.repeat(8)}`
    const sensitiveValues = ['password is synthetic-secret', 'passphrase is synthetic-phrase', 'token is synthetic-token', 'api key is synthetic-key', jwt]

    for (const [index, value] of sensitiveValues.entries()) {
      const chatId = `sensitive-${index}`
      store.setDraft(chatId, value)
      await store.send(chatId, value)
      store.hydrate(`${chatId}-hydrated`, [
        { id: 'u1', role: 'user', content: value, state: 'complete' },
      ])
      store.beginRun(`${chatId}-completed`, `run-${index}`)
      store.apply({ kind: 'chat:completed', chatId: `${chatId}-completed`, runId: `run-${index}`, messageId: `m-${index}`, content: value })

      expect(rendererStateText(store.state).some(content => content.includes(value))).toBe(false)
      expect(JSON.stringify(api.send.mock.calls)).not.toContain(value)
    }
  })

  it('redacts every simulated OpenAI project token before putting input in renderer state or IPC', async () => {
    const api = { send: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined), onEvent: vi.fn(() => () => undefined) }
    const store = createGlobalChatStore(api)
    const firstToken = 'sk-proj-' + 'A'.repeat(32)
    const secondToken = 'sk-proj-' + 'B'.repeat(32)
    await store.send('c1', `use ${firstToken} and ${secondToken}`)

    for (const token of [firstToken, secondToken]) {
      expect(JSON.stringify(store.state)).not.toContain(token)
      expect(JSON.stringify(api.send.mock.calls)).not.toContain(token)
    }
    expect(store.state.messages.c1?.[0]?.content.match(/\[REDACTED SENSITIVE CONTENT\]/g)).toHaveLength(2)
  })

  it('redacts generic OpenAI tokens before putting input in renderer state or IPC', async () => {
    const api = { send: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined), onEvent: vi.fn(() => () => undefined) }
    const store = createGlobalChatStore(api)
    const genericOpenAiToken = 'sk-' + 'A'.repeat(32)
    store.setDraft('c1', `use ${genericOpenAiToken}`)
    await store.send('c1', `use ${genericOpenAiToken}`)
    expect(store.draft('c1').includes(genericOpenAiToken)).toBe(false)
    expect(JSON.stringify(store.state).includes(genericOpenAiToken)).toBe(false)
    expect(JSON.stringify(api.send.mock.calls).includes(genericOpenAiToken)).toBe(false)
    expect(store.state.messages.c1?.[0]?.content).toContain('[REDACTED SENSITIVE CONTENT]')
  })

  it('redacts adjacent generic OpenAI tokens before putting input in renderer state or IPC', async () => {
    const api = { send: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined), onEvent: vi.fn(() => () => undefined) }
    const store = createGlobalChatStore(api)
    const genericOpenAiToken = 'sk-' + 'A'.repeat(32)
    const adjacentValue = `prefixX${genericOpenAiToken}`
    await store.send('c1', adjacentValue)
    expect(JSON.stringify(store.state).includes(genericOpenAiToken)).toBe(false)
    expect(JSON.stringify(api.send.mock.calls).includes(genericOpenAiToken)).toBe(false)
  })

  it.each(['/', '+', '='])('redacts a 40-character Base64 credential ending in %s before putting input in renderer state or IPC', async ending => {
    const api = { send: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined), onEvent: vi.fn(() => () => undefined) }
    const store = createGlobalChatStore(api)
    const base64Credential = 'A'.repeat(39) + ending
    await store.send('c1', `use ${base64Credential}`)

    expect(JSON.stringify(store.state).includes(base64Credential)).toBe(false)
    expect(JSON.stringify(api.send.mock.calls).includes(base64Credential)).toBe(false)
  })

  it('redacts 44-character padded and longer Base64-like input before renderer state or IPC', async () => {
    const api = { send: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined), onEvent: vi.fn(() => () => undefined) }
    const store = createGlobalChatStore(api)
    const paddedCredential = 'A'.repeat(43) + '='
    const extendedCredential = 'A'.repeat(45) + '+/='

    for (const credential of [paddedCredential, extendedCredential]) {
      await store.send('c1', `use ${credential}`)
      expect(JSON.stringify(store.state).includes(credential)).toBe(false)
      expect(JSON.stringify(api.send.mock.calls).includes(credential)).toBe(false)
    }
  })

  it('redacts synthetic temporary and private-key paths from renderer state, IPC, hydration, and events', async () => {
    const sentRequests: Array<{ content: string }> = []
    const api = {
      send: vi.fn(async (request: { chatId: string; runId: string; content: string }) => { sentRequests.push(request) }),
      cancel: vi.fn(async () => undefined),
      onEvent: vi.fn(() => () => undefined),
    }
    const store = createGlobalChatStore(api)
    const temporaryPath = `tmp:${['C:', 'synthetic', 'AppData', 'Local', 'Temp', 'access', 'profile.conf'].join('\\')}`
    const privateKeyPath = ['C:', 'synthetic', '.ssh', 'id_rsa'].join('\\')

    for (const path of [temporaryPath, privateKeyPath]) {
      store.setDraft('input', `use ${path}`)
      await store.send('input', `use ${path}`)
      expect(rendererStateText(store.state).some(content => content.includes(path))).toBe(false)
      expect(sentRequests.some(request => request.content.includes(path))).toBe(false)
    }

    store.hydrate('hydrated', [
      { id: 'u1', role: 'user', content: `saved ${temporaryPath}`, state: 'complete' },
      { id: 'a1', role: 'assistant', content: `saved ${privateKeyPath}`, state: 'complete' },
    ])
    store.beginRun('events', 'run-events')
    store.apply({ kind: 'chat:delta', chatId: 'events', runId: 'run-events', messageId: 'm1', content: `delta ${temporaryPath}` })
    store.apply({ kind: 'chat:completed', chatId: 'events', runId: 'run-events', messageId: 'm1', content: `complete ${privateKeyPath}` })
    store.beginRun('errors', 'run-errors')
    store.apply({ kind: 'chat:error', chatId: 'errors', runId: 'run-errors', messageId: 'm2', error: `error ${temporaryPath}`, retryable: true })

    for (const path of [temporaryPath, privateKeyPath]) expect(rendererStateText(store.state).some(content => content.includes(path))).toBe(false)
  })

  it('redacts wildcard .ssh id_* filenames from intermediate and completed renderer state', () => {
    const api = { send: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined), onEvent: vi.fn(() => () => undefined) }
    const store = createGlobalChatStore(api)
    const customIdentity = '/home/synthetic/.ssh/id_custom'
    store.beginRun('wildcard-identity', 'wildcard-identity-run')

    store.apply({ kind: 'chat:delta', chatId: 'wildcard-identity', runId: 'wildcard-identity-run', messageId: 'wildcard-identity-message', content: `result ${customIdentity}` })
    store.apply({ kind: 'chat:delta', chatId: 'wildcard-identity', runId: 'wildcard-identity-run', messageId: 'wildcard-identity-message', content: ' ' })
    expect(rendererStateText(store.state).join('')).not.toContain(customIdentity)

    store.beginRun('wildcard-identity-completed', 'wildcard-identity-completed-run')
    store.apply({ kind: 'chat:completed', chatId: 'wildcard-identity-completed', runId: 'wildcard-identity-completed-run', messageId: 'wildcard-identity-completed-message', content: `complete ${customIdentity}` })
    expect(rendererStateText(store.state).join('')).not.toContain(customIdentity)
  })

  it.each([
    ['a split .ssh private-key filename', () => {
      const base = ['C:', 'synthetic', '.ssh', 'id_'].join('\\')
      return { value: `${base}rsa`, parts: [base, 'rsa'] }
    }],
    ['a split .pem private-key filename', () => {
      const base = ['C:', 'synthetic', 'keys', 'identity'].join('\\')
      return { value: `${base}.pem`, parts: [base, '.pem'] }
    }],
    ['a split .ppk private-key filename', () => {
      const base = ['C:', 'synthetic', 'keys', 'identity'].join('\\')
      return { value: `${base}.ppk`, parts: [base, '.ppk'] }
    }],
    ['a split .key private-key filename', () => {
      const base = ['C:', 'synthetic', 'keys', 'identity'].join('\\')
      return { value: `${base}.key`, parts: [base, '.key'] }
    }],
    ['a split temporary profile path', () => {
      const value = `tmp:${['C:', 'synthetic', 'AppData', 'Local', 'Temp', 'access', 'profile.conf'].join('\\')}`
      return { value, parts: ['tmp:', value.slice(4)] }
    }],
    ['a split OpenAI project credential', () => {
      const prefix = 'sk-proj-'
      return { value: prefix + 'A'.repeat(32), parts: [prefix, 'A'.repeat(32)] }
    }],
    ['a split padded 44-character Base64-like credential', () => {
      const value = 'A'.repeat(43) + '='
      return { value, parts: [value.slice(0, 21), value.slice(21)] }
    }],
    ['a split long /+= Base64-like credential', () => {
      const value = 'A'.repeat(45) + '+/='
      return { value, parts: [value.slice(0, 30), value.slice(30)] }
    }],
  ])('never reconstructs %s in reactive message state across renderer deltas', (_description, createCandidate) => {
    const api = { send: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined), onEvent: vi.fn(() => () => undefined) }
    const store = createGlobalChatStore(api)
    const { value, parts } = createCandidate()
    const chatId = `split-${parts[0].length}`
    const runId = `split-run-${parts[0].length}`
    const messageId = `split-message-${parts[0].length}`
    store.beginRun(chatId, runId)

    for (const [index, part] of parts.entries()) {
      store.apply({ kind: 'chat:delta', chatId, runId, messageId, content: part })
      const content = messageContent(store, chatId, messageId)
      if (index === 0) expect(content.includes(part)).toBe(false)
      expect(content.includes(value)).toBe(false)
    }
  })

  it('uses completed content authoritatively and discards split candidates on completion, error, cancellation, and supersession', async () => {
    const api = { send: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined), onEvent: vi.fn(() => () => undefined) }
    const store = createGlobalChatStore(api)
    const prefix = 'sk-proj-'
    const credential = prefix + 'A'.repeat(32)
    const suffix = credential.slice(prefix.length)

    store.beginRun('completed', 'run-completed')
    store.apply({ kind: 'chat:delta', chatId: 'completed', runId: 'run-completed', messageId: 'message-completed', content: prefix })
    expect(messageContent(store, 'completed', 'message-completed').includes(prefix)).toBe(false)
    expect(messageContent(store, 'completed', 'message-completed').includes(credential)).toBe(false)
    store.apply({ kind: 'chat:completed', chatId: 'completed', runId: 'run-completed', messageId: 'message-completed', content: `finished ${credential}` })
    expect(messageContent(store, 'completed', 'message-completed').includes(credential)).toBe(false)
    expect(store.state.messages.completed?.find(message => message.id === 'message-completed')).toMatchObject({ state: 'complete' })

    store.beginRun('error', 'run-error')
    store.apply({ kind: 'chat:delta', chatId: 'error', runId: 'run-error', messageId: 'message-error', content: prefix })
    expect(messageContent(store, 'error', 'message-error').includes(prefix)).toBe(false)
    expect(messageContent(store, 'error', 'message-error').includes(credential)).toBe(false)
    store.apply({ kind: 'chat:error', chatId: 'error', runId: 'run-error', messageId: 'message-error', error: 'failed', retryable: true })
    store.beginRun('error', 'run-error-next')
    store.apply({ kind: 'chat:delta', chatId: 'error', runId: 'run-error-next', messageId: 'message-error-next', content: 'after-error ' })
    expect(messageContent(store, 'error', 'message-error-next')).toBe('after-error ')
    expect(rendererStateText(store.state).some(content => content.includes(suffix))).toBe(false)

    store.beginRun('cancel', 'run-cancel')
    store.apply({ kind: 'chat:delta', chatId: 'cancel', runId: 'run-cancel', messageId: 'message-cancel', content: prefix })
    expect(messageContent(store, 'cancel', 'message-cancel').includes(prefix)).toBe(false)
    expect(messageContent(store, 'cancel', 'message-cancel').includes(credential)).toBe(false)
    await store.cancel('cancel')
    store.beginRun('cancel', 'run-cancel-next')
    store.apply({ kind: 'chat:delta', chatId: 'cancel', runId: 'run-cancel-next', messageId: 'message-cancel-next', content: 'after-cancel ' })
    expect(messageContent(store, 'cancel', 'message-cancel-next')).toBe('after-cancel ')

    store.beginRun('supersede', 'run-old')
    store.apply({ kind: 'chat:delta', chatId: 'supersede', runId: 'run-old', messageId: 'message-old', content: prefix })
    expect(messageContent(store, 'supersede', 'message-old').includes(prefix)).toBe(false)
    expect(messageContent(store, 'supersede', 'message-old').includes(credential)).toBe(false)
    store.beginRun('supersede', 'run-new')
    store.apply({ kind: 'chat:delta', chatId: 'supersede', runId: 'run-old', messageId: 'message-old', content: suffix })
    store.apply({ kind: 'chat:delta', chatId: 'supersede', runId: 'run-new', messageId: 'message-new', content: 'after-supersede ' })
    expect(messageContent(store, 'supersede', 'message-new')).toBe('after-supersede ')
    expect(rendererStateText(store.state).some(content => content.includes(credential))).toBe(false)
  })

  it('releases a normal delimited filesystem path without waiting for completion', () => {
    const api = { send: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined), onEvent: vi.fn(() => () => undefined) }
    const store = createGlobalChatStore(api)
    const normalPath = ['C:', 'synthetic', 'notes', 'readme.txt'].join('\\')
    store.beginRun('normal-path', 'normal-path-run')
    store.apply({ kind: 'chat:delta', chatId: 'normal-path', runId: 'normal-path-run', messageId: 'normal-path-message', content: `open ${normalPath}` })
    expect(messageContent(store, 'normal-path', 'normal-path-message')).toBe('open ')
    store.apply({ kind: 'chat:delta', chatId: 'normal-path', runId: 'normal-path-run', messageId: 'normal-path-message', content: ' ' })

    expect(messageContent(store, 'normal-path', 'normal-path-message')).toBe(`open ${normalPath} `)
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
  ])('never exposes any boundary of %s in reactive state', (_description, value, opening, closing) => {
    for (let cut = 1; cut < value.length; cut += 1) {
      const api = { send: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined), onEvent: vi.fn(() => () => undefined) }
      const store = createGlobalChatStore(api)
      const chatId = `boundary-${value.length}-${cut}`
      const runId = `run-${value.length}-${cut}`
      const messageId = `message-${value.length}-${cut}`
      const prefix = value.slice(0, cut)
      store.beginRun(chatId, runId)

      store.apply({ kind: 'chat:delta', chatId, runId, messageId, content: `${opening}${prefix}` })
      expect(messageContent(store, chatId, messageId).endsWith(prefix)).toBe(false)

      store.apply({ kind: 'chat:delta', chatId, runId, messageId, content: `${value.slice(cut)}${closing}` })
      const visible = messageContent(store, chatId, messageId)
      expect(visible).not.toContain(value)
      expect(rendererStateText(store.state).join('')).not.toContain(value)
      expect(visible).toContain('[REDACTED SENSITIVE CONTENT]')
    }
  })

  it('releases a normal JSON-quoted path as soon as its closing delimiter arrives', () => {
    const api = { send: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined), onEvent: vi.fn(() => () => undefined) }
    const store = createGlobalChatStore(api)
    const path = ['C:', 'synthetic', 'notes', 'readme.txt'].join('\\')
    store.beginRun('quoted-normal-path', 'quoted-normal-path-run')
    store.apply({ kind: 'chat:delta', chatId: 'quoted-normal-path', runId: 'quoted-normal-path-run', messageId: 'quoted-normal-path-message', content: `JSON {"path":"${path}` })
    expect(messageContent(store, 'quoted-normal-path', 'quoted-normal-path-message')).toBe('JSON {"path":"')

    store.apply({ kind: 'chat:delta', chatId: 'quoted-normal-path', runId: 'quoted-normal-path-run', messageId: 'quoted-normal-path-message', content: '"} ' })
    expect(messageContent(store, 'quoted-normal-path', 'quoted-normal-path-message')).toBe(`JSON {"path":"${path}"} `)
  })

  it('rejects every ordinary event from a run invalidated by hydration', () => {
    const api = { send: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined), onEvent: vi.fn(() => () => undefined) }
    const store = createGlobalChatStore(api)
    store.beginRun('c1', 'stale-run')
    store.hydrate('c1', [
      { id: 'saved-user', role: 'user', content: 'saved question', state: 'complete' },
      { id: 'saved-answer', role: 'assistant', content: 'saved answer', state: 'complete' },
    ])

    store.apply({ kind: 'chat:delta', chatId: 'c1', runId: 'stale-run', messageId: 'stale-assistant', content: 'stale delta' })
    store.apply({ kind: 'chat:completed', chatId: 'c1', runId: 'stale-run', messageId: 'stale-assistant', content: 'stale completion' })
    store.apply({ kind: 'chat:error', chatId: 'c1', runId: 'stale-run', messageId: 'stale-assistant', error: 'stale error', retryable: true })

    expect(store.state.runs.c1).toBeNull()
    expect(store.state.errors.c1).toBe('')
    expect(store.state.activeMessageIds.c1).toBeNull()
    expect(store.state.messages.c1).toEqual([
      { id: 'saved-user', role: 'user', content: 'saved question', state: 'complete' },
      { id: 'saved-answer', role: 'assistant', content: 'saved answer', state: 'complete' },
    ])
  })

  it('clears a cancelled run immediately and ignores late events', async () => {
    const api = { send: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined), onEvent: vi.fn(() => () => undefined) }
    const store = createGlobalChatStore(api)
    store.beginRun('c1', 'r1')
    store.apply({ kind: 'chat:delta', chatId: 'c1', runId: 'r1', messageId: 'm1', content: 'partial' })
    await store.cancel('c1')
    expect(api.cancel).toHaveBeenCalledWith('c1')
    expect(store.state.runs.c1).toBeNull()
    expect(store.state.activeMessageIds.c1).toBeNull()
    store.apply({ kind: 'chat:delta', chatId: 'c1', runId: 'r1', messageId: 'm1', content: 'late' })
    expect(store.state.messages.c1?.[0]).toMatchObject({ content: '已取消。', state: 'error' })
  })

  it('surfaces a safe terminal status when durable cancellation fails without creating a terminal message', async () => {
    const persistenceFailure = 'storage password is synthetic-secret'
    const api = {
      send: vi.fn(async () => undefined),
      cancel: vi.fn(async () => { throw new Error(persistenceFailure) }),
      onEvent: vi.fn(() => () => undefined),
    }
    const store = createGlobalChatStore(api)
    store.beginRun('c1', 'r1')

    await expect(store.cancel('c1')).resolves.toBeUndefined()

    expect(store.state.runs.c1).toBeNull()
    expect(store.state.activeMessageIds.c1).toBeNull()
    expect(store.state.errors.c1).toBe('取消状态未能保存，请重新加载后确认。')
    expect(store.state.retryableErrors.c1).toBe(false)
    expect(store.state.messages.c1).toBeUndefined()
    expect(JSON.stringify(store.state)).not.toContain(persistenceFailure)
  })

  it('keeps the run registered until an authoritative pre-stream cancellation event arrives', async () => {
    let emit!: (event: Parameters<ReturnType<typeof createGlobalChatStore>['apply']>[0]) => void
    const api = {
      send: vi.fn(async () => undefined),
      cancel: vi.fn(async () => {
        emit({ kind: 'chat:error', chatId: 'c1', runId: 'r1', messageId: 'durable-cancelled-assistant', error: '已取消。', retryable: false })
      }),
      onEvent: vi.fn(listener => {
        emit = listener
        return () => undefined
      }),
    }
    const store = createGlobalChatStore(api)
    store.beginRun('c1', 'r1')

    await store.cancel('c1')

    expect(store.state.runs.c1).toBeNull()
    expect(store.state.errors.c1).toBe('已取消。')
    expect(store.state.activeMessageIds.c1).toBe('durable-cancelled-assistant')
  })

  it('accepts the matching pre-stream cancellation event when IPC delivers it after cancel resolves', async () => {
    let emit!: (event: Parameters<ReturnType<typeof createGlobalChatStore>['apply']>[0]) => void
    const api = {
      send: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
      onEvent: vi.fn(listener => {
        emit = listener
        return () => undefined
      }),
    }
    const store = createGlobalChatStore(api)
    store.beginRun('c1', 'r1')

    await store.cancel('c1')
    emit({ kind: 'chat:error', chatId: 'c1', runId: 'r1', messageId: 'late-durable-cancelled-assistant', error: '已取消。', retryable: false })

    expect(store.state.errors.c1).toBe('已取消。')
    expect(store.state.activeMessageIds.c1).toBe('late-durable-cancelled-assistant')
  })

  it.each(['a newer run', 'hydration'] as const)('rejects a late cancelled-run event after %s clears its allowance', async transition => {
    let emit!: (event: Parameters<ReturnType<typeof createGlobalChatStore>['apply']>[0]) => void
    const api = {
      send: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
      onEvent: vi.fn(listener => {
        emit = listener
        return () => undefined
      }),
    }
    const store = createGlobalChatStore(api)
    store.beginRun('c1', 'cancelled-run')
    await store.cancel('c1')
    if (transition === 'a newer run') store.beginRun('c1', 'new-run')
    else store.hydrate('c1', [{ id: 'saved-user', role: 'user', content: 'saved', state: 'complete' }])

    emit({ kind: 'chat:error', chatId: 'c1', runId: 'cancelled-run', messageId: 'late-cancelled-assistant', error: '已取消。', retryable: false })

    expect(store.state.errors.c1).not.toBe('已取消。')
    expect(store.state.activeMessageIds.c1).not.toBe('late-cancelled-assistant')
    if (transition === 'a newer run') expect(store.state.runs.c1).toBe('new-run')
    else expect(store.state.messages.c1).toEqual([{ id: 'saved-user', role: 'user', content: 'saved', state: 'complete' }])
  })

  it('surfaces a run-scoped error even when the model fails before its first delta', () => {
    const api = { send: vi.fn(), cancel: vi.fn(), onEvent: vi.fn(() => () => undefined) }
    const store = createGlobalChatStore(api)
    store.beginRun('c1', 'r1')
    store.apply({ kind: 'chat:error', chatId: 'c1', runId: 'r1', messageId: 'm1', error: '模型连接失败', retryable: true })
    expect(store.state.errors.c1).toBe('模型连接失败')
  })
})

function rendererStateText(state: {
  drafts: Record<string, string>
  messages: Record<string, Array<{ content: string }>>
  errors: Record<string, string>
}): string[] {
  return [
    ...Object.values(state.drafts),
    ...Object.values(state.messages).flatMap(messages => messages.map(message => message.content)),
    ...Object.values(state.errors),
  ]
}

function messageContent(store: ReturnType<typeof createGlobalChatStore>, chatId: string, messageId: string): string {
  return store.state.messages[chatId]?.find(message => message.id === messageId)?.content ?? ''
}
