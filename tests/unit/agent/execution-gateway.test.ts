import { describe, expect, it, vi } from 'vitest'
import { ExecutionGateway } from '../../../src/main/agent/execution-gateway'

describe('ExecutionGateway', () => {
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
})
