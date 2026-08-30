import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { AgentCandidate } from '../../shared/contracts'
import type { ChatCompletionsClient, ChatMessage } from '../model/chat-completions-client'
import type { ModelSettingsService, ModelSettings } from '../settings/model-settings-service'
import type { AgentEventPublisher, SchedulerModelPort, SchedulerModelRequest } from './agent-contracts'
import { modelHostname, projectModelFacts } from '../../shared/model-context'

type ModelSettingsSource = Pick<ModelSettingsService, 'load'>
type ChatCompletionsSource = Pick<ChatCompletionsClient, 'stream'>
type ProfileRouteSource = { resolveRoute(request: { hasImages: boolean }): Promise<{ endpoint: string; model: string; kind: 'llm' | 'vlm'; provider: 'openai' | 'ollama' | 'llama-cpp'; contextLimit?: number; maxImages?: number; apiKey: string | null }> }
type ProtectedModelSettings = ModelSettings & { apiKey: string }

const agentResultSchema = z.object({
  analysis: z.string().trim().min(1).max(8_000),
  evidenceStrategy: z.array(z.string().trim().min(1).max(1_000)).max(12),
  candidate: z.object({
    command: z.string().trim().min(1).max(64 * 1_024),
    explanation: z.string().trim().min(1).max(1_000),
  }).strict().nullable(),
}).strict()

export class ModelConfigurationError extends Error {}

export class AgentModelRuntime implements SchedulerModelPort {
  constructor(
    private readonly models: ModelSettingsSource,
    private readonly client: ChatCompletionsSource,
    private readonly createCandidateId: () => string = randomUUID,
    private readonly routes?: ProfileRouteSource,
  ) {}

  async stream(request: SchedulerModelRequest, publish: AgentEventPublisher): Promise<void> {
    const settings = await this.requireSettings(request.hasImages ?? false)
    let response = ''
    const onDelta = (content: string): void => {
      response += content
      publish({ kind: 'delta', content })
    }
    if (request.signal) {
      await this.client.stream(settings, createMessages(request), onDelta, undefined, request.signal)
    } else {
      await this.client.stream(settings, createMessages(request), onDelta)
    }
    const parsed = parseFinalResult(response)
    const candidate: AgentCandidate | null = parsed.candidate
      ? { id: this.createCandidateId(), sessionId: request.sessionId, ...parsed.candidate }
      : null
    await publish({
      kind: 'proposal',
      analysis: parsed.analysis,
      evidenceStrategy: parsed.evidenceStrategy,
      candidate,
    })
  }

  private async requireSettings(hasImages: boolean): Promise<ProtectedModelSettings> {
    if (this.routes) {
      const profile = await this.routes.resolveRoute({ hasImages })
      const apiKey = profile.apiKey ?? ''
      if (profile.provider !== 'ollama' && !apiKey) throw new ModelConfigurationError('The protected model configuration is unavailable')
      return {
        endpoint: profile.endpoint,
        model: profile.model,
        contextLimit: profile.contextLimit ?? profile.maxImages ?? 1_024,
        apiKey,
        provider: profile.provider,
      }
    }
    const settings = await this.models.load()
    const apiKey = settings?.apiKey
    if (!settings || !apiKey) throw new ModelConfigurationError('The protected model configuration is unavailable')
    return { ...settings, apiKey }
  }
}

function createMessages(request: SchedulerModelRequest): ChatMessage[] {
  // Keep user-authored goal text intact, but project all host facts at the
  // model boundary. Transport addresses (including bastion endpoints and
  // interface lists) are intentionally unavailable to the model.
  const facts = projectModelFacts(request.facts)
  const hostname = modelHostname(request.hostname) ?? modelHostname(request.facts.hostname)
  return [
    {
      role: 'system',
      content: '你是运维辅助代理。只能基于提供的目标和结构化主机事实进行分析。最终必须使用中文，并严格返回指定 JSON：analysis、evidenceStrategy、candidate；candidate 只能是 null 或一条候选命令。辅助驾驶会在执行前要求用户确认。',
    },
    {
      role: 'user',
      content: JSON.stringify({
        goal: request.goal,
        ...(hostname ? { hostname } : {}),
        facts,
      }),
    },
  ]
}

function parseFinalResult(response: string): z.infer<typeof agentResultSchema> {
  try {
    return agentResultSchema.parse(JSON.parse(unfenceJson(response)))
  } catch {
    throw new Error('AI returned an invalid analysis result')
  }
}

function unfenceJson(value: string): string {
  const trimmed = value.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/i)
  return fenced?.[1] ?? trimmed
}
