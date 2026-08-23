import { z } from 'zod'

const sensitiveEndpointTokenPattern = /(?:api[_-]?key|token|password|secret|credential|private[_-]?key|access[_-]?token|auth|\bkey\b)/i

export const modelEndpointSchema = z.string().url().superRefine((value, context) => {
  const url = new URL(value)
  if (url.username || url.password) {
    context.addIssue({ code: 'custom', message: 'Endpoint cannot contain URL credentials' })
  }
  if (url.hash) {
    context.addIssue({ code: 'custom', message: 'Endpoint cannot contain URL fragments' })
  }
  if (sensitiveEndpointTokenPattern.test(url.pathname)) {
    context.addIssue({ code: 'custom', message: 'Endpoint path cannot contain credentials' })
  }
  for (const [name, parameterValue] of url.searchParams) {
    if (sensitiveEndpointTokenPattern.test(name) || sensitiveEndpointTokenPattern.test(parameterValue)) {
      context.addIssue({ code: 'custom', message: 'Endpoint query parameters cannot contain credentials' })
      break
    }
  }
})

export const modelApiKeySchema = z.string().trim().min(1).max(4_096).refine(
  value => new TextEncoder().encode(value).byteLength <= 4_096,
  'API key exceeds the maximum supported size',
)

export const modelSettingsInputSchema = z.object({
  endpoint: modelEndpointSchema.refine(
    value => new URL(value).pathname.endsWith('/chat/completions'),
    'Endpoint must target OpenAI Chat Completions',
  ),
  model: z.string().trim().min(1).max(128),
  apiKey: modelApiKeySchema,
  contextLimit: z.number().int().min(1024).max(1_000_000),
})

export type ModelSettingsInput = z.infer<typeof modelSettingsInputSchema>

// The legacy model IPC remains for compatibility, but renderer requests must
// never carry a plaintext API key. Main-process callers use modelSettingsInputSchema.
export const rendererModelSettingsInputSchema = modelSettingsInputSchema.omit({ apiKey: true }).strict()
export type RendererModelSettingsInput = z.infer<typeof rendererModelSettingsInputSchema>

export type PersistedModelSettings = Omit<ModelSettingsInput, 'apiKey'>

export const modelProfileKindSchema = z.enum(['llm', 'vlm'])
export type ModelProfileKind = z.infer<typeof modelProfileKindSchema>

export const modelProviderSchema = z.enum(['openai', 'ollama', 'llama-cpp'])
export type ModelProvider = z.infer<typeof modelProviderSchema>

export const modelRoutingSchema = z.enum(['combined', 'vision-only'])
export type ModelRouting = z.infer<typeof modelRoutingSchema>

export const modelProfileIdSchema = z.string().trim().min(1).max(128)

const modelProfileBaseSchema = z.object({
  id: modelProfileIdSchema.optional(),
  name: z.string().trim().min(1).max(255),
  kind: modelProfileKindSchema,
  provider: modelProviderSchema,
  model: z.string().trim().min(1).max(255),
  endpoint: modelEndpointSchema,
  contextLimit: z.number().int().min(1_024).max(1_000_000).optional(),
  maxImages: z.number().int().min(1).max(128).optional(),
  apiKey: modelApiKeySchema.optional(),
}).strict()

type ModelProfileValidationFields = {
  kind: ModelProfileKind
  provider: ModelProvider
  endpoint: string
  contextLimit?: number
  maxImages?: number
  apiKey?: string
}

function validateModelProfile(profile: ModelProfileValidationFields, context: z.RefinementCtx): void {
  const endpoint = profile.endpoint
  if (profile.kind === 'llm' && profile.contextLimit === undefined) {
    context.addIssue({ code: 'custom', path: ['contextLimit'], message: 'LLM contextLimit is required' })
  }
  if (profile.kind === 'llm' && profile.maxImages !== undefined) {
    context.addIssue({ code: 'custom', path: ['maxImages'], message: 'LLM profiles cannot define maxImages' })
  }
  if (profile.kind === 'vlm' && profile.maxImages === undefined) {
    context.addIssue({ code: 'custom', path: ['maxImages'], message: 'VLM maxImages is required' })
  }
  if (profile.kind === 'vlm' && profile.contextLimit !== undefined) {
    context.addIssue({ code: 'custom', path: ['contextLimit'], message: 'VLM profiles cannot define contextLimit' })
  }
  const pathname = new URL(endpoint).pathname
  if (profile.provider !== 'ollama' && !pathname.endsWith('/chat/completions')) {
    context.addIssue({ code: 'custom', path: ['endpoint'], message: 'Endpoint must target OpenAI Chat Completions' })
  }
  if (profile.provider === 'ollama' && !pathname.endsWith('/api/chat')) {
    context.addIssue({ code: 'custom', path: ['endpoint'], message: 'Ollama endpoint must target /api/chat' })
  }
}

export const modelProfileInputSchema = modelProfileBaseSchema.superRefine(validateModelProfile)
export type ModelProfileInput = z.infer<typeof modelProfileInputSchema>

export const rendererModelProfileInputSchema = modelProfileBaseSchema.superRefine(validateModelProfile)
export type RendererModelProfileInput = z.infer<typeof rendererModelProfileInputSchema>
