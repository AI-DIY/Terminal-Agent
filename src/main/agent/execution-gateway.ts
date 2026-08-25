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

export type ApprovedExecutionAuditEntry = { kind: 'approved-command'; label: string; at: string }

/** In-memory, bounded context for commands that passed explicit human approval. */
export class ApprovedExecutionAudit {
  private readonly entries: Array<ApprovedExecutionAuditEntry & { sessionId: string }> = []

  constructor(private readonly now: () => Date = () => new Date()) {}

  record(sessionId: string, command: string): void {
    const label = command.slice(0, 512)
    this.entries.unshift({ sessionId, kind: 'approved-command', label, at: this.now().toISOString() })
    if (this.entries.length > 100) this.entries.length = 100
  }

  recent(sessionIds: readonly string[], limit = 20): ApprovedExecutionAuditEntry[] {
    const allowed = new Set(sessionIds)
    return this.entries
      .filter(entry => allowed.has(entry.sessionId))
      .slice(0, Math.max(0, Math.min(limit, 20)))
      .map(({ kind, label, at }) => ({ kind, label, at }))
  }
}

export class ExecutionGateway {
  constructor(
    private readonly sessionModes: SessionModes,
    private readonly confirmations: Confirmations,
    private readonly fence: Fence,
    private readonly send: CommandSender,
    private readonly approvedAudit?: ApprovedExecutionAudit,
  ) {}

  async execute(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    if (this.sessionModes.get(request.sessionId) === 'autonomous') {
      return this.send(request.sessionId, request.command)
    }
    if (request.confirmationId && this.confirmations.consume(request.sessionId, request.command, request.confirmationId)) {
      const result = await this.send(request.sessionId, request.command)
      if (result.kind === 'sent') this.approvedAudit?.record(request.sessionId, request.command)
      return result
    }
    const matched = this.fence.match(request.command)
    if (matched) return { kind: 'intercepted', ruleId: matched.id, ruleName: matched.name }
    return this.send(request.sessionId, request.command)
  }
}
