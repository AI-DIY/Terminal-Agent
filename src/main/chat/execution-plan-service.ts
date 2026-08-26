import type { AssistantPlanOutput, ChatExecutionPlan, ExecutionPlanStep, ChatPlanEditStepRequest, ChatPlanRemoveStepRequest, ChatPlanCancelRequest, ChatPlanExecuteRequest } from '../../shared/chat-plan'

type FenceMatcher = { match(command: string): { id: string; name: string } | null }
type Sessions = { snapshot(): Array<{ id: string; hostname: string }>; write(sessionId: string, data: string): void | Promise<void> }
type Chats = { get(chatId: string): Promise<{ chat: { messages: Array<{ id: string; role: string; state: string; content: string; executionPlan?: ChatExecutionPlan }>; shells: Array<{ sessionId?: string; hostname: string; status: string }> } }>; updateMessage(request: { requestId: string; chatId: string; messageId: string; content: string; state: 'complete'; executionPlan?: ChatExecutionPlan }): Promise<unknown>; appendMessage(request: { requestId: string; chatId: string; role: 'user'; state: 'complete'; content: string; messageType: 'execution_audit' }): Promise<unknown> }

export class ExecutionPlanService {
  private readonly active = new Set<string>()
  constructor(private readonly chats: Chats, private readonly sessions: Sessions, private readonly fence: FenceMatcher, private readonly createId = () => crypto.randomUUID()) {}

  materialize(plan: NonNullable<AssistantPlanOutput['plan']>): ChatExecutionPlan {
    return { id: `EP-${this.createId()}`, title: plan.title, status: 'pending_review', steps: plan.steps.map(step => {
      const matched = this.fence.match(step.command)
      return { id: this.createId(), target: step.target, explanation: step.explanation, originalCommand: step.command, sendState: 'pending', ...(matched ? { fence: { ruleId: matched.id, ruleName: matched.name } } : {}) }
    }) }
  }

  async editStep(request: ChatPlanEditStepRequest): Promise<unknown> { return this.mutate(request, plan => { const step = plan.steps.find(item => item.id === request.stepId); if (!step || plan.status !== 'pending_review') throw new Error('计划不可编辑'); step.finalCommand = request.command; return plan }) }
  async removeStep(request: ChatPlanRemoveStepRequest): Promise<unknown> { return this.mutate(request, plan => { if (plan.status !== 'pending_review') throw new Error('计划不可删除'); if (plan.steps.length <= 1) throw new Error('计划至少保留一个步骤'); plan.steps = plan.steps.filter(item => item.id !== request.stepId); return plan }) }
  async cancel(request: ChatPlanCancelRequest): Promise<unknown> { return this.mutate(request, plan => { if (plan.status !== 'pending_review') throw new Error('计划不可取消'); plan.status = 'cancelled'; return plan }) }

  async execute(request: ChatPlanExecuteRequest): Promise<unknown> {
    if (this.active.has(request.messageId)) throw new Error('计划正在执行')
    this.active.add(request.messageId)
    try {
      const current = await this.requirePlan(request)
      if (current.status !== 'pending_review') throw new Error('计划不可执行')
      const workspace = await this.chats.get(request.chatId)
      const online = this.sessions.snapshot()
      const steps = current.steps.map(step => ({ ...step, sessionId: workspace.chat.shells.find(shell => shell.status === 'open' && shell.hostname === step.target && shell.sessionId && online.some(session => session.id === shell.sessionId))?.sessionId }))
      current.status = 'executing'; current.steps = steps
      await this.save(request, current)
      let sent = 0
      for (const step of current.steps) {
        if (!step.sessionId) { step.sendState = 'failed'; step.failure = '目标 Shell 已断开或不可用'; break }
        try { await this.sessions.write(step.sessionId, `${step.finalCommand ?? step.originalCommand}\n`); step.sendState = 'sent'; sent += 1 } catch { step.sendState = 'failed'; step.failure = '命令未能写入目标 Shell'; break }
      }
      const failed = current.steps.some(step => step.sendState === 'failed')
      current.steps = current.steps.map((step, index) => index > sent && step.sendState === 'pending' ? { ...step, sendState: 'not_sent' } : step)
      current.status = failed ? (sent > 0 ? 'partially_executed' : 'execution_failed') : 'executed'
      const result = await this.save(request, current)
      await this.chats.appendMessage({ requestId: `${request.requestId}:audit`, chatId: request.chatId, role: 'user', state: 'complete', messageType: 'execution_audit', content: this.audit(current) })
      return result
    } finally { this.active.delete(request.messageId) }
  }

  private async mutate(request: { chatId: string; messageId: string; requestId: string }, change: (plan: ChatExecutionPlan) => ChatExecutionPlan): Promise<unknown> { const plan = await this.requirePlan(request); const next = change(structuredClone(plan)); return this.save(request, next) }
  private async requirePlan(request: { chatId: string; messageId: string }): Promise<ChatExecutionPlan> { const workspace = await this.chats.get(request.chatId); const message = workspace.chat.messages.find(item => item.id === request.messageId); if (!message?.executionPlan || message.role !== 'assistant' || message.state !== 'complete') throw new Error('未知执行计划'); return structuredClone(message.executionPlan) }
  private async save(request: { chatId: string; messageId: string; requestId: string }, plan: ChatExecutionPlan): Promise<unknown> { const workspace = await this.chats.get(request.chatId); const message = workspace.chat.messages.find(item => item.id === request.messageId); if (!message) throw new Error('未知执行计划'); return this.chats.updateMessage({ requestId: request.requestId, chatId: request.chatId, messageId: request.messageId, content: message.content, state: 'complete', executionPlan: plan }) }
  private audit(plan: ChatExecutionPlan): string { return `【执行审计】计划 ${plan.id} 状态 ${plan.status}。${plan.steps.map(step => `${step.target}: ${step.finalCommand ?? step.originalCommand}（${step.sendState}）`).join('；')}` }
}
