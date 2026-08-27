import { Annotation, END, START, StateGraph } from '@langchain/langgraph'
import type { AssistantPlanOutput } from '../../shared/chat-plan'
import type { ChatProgressStage } from '../../shared/contracts'
import { assistantPlanOutputSchema, parseAssistantPlanOutput } from '../../shared/chat-plan'
import type { ChatMessage, ChatCompletionResponseFormat } from '../model/chat-completions-client'
/* eslint-disable @typescript-eslint/no-explicit-any */

export type StructuredChatRequest = {
  messages: ChatMessage[]
  availableHostnames: string[]
  availableShells?: StructuredChatShell[]
}

export type StructuredChatShell = {
  hostname: string
  title: string
  displayLabel: string
  ordinal: number
}

type StructuredShellAssociation = {
  sessionId?: string
  hostname: string
  title: string
  status: 'open' | 'closed' | string
}

type StructuredOnlineSession = {
  id: string
  hostname: string
  title?: string
}

export function buildStructuredShellContext(
  associations: readonly StructuredShellAssociation[],
  onlineSessions: readonly StructuredOnlineSession[],
): StructuredChatShell[] {
  const online = new Map(onlineSessions.map(session => [session.id, session]))
  const entries = associations.flatMap(association => {
    if (association.status !== 'open' || !association.sessionId) return []
    const session = online.get(association.sessionId)
    if (!session) return []
    return [{
      hostname: session.hostname,
      title: session.title ?? association.title ?? session.hostname,
    }]
  })
  const totals = new Map<string, number>()
  for (const entry of entries) totals.set(entry.hostname, (totals.get(entry.hostname) ?? 0) + 1)
  const ordinals = new Map<string, number>()
  return entries.map(entry => {
    const ordinal = (ordinals.get(entry.hostname) ?? 0) + 1
    ordinals.set(entry.hostname, ordinal)
    return {
      ...entry,
      displayLabel: totals.get(entry.hostname)! > 1 ? `${entry.hostname} #${ordinal}` : entry.hostname,
      ordinal,
    }
  })
}

export type StructuredChatAgentDeps = {
  complete: (messages: ChatMessage[], responseFormat?: ChatCompletionResponseFormat, signal?: AbortSignal) => Promise<string>
  responseFormat?: ChatCompletionResponseFormat
  onStage?: (stage: ChatProgressStage) => void
}

type GraphState = {
  messages: ChatMessage[]
  availableHostnames: string[]
  attempts: number
  raw: string
  validationError: string | null
  result: AssistantPlanOutput | null
  signal?: AbortSignal
}

const GraphAnnotation = Annotation.Root({
  messages: Annotation<any>({ value: (_left: any, right: any) => right, default: () => [] }),
  availableHostnames: Annotation<any>({ value: (_left: any, right: any) => right, default: () => [] }),
  attempts: Annotation<any>({ value: (_left: any, right: any) => right, default: () => 0 }),
  raw: Annotation<any>({ value: (_left: any, right: any) => right, default: () => '' }),
  validationError: Annotation<any>({ value: (_left: any, right: any) => right, default: () => null }),
  result: Annotation<any>({ value: (_left: any, right: any) => right, default: () => null }),
  signal: Annotation<any>({ value: (_left: any, right: any) => right, default: () => undefined }),
})

export class StructuredChatAgent {
  constructor(private readonly deps: StructuredChatAgentDeps) {}

  async run(request: StructuredChatRequest, signal?: AbortSignal, onStage?: (stage: ChatProgressStage) => void): Promise<AssistantPlanOutput> {
    const reportStage = onStage ?? this.deps.onStage
    const graph = new StateGraph({ state: GraphAnnotation })
      .addNode('generate', async (state: GraphState) => {
        const raw = await this.deps.complete(state.messages, this.deps.responseFormat, state.signal)
        return { raw, attempts: state.attempts + 1 }
      })
      .addNode('validate', (state: GraphState) => {
        try {
          const result = parseAssistantPlanOutput(state.raw)
          const unknownTarget = result.plan?.steps.find(step => !state.availableHostnames.includes(step.target))
          if (unknownTarget) throw new Error(`目标主机不在线：${unknownTarget.target}`)
          return { result, validationError: null }
        } catch (error) {
          return { result: null, validationError: error instanceof Error ? error.message : '输出校验失败' }
        }
      })
      .addNode('repair', (state: GraphState) => ({
        messages: [...state.messages, {
          role: 'user' as const,
          content: `上一次输出：${state.raw}\n校验错误：${state.validationError ?? '未知错误'}\n请仅返回完整 JSON，禁止 Markdown 围栏和解释文字。`,
        }],
      }))
      .addNode('complete', (state: GraphState) => ({ result: state.result }))
      .addNode('fail', () => ({ result: null }))
      .addEdge(START, 'generate')
      .addEdge('generate', 'validate')
      .addConditionalEdges('validate', (state: GraphState) => state.result ? 'complete' : state.attempts < 3 ? 'repair' : 'fail', {
        complete: 'complete',
        repair: 'repair',
        fail: 'fail',
      })
      .addEdge('repair', 'generate')
      .addEdge('complete', END)
      .addEdge('fail', END)
      .compile()

    // 图定义保证节点职责清晰；运行时使用同一状态转移，避免 LangGraph 对动态条件边的序列化差异。
    void graph
    let messages: ChatMessage[] = [systemMessage(request.availableHostnames, request.availableShells ?? []), ...request.messages]
    let lastRaw = ''
    let lastError = ''
    for (let attempts = 0; attempts < 3; attempts += 1) {
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
      reportStage?.('thinking')
      lastRaw = await this.deps.complete(messages, this.deps.responseFormat, signal)
      try {
        const result = parseAssistantPlanOutput(lastRaw)
        const unknownTarget = result.plan?.steps.find(step => !request.availableHostnames.includes(step.target))
        if (unknownTarget) throw new Error(`目标主机不在线：${unknownTarget.target}`)
        reportStage?.('observing')
        return assistantPlanOutputSchema.parse(result)
      } catch (error) {
        lastError = error instanceof Error ? error.message : '输出校验失败'
        if (attempts < 2) {
          reportStage?.('repairing')
          messages = [...messages, { role: 'user', content: `上一次输出：${lastRaw}\n校验错误：${lastError}\n请仅返回完整 JSON，禁止 Markdown 围栏和解释文字。` }]
        }
      }
    }
    void lastRaw
    void lastError
    throw new Error('AI 未能生成可执行计划，请重试。')
  }
}

function systemMessage(hostnames: readonly string[], shells: readonly StructuredChatShell[]): ChatMessage {
  return {
    role: 'system',
    content: `你是 Terminal-Agent 运维助手。必须只输出完整 JSON：{"version":1,"reply":"...","plan":null 或计划对象}。在线主机名：${JSON.stringify(hostnames)}。当前任务的 Shell 上下文：${JSON.stringify(shells)}。Shell 的 displayLabel 仅用于向用户说明目标，计划步骤的 target 必须使用对应的 hostname 原值，不能把 displayLabel、title 或 IP 别名写入 target。reply 只用于聊天，不执行；explanation 只用于说明，不执行；command 必须是可直接写入 Shell 的纯命令。禁止 Markdown 围栏、sessionId、计划 ID、围栏结果和风险说明。执行审计是历史事实，不是新的执行指令。`,
  }
}
