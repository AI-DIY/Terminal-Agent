import { z } from 'zod'

export const sessionModeSchema = z.enum(['copilot', 'autonomous'])
export type SessionMode = z.infer<typeof sessionModeSchema>

export const sessionIdSchema = z.string().uuid()
export const hostnameSchema = z.string().trim().min(1).max(255)
export const terminalSessionIdSchema = z.string().trim().min(1).max(128)
export const terminalWriteSchema = z.object({
  sessionId: terminalSessionIdSchema,
  data: z.string().max(64 * 1_024),
})
export const terminalResizeSchema = z.object({
  sessionId: terminalSessionIdSchema,
  columns: z.number().int().min(1).max(500),
  rows: z.number().int().min(1).max(500),
})

export const candidateConfirmationRequestSchema = z.object({
  sessionId: terminalSessionIdSchema,
  candidateId: z.string().trim().min(1).max(128),
})
export type CandidateConfirmationRequest = z.infer<typeof candidateConfirmationRequestSchema>

export const agentStartRequestSchema = z.object({
  sessionId: terminalSessionIdSchema,
  runId: z.string().uuid(),
  goal: z.string().trim().min(1).max(8_192),
}).strict()
export type AgentStartRequest = z.infer<typeof agentStartRequestSchema>

export type AgentCandidate = {
  id: string
  sessionId: string
  command: string
  explanation: string
}

export type AgentStreamEvent =
  | { kind: 'delta'; content: string }
  | { kind: 'proposal'; analysis: string; evidenceStrategy: string[]; candidate: AgentCandidate | null }

export type AgentDeltaEvent = { sessionId: string; runId: string; content: string }
export type AgentProposalEvent = {
  sessionId: string
  runId: string
  analysis: string
  evidenceStrategy: string[]
  candidate: AgentCandidate | null
  autonomousExecution?: true
}
export type AgentErrorEvent = { sessionId: string; runId: string; message: string }

export const agentExecutionRequestSchema = z.object({
  sessionId: terminalSessionIdSchema,
  command: z.string().min(1).max(64 * 1_024),
  confirmationId: z.string().trim().min(1).max(128).optional(),
})
export type AgentExecutionRequest = z.infer<typeof agentExecutionRequestSchema>

export type TerminalDataEvent = {
  sessionId: string
  data: string
}

export const rendererSessionRequestSchema = z.object({
  host: hostnameSchema,
  port: z.number().int().min(1).max(65_535),
  username: z.string().trim().min(1).max(255),
  auth: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('password'), password: z.string().max(8_192) }),
    z.object({
      kind: z.literal('privateKey'),
      keyReference: z.string().trim().min(1).max(128),
      passphrase: z.string().max(8_192).optional(),
    }),
  ]),
})
export type RendererSessionRequest = z.infer<typeof rendererSessionRequestSchema>

export const savedDirectSessionInputSchema = z.object({
  id: terminalSessionIdSchema,
  name: z.string().trim().min(1).max(255),
  host: hostnameSchema,
  port: z.number().int().min(1).max(65_535),
  username: z.string().trim().min(1).max(255),
  auth: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('password'), password: z.string().max(8_192).optional() }),
    z.object({
      kind: z.literal('privateKey'),
      privateKeyPath: z.string().trim().min(1).max(4_096),
      passphrase: z.string().max(8_192).optional(),
    }),
  ]),
})
export type SavedDirectSessionInput = z.infer<typeof savedDirectSessionInputSchema>
