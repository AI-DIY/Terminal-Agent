import { describe, expect, it, vi } from 'vitest'
import { registerSessionObservation } from '../../../src/main/observation/register-session-observation'

describe('registerSessionObservation', () => {
  it('collects and stores structured facts after an SSH session has opened', async () => {
    const sessions = createSessions(true)
    const facts = { observe: vi.fn().mockResolvedValue({ record: { hostname: 'api-prod' } }) }
    registerSessionObservation(sessions, facts)

    await openAndWait(sessions, { id: 's1', hostname: '10.0.0.12', mode: 'copilot' })
    await vi.waitFor(() => expect(sessions.executeReadOnly).toHaveBeenCalledTimes(6))
    await vi.waitFor(() => expect(facts.observe).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(sessions.setObservedHostname).toHaveBeenCalledWith('s1', 'api-prod'))

    expect(sessions.executeReadOnly.mock.calls.flat()).toContain('hostname')
    expect(facts.observe).toHaveBeenCalledWith(expect.objectContaining({
      hostname: 'api-prod',
      software: { nginx: '1.25' },
      processes: [{ name: 'nginx', status: 'Ssl' }],
      services: { 'nginx.service': 'active running' },
    }))
  })

  it('does not observe a Raw TCP session', async () => {
    const sessions = createSessions(false)
    const facts = { observe: vi.fn().mockResolvedValue({ record: { hostname: 'api-prod' } }) }
    registerSessionObservation(sessions, facts)

    sessions.openedListener?.({ id: 's1', hostname: '127.0.0.1', mode: 'copilot' })
    await new Promise(resolve => setImmediate(resolve))

    expect(sessions.executeReadOnly).not.toHaveBeenCalled()
    expect(facts.observe).not.toHaveBeenCalled()
  })

  it('contains observation failures so a terminal session remains open', async () => {
    const sessions = createSessions(true)
    sessions.executeReadOnly.mockRejectedValue(new Error('exec unavailable'))
    const facts = { observe: vi.fn().mockResolvedValue({ record: { hostname: 'api-prod' } }) }
    registerSessionObservation(sessions, facts)

    expect(() => sessions.openedListener?.({ id: 's1', hostname: 'server-a', mode: 'copilot' })).not.toThrow()
    await vi.waitFor(() => expect(sessions.executeReadOnly).toHaveBeenCalled())
    await new Promise(resolve => setImmediate(resolve))

    expect(facts.observe).not.toHaveBeenCalled()
  })
})

function createSessions(supportsObservation: boolean) {
  let openedListener: ((session: { id: string; hostname: string; mode: 'copilot' }) => void) | undefined
  const executeReadOnly = vi.fn((_sessionId: string, command: string) => Promise.resolve(commandOutput(command)))
  return {
    onOpened: vi.fn((listener: typeof openedListener) => {
      openedListener = listener
      return vi.fn()
    }),
    supportsReadOnlyObservation: vi.fn(() => supportsObservation),
    setObservedHostname: vi.fn(),
    executeReadOnly,
    get openedListener() { return openedListener },
  }
}

async function openAndWait(
  sessions: ReturnType<typeof createSessions>,
  session: { id: string; hostname: string; mode: 'copilot' },
): Promise<void> {
  sessions.openedListener?.(session)
  await vi.waitFor(() => expect(sessions.executeReadOnly).toHaveBeenCalled())
}

function commandOutput(command: string): string {
  if (command === 'hostname') return 'api-prod\n'
  if (command === 'ps -eo comm=,stat=') return 'nginx Ssl\n'
  if (command === 'systemctl list-units --type=service --no-pager --no-legend') {
    return 'nginx.service loaded active running nginx\n'
  }
  if (command.startsWith('dpkg-query')) return 'nginx\t1.25\n'
  return ''
}
