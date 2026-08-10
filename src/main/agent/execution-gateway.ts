import type { SessionMode } from '../../shared/contracts'
import type { RegexFenceMatch } from './regex-fence-service'

export type AgentExecutionRequest = {
  sessionId: string
  command: string
  confirmationId?: string
}

export type AgentExecutionResult =
  | { kind: 'sent' }
  | { kind: 'intercepted'; ruleId: string; ruleName: string }

type SessionModes = { get(sessionId: string): SessionMode }
type Confirmations = { consume(sessionId: string, command: string, markerId: string): boolean }
type Fence = { match(command: string): RegexFenceMatch | null }
type CommandSender = (sessionId: string, command: string) => Promise<AgentExecutionResult> | AgentExecutionResult

export class ExecutionGateway {
  constructor(
    private readonly sessionModes: SessionModes,
    private readonly confirmations: Confirmations,
    private readonly fence: Fence,
    private readonly send: CommandSender,
  ) {}

  async execute(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    if (this.sessionModes.get(request.sessionId) === 'autonomous') {
      return this.send(request.sessionId, request.command)
    }
    if (request.confirmationId && this.confirmations.consume(request.sessionId, request.command, request.confirmationId)) {
      return this.send(request.sessionId, request.command)
    }
    const matched = this.fence.match(request.command)
    if (matched) return { kind: 'intercepted', ruleId: matched.id, ruleName: matched.name }
    return this.send(request.sessionId, request.command)
  }
}
