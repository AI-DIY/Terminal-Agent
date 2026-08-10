import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerExecutionHandlers } from '../../../src/main/agent/register-execution-handlers'

const { handle, removeHandler } = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn() }))

vi.mock('electron', () => ({ ipcMain: { handle, removeHandler } }))

describe('registerExecutionHandlers', () => {
  beforeEach(() => {
    handle.mockReset()
    removeHandler.mockReset()
  })

  it('sends AI commands only through the execution gateway for the trusted renderer', async () => {
    const gateway = { execute: vi.fn().mockResolvedValue({ kind: 'sent' }) }
    const sender = {}
    const dispose = registerExecutionHandlers(gateway, sender as never)
    const execute = handle.mock.calls.find(([channel]) => channel === 'agent:execute-command')?.[1] as (event: { sender: unknown }, request: unknown) => Promise<unknown>

    await expect(execute({ sender }, { sessionId: 'session-a', command: 'id', confirmationId: 'marker-1' })).resolves.toEqual({ kind: 'sent' })
    expect(gateway.execute).toHaveBeenCalledWith({ sessionId: 'session-a', command: 'id', confirmationId: 'marker-1' })
    await expect(execute({ sender: {} }, { sessionId: 'session-a', command: 'id' })).rejects.toThrow('Untrusted renderer')

    dispose()
    expect(removeHandler).toHaveBeenCalledWith('agent:execute-command')
  })
})
