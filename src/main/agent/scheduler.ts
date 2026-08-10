import { normalizeHostname } from '../facts/host-facts-service'
import type { AgentEventPublisher, AgentGoalContext, SchedulerModelPort, SchedulerModelRequest } from './agent-contracts'

export class AgentScheduler {
  constructor(private readonly model: SchedulerModelPort) {}

  async start(context: AgentGoalContext, publish: AgentEventPublisher): Promise<void> {
    const hostname = normalizeHostname(context.session.hostname)
    if (normalizeHostname(context.facts.hostname) !== hostname) {
      throw new Error('Structured facts must match the active session hostname')
    }

    const request: SchedulerModelRequest = {
      goal: context.goal,
      sessionId: context.session.id,
      hostname,
      signal: context.signal,
      facts: {
        ...context.facts,
        hostname,
        software: { ...context.facts.software },
        processes: context.facts.processes.map(process => ({ ...process })),
        installLocations: { ...context.facts.installLocations },
        services: { ...context.facts.services },
        logLocations: [...context.facts.logLocations],
        configurationHashes: { ...context.facts.configurationHashes },
      },
    }
    await this.model.stream(request, publish)
  }
}
