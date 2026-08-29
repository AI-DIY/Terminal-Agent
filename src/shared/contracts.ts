import { z } from 'zod'
import { chatMessageContentSchema } from './chat-content'
import { chatExecutionPlanSchema } from './chat-plan'
import { containsSensitiveHostMemoryData, normalizeSafeHostMemoryConnectionIp, normalizeSafeHostMemoryConnectionLabel, normalizeSafeHostMemoryIdentity } from './host-memory-safety'
import { modelEndpointSchema, modelProfileIdSchema } from './validation'

export const WORKBENCH_LEFT_WIDTH_MIN = 210
export const WORKBENCH_LEFT_WIDTH_MAX = 360
export const WORKBENCH_RIGHT_WIDTH_MIN = 340
export const WORKBENCH_RIGHT_WIDTH_MAX = 520

export const workbenchThemeSchema = z.enum(['pearl', 'graphite'])
export type WorkbenchTheme = z.infer<typeof workbenchThemeSchema>

export const shellRowHeightPercentSchema = z.union([z.literal(48), z.literal(64), z.literal(80)])
export type ShellRowHeightPercent = z.infer<typeof shellRowHeightPercentSchema>

export const workbenchLayoutSchema = z.object({
  leftWidth: z.number().int().min(WORKBENCH_LEFT_WIDTH_MIN).max(WORKBENCH_LEFT_WIDTH_MAX),
  rightWidth: z.number().int().min(WORKBENCH_RIGHT_WIDTH_MIN).max(WORKBENCH_RIGHT_WIDTH_MAX),
  leftCollapsed: z.boolean(),
  rightCollapsed: z.boolean(),
  visibleCount: z.number().int().min(1).max(4),
  columns: z.number().int().min(1).max(4),
  rowHeightPercent: shellRowHeightPercentSchema,
}).strict()
export type WorkbenchLayout = z.infer<typeof workbenchLayoutSchema>

export const workbenchLayoutPatchSchema = workbenchLayoutSchema.partial().strict()
export type WorkbenchLayoutPatch = z.infer<typeof workbenchLayoutPatchSchema>

export const workbenchPreferencesSchema = z.object({
  theme: workbenchThemeSchema,
  ...workbenchLayoutSchema.shape,
}).strict()
export type WorkbenchPreferences = z.infer<typeof workbenchPreferencesSchema>

export const workbenchPreferencesDocumentSchema = z.object({
  version: z.literal(3),
  appearance: z.object({ theme: workbenchThemeSchema }).strict(),
  layout: workbenchLayoutSchema,
  routing: z.object({}).strict(),
  memory: z.object({}).strict(),
}).strict()
export type WorkbenchPreferencesDocument = z.infer<typeof workbenchPreferencesDocumentSchema>

export function createDefaultWorkbenchPreferences(): WorkbenchPreferences {
  return {
    theme: 'pearl',
    leftWidth: 222,
    rightWidth: 390,
    leftCollapsed: false,
    rightCollapsed: false,
    visibleCount: 3,
    columns: 3,
    rowHeightPercent: 64,
  }
}

export type { ModelProfileKind, ModelProvider, ModelRouting, RendererModelProfileInput } from './validation'

export const rendererModelProfileSchema = z.object({
  id: modelProfileIdSchema,
  name: z.string().trim().min(1).max(255),
  kind: z.enum(['llm', 'vlm']),
  provider: z.enum(['openai', 'ollama', 'llama-cpp']),
  model: z.string().trim().min(1).max(255),
  endpoint: modelEndpointSchema,
  contextLimit: z.number().int().min(1_024).max(1_000_000).optional(),
  maxImages: z.number().int().min(1).max(128).optional(),
  hasApiKey: z.boolean(),
  active: z.boolean(),
}).strip()
export type RendererModelProfile = z.infer<typeof rendererModelProfileSchema>

export const sessionModeSchema = z.enum(['copilot', 'autonomous'])
export type SessionMode = z.infer<typeof sessionModeSchema>

export const chatIdentifierSchema = z.string().trim().min(1).max(128)
export const chatRequestIdSchema = z.string().trim().min(1).max(128)
const canonicalChatTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
export const chatTimestampSchema = z.string().regex(canonicalChatTimestampPattern).refine(timestamp => {
  const milliseconds = Date.parse(timestamp)
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === timestamp
}, 'Invalid canonical chat timestamp')

export const chatTitleStateSchema = z.enum(['new', 'started', 'custom'])
export type ChatTitleState = z.infer<typeof chatTitleStateSchema>

export const chatSummarySchema = z.object({
  id: chatIdentifierSchema,
  title: z.string().trim().min(1).max(255),
  titleState: chatTitleStateSchema,
  pinnedAt: chatTimestampSchema.nullable(),
  createdAt: chatTimestampSchema,
  updatedAt: chatTimestampSchema,
  shellCount: z.number().int().nonnegative(),
  mode: sessionModeSchema,
  live: z.boolean(),
}).strict()
export type ChatSummary = z.infer<typeof chatSummarySchema>

const chatMessageRoleSchema = z.enum(['user', 'assistant', 'system'])
const chatMessageStateSchema = z.enum(['complete', 'streaming', 'error'])
const chatMessageInternalFields = {
  messageType: z.literal('execution_audit').optional(),
  executionPlan: chatExecutionPlanSchema.optional(),
}

export const chatMessageRecordSchema = z.object({
  id: chatIdentifierSchema,
  chatId: chatIdentifierSchema,
  role: chatMessageRoleSchema,
  content: chatMessageContentSchema,
  createdAt: chatTimestampSchema,
  state: chatMessageStateSchema,
  retryable: z.boolean().optional(),
  ...chatMessageInternalFields,
}).strict().superRefine((message, context) => {
  if (Array.isArray(message.content) && message.role !== 'user') {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['content'], message: 'Only user messages may contain multimodal content' })
  }
  if (message.messageType === 'execution_audit' && (message.role !== 'user' || message.state !== 'complete' || Array.isArray(message.content))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['messageType'], message: 'Execution audits must be complete user text messages' })
  }
  if (message.executionPlan && (message.role !== 'assistant' || message.state !== 'complete' || Array.isArray(message.content))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['executionPlan'], message: 'Execution plans must be complete assistant text messages' })
  }
})
export type ChatMessageRecord = z.infer<typeof chatMessageRecordSchema>

export const chatShellAssociationSchema = z.object({
  id: chatIdentifierSchema,
  chatId: chatIdentifierSchema,
  sessionId: z.string().trim().min(1).max(128).optional(),
  historyId: chatIdentifierSchema,
  hostname: z.string().trim().min(1).max(255),
  observedHostname: z.string().trim().min(1).max(255).optional(),
  title: z.string().trim().min(1).max(255),
  status: z.enum(['open', 'closed']),
  associatedAt: chatTimestampSchema,
  closedAt: chatTimestampSchema.optional(),
}).strict()
export type ChatShellAssociation = z.infer<typeof chatShellAssociationSchema>

export const chatWorkspaceSchema = chatSummarySchema.extend({
  messages: z.array(chatMessageRecordSchema),
  shells: z.array(chatShellAssociationSchema),
}).strict()
export type ChatWorkspace = z.infer<typeof chatWorkspaceSchema>

export const chatWorkspaceSnapshotSchema = z.object({
  revision: z.number().int().nonnegative(),
  chat: chatWorkspaceSchema,
  liveChatId: chatIdentifierSchema.nullable(),
}).strict()
export type ChatWorkspaceSnapshot = z.infer<typeof chatWorkspaceSnapshotSchema>

export const chatListSnapshotSchema = z.object({
  revision: z.number().int().nonnegative(),
  chats: z.array(chatSummarySchema),
  liveChatId: chatIdentifierSchema.nullable(),
}).strict()
export type ChatListSnapshot = z.infer<typeof chatListSnapshotSchema>

export const chatCreateRequestSchema = z.object({
  requestId: chatRequestIdSchema,
  title: z.string().trim().min(1).max(255).optional(),
}).strict()
export type ChatCreateRequest = z.infer<typeof chatCreateRequestSchema>

export const chatSetModeRequestSchema = z.object({
  requestId: chatRequestIdSchema,
  chatId: chatIdentifierSchema,
  mode: sessionModeSchema,
}).strict()
export type ChatSetModeRequest = z.infer<typeof chatSetModeRequestSchema>

export const chatRemoveRequestSchema = z.object({
  requestId: chatRequestIdSchema,
  chatId: chatIdentifierSchema,
}).strict()
export type ChatRemoveRequest = z.infer<typeof chatRemoveRequestSchema>

export const chatPinRequestSchema = z.object({
  requestId: chatRequestIdSchema,
  chatId: chatIdentifierSchema,
}).strict()
export type ChatPinRequest = z.infer<typeof chatPinRequestSchema>

export const chatUnpinRequestSchema = z.object({
  requestId: chatRequestIdSchema,
  chatId: chatIdentifierSchema,
}).strict()
export type ChatUnpinRequest = z.infer<typeof chatUnpinRequestSchema>

export const chatBindSessionRequestSchema = z.object({
  requestId: chatRequestIdSchema,
  chatId: chatIdentifierSchema,
  sessionId: z.string().trim().min(1).max(128),
}).strict()
export type ChatBindSessionRequest = z.infer<typeof chatBindSessionRequestSchema>

export const chatTransferSessionsRequestSchema = z.object({
  requestId: chatRequestIdSchema,
  sourceChatId: chatIdentifierSchema,
  targetChatId: chatIdentifierSchema.optional(),
  sessionIds: z.array(chatBindSessionRequestSchema.shape.sessionId).min(1).max(128),
}).strict().superRefine((request, context) => {
  if (new Set(request.sessionIds).size !== request.sessionIds.length) {
    context.addIssue({ code: 'custom', path: ['sessionIds'], message: 'sessionIds must be unique' })
  }
  if (request.targetChatId && request.sourceChatId === request.targetChatId) {
    context.addIssue({ code: 'custom', path: ['targetChatId'], message: 'source and target chats must differ' })
  }
})
export type ChatTransferSessionsRequest = z.infer<typeof chatTransferSessionsRequestSchema>

export const chatResolveSessionRequestSchema = z.object({
  sessionId: chatBindSessionRequestSchema.shape.sessionId,
}).strict()
export type ChatResolveSessionRequest = z.infer<typeof chatResolveSessionRequestSchema>

export const chatSessionResolutionSchema = z.object({
  revision: z.number().int().nonnegative(),
  sessionId: chatBindSessionRequestSchema.shape.sessionId,
  chat: chatWorkspaceSchema.nullable(),
  liveChatId: chatIdentifierSchema.nullable(),
}).strict()
export type ChatSessionResolution = z.infer<typeof chatSessionResolutionSchema>

export const chatRunRequestSchema = z.object({
  chatId: chatIdentifierSchema,
  runId: z.string().uuid(),
  content: chatMessageContentSchema.refine(content => typeof content !== 'string' || content.trim().length > 0, 'Text content cannot be blank'),
  retry: z.boolean().optional(),
}).strict()
export type ChatRunRequest = z.infer<typeof chatRunRequestSchema>

export const chatProgressStageSchema = z.enum(['thinking', 'executing', 'observing', 'repairing'])
export type ChatProgressStage = z.infer<typeof chatProgressStageSchema>

export const chatRuntimeEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('chat:progress'), chatId: chatIdentifierSchema, runId: z.string().uuid(), stage: chatProgressStageSchema }).strict(),
  z.object({ kind: z.literal('chat:delta'), chatId: chatIdentifierSchema, runId: z.string().uuid(), messageId: chatIdentifierSchema, content: z.string().max(100_000) }).strict(),
  z.object({ kind: z.literal('chat:completed'), chatId: chatIdentifierSchema, runId: z.string().uuid(), messageId: chatIdentifierSchema, content: z.string().max(1_000_000), executionPlan: chatExecutionPlanSchema.optional() }).strict(),
  z.object({ kind: z.literal('chat:error'), chatId: chatIdentifierSchema, runId: z.string().uuid(), messageId: chatIdentifierSchema, error: z.string().max(4_000), retryable: z.boolean() }).strict(),
])
export type ChatRuntimeEvent = z.infer<typeof chatRuntimeEventSchema>

export const chatAppendMessageRequestSchema = z.object({
  requestId: chatRequestIdSchema,
  chatId: chatIdentifierSchema,
  role: chatMessageRoleSchema,
  content: chatMessageContentSchema,
  state: chatMessageStateSchema,
  retryable: z.boolean().optional(),
  ...chatMessageInternalFields,
}).strict().superRefine((message, context) => {
  if (Array.isArray(message.content) && message.role !== 'user') {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['content'], message: 'Only user messages may contain multimodal content' })
  }
  if (message.messageType === 'execution_audit' && (message.role !== 'user' || message.state !== 'complete' || Array.isArray(message.content))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['messageType'], message: 'Execution audits must be complete user text messages' })
  }
  if (message.executionPlan && (message.role !== 'assistant' || message.state !== 'complete' || Array.isArray(message.content))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['executionPlan'], message: 'Execution plans must be complete assistant text messages' })
  }
})
export type ChatAppendMessageRequest = z.infer<typeof chatAppendMessageRequestSchema>

export const chatUpdateMessageRequestSchema = z.object({
  requestId: chatRequestIdSchema,
  chatId: chatIdentifierSchema,
  messageId: chatIdentifierSchema,
  content: chatMessageContentSchema,
  state: chatMessageStateSchema,
  retryable: z.boolean().optional(),
  ...chatMessageInternalFields,
}).strict().superRefine((message, context) => {
  if (Array.isArray(message.content)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['content'], message: 'Message updates cannot introduce multimodal content' })
  }
  if (message.messageType === 'execution_audit' && message.state !== 'complete') {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['messageType'], message: 'Execution audits must be complete' })
  }
  if (message.executionPlan && message.state !== 'complete') {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['executionPlan'], message: 'Execution plans must be complete' })
  }
})
export type ChatUpdateMessageRequest = z.infer<typeof chatUpdateMessageRequestSchema>

export const chatUpdateTitleRequestSchema = z.object({
  requestId: chatRequestIdSchema,
  chatId: chatIdentifierSchema,
  title: z.string().trim().min(1).max(255),
}).strict()
export type ChatUpdateTitleRequest = z.infer<typeof chatUpdateTitleRequestSchema>

export const chatAssociateShellRequestSchema = z.object({
  requestId: chatRequestIdSchema,
  chatId: chatIdentifierSchema,
  sessionId: z.string().trim().min(1).max(128).optional(),
  historyId: chatIdentifierSchema,
  hostname: z.string().trim().min(1).max(255),
  observedHostname: z.string().trim().min(1).max(255).optional(),
  title: z.string().trim().min(1).max(255),
}).strict()
export type ChatAssociateShellRequest = z.infer<typeof chatAssociateShellRequestSchema>

export const chatCloseAssociationRequestSchema = z.object({
  requestId: chatRequestIdSchema,
  chatId: chatIdentifierSchema,
  associationId: chatIdentifierSchema,
}).strict()
export type ChatCloseAssociationRequest = z.infer<typeof chatCloseAssociationRequestSchema>

export const chatChangedEventSchema = z.discriminatedUnion('kind', [
  z.object({ revision: z.number().int().nonnegative(), kind: z.enum(['created', 'updated']), chat: chatWorkspaceSchema, liveChatId: chatIdentifierSchema.nullable() }).strict(),
  z.object({ revision: z.number().int().nonnegative(), kind: z.literal('removed'), chatId: chatIdentifierSchema, liveChatId: chatIdentifierSchema.nullable() }).strict(),
])
export type ChatChangedEvent = z.infer<typeof chatChangedEventSchema>

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
  hasImages: z.boolean().optional(),
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

export const shellHistoryIdSchema = z.string().trim().min(1).max(128)
export const shellHistoryStatusSchema = z.literal('closed')
export type ShellHistoryStatus = z.infer<typeof shellHistoryStatusSchema>

export const shellHistorySummarySchema = z.object({
  id: shellHistoryIdSchema,
  chatId: chatIdentifierSchema,
  hostname: hostnameSchema,
  title: z.string().trim().min(1).max(255),
  startedAt: chatTimestampSchema,
  endedAt: chatTimestampSchema,
  status: shellHistoryStatusSchema,
  preview: z.string().max(512),
  reconnectable: z.boolean(),
}).strict()
export type ShellHistorySummary = z.infer<typeof shellHistorySummarySchema>

export const shellHistoryDetailSchema = shellHistorySummarySchema.extend({
  output: z.string().max(256 * 1024),
}).strict()
export type ShellHistoryDetail = z.infer<typeof shellHistoryDetailSchema>

export const shellHistoryConnectedSessionSchema = z.object({
  id: terminalSessionIdSchema,
  hostname: hostnameSchema,
  title: z.string().trim().min(1).max(255).optional(),
  mode: sessionModeSchema,
  chatId: chatIdentifierSchema.optional(),
}).strict()
export type ShellHistoryConnectedSession = z.infer<typeof shellHistoryConnectedSessionSchema>

export const shellHistoryListRequestSchema = z.object({
  chatId: chatIdentifierSchema.optional(),
  hostname: hostnameSchema.optional(),
}).strict()
export type ShellHistoryListRequest = z.infer<typeof shellHistoryListRequestSchema>

export const shellHistoryDuplicateRequestSchema = z.object({
  sessionId: terminalSessionIdSchema,
  chatId: chatIdentifierSchema,
}).strict()
export type ShellHistoryDuplicateRequest = z.infer<typeof shellHistoryDuplicateRequestSchema>

export const shellHistoryChangedEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('saved'), record: shellHistorySummarySchema }).strict(),
  z.object({ kind: z.literal('error'), message: z.literal('Shell 历史保存失败，实时连接未受影响。') }).strict(),
])
export type ShellHistoryChangedEvent = z.infer<typeof shellHistoryChangedEventSchema>

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

export type BastionSystemSummary = {
  id: string
  name: string
}

export type BastionHostSummary = {
  id: string
  systemId: string
  name: string
  address: string
  environment?: string
}

export type BastionLaunchRequest =
  | { kind: 'cmdb'; systemId: string; hostId: string }
  | { kind: 'host'; target: string }

export type BastionLaunchResult =
  | { kind: 'opened'; sessionId: string }
  | { kind: 'focused'; sessionId: string }

export type BastionCatalogSnapshot =
  | { available: true; systems: BastionSystemSummary[] }
  | { available: false; systems: []; message: string }

export function isCompleteBastionTarget(value: string): boolean {
  const target = value.trim()
  if (!target || target.length > 255 || /\s/.test(target)) return false

  const ipv4 = target.split('.')
  if (ipv4.length === 4 && ipv4.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return true
  if (ipv4.length === 4 && ipv4.every(part => /^\d+$/.test(part))) return false

  const labels = target.split('.')
  if (!labels.every(label => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label))) return false
  return target.includes('.') || target.includes('-')
}

export const bastionIdentifierSchema = z.string().trim().min(1).max(128)
const bastionTargetSchema = z.string().trim().min(3).max(255).refine(isCompleteBastionTarget)

export const bastionLaunchRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('cmdb'),
    systemId: bastionIdentifierSchema,
    hostId: bastionIdentifierSchema,
  }).strict(),
  z.object({
    kind: z.literal('host'),
    target: bastionTargetSchema,
  }).strict(),
])

export const hostMemoryScopeSchema = z.enum(['identity', 'hardware', 'processes', 'runtime'])
export type HostMemoryScope = z.infer<typeof hostMemoryScopeSchema>

export const hostMemoryScopesSchema = z.object({
  identity: z.boolean(),
  hardware: z.boolean(),
  processes: z.boolean(),
  runtime: z.boolean(),
}).strict()
export type HostMemoryScopes = z.infer<typeof hostMemoryScopesSchema>

export const hostMemorySettingsSchema = z.object({ enabled: z.boolean(), scopes: hostMemoryScopesSchema }).strict()
export type HostMemorySettings = z.infer<typeof hostMemorySettingsSchema>

export const hostMemoryConsentTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'Invalid host memory consent token')
export const hostMemoryDisclosureSchema = z.object({
  token: hostMemoryConsentTokenSchema,
  hostIdentity: z.string().refine(value => {
    try { normalizeSafeHostMemoryConnectionLabel(value); return true } catch { return false }
  }, { message: 'Host memory connection label must be safe' }),
}).strict()
export type HostMemoryDisclosure = z.infer<typeof hostMemoryDisclosureSchema>
export const hostMemoryInvalidationSchema = z.object({ token: hostMemoryConsentTokenSchema }).strict()
export type HostMemoryInvalidation = z.infer<typeof hostMemoryInvalidationSchema>

const hostMemorySafeTextSchema = z.string().trim().min(1).max(255).refine(value => !hasHostMemoryControlCharacters(value) && !containsSensitiveHostMemoryData(value), 'Host memory text must be safe')
const hostMemoryProcessNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.+@:_-]{0,126}$/).refine(value => !/^[A-Z_][A-Z0-9_]*$/.test(value), 'Environment variable names are not process facts')
const hostMemoryServiceNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9@_.:-]{0,247}\.service$/)
const hostMemoryServiceStatusSchema = z.string().regex(/^(?:active|inactive|failed|activating|deactivating|reloading|maintenance|refreshing) [a-z][a-z0-9-]{0,63}$/)
export const hostMemoryCurrentServicesSchema = z.record(hostMemoryServiceNameSchema, hostMemoryServiceStatusSchema)
const hostMemoryLinuxPathSchema = z.string().min(1).max(512).regex(/^\/(?:[A-Za-z0-9._+@:-]+(?:\/[A-Za-z0-9._+@:-]+)*)?$/).refine(value => !value.split('/').includes('..') && !containsSensitiveHostMemoryData(value), 'Host memory path must be safe')
const hostMemoryLegacyTextSchema = z.string().min(1).max(255).refine(value => !hasHostMemoryControlCharacters(value) && !containsSensitiveHostMemoryData(value), 'Legacy host memory text must be safe')
const hostMemoryLegacyFactNameSchema = hostMemoryLegacyTextSchema.refine(value => !/^[A-Z_][A-Z0-9_]*$/.test(value), 'Environment variable names are not host facts')
const hostMemoryLegacyConfigurationHashSchema = z.string().regex(/^[a-fA-F0-9]{64}$/, 'Configuration hashes must be SHA-256 values')
const hostMemoryLegacySoftwareSchema = z.record(hostMemoryLegacyFactNameSchema, hostMemoryLegacyTextSchema).refine(value => Object.keys(value).length <= 2_000, 'Too many legacy software facts')
const hostMemoryLegacyProcessesSchema = z.array(z.object({ name: hostMemoryLegacyFactNameSchema, status: hostMemoryLegacyTextSchema }).strict()).max(2_000)
const hostMemoryLegacyInstallLocationsSchema = z.record(hostMemoryLegacyFactNameSchema, hostMemoryLinuxPathSchema).refine(value => Object.keys(value).length <= 2_000, 'Too many legacy install locations')
const hostMemoryLegacyServicesSchema = z.record(hostMemoryLegacyFactNameSchema, hostMemoryLegacyTextSchema).refine(value => Object.keys(value).length <= 128, 'Too many legacy services')
const hostMemoryLegacyLogLocationsSchema = z.array(hostMemoryLinuxPathSchema).max(2_000)
const hostMemoryLegacyConfigurationHashesSchema = z.record(z.string(), hostMemoryLegacyConfigurationHashSchema).superRefine((hashes, context) => {
  if (Object.keys(hashes).length > 2_000) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Too many legacy configuration hashes' })
  for (const path of Object.keys(hashes)) {
    if (!hostMemoryLinuxPathSchema.safeParse(path).success) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Configuration hash path must be safe', path: [path] })
  }
})
export const hostMemoryLegacyRecordSchema = z.object({
  software: hostMemoryLegacySoftwareSchema,
  processes: hostMemoryLegacyProcessesSchema,
  installLocations: hostMemoryLegacyInstallLocationsSchema,
  services: hostMemoryLegacyServicesSchema,
  logLocations: hostMemoryLegacyLogLocationsSchema,
  configurationHashes: hostMemoryLegacyConfigurationHashesSchema,
}).strict()
export type HostMemoryLegacyRecord = z.infer<typeof hostMemoryLegacyRecordSchema>
export const hostMemoryLegacyFactsSchema = z.object({
  software: hostMemoryLegacySoftwareSchema.refine(value => Object.keys(value).length > 0, 'Legacy software facts cannot be empty').optional(),
  processes: hostMemoryLegacyProcessesSchema.min(1).optional(),
  installLocations: hostMemoryLegacyInstallLocationsSchema.refine(value => Object.keys(value).length > 0, 'Legacy install locations cannot be empty').optional(),
  services: hostMemoryLegacyServicesSchema.refine(value => Object.keys(value).length > 0, 'Legacy services cannot be empty').optional(),
  logLocations: hostMemoryLegacyLogLocationsSchema.min(1).optional(),
  configurationHashes: hostMemoryLegacyConfigurationHashesSchema.refine(value => Object.keys(value).length > 0, 'Legacy configuration hashes cannot be empty').optional(),
}).strict().refine(value => Object.keys(value).length > 0, 'Legacy facts cannot be empty')
export type HostMemoryLegacyFacts = z.infer<typeof hostMemoryLegacyFactsSchema>
const hostMemoryConnectionIpSchema = z.string().refine(value => {
  try { normalizeSafeHostMemoryConnectionIp(value); return true } catch { return false }
}, { message: 'Host memory connection IP must be a valid IP address' })
const hostMemoryOperatingSystemSchema = z.object({ name: hostMemorySafeTextSchema, version: hostMemorySafeTextSchema.optional() }).strict()
const hostMemoryCpuSchema = z.object({
  model: hostMemorySafeTextSchema.optional(),
  architecture: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/).optional(),
  logicalCores: z.number().int().min(1).max(65_536).optional(),
}).strict().refine(value => Object.values(value).some(item => item !== undefined), 'CPU facts cannot be empty')
const hostMemoryByteCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const hostMemoryDiskSchema = z.object({ name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/), totalBytes: hostMemoryByteCountSchema }).strict()
const hostMemoryNetworkInterfaceSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,63}$/),
  addresses: z.array(hostMemoryConnectionIpSchema).max(16),
}).strict()
const hostMemoryUserSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,63}\$?$/).refine(value => !containsSensitiveHostMemoryData(value), 'Host memory user must be safe')
export const hostMemoryHostnameSchema = z.string().refine(value => {
  try { normalizeSafeHostMemoryIdentity(value); return true } catch { return false }
}, { message: 'Host memory identity must be a safe hostname' })
export const hostMemoryRecordSchema = z.object({
  hostname: hostMemoryHostnameSchema,
  observedAt: chatTimestampSchema,
  connectionIp: hostMemoryConnectionIpSchema.optional(),
  operatingSystem: hostMemoryOperatingSystemSchema.optional(),
  cpu: hostMemoryCpuSchema.optional(),
  memory: z.object({ totalBytes: hostMemoryByteCountSchema }).strict().optional(),
  disks: z.array(hostMemoryDiskSchema).max(64).optional(),
  networkInterfaces: z.array(hostMemoryNetworkInterfaceSchema).max(64).optional(),
  processes: z.array(z.object({
    name: hostMemoryProcessNameSchema,
    pid: z.number().int().min(1).max(4_194_304),
    workingDirectory: hostMemoryLinuxPathSchema.optional(),
  }).strict()).max(200).optional(),
  currentUser: hostMemoryUserSchema.optional(),
  workingDirectory: hostMemoryLinuxPathSchema.optional(),
  services: hostMemoryCurrentServicesSchema.optional(),
  legacyFacts: hostMemoryLegacyFactsSchema.optional(),
}).strict().superRefine((record, context) => {
  if (containsSensitiveHostMemoryData(record)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Host memory record contains sensitive data' })
})
export type HostMemoryRecord = z.infer<typeof hostMemoryRecordSchema>

export const hostMemoryRecordUpdateSchema = z.object({ hostname: hostMemoryHostnameSchema, record: hostMemoryRecordSchema }).strict()
export type HostMemoryRecordUpdate = z.infer<typeof hostMemoryRecordUpdateSchema>

function hasHostMemoryControlCharacters(value: string): boolean {
  return [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
}
