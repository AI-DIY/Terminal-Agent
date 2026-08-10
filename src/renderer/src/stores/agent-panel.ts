import { reactive } from 'vue'
import type { AgentCandidate, AgentDeltaEvent, AgentErrorEvent, AgentProposalEvent } from '../../../shared/contracts'

export type AgentPanelState = {
  sessionId: string | null
  runId: string | null
  goal: string
  streaming: boolean
  strategy: string
  proposal: {
    analysis: string
    evidenceStrategy: string[]
    candidate: AgentCandidate | null
    autonomousExecution?: true
  } | null
  error: string
}

type AgentPanelEvent =
  | ({ kind: 'delta' } & AgentDeltaEvent)
  | ({ kind: 'proposal' } & AgentProposalEvent)
  | ({ kind: 'error' } & AgentErrorEvent)

export function createAgentPanelStore(): {
  state: AgentPanelState
  activate(sessionId: string): void
  start(sessionId: string, goal: string, runId: string): void
  apply(event: AgentPanelEvent): void
} {
  const state = reactive<AgentPanelState>({
    sessionId: null,
    runId: null,
    goal: '',
    streaming: false,
    strategy: '',
    proposal: null,
    error: '',
  })

  return {
    state,
    activate(sessionId) {
      if (state.sessionId === sessionId) return
      state.sessionId = sessionId
      state.runId = null
      state.goal = ''
      state.streaming = false
      state.strategy = ''
      state.proposal = null
      state.error = ''
    },
    start(sessionId, goal, runId) {
      state.sessionId = sessionId
      state.runId = runId
      state.goal = goal
      state.streaming = true
      state.strategy = ''
      state.proposal = null
      state.error = ''
    },
    apply(event) {
      if (event.sessionId !== state.sessionId || event.runId !== state.runId) return
      if (event.kind === 'delta') {
        state.strategy += event.content
        return
      }
      state.streaming = false
      if (event.kind === 'proposal') {
        state.proposal = {
          analysis: event.analysis,
          evidenceStrategy: [...event.evidenceStrategy],
          candidate: event.candidate ? { ...event.candidate } : null,
          ...(event.autonomousExecution ? { autonomousExecution: true as const } : {}),
        }
        return
      }
      state.proposal = null
      state.error = event.message
    },
  }
}
