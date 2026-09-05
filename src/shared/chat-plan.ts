import { z } from 'zod'

const chatIdentifierSchema = z.string().trim().min(1).max(128)
const hostnameSchema = z.string().trim().min(1).max(255)
  .refine(value => !/\s/.test(value), 'Hostnames cannot contain whitespace')
const terminalSessionIdSchema = z.string().trim().min(1).max(128)
const commandSchema = z.string().trim().min(1).max(64 * 1024)
  .refine(value => !value.includes('\0'), 'Commands cannot contain NUL')
  .refine(value => !value.includes('```'), 'Commands cannot be Markdown code fences')

export const assistantPlanOutputSchema = z.object({
  version: z.literal(1),
  reply: z.string().trim().min(1).max(12_000),
  plan: z.object({
    title: z.string().trim().min(1).max(255),
    steps: z.array(z.object({
      target: hostnameSchema,
      explanation: z.string().trim().min(1).max(4_000),
      command: commandSchema,
    }).strict()).min(1).max(32),
  }).strict().nullable(),
}).strict()
export type AssistantPlanOutput = z.infer<typeof assistantPlanOutputSchema>

export const executionPlanStatusSchema = z.enum([
  'pending_review', 'executing', 'executed', 'partially_executed', 'execution_failed', 'cancelled',
])
export type ExecutionPlanStatus = z.infer<typeof executionPlanStatusSchema>

export const executionPlanStepSchema = z.object({
  id: chatIdentifierSchema,
  target: hostnameSchema,
  explanation: z.string().trim().min(1).max(4_000),
  originalCommand: commandSchema,
  finalCommand: commandSchema.optional(),
  fence: z.object({ ruleId: z.string(), ruleName: z.string() }).strict().optional(),
  sessionId: terminalSessionIdSchema.optional(),
  sendState: z.enum(['pending', 'sent', 'failed', 'not_sent']),
  failure: z.string().max(1_000).optional(),
}).strict()
export type ExecutionPlanStep = z.infer<typeof executionPlanStepSchema>

export const chatExecutionPlanSchema = z.object({
  id: chatIdentifierSchema,
  title: z.string().trim().min(1).max(255),
  status: executionPlanStatusSchema,
  // A cancelled plan may intentionally retain an empty step list after the
  // user removes its final host command. Assistant-generated plans still
  // require at least one step via assistantPlanOutputSchema above.
  steps: z.array(executionPlanStepSchema).max(32),
}).strict()
export type ChatExecutionPlan = z.infer<typeof chatExecutionPlanSchema>

const chatPlanRequestSchema = z.object({
  requestId: chatIdentifierSchema,
  chatId: chatIdentifierSchema,
  messageId: chatIdentifierSchema,
}).strict()

export const chatPlanEditStepRequestSchema = chatPlanRequestSchema.extend({
  stepId: chatIdentifierSchema,
  command: commandSchema,
}).strict()
export type ChatPlanEditStepRequest = z.infer<typeof chatPlanEditStepRequestSchema>

export const chatPlanRemoveStepRequestSchema = chatPlanRequestSchema.extend({
  stepId: chatIdentifierSchema,
}).strict()
export type ChatPlanRemoveStepRequest = z.infer<typeof chatPlanRemoveStepRequestSchema>

export const chatPlanCancelRequestSchema = chatPlanRequestSchema
export type ChatPlanCancelRequest = z.infer<typeof chatPlanCancelRequestSchema>

export const chatPlanExecuteRequestSchema = chatPlanRequestSchema
export type ChatPlanExecuteRequest = z.infer<typeof chatPlanExecuteRequestSchema>

export function parseAssistantPlanOutput(value: string): AssistantPlanOutput {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('Assistant output must be a complete JSON object')
  }
  return assistantPlanOutputSchema.parse(parsed)
}
