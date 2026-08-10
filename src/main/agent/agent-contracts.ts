import type { HostFacts } from '../observation/observation-schema'
import type { AgentStreamEvent } from '../../shared/contracts'

export type { AgentStreamEvent } from '../../shared/contracts'

export type AgentSessionContext = {
  id: string
  hostname: string
}

export type AgentGoalContext = {
  goal: string
  session: AgentSessionContext
  facts: HostFacts
  signal?: AbortSignal
}

export type AgentEventPublisher = (event: AgentStreamEvent) => unknown

export type SchedulerModelRequest = {
  goal: string
  sessionId: string
  hostname: string
  facts: HostFacts
  signal?: AbortSignal
}

export type SchedulerModelPort = {
  stream(request: SchedulerModelRequest, publish: AgentEventPublisher): Promise<void>
}
