import { normalizeHostname } from '../facts/host-facts-service'
import type { HostMemoryLegacyFacts } from '../../shared/contracts'
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
      hasImages: context.hasImages,
      facts: {
        ...context.facts,
        hostname,
        ...(context.facts.operatingSystem ? { operatingSystem: { ...context.facts.operatingSystem } } : {}),
        ...(context.facts.cpu ? { cpu: { ...context.facts.cpu } } : {}),
        ...(context.facts.memory ? { memory: { ...context.facts.memory } } : {}),
        ...(context.facts.disks ? { disks: context.facts.disks.map(disk => ({ ...disk })) } : {}),
        ...(context.facts.networkInterfaces ? { networkInterfaces: context.facts.networkInterfaces.map(item => ({ ...item, addresses: [...item.addresses] })) } : {}),
        ...(context.facts.processes ? { processes: context.facts.processes.map(process => ({ ...process })) } : {}),
        ...(context.facts.services ? { services: { ...context.facts.services } } : {}),
        ...(context.facts.legacyFacts ? { legacyFacts: cloneLegacyFacts(context.facts.legacyFacts) } : {}),
      },
    }
    await this.model.stream(request, publish)
  }
}

function cloneLegacyFacts(facts: HostMemoryLegacyFacts): HostMemoryLegacyFacts {
  return {
    ...(facts.software ? { software: { ...facts.software } } : {}),
    ...(facts.processes ? { processes: facts.processes.map(process => ({ ...process })) } : {}),
    ...(facts.installLocations ? { installLocations: { ...facts.installLocations } } : {}),
    ...(facts.services ? { services: { ...facts.services } } : {}),
    ...(facts.logLocations ? { logLocations: [...facts.logLocations] } : {}),
    ...(facts.configurationHashes ? { configurationHashes: { ...facts.configurationHashes } } : {}),
  }
}
