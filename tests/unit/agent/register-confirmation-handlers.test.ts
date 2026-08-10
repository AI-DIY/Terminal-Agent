import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerConfirmationHandlers } from '../../../src/main/agent/register-confirmation-handlers'

const { handle, removeHandler } = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn() }))

vi.mock('electron', () => ({ ipcMain: { handle, removeHandler } }))

describe('registerConfirmationHandlers', () => {
  beforeEach(() => {
    handle.mockReset()
    removeHandler.mockReset()
  })

  it('issues a marker only for a trusted renderer candidate request', () => {
    const source = { issueForCandidate: vi.fn(() => ({ id: 'marker-1' })) }
    const sender = {}
    const dispose = registerConfirmationHandlers(source, sender as never)
    const confirm = handle.mock.calls.find(([channel]) => channel === 'agent:confirm-candidate')?.[1] as (event: { sender: unknown }, request: unknown) => unknown

    expect(confirm({ sender }, { sessionId: 'session-a', candidateId: 'candidate-1' })).toEqual({ id: 'marker-1' })
    expect(source.issueForCandidate).toHaveBeenCalledWith('session-a', 'candidate-1')
    expect(JSON.stringify(source.issueForCandidate.mock.calls)).not.toContain('systemctl')
    expect(() => confirm({ sender: {} }, { sessionId: 'session-a', candidateId: 'candidate-1' })).toThrow('Untrusted renderer')

    dispose()
    expect(removeHandler).toHaveBeenCalledWith('agent:confirm-candidate')
  })
})
