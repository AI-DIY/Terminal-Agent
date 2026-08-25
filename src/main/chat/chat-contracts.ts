import { z } from 'zod'
import {
  chatIdentifierSchema,
  chatMessageRecordSchema,
  chatRequestIdSchema,
  chatShellAssociationSchema,
  chatTimestampSchema,
  chatTitleStateSchema,
  sessionModeSchema,
} from '../../shared/contracts'

export const persistedChatSchema = z.object({
  id: chatIdentifierSchema,
  title: z.string().trim().min(1).max(255),
  titleState: chatTitleStateSchema,
  pinnedAt: chatTimestampSchema.nullable(),
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
  kind: z.enum(['create', 'appendMessage', 'updateMessage', 'updateTitle', 'setMode', 'associateShell', 'bindSession', 'closeAssociation', 'pin', 'unpin', 'remove']),
  chatId: chatIdentifierSchema,
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  appliedAt: chatTimestampSchema,
  resultId: chatIdentifierSchema.optional(),
  result: z.object({
    title: z.string().trim().min(1).max(255),
    titleState: chatTitleStateSchema,
    pinnedAt: chatTimestampSchema.nullable(),
    createdAt: chatTimestampSchema,
    updatedAt: chatTimestampSchema,
    mode: sessionModeSchema,
  }).strict().optional(),
}).strict()

export const chatDocumentSchema = z.object({
  version: z.literal(2),
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
      if (chat.title !== '已删除任务') addIssue(context, ['chats', index, 'title'], 'deleted chat must use the safe tombstone title')
      if (chat.titleState !== 'custom') addIssue(context, ['chats', index, 'titleState'], 'deleted chat must use the custom title state')
      if (chat.pinnedAt !== null) addIssue(context, ['chats', index, 'pinnedAt'], 'deleted chat cannot remain pinned')
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
  const lastResultByChat = new Map<string, z.infer<typeof chatOperationSchema.shape.result>>()
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
    if (operation.kind !== 'pin' && operation.kind !== 'unpin') {
      requireTimeOrder(operation.appliedAt, chat.updatedAt, ['operations', index, 'appliedAt'], 'operation appliedAt follows chat updatedAt', context)
    }
    if (result.createdAt !== chat.createdAt) addIssue(context, ['operations', index, 'result', 'createdAt'], 'operation result createdAt must match chat createdAt')
    requireTimeOrder(chat.createdAt, result.updatedAt, ['operations', index, 'result', 'updatedAt'], 'operation result updatedAt precedes chat createdAt', context)
    requireTimeOrder(result.updatedAt, chat.updatedAt, ['operations', index, 'result', 'updatedAt'], 'operation result updatedAt follows chat updatedAt', context)
    if (result.titleState !== 'custom') {
      const expectedTitle = systemTaskTitle(result.titleState, result.createdAt)
      if (result.title !== expectedTitle) {
        addIssue(context, ['operations', index, 'result', 'title'], `${result.titleState} task title must match its creation time`)
      }
    }

   const previous = lastResultByChat.get(operation.chatId)
   if (operation.kind === 'create') {
     if (previous) addIssue(context, ['operations', index, 'kind'], 'create operation must be the first chat operation')
     if (result.updatedAt !== result.createdAt) addIssue(context, ['operations', index, 'result', 'updatedAt'], 'create result updatedAt must equal createdAt')
     if (result.mode !== 'copilot') addIssue(context, ['operations', index, 'result', 'mode'], 'create result mode must be copilot')
      if (result.titleState === 'started') addIssue(context, ['operations', index, 'result', 'titleState'], 'create result cannot start a task')
    } else if (!previous) {
      addIssue(context, ['operations', index, 'kind'], 'chat operation requires an earlier create result')
    }
    if (previous) {
      requireTimeOrder(previous.updatedAt, result.updatedAt, ['operations', index, 'result', 'updatedAt'], 'operation result time moved backward', context)
      if (operation.kind !== 'setMode' && result.mode !== previous.mode) {
        addIssue(context, ['operations', index, 'result', 'mode'], `${operation.kind} cannot change chat mode`)
      }
      if (operation.kind === 'pin' || operation.kind === 'unpin') {
        if (result.updatedAt !== previous.updatedAt) addIssue(context, ['operations', index, 'result', 'updatedAt'], `${operation.kind} cannot change chat updatedAt`)
        if (result.title !== previous.title) addIssue(context, ['operations', index, 'result', 'title'], `${operation.kind} cannot change chat title`)
        if (result.titleState !== previous.titleState) addIssue(context, ['operations', index, 'result', 'titleState'], `${operation.kind} cannot change chat titleState`)
        if (operation.kind === 'pin' && result.pinnedAt !== operation.appliedAt) {
          addIssue(context, ['operations', index, 'result', 'pinnedAt'], 'pin result pinnedAt must equal appliedAt')
        }
        if (operation.kind === 'unpin' && result.pinnedAt !== null) {
          addIssue(context, ['operations', index, 'result', 'pinnedAt'], 'unpin result pinnedAt must be null')
        }
      } else {
        if (result.updatedAt !== operation.appliedAt) addIssue(context, ['operations', index, 'result', 'updatedAt'], 'operation result updatedAt must equal appliedAt')
        if (result.pinnedAt !== previous.pinnedAt) addIssue(context, ['operations', index, 'result', 'pinnedAt'], `${operation.kind} cannot change pinnedAt`)
        if (operation.kind === 'updateTitle') {
          if (result.titleState !== 'custom') addIssue(context, ['operations', index, 'result', 'titleState'], 'updateTitle result must use the custom title state')
        } else if (operation.kind === 'appendMessage' || operation.kind === 'associateShell' || operation.kind === 'bindSession') {
          const startsTask = previous.titleState === 'new' && (
            operation.kind === 'associateShell'
            || (operation.kind === 'appendMessage' && operation.resultId !== undefined
              && messagesById.get(operation.resultId)?.message.role === 'user')
          )
          if (!startsTask && result.title !== previous.title) {
            addIssue(context, ['operations', index, 'result', 'title'], `${operation.kind} cannot change chat title`)
          }
          const expectedTitleState = startsTask ? 'started' : previous.titleState
          if (result.titleState !== expectedTitleState) {
            addIssue(context, ['operations', index, 'result', 'titleState'], `${operation.kind} result has an invalid titleState transition`)
          }
        } else {
          if (result.title !== previous.title) addIssue(context, ['operations', index, 'result', 'title'], `${operation.kind} cannot change chat title`)
          if (result.titleState !== previous.titleState) addIssue(context, ['operations', index, 'result', 'titleState'], `${operation.kind} cannot change chat titleState`)
        }
      }
    } else if (result.updatedAt !== operation.appliedAt) {
      addIssue(context, ['operations', index, 'result', 'updatedAt'], 'operation result updatedAt must equal appliedAt')
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
    if (finalResult.title !== chat.title) addIssue(context, ['chats', index, 'title'], 'chat title must match its final operation result')
    if (finalResult.titleState !== chat.titleState) addIssue(context, ['chats', index, 'titleState'], 'chat titleState must match its final operation result')
    if (finalResult.pinnedAt !== chat.pinnedAt) addIssue(context, ['chats', index, 'pinnedAt'], 'chat pinnedAt must match its final operation result')
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

export const incompatibleChatDocumentVersionMessage = '任务数据版本不兼容，请清空旧任务数据后重试。'

export function emptyChatDocument(): ChatDocument {
  return { version: 2, liveChatId: null, chats: [], messages: [], associations: [], operations: [] }
}

export function guardChatDocumentVersion(persisted: unknown): { value: unknown; changed: boolean } {
  if (isRecord(persisted) && Object.hasOwn(persisted, 'version') && persisted.version !== 2) {
    throw new Error(incompatibleChatDocumentVersionMessage)
  }
  return { value: persisted, changed: false }
}

function systemTaskTitle(state: 'new' | 'started', createdAt: string): string {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(createdAt))
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? ''
  const prefix = state === 'new' ? '新建任务' : '任务'
  return `${prefix} ${value('year')}-${value('month')}-${value('day')} ${value('hour')}:${value('minute')}:${value('second')}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
