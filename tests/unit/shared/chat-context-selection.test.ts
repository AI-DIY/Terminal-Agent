import { describe, expect, it } from 'vitest'
import { chatContextSessionsAreResolved, normalizeChatContextSessionIds } from '../../../src/shared/chat-context-selection'

describe('chat context connection selection', () => {
  const connections = [
    { id: 'a-primary', hostname: 'web-01', title: 'primary' },
    { id: 'b-alternate', hostname: 'web-01', title: 'alternate' },
    { id: 'db', hostname: 'db-01', title: 'database' },
  ]

  it('waits for every associated session before a renderer persists a default selection', () => {
    expect(chatContextSessionsAreResolved(0, 0)).toBe(true)
    expect(chatContextSessionsAreResolved(1, 0)).toBe(false)
    expect(chatContextSessionsAreResolved(2, 1)).toBe(false)
    expect(chatContextSessionsAreResolved(2, 2)).toBe(true)
    expect(chatContextSessionsAreResolved(2, 3)).toBe(true)
  })

  it('defaults to no SSH context until the user selects a connection', () => {
    expect(normalizeChatContextSessionIds(connections, undefined)).toEqual([])
  })

  it('keeps an explicit alternate selection and rejects stale ids', () => {
    expect(normalizeChatContextSessionIds(connections, ['b-alternate', 'missing', 'b-alternate'])).toEqual(['b-alternate'])
    expect(normalizeChatContextSessionIds(connections, [])).toEqual([])
  })

  it('keeps explicitly selected bridged connections when observed hostnames differ', () => {
    const bridged = [
      { id: 'a-route', hostname: '127.0.0.1', observedHostname: 'web-01', title: 'route a' },
      { id: 'b-route', hostname: '127.0.0.1', observedHostname: 'web-01', title: 'route b' },
      { id: 'route-c', hostname: '127.0.0.1', observedHostname: 'db-01', title: 'route c' },
    ]
    expect(normalizeChatContextSessionIds(bridged, ['a-route', 'route-c'])).toEqual(['a-route', 'route-c'])
  })
})
