import { describe, expect, it } from 'vitest'
import { buildChatContext } from '../../../src/main/chat/chat-context-builder'

describe('chat context builder', () => {
  it('keeps only recent safe messages and display metadata', () => {
    const context = buildChatContext({
      messages: [
        { role: 'user', content: 'old', createdAt: '2026-08-16T00:00:00.000Z' },
        { role: 'assistant', content: 'Bearer secret-token', createdAt: '2026-08-16T00:00:01.000Z' },
        { role: 'user', content: 'check host', createdAt: '2026-08-16T00:00:02.000Z' },
      ],
      shells: [{ hostname: 'prod.example', title: 'Production', status: 'open' }],
      facts: [{ hostname: 'prod.example', scope: 'identity', values: { os: 'Linux', token: 'sk-proj-secret' } }],
      maxMessages: 2,
    })
    expect(context).toEqual([
      { role: 'system', content: expect.stringContaining('prod.example') },
      { role: 'assistant', content: 'Bearer [REDACTED]' },
      { role: 'user', content: 'check host' },
    ])
    expect(JSON.stringify(context)).not.toContain('sk-proj-secret')
  })

  it('recursively removes sensitive nested fields from facts', () => {
    const context = buildChatContext({
      messages: [],
      facts: [{ hostname: 'host', scope: 'runtime', values: { nested: { token: 'secret', safe: 'ok' }, list: [{ privateKey: 'pem' }, { stdout: 'terminal' }] } }],
    })
    const serialized = JSON.stringify(context)
    expect(serialized).not.toContain('secret')
    expect(serialized).not.toContain('pem')
    expect(serialized).not.toContain('terminal')
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

  it('removes raw terminal output field variants and credentials from nested facts', () => {
    const context = buildChatContext({
      messages: [],
      facts: [{ hostname: 'host', scope: 'runtime', values: {
        rawOutput: 'raw-terminal-secret', terminalOutput: 'terminal-secret', commandOutput: 'command-secret', terminalHistory: 'history-secret',
        nested: { stderr: 'stderr-secret', safe: 'ok' },
      } }],
    })
    const serialized = JSON.stringify(context)
    for (const value of ['raw-terminal-secret', 'terminal-secret', 'command-secret', 'history-secret', 'stderr-secret']) expect(serialized).not.toContain(value)
    expect(serialized).toContain('safe')
  })

  it('redacts synthetic temporary and private-key paths from messages and audit labels', () => {
    const temporaryPath = `tmp:${['C:', 'synthetic', 'AppData', 'Local', 'Temp', 'access', 'profile.conf'].join('\\')}`
    const privateKeyPath = ['C:', 'synthetic', '.ssh', 'id_rsa'].join('\\')
    const context = buildChatContext({
      messages: [{ role: 'user', content: `inspect ${temporaryPath}` }],
      audit: [{ kind: 'approved-command', label: `identity ${privateKeyPath}`, at: '2026-08-16T00:00:00.000Z' }],
    })
    expect(context.some(message => message.content.includes(temporaryPath))).toBe(false)
    expect(context.some(message => message.content.includes(privateKeyPath))).toBe(false)
  })
})
