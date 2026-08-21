import { describe, expect, it } from 'vitest'
import { createSessionsStore, MAX_SESSION_BUFFER_CHARS, sessionLabel } from '../../../src/renderer/src/stores/sessions'

describe('sessions store', () => {
  it('keeps terminal data isolated by session id', () => {
    const store = createSessionsStore()
    store.add({ id: 'a', hostname: 'alpha', mode: 'copilot' })
    store.add({ id: 'b', hostname: 'beta', mode: 'copilot' })
    store.appendData('a', 'alpha output')

    expect(store.byId('a')?.buffer).toBe('alpha output')
    expect(store.byId('b')?.buffer).toBe('')
  })

  it('retains only the newest bounded tail for a hidden session without affecting other sessions', () => {
    const store = createSessionsStore()
    store.add({ id: 'a', hostname: 'alpha', mode: 'copilot' })
    store.add({ id: 'b', hostname: 'beta', mode: 'copilot' })
    const original = 'x'.repeat(MAX_SESSION_BUFFER_CHARS)

    store.appendData('a', original)
    store.appendData('a', 'tail')

    expect(store.byId('a')?.buffer).toBe(`${original.slice('tail'.length)}tail`)
    expect(store.byId('a')?.buffer).toHaveLength(MAX_SESSION_BUFFER_CHARS)
    expect(store.byId('b')?.buffer).toBe('')
  })

  it('keeps received terminal output when a session summary is delivered more than once', () => {
    const store = createSessionsStore()
    store.add({ id: 'a', hostname: 'alpha', mode: 'copilot' })
    store.appendData('a', 'ready\r\n')

    store.add({ id: 'a', hostname: 'alpha', title: '生产终端', mode: 'copilot' })

    expect(store.byId('a')).toMatchObject({ hostname: 'alpha', title: '生产终端', buffer: 'ready\r\n' })
  })

  it('labels a session with its safe public title before the connection host', () => {
    expect(sessionLabel({
      id: 'a', hostname: '10.0.0.12', title: '生产终端', mode: 'copilot', buffer: '',
    })).toBe('生产终端')
    expect(sessionLabel({
      id: 'b', hostname: '10.0.0.13', title: '堡垒机终端', mode: 'copilot', buffer: '',
    })).toBe('堡垒机终端')
    expect(sessionLabel({
      id: 'c', hostname: '127.0.0.1', mode: 'copilot', buffer: '',
    })).toBe('127.0.0.1')
  })
})
