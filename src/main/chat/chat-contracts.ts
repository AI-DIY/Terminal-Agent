import { z } from 'zod'
import {
  chatIdentifierSchema,
  chatMessageRecordSchema,
  chatRequestIdSchema,
  chatShellAssociationSchema,
  chatTimestampSchema,
  sessionModeSchema,
} from '../../shared/contracts'
import { sanitizeShellHistoryDisplay } from '../shell-history/shell-history-contracts'

export const persistedChatSchema = z.object({
  id: chatIdentifierSchema,
  title: z.string().trim().min(1).max(255),
  createdAt: chatTimestampSchema,
  updatedAt: chatTimestampSchema,
  mode: sessionModeSchema,
  deletedAt: chatTimestampSchema.optional(),
}).strict()

export const persistedMessageSchema = chatMessageRecordSchema.extend({
  requestId: chatRequestIdSchema,
}).strict()

export const persistedAssociationSchema = chatShellAssociationSchema.extend({
  requestId: chatRequestIdSchema,
  closeRequestId: chatRequestIdSchema.optional(),
}).strict()

export const chatOperationSchema = z.object({
  requestId: chatRequestIdSchema,
  kind: z.enum(['create', 'appendMessage', 'updateMessage', 'updateTitle', 'setMode', 'associateShell', 'bindSession', 'closeAssociation', 'remove']),
  chatId: chatIdentifierSchema,
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  appliedAt: chatTimestampSchema,
  resultId: chatIdentifierSchema.optional(),
  result: z.object({
    createdAt: chatTimestampSchema,
    updatedAt: chatTimestampSchema,
    mode: sessionModeSchema,
  }).strict().optional(),
}).strict()

export const chatDocumentSchema = z.object({
  version: z.literal(1),
  liveChatId: chatIdentifierSchema.nullable(),
  chats: z.array(persistedChatSchema),
  messages: z.array(persistedMessageSchema),
  associations: z.array(persistedAssociationSchema),
  operations: z.array(chatOperationSchema),
}).strict().superRefine((document, context) => {
  requireUnique(document.chats, chat => chat.id, ['chats'], 'chat id', context)
  requireUnique(document.messages, message => message.id, ['messages'], 'message id', context)
  requireUnique(document.associations, association => association.id, ['associations'], 'association id', context)
  requireUnique(document.operations, operation => operation.requestId, ['operations'], 'operation requestId', context)

  const chatsById = new Map(document.chats.map((chat, index) => [chat.id, { chat, index }]))
  const messagesById = new Map(document.messages.map((message, index) => [message.id, { message, index }]))
  const associationsById = new Map(document.associations.map((association, index) => [association.id, { association, index }]))
  const operationsByRequestId = new Map(document.operations.map((operation, index) => [operation.requestId, { operation, index }]))
  const appendOperationsByMessageId = new Map<string, ChatOperation>()
  for (const operation of document.operations) {
    if (operation.kind === 'appendMessage' && operation.resultId) appendOperationsByMessageId.set(operation.resultId, operation)
  }

  if (document.liveChatId) {
    const liveChat = chatsById.get(document.liveChatId)
    if (!liveChat || liveChat.chat.deletedAt) {
      addIssue(context, ['liveChatId'], 'live chat must reference an active chat')
    }
  }

  for (const [index, chat] of document.chats.entries()) {
    requireTimeOrder(chat.createdAt, chat.updatedAt, ['chats', index, 'updatedAt'], 'chat updatedAt precedes createdAt', context)
    if (chat.deletedAt) {
      requireTimeOrder(chat.createdAt, chat.deletedAt, ['chats', index, 'deletedAt'], 'chat deletedAt precedes createdAt', context)
      if (chat.title !== '已删除聊天') addIssue(context, ['chats', index, 'title'], 'deleted chat must use the safe tombstone title')
    }
  }
  for (const [index, message] of document.messages.entries()) {
    const chatEntry = chatsById.get(message.chatId)
    if (!chatEntry) {
      addIssue(context, ['messages', index, 'chatId'], 'message references a missing chat')
    } else if (chatEntry.chat.deletedAt) {
      addIssue(context, ['messages', index, 'chatId'], 'message cannot reference a deleted chat')
    } else {
      requireTimeOrder(chatEntry.chat.createdAt, message.createdAt, ['messages', index, 'createdAt'], 'message createdAt precedes chat createdAt', context)
      requireTimeOrder(message.createdAt, chatEntry.chat.updatedAt, ['messages', index, 'createdAt'], 'message createdAt follows chat updatedAt', context)
    }

    const operationEntry = operationsByRequestId.get(message.requestId)
    if (!operationEntry) {
      addIssue(context, ['messages', index, 'requestId'], 'message requires a matching appendMessage operation')
    } else {
      const { operation } = operationEntry
      if (operation.kind !== 'appendMessage') addIssue(context, ['messages', index, 'requestId'], 'message operation must be appendMessage')
      if (operation.chatId !== message.chatId) addIssue(context, ['messages', index, 'chatId'], 'message operation references another chat')
      if (operation.resultId !== message.id) addIssue(context, ['messages', index, 'id'], 'message operation resultId must match the message id')
    }
  }
  for (const [index, association] of document.associations.entries()) {
    const chatEntry = chatsById.get(association.chatId)
    if (!chatEntry) {
      addIssue(context, ['associations', index, 'chatId'], 'association references a missing chat')
    } else if (chatEntry.chat.deletedAt) {
      addIssue(context, ['associations', index, 'chatId'], 'association cannot reference a deleted chat')
    } else {
      requireTimeOrder(chatEntry.chat.createdAt, association.associatedAt, ['associations', index, 'associatedAt'], 'association associatedAt precedes chat createdAt', context)
      requireTimeOrder(association.associatedAt, chatEntry.chat.updatedAt, ['associations', index, 'associatedAt'], 'association associatedAt follows chat updatedAt', context)
      if (association.closedAt) {
        requireTimeOrder(association.closedAt, chatEntry.chat.updatedAt, ['associations', index, 'closedAt'], 'association closedAt follows chat updatedAt', context)
      }
    }

    const operationEntry = operationsByRequestId.get(association.requestId)
    if (!operationEntry) {
      addIssue(context, ['associations', index, 'requestId'], 'association requires a matching associateShell operation')
    } else {
      const { operation } = operationEntry
      if (operation.kind !== 'associateShell') addIssue(context, ['associations', index, 'requestId'], 'association operation must be associateShell')
      if (operation.chatId !== association.chatId) addIssue(context, ['associations', index, 'chatId'], 'association operation references another chat')
      if (operation.resultId !== association.id) addIssue(context, ['associations', index, 'id'], 'association operation resultId must match the association id')
    }

    if (association.status === 'open') {
      if (association.closedAt !== undefined) addIssue(context, ['associations', index, 'closedAt'], 'open association cannot have closedAt')
      if (association.closeRequestId !== undefined) addIssue(context, ['associations', index, 'closeRequestId'], 'open association cannot have closeRequestId')
    } else {
      if (association.closedAt === undefined) addIssue(context, ['associations', index, 'closedAt'], 'closed association requires closedAt')
      if (association.closeRequestId === undefined) addIssue(context, ['associations', index, 'closeRequestId'], 'closed association requires closeRequestId')
      if (association.closedAt) {
        requireTimeOrder(association.associatedAt, association.closedAt, ['associations', index, 'closedAt'], 'association closedAt precedes associatedAt', context)
      }
      if (association.closeRequestId) {
        const closeOperationEntry = operationsByRequestId.get(association.closeRequestId)
        if (!closeOperationEntry) {
          addIssue(context, ['associations', index, 'closeRequestId'], 'closed association requires a matching closeAssociation operation')
        } else {
          const { operation } = closeOperationEntry
          if (operation.kind !== 'closeAssociation') addIssue(context, ['associations', index, 'closeRequestId'], 'close operation must be closeAssociation')
          if (operation.chatId !== association.chatId) addIssue(context, ['associations', index, 'chatId'], 'close operation references another chat')
          if (operation.resultId !== association.id) addIssue(context, ['associations', index, 'id'], 'close operation resultId must match the association id')
        }
      }
    }
  }
  const lastResultByChat = new Map<string, { createdAt: string; updatedAt: string; mode: 'copilot' | 'autonomous' }>()
  let previousAppliedAt: string | undefined
  const removeOperationsByChat = indexRemoveOperations(document.operations, (operation, index) => {
    if (previousAppliedAt && Date.parse(operation.appliedAt) <= Date.parse(previousAppliedAt)) {
      addIssue(context, ['operations', index, 'appliedAt'], 'operation appliedAt must advance globally')
    }
    previousAppliedAt = operation.appliedAt
    const chatEntry = chatsById.get(operation.chatId)
    if (!chatEntry) {
      addIssue(context, ['operations', index, 'chatId'], 'operation references a missing chat')
      return
    }
    if (chatEntry.chat.deletedAt) {
      requireTimeOrder(chatEntry.chat.createdAt, operation.appliedAt, ['operations', index, 'appliedAt'], 'operation appliedAt precedes chat createdAt', context)
      requireTimeOrder(operation.appliedAt, chatEntry.chat.updatedAt, ['operations', index, 'appliedAt'], 'operation appliedAt follows tombstone updatedAt', context)
      if (operation.resultId !== undefined) addIssue(context, ['operations', index, 'resultId'], 'deleted chat operation cannot retain resultId')
      if (operation.result !== undefined) addIssue(context, ['operations', index, 'result'], 'deleted chat operation cannot retain a result snapshot')
      return
    }

    if (operation.kind === 'appendMessage' || operation.kind === 'updateMessage') {
      if (operation.resultId === undefined) {
        addIssue(context, ['operations', index, 'resultId'], 'appendMessage operation requires resultId')
      } else {
        const messageEntry = messagesById.get(operation.resultId)
        if (!messageEntry) {
          addIssue(context, ['operations', index, 'resultId'], 'appendMessage resultId references a missing message')
        } else {
          if (messageEntry.message.chatId !== operation.chatId) addIssue(context, ['operations', index, 'chatId'], 'appendMessage result belongs to another chat')
          if (operation.kind === 'appendMessage') {
            if (messageEntry.message.requestId !== operation.requestId) addIssue(context, ['operations', index, 'requestId'], 'appendMessage result belongs to another request')
          } else {
            const appendOperation = appendOperationsByMessageId.get(messageEntry.message.id)
            if (!appendOperation || messageEntry.message.requestId !== appendOperation.requestId) {
              addIssue(context, ['operations', index, 'resultId'], 'updateMessage result must reference a message created by appendMessage')
            }
          }
          if (operation.kind === 'appendMessage' && operation.result && operation.result.updatedAt !== messageEntry.message.createdAt) {
            addIssue(context, ['operations', index, 'result', 'updatedAt'], 'appendMessage result must capture the message timestamp')
          }
        }
      }
    } else if (operation.kind === 'associateShell') {
      if (operation.resultId === undefined) {
        addIssue(context, ['operations', index, 'resultId'], 'associateShell operation requires resultId')
      } else {
        const associationEntry = associationsById.get(operation.resultId)
        if (!associationEntry) {
          addIssue(context, ['operations', index, 'resultId'], 'associateShell resultId references a missing association')
        } else {
          if (associationEntry.association.chatId !== operation.chatId) addIssue(context, ['operations', index, 'chatId'], 'associateShell result belongs to another chat')
          if (associationEntry.association.requestId !== operation.requestId) addIssue(context, ['operations', index, 'requestId'], 'associateShell result belongs to another request')
          if (operation.result && operation.result.updatedAt !== associationEntry.association.associatedAt) {
            addIssue(context, ['operations', index, 'result', 'updatedAt'], 'associateShell result must capture the association timestamp')
          }
        }
      }
    } else if (operation.kind === 'closeAssociation') {
      if (operation.resultId === undefined) {
        addIssue(context, ['operations', index, 'resultId'], 'closeAssociation operation requires resultId')
      } else {
        const associationEntry = associationsById.get(operation.resultId)
        if (!associationEntry) {
          addIssue(context, ['operations', index, 'resultId'], 'closeAssociation resultId references a missing association')
        } else {
          if (associationEntry.association.chatId !== operation.chatId) addIssue(context, ['operations', index, 'chatId'], 'closeAssociation result belongs to another chat')
          if (associationEntry.association.closeRequestId !== operation.requestId) addIssue(context, ['operations', index, 'requestId'], 'closeAssociation result belongs to another request')
          if (operation.result && operation.result.updatedAt !== associationEntry.association.closedAt) {
            addIssue(context, ['operations', index, 'result', 'updatedAt'], 'closeAssociation result must capture the close timestamp')
          }
        }
      }
    } else if (operation.resultId !== undefined) {
      addIssue(context, ['operations', index, 'resultId'], `${operation.kind} operation cannot carry resultId`)
    }

    if (operation.kind === 'remove') {
      if (operation.result !== undefined) addIssue(context, ['operations', index, 'result'], 'remove operation cannot carry a result snapshot')
      return
    }
    if (!operation.result) {
      addIssue(context, ['operations', index, 'result'], `${operation.kind} operation requires a result snapshot`)
      return
    }

    const result = operation.result
    const chat = chatEntry.chat
    requireTimeOrder(chat.createdAt, operation.appliedAt, ['operations', index, 'appliedAt'], 'operation appliedAt precedes chat createdAt', context)
    requireTimeOrder(operation.appliedAt, chat.updatedAt, ['operations', index, 'appliedAt'], 'operation appliedAt follows chat updatedAt', context)
    if (result.createdAt !== chat.createdAt) addIssue(context, ['operations', index, 'result', 'createdAt'], 'operation result createdAt must match chat createdAt')
    if (result.updatedAt !== operation.appliedAt) addIssue(context, ['operations', index, 'result', 'updatedAt'], 'operation result updatedAt must equal appliedAt')
    requireTimeOrder(chat.createdAt, result.updatedAt, ['operations', index, 'result', 'updatedAt'], 'operation result updatedAt precedes chat createdAt', context)
    requireTimeOrder(result.updatedAt, chat.updatedAt, ['operations', index, 'result', 'updatedAt'], 'operation result updatedAt follows chat updatedAt', context)

    const previous = lastResultByChat.get(operation.chatId)
    if (operation.kind === 'create') {
      if (previous) addIssue(context, ['operations', index, 'kind'], 'create operation must be the first chat operation')
      if (result.updatedAt !== result.createdAt) addIssue(context, ['operations', index, 'result', 'updatedAt'], 'create result updatedAt must equal createdAt')
      if (result.mode !== 'copilot') addIssue(context, ['operations', index, 'result', 'mode'], 'create result mode must be copilot')
    } else if (!previous) {
      addIssue(context, ['operations', index, 'kind'], 'chat operation requires an earlier create result')
    }
    if (previous) {
      requireTimeOrder(previous.updatedAt, result.updatedAt, ['operations', index, 'result', 'updatedAt'], 'operation result time moved backward', context)
      if (operation.kind !== 'setMode' && result.mode !== previous.mode) {
        addIssue(context, ['operations', index, 'result', 'mode'], `${operation.kind} cannot change chat mode`)
      }
    }
    lastResultByChat.set(operation.chatId, result)
  })

  for (const [chatId, { chat, index }] of chatsById) {
    const removeOperations = removeOperationsByChat.get(chatId)
    if (chat.deletedAt) {
      if (!removeOperations) addIssue(context, ['chats', index, 'deletedAt'], 'deleted chat requires a remove operation')
      if (chat.deletedAt !== chat.updatedAt) addIssue(context, ['chats', index, 'deletedAt'], 'deletedAt must equal updatedAt')
      const finalRemove = removeOperations?.final
      if (finalRemove && finalRemove.appliedAt !== chat.deletedAt) {
        addIssue(context, ['chats', index, 'deletedAt'], 'deletedAt must equal the final remove appliedAt')
      }
      continue
    }
    if (removeOperations) addIssue(context, ['chats', index], 'active chat cannot have a remove operation')
    const finalResult = lastResultByChat.get(chatId)
    if (!finalResult) {
      addIssue(context, ['chats', index], 'active chat requires operation result history')
      continue
    }
    if (finalResult.updatedAt !== chat.updatedAt) addIssue(context, ['chats', index, 'updatedAt'], 'chat updatedAt must match its final operation result')
    if (finalResult.mode !== chat.mode) addIssue(context, ['chats', index, 'mode'], 'chat mode must match its final operation result')
  }
})

export function indexRemoveOperations(
  operations: readonly ChatOperation[],
  visit: (operation: ChatOperation, index: number) => void = () => undefined,
): Map<string, { count: number; final: ChatOperation }> {
  const removals = new Map<string, { count: number; final: ChatOperation }>()
  for (const [index, operation] of operations.entries()) {
    visit(operation, index)
    if (operation.kind !== 'remove') continue
    const current = removals.get(operation.chatId)
    removals.set(operation.chatId, { count: (current?.count ?? 0) + 1, final: operation })
  }
  return removals
}

function requireUnique<T>(
  values: T[],
  identify: (value: T) => string,
  path: PropertyKey[],
  label: string,
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>()
  for (const [index, value] of values.entries()) {
    const id = identify(value)
    if (seen.has(id)) addIssue(context, [...path, index], `duplicate ${label}`)
    seen.add(id)
  }
}

function requireTimeOrder(
  earlier: string,
  later: string,
  path: PropertyKey[],
  message: string,
  context: z.RefinementCtx,
): void {
  if (Date.parse(later) < Date.parse(earlier)) addIssue(context, path, message)
}

function addIssue(context: z.RefinementCtx, path: PropertyKey[], message: string): void {
  context.addIssue({ code: 'custom', path, message })
}

export type PersistedChat = z.infer<typeof persistedChatSchema>
export type PersistedMessage = z.infer<typeof persistedMessageSchema>
export type PersistedAssociation = z.infer<typeof persistedAssociationSchema>
export type ChatOperation = z.infer<typeof chatOperationSchema>
export type ChatDocument = z.infer<typeof chatDocumentSchema>

export function emptyChatDocument(): ChatDocument {
  return { version: 1, liveChatId: null, chats: [], messages: [], associations: [], operations: [] }
}

export function migrateChatDocument(persisted: unknown): { value: unknown; changed: boolean } {
  if (!isRecord(persisted) || persisted.version !== 1) {
    return { value: persisted, changed: false }
  }

  let changed = false
  const chats = Array.isArray(persisted.chats) ? persisted.chats.filter(isRecord) : []
  const messages = Array.isArray(persisted.messages) ? persisted.messages : []
  const migratedMessages = messages.map(message => {
    if (!isRecord(message) || message.role !== 'assistant' || message.state !== 'error' || message.content !== '已取消。' || message.retryable !== undefined) return message
    changed = true
    return { ...message, retryable: false }
  })
  const associations = Array.isArray(persisted.associations) ? persisted.associations.filter(isRecord) : []
  const migratedAssociations = associations.map(association => {
    const migrated = { ...association }
    for (const field of ['hostname', 'title'] as const) {
      if (typeof association[field] !== 'string') continue
      const safeValue = sanitizeShellHistoryDisplay(association[field])
      if (safeValue !== association[field]) changed = true
      migrated[field] = safeValue
    }
    return migrated
  })
  const hasLiveChatId = Object.prototype.hasOwnProperty.call(persisted, 'liveChatId')
  if (hasLiveChatId && !changed) return { value: persisted, changed: false }

  const openChatIds = new Set(associations
    .filter(association => association.status === 'open' && typeof association.chatId === 'string')
    .map(association => association.chatId as string))
  const liveChatId = hasLiveChatId
    ? persisted.liveChatId
    : chats
      .filter(chat => typeof chat.id === 'string' && chat.deletedAt === undefined && openChatIds.has(chat.id))
      .sort((left, right) => {
        const updatedOrder = String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? ''))
        return updatedOrder || String(left.id).localeCompare(String(right.id))
      })[0]?.id ?? null

  return { value: { ...persisted, liveChatId, messages: migratedMessages, associations: migratedAssociations }, changed: true }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
