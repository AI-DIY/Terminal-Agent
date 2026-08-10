import { z } from 'zod'

export const modelSettingsInputSchema = z.object({
  endpoint: z.string().url().refine(
    value => new URL(value).pathname.endsWith('/chat/completions'),
    'Endpoint must target OpenAI Chat Completions',
  ),
  model: z.string().trim().min(1).max(128),
  apiKey: z.string().trim().min(1).max(4096),
  contextLimit: z.number().int().min(1024).max(1_000_000),
})

export type ModelSettingsInput = z.infer<typeof modelSettingsInputSchema>

export const rendererModelSettingsInputSchema = modelSettingsInputSchema.extend({
  apiKey: z.string().trim().min(1).max(4096).optional(),
})
export type RendererModelSettingsInput = z.infer<typeof rendererModelSettingsInputSchema>

export type PersistedModelSettings = Omit<ModelSettingsInput, 'apiKey'>
