import type { HostFactsService } from '../facts/host-facts-service'
import type { ConnectedSession, SessionService } from '../ssh/session-service'
import { ObservationRunner } from './observation-runner'

type SessionObservationSource = Pick<SessionService, 'executeReadOnly' | 'onOpened' | 'setObservedHostname' | 'supportsReadOnlyObservation'>
type HostFactsSink = Pick<HostFactsService, 'observe'>

export function registerSessionObservation(sessions: SessionObservationSource, facts: HostFactsSink): () => void {
  return sessions.onOpened(session => {
    try {
      if (!sessions.supportsReadOnlyObservation(session.id)) return
      void observeSession(sessions, facts, session).catch(() => undefined)
    } catch {
      // Observation must never make an already-open terminal session fail.
    }
  })
}

async function observeSession(
  sessions: SessionObservationSource,
  facts: HostFactsSink,
  session: ConnectedSession,
): Promise<void> {
  const runner = new ObservationRunner(command => sessions.executeReadOnly(session.id, command))
  await facts.observe(await runner.collectFacts('linux', undefined, hostname => {
    sessions.setObservedHostname(session.id, hostname)
  }))
}
