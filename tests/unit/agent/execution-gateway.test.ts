import { describe, expect, it, vi } from 'vitest'
import { ApprovedExecutionAudit, ExecutionGateway } from '../../../src/main/agent/execution-gateway'
import { buildChatContext } from '../../../src/main/chat/chat-context-builder'

describe('ExecutionGateway', () => {
  it('records only successfully human-approved commands as raw context audit entries', async () => {
    const audit = new ApprovedExecutionAudit(() => new Date('2026-08-16T08:00:00.000Z'))
    const gateway = new ExecutionGateway(
      { get: () => 'copilot' as const },
      { consume: (_sessionId, command) => command === 'approved command' || command.startsWith('approved glpat-') },
      { match: () => null },
      vi.fn(async () => ({ kind: 'sent' as const })),
      audit,
    )

    await gateway.execute({ sessionId: 's1', command: 'unapproved command' })
    await gateway.execute({ sessionId: 's1', command: 'approved command', confirmationId: 'marker' })
    await gateway.execute({ sessionId: 's2', command: `approved glpat-${'0'.repeat(20)}`, confirmationId: 'marker' })

    expect(audit.recent(['s1'])).toEqual([{ kind: 'approved-command', label: 'approved command', at: '2026-08-16T08:00:00.000Z' }])
    expect(JSON.stringify(audit.recent(['s2']))).toContain('glpat-')
  })

  it('executes a Copilot command carrying a valid human marker before applying the fence', async () => {
    const send = vi.fn().mockResolvedValue({ kind: 'sent' })
    const modes = { get: () => 'copilot' as const }
    const gateway = new ExecutionGateway(modes, { consume: () => true }, { match: () => ({ id: 'kill', name: '终止进程' }) }, send)

    await expect(gateway.execute({ sessionId: 's', command: 'kill -9 1', confirmationId: 'approved' })).resolves.toEqual({ kind: 'sent' })
    expect(send).toHaveBeenCalledWith('s', 'kill -9 1')
  })

  it('intercepts an unconfirmed Copilot command when its regex matches', async () => {
    const send = vi.fn().mockResolvedValue({ kind: 'sent' })
    const modes = { get: () => 'copilot' as const }
    const gateway = new ExecutionGateway(modes, { consume: () => false }, { match: () => ({ id: 'kill', name: '终止进程' }) }, send)

    await expect(gateway.execute({ sessionId: 's', command: 'kill -9 1' })).resolves.toEqual({ kind: 'intercepted', ruleId: 'kill', ruleName: '终止进程' })
    expect(send).not.toHaveBeenCalled()
  })

  it('does not use the Copilot fence after the user explicitly upgrades to autonomous mode', async () => {
    const send = vi.fn().mockResolvedValue({ kind: 'sent' })
    const modes = { get: () => 'autonomous' as const }
    const gateway = new ExecutionGateway(modes, { consume: () => false }, { match: () => ({ id: 'kill', name: '终止进程' }) }, send)

    await gateway.execute({ sessionId: 's', command: 'kill -9 1' })
    expect(send).toHaveBeenCalledWith('s', 'kill -9 1')
  })

  it('does not expose autonomous sends as human-approved audit context', async () => {
    const command = 'systemctl status simulated-service'
    const audit = new ApprovedExecutionAudit(() => new Date('2026-08-16T08:00:00.000Z'))
    const confirmations = { consume: vi.fn(() => false) }
    const fence = { match: vi.fn(() => ({ id: 'blocked', name: 'Blocked' })) }
    const send = vi.fn(async () => ({ kind: 'sent' as const }))
    const gateway = new ExecutionGateway(
      { get: () => 'autonomous' as const },
      confirmations,
      fence,
      send,
      audit,
    )

    await expect(gateway.execute({ sessionId: 's-auto', command })).resolves.toEqual({ kind: 'sent' })
    expect(send).toHaveBeenCalledWith('s-auto', command)
    expect(confirmations.consume).not.toHaveBeenCalled()
    expect(fence.match).not.toHaveBeenCalled()

    const entries = audit.recent(['s-auto'])
    expect(entries).toEqual([])

    const context = buildChatContext({ messages: [], audit: entries })
    expect(JSON.stringify(context)).not.toContain(command)
    expect(JSON.stringify(context)).not.toContain('approved-command')
  })

  it('keeps approved audit labels raw while bounding their length', () => {
    const audit = new ApprovedExecutionAudit(() => new Date('2026-08-16T08:00:00.000Z'))
    const temporaryPath = `tmp:${['C:', 'synthetic', 'AppData', 'Local', 'Temp', 'access', 'profile.conf'].join('\\')}`
    const privateKeyPath = ['C:', 'synthetic', '.ssh', 'id_rsa'].join('\\')

    audit.record('s-paths', `use ${temporaryPath}`)
    audit.record('s-paths', `use ${privateKeyPath}`)

    const entries = audit.recent(['s-paths'])
    expect(entries.some(entry => entry.label.includes(temporaryPath))).toBe(true)
    expect(entries.some(entry => entry.label.includes(privateKeyPath))).toBe(true)
    audit.record('s-paths', 'x'.repeat(600))
    expect(audit.recent(['s-paths'])[0]?.label).toHaveLength(512)
  })
})
