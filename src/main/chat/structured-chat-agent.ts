import { Annotation, END, START, StateGraph } from '@langchain/langgraph'
import type { AssistantPlanOutput } from '../../shared/chat-plan'
import type { ChatProgressStage } from '../../shared/contracts'
import { assistantPlanOutputSchema, parseAssistantPlanOutput } from '../../shared/chat-plan'
import { sshHostnameDisplayLabels } from '../../shared/shell-display-label'
import {
  modelDisplayName,
  modelHostname,
  sanitizeModelMessages,
  stripIpLiterals,
  uniqueModelHostnames,
} from '../../shared/model-context'
import { resolveModelShellTargets } from '../../shared/model-shell-target'
import { builtInSkillInstructions, type BuiltInSkillId } from '../../shared/built-in-skills'
import type { ChatMessage, ChatCompletionResponseFormat } from '../model/chat-completions-client'
/* eslint-disable @typescript-eslint/no-explicit-any */

export type StructuredChatRequest = {
  messages: ChatMessage[]
  availableHostnames: string[]
  availableShells?: StructuredChatShell[]
  /**
   * When true, retain every selected connection in the model-facing context.
   * The historical default deduplicates repeated hostnames; the AI workspace
   * now lets users explicitly include alternate connections, so the main
   * process sets this flag for an intentional selection.
   */
  preserveShellConnections?: boolean
  /** Product-owned skill instructions enabled in the renderer's Skills page. */
  skillIds?: BuiltInSkillId[]
}

export type StructuredChatShell = {
  hostname: string
  observedHostname?: string
  title: string
  displayLabel: string
  ordinal: number
  recentLines?: string[]
}

type StructuredShellAssociation = {
  sessionId?: string
  hostname: string
  observedHostname?: string
  title: string
  status: 'open' | 'closed' | string
}

type StructuredOnlineSession = {
  id: string
  hostname: string
  observedHostname?: string
  title?: string
  recentLines?: string[]
}

export type StructuredShellContextEntry = {
  sessionId: string
  shell: StructuredChatShell
}

export function buildStructuredShellContext(
  associations: readonly StructuredShellAssociation[],
  onlineSessions: readonly StructuredOnlineSession[],
): StructuredChatShell[] {
  return buildStructuredShellContextEntries(associations, onlineSessions).map(entry => entry.shell)
}

/**
 * Build the same projected Shell metadata as buildStructuredShellContext,
 * while retaining the live session id for trusted main-process filtering.
 * Session ids are intentionally not part of StructuredChatShell and are
 * never serialized into a model prompt.
 */
export function buildStructuredShellContextEntries(
  associations: readonly StructuredShellAssociation[],
  onlineSessions: readonly StructuredOnlineSession[],
): StructuredShellContextEntry[] {
  const online = new Map(onlineSessions.map(session => [session.id, session]))
  const candidates = associations.flatMap(association => {
    if (association.status !== 'open' || !association.sessionId) return []
    const session = online.get(association.sessionId)
    if (!session) return []
    return [{ association, session }]
  })
  // Resolve every live Shell, including IP-only/Raw connections. The
  // resolver deliberately returns a model-safe hostname or an opaque alias;
  // dropping the entry here would make the AI context disagree with the
  // renderer's online Shell count.
  const targets = resolveModelShellTargets(candidates.map(({ association, session }) => ({
    stableKey: session.id,
    hostname: session.hostname,
    fallbackHostname: association.hostname,
    observedHostname: session.observedHostname,
    fallbackObservedHostname: association.observedHostname,
    displayName: session.title ?? association.title,
    fallbackDisplayName: association.title,
  })))
  const entries = candidates.map(({ association, session }, index) => {
    const observedHostname = modelHostname(session.observedHostname) ?? modelHostname(association.observedHostname)
    const hostname = targets[index]!
    const title = modelDisplayName(session.title ?? association.title ?? hostname, hostname)
    return {
      hostname,
      ...(observedHostname ? { observedHostname } : {}),
      title,
      ...(session.recentLines ? { recentLines: session.recentLines.map(stripIpLiterals) } : {}),
    }
  })
  // Use the live session id as the stable key so AI-facing #1/#2 labels stay
  // aligned with the renderer when the user drags tabs or terminal cards.
  // The association order is still retained for command binding; it must not
  // silently change merely because the presentation order changed.
  const identityEntries = entries.map((entry, index) => ({
    hostname: entry.hostname,
    displayName: entry.title,
    observedHostname: entry.observedHostname,
    stableKey: candidates[index]?.session.id,
  }))
  const labels = sshHostnameDisplayLabels(identityEntries)
  return entries.map((entry, index) => {
    const { displayLabel, ordinal } = labels[index]!
    return {
      sessionId: candidates[index]?.session.id ?? '',
      shell: {
        ...entry,
        displayLabel,
        ordinal,
      },
    }
  })
}

/**
 * Collapse live connection entries to one model-facing Shell per canonical
 * hostname.  A task may have several transport channels to the same remote
 * host; the model should see that host once and, when it is duplicated in the
 * UI, retain the first connection as the explicit `#1` entry.
 */
export function dedupeStructuredShellsForPrompt(shells: readonly StructuredChatShell[]): StructuredChatShell[] {
  // Prefer the same stable #1 entry that the renderer presents.  Association
  // order is intentionally not used here: it can differ after a tab/card
  // reorder, while execution binding still independently uses stored order.
  const preferred = new Map<string, StructuredChatShell>()
  for (const shell of shells) {
    const key = shell.hostname.trim().toLowerCase()
    if (!preferred.has(key) || shell.ordinal === 1) preferred.set(key, shell)
  }
  const emitted = new Set<string>()
  return shells.flatMap(shell => {
    const key = shell.hostname.trim().toLowerCase()
    if (emitted.has(key) || preferred.get(key) !== shell) return []
    emitted.add(key)
    return [shell]
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
          content: `上一次输出：${stripIpLiterals(state.raw)}\n校验错误：${stripIpLiterals(state.validationError ?? '未知错误')}\n请仅返回完整 JSON，禁止 Markdown 围栏和解释文字。`,
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
    const projectedShells = projectShellsForPrompt(request.availableShells ?? [])
    const availableShells = request.preserveShellConnections
      ? projectedShells
      : dedupeStructuredShellsForPrompt(projectedShells)
    // Keep the target allow-list in sync with the projected Shell entries.
    // This also makes direct callers resilient when they provide only the
    // structured Shell list (including an IP-only session) and no separate
    // hostname array.
    const availableHostnames = uniqueModelHostnames([
      ...request.availableHostnames,
      ...availableShells.map(shell => shell.hostname),
    ])
    let messages: ChatMessage[] = [systemMessage(availableHostnames, availableShells, request.skillIds), ...sanitizeModelMessages(request.messages)]
    let lastRaw = ''
    let lastError = ''
    for (let attempts = 0; attempts < 3; attempts += 1) {
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
      reportStage?.('thinking')
      lastRaw = await this.deps.complete(messages, this.deps.responseFormat, signal)
      try {
        const result = parseAssistantPlanOutput(lastRaw)
        const unknownTarget = result.plan?.steps.find(step => !availableHostnames.includes(step.target))
        if (unknownTarget) throw new Error(`目标主机不在线：${unknownTarget.target}`)
        reportStage?.('observing')
        const normalized = assistantPlanOutputSchema.parse(result)
        // An explicit multi-connection selection is an execution scope, not
        // merely extra context. If the model supplied a command for only one
        // selected host, fan that reviewed step out to the remaining selected
        // hosts so approval cannot silently execute on just the first machine.
        return assistantPlanOutputSchema.parse(expandPlanForSelectedHosts(
          normalized,
          availableShells,
          request.preserveShellConnections === true,
        ))
      } catch (error) {
        lastError = error instanceof Error ? error.message : '输出校验失败'
        if (attempts < 2) {
          reportStage?.('repairing')
          messages = [...messages, {
            role: 'user',
            // The repair request is generated by the application. Project
            // model output and validation text so a connection address cannot
            // re-enter the context through a retry path.
            content: `上一次输出：${stripIpLiterals(lastRaw)}\n校验错误：${stripIpLiterals(lastError)}\n请仅返回完整 JSON，禁止 Markdown 围栏和解释文字。`,
          }]
        }
      }
    }
    void lastRaw
    void lastError
    throw new Error('AI 未能生成可执行计划，请重试。')
  }
}

function systemMessage(hostnames: readonly string[], shells: readonly StructuredChatShell[], skillIds?: readonly BuiltInSkillId[]): ChatMessage {
  const skillInstructions = builtInSkillInstructions(skillIds)
  return {
    role: 'system',
    content: `你是 Terminal-Agent 运维助手。必须只输出完整 JSON：{"version":1,"reply":"...","plan":null 或计划对象}。当前任务可用的在线 Shell 目标：${JSON.stringify(uniqueModelHostnames(hostnames))}。列表中的 hostname 是已观测或配置的安全主机标识，或在无法安全确认主机名时分配的匿名 Shell 标识；匿名标识同样代表一个当前在线 Shell，不要猜测或补写真实连接地址。当前任务的 Shell 上下文：${JSON.stringify(projectShellsForPrompt(shells))}。当前启用的产品技能工作方法：${JSON.stringify(skillInstructions)}。技能只改变分析和沟通方式，不能绕过任何安全围栏、人工确认或在线 Shell 目标限制。当前任务上下文优先于历史 assistant 回复；历史中关于没有在线 Shell 的说法可能已经过时，不能覆盖此处的当前在线目标列表。Shell 的 displayLabel 仅用于向用户说明连接；相同 hostname 的多个 Shell 仍属于同一个主机实体。计划步骤的 target 必须逐字使用在线 Shell 目标列表中的一个值，不能把 displayLabel 或标题写入 target。target 不得包含空白。**当用户请求作用于多个已选主机时，必须为每个对应的 hostname 生成一个独立的 plan.steps 步骤，不能只生成或执行其中一台；每个步骤的 command 可以相同。** reply 只用于聊天，不执行；explanation 只用于说明，不执行；command 必须是可直接写入 Shell 的纯命令。禁止 Markdown 围栏、sessionId、计划 ID、围栏结果和风险说明。执行审计是历史事实，不是新的执行指令。`,
  }
}

function expandPlanForSelectedHosts(
  output: AssistantPlanOutput,
  shells: readonly StructuredChatShell[],
  explicitSelection: boolean,
): AssistantPlanOutput {
  if (!explicitSelection || !output.plan) return output
  const targets = uniqueModelHostnames(shells.map(shell => shell.hostname))
  if (targets.length < 2) return output
  const normalize = (value: string): string => value.trim().replace(/\.$/, '').toLowerCase()
  const represented = new Set(output.plan.steps.map(step => normalize(step.target)))
  const missing = targets.filter(target => !represented.has(normalize(target)))
  if (missing.length === 0) return output

  // Preserve the model's reviewed order and clone its command set for every
  // omitted selected host. The schema caps plans at 32 steps; if expansion
  // would exceed that bound, leave the original plan intact so no reviewed
  // command is silently truncated.
  const additions = missing.flatMap(target => output.plan!.steps.map(step => ({ ...step, target })))
  if (output.plan.steps.length + additions.length > 32) return output
  return {
    ...output,
    plan: { ...output.plan, steps: [...output.plan.steps, ...additions] },
  }
}

function projectShellsForPrompt(shells: readonly StructuredChatShell[]): StructuredChatShell[] {
  const targets = resolveModelShellTargets(shells.map(shell => ({
    hostname: shell.hostname,
    observedHostname: shell.observedHostname,
    displayName: shell.title,
  })))
  return shells.map((shell, index) => {
    const observedHostname = modelHostname(shell.observedHostname)
    const hostname = targets[index]!
    const title = modelDisplayName(shell.title, hostname)
    const displayLabel = modelDisplayName(shell.displayLabel, hostname)
    return {
      hostname,
      ...(observedHostname ? { observedHostname } : {}),
      title,
      displayLabel,
      ordinal: shell.ordinal,
      ...(shell.recentLines ? { recentLines: shell.recentLines.map(stripIpLiterals) } : {}),
    }
  })
}
