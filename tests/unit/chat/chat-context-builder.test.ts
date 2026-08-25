import { describe, expect, it } from 'vitest'
import { buildChatContext } from '../../../src/main/chat/chat-context-builder'

describe('chat context builder', () => {
  it('keeps only recent messages while passing authorized metadata through unchanged', () => {
    const temporaryPath = `tmp:${['C:', 'synthetic', 'AppData', 'Local', 'Temp', 'access', 'profile.conf'].join('\\')}`
    const tokenLike = `sk-proj-${'A'.repeat(32)}`
    const context = buildChatContext({
      messages: [
        { role: 'user', content: 'old', createdAt: '2026-08-16T00:00:00.000Z' },
        { role: 'assistant', content: `Bearer ${tokenLike}`, createdAt: '2026-08-16T00:00:01.000Z' },
        { role: 'user', content: 'check host', createdAt: '2026-08-16T00:00:02.000Z' },
      ],
      shells: [{ hostname: 'prod.example', title: temporaryPath, status: 'open' }],
      facts: [{ hostname: 'prod.example', scope: 'identity', values: { os: 'Linux', token: tokenLike } }],
      audit: [{ kind: 'approved-command', label: `type ${temporaryPath}`, at: '2026-08-16T00:00:03.000Z' }],
      maxMessages: 2,
    })
    expect(context.slice(1)).toEqual([
      { role: 'assistant', content: `Bearer ${tokenLike}` },
      { role: 'user', content: 'check host' },
    ])
    const system = context[0]?.content ?? ''
    const metadata = JSON.parse(system.slice(system.indexOf('：') + 1))
    expect(metadata.shells[0].title).toBe(temporaryPath)
    expect(metadata.facts[0].values.token).toBe(tokenLike)
    expect(metadata.audit[0].label).toBe(`type ${temporaryPath}`)
    expect(system).not.toContain('只使用脱敏消息')
  })

  it('preserves nested authorized fact fields verbatim', () => {
    const context = buildChatContext({
      messages: [],
      facts: [{ hostname: 'host', scope: 'runtime', values: { nested: { token: 'secret', safe: 'ok' }, list: [{ privateKey: 'pem' }, { stdout: 'terminal' }] } }],
    })
    const serialized = JSON.stringify(context)
    expect(serialized).toContain('secret')
    expect(serialized).toContain('pem')
    expect(serialized).toContain('terminal')
    expect(serialized).toContain('safe\\":\\"ok')
  })

  it('includes only live Shell display metadata in the model system context', () => {
    const context = buildChatContext({
      messages: [],
      shells: [
        { hostname: 'live-host', title: 'Live Shell', status: 'open' },
        { hostname: 'closed-host', title: 'Closed Shell', status: 'closed' },
      ],
    })

    const systemContent = context[0]?.content ?? ''
    expect(systemContent).toContain('live-host')
    expect(systemContent).toContain('Live Shell')
    expect(systemContent).not.toContain('closed-host')
    expect(systemContent).not.toContain('Closed Shell')
  })

  it('does not recursively strip authorized fact field names before model serialization', () => {
    const context = buildChatContext({
      messages: [],
      facts: [{ hostname: 'host', scope: 'runtime', values: {
        rawOutput: 'raw-terminal-secret', terminalOutput: 'terminal-secret', commandOutput: 'command-secret', terminalHistory: 'history-secret',
        nested: { stderr: 'stderr-secret', safe: 'ok' },
      } }],
    })
    const serialized = JSON.stringify(context)
    for (const value of ['raw-terminal-secret', 'terminal-secret', 'command-secret', 'history-secret', 'stderr-secret']) expect(serialized).toContain(value)
    expect(serialized).toContain('safe')
  })

  it('preserves synthetic paths from messages and audit labels', () => {
    const temporaryPath = `tmp:${['C:', 'synthetic', 'AppData', 'Local', 'Temp', 'access', 'profile.conf'].join('\\')}`
    const privateKeyPath = ['C:', 'synthetic', '.ssh', 'id_rsa'].join('\\')
    const context = buildChatContext({
      messages: [{ role: 'user', content: `inspect ${temporaryPath}` }],
      audit: [{ kind: 'approved-command', label: `identity ${privateKeyPath}`, at: '2026-08-16T00:00:00.000Z' }],
    })
    const metadata = JSON.parse((context[0]?.content ?? '').slice((context[0]?.content ?? '').indexOf('：') + 1))
    expect(metadata.audit[0].label).toContain(privateKeyPath)
    expect(context.some(message => message.content.includes(temporaryPath))).toBe(true)
  })
})
