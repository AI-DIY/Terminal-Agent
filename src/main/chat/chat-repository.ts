import { createHash, randomUUID } from 'node:crypto'
import {
  chatAppendMessageRequestSchema,
  chatAssociateShellRequestSchema,
  chatBindSessionRequestSchema,
  chatCloseAssociationRequestSchema,
  chatCreateRequestSchema,
  chatIdentifierSchema,
  chatRemoveRequestSchema,
  chatSetModeRequestSchema,
  chatTransferSessionsRequestSchema,
  chatUpdateTitleRequestSchema,
  type ChatAppendMessageRequest,
  chatUpdateMessageRequestSchema,
  type ChatUpdateMessageRequest,
  type ChatAssociateShellRequest,
  type ChatBindSessionRequest,
  type ChatCloseAssociationRequest,
  type ChatCreateRequest,
  type ChatMessageRecord,
  type ChatRemoveRequest,
  type ChatSetModeRequest,
  type ChatTransferSessionsRequest,
  type ChatShellAssociation,
  type ChatSummary,
  type ChatUpdateTitleRequest,
  type ChatWorkspace,
} from '../../shared/contracts'
import { AtomicJsonStore, type AtomicJsonStoreOptions } from '../persistence/atomic-json-store'
import { sanitizeShellHistoryDisplay } from '../shell-history/shell-history-contracts'
import {
  chatDocumentSchema,
  emptyChatDocument,
  migrateChatDocument,
  type ChatDocument,
  type ChatOperation,
  type PersistedAssociation,
  type PersistedChat,
} from './chat-contracts'

export type ChatMutation<T> = { value: T; changed: boolean; liveChatId: string | null }
export type ChatList = { chats: ChatSummary[]; liveChatId: string | null }

const interruptedStreamRecoveryContent = '聊天请求已中断，请重试。'

type ChatRepositoryOptions = Pick<AtomicJsonStoreOptions, 'fileSystem'> & {
  now?: () => Date
  createId?: () => string
}

type TransferSessionMetadata = {
  sessionId: string
  historyId: string
  hostname: string
  title: string
}

export type ChatTransferMutation = ChatMutation<{
  source: ChatWorkspace
  target: ChatWorkspace
}>

class DuplicateRequest extends Error {
  constructor(readonly operation: ChatOperation) {
    super('Duplicate chat request')
  }
}

class NoOpenSession extends Error {}

class NoMatchingSessionOwner extends Error {}

export class ChatRepository {
  private readonly store: AtomicJsonStore<ChatDocument>
  private readonly now: () => Date
  private readonly createId: () => string

  constructor(public readonly path: string, options: ChatRepositoryOptions = {}) {
    this.now = options.now ?? (() => new Date())
    this.createId = options.createId ?? randomUUID
    this.store = new AtomicJsonStore(path, chatDocumentSchema, emptyChatDocument, {
      ...(options.fileSystem ? { fileSystem: options.fileSystem } : {}),
      migrate: migrateChatDocument,
    })
  }

  async list(): Promise<ChatSummary[]> {
    const document = await this.store.load()
    return summarizeChats(document.chats, document.associations)
  }

  async listSnapshot(): Promise<ChatList> {
    const document = await this.store.load()
    return { chats: summarizeChats(document.chats, document.associations), liveChatId: document.liveChatId }
  }

  async get(chatId: string): Promise<ChatWorkspace> {
    const parsed = chatIdentifierSchema.parse(chatId)
    return toWorkspace(await this.store.load(), parsed)
  }

  async findRetryMessage(chatId: string, content?: string): Promise<string | undefined> {
    const parsed = chatIdentifierSchema.parse(chatId)
    const document = await this.store.load()
    requireChat(document, parsed)
    const messages = document.messages.filter(message => message.chatId === parsed)
    const assistant = messages.at(-1)
    const user = messages.at(-2)
    if (assistant?.role !== 'assistant' || assistant.state !== 'error' || user?.role !== 'user') return undefined
    if (assistant.retryable === false || assistant.content === '已取消。') return undefined
    if (content !== undefined && user.content !== content) return undefined
    return assistant.id
  }

  async recoverInterruptedStreams(): Promise<number> {
    const current = await this.store.load()
    const interrupted = current.messages.filter(message => message.role === 'assistant' && message.state === 'streaming')
    if (interrupted.length === 0) return 0

    await this.store.update(document => {
      for (const message of document.messages) {
        if (message.role !== 'assistant' || message.state !== 'streaming') continue

        const chat = requireChat(document, message.chatId)
        const appliedAt = nextLogicalTimestamp(this.now(), document)
        message.content = interruptedStreamRecoveryContent
        message.state = 'error'
        chat.updatedAt = appliedAt
        document.operations.push({
          requestId: interruptedStreamRecoveryRequestId(message.id),
          kind: 'updateMessage',
          chatId: chat.id,
          fingerprint: requestFingerprint('updateMessage', [
            chat.id, message.id, interruptedStreamRecoveryContent, 'error',
          ]),
          appliedAt,
          resultId: message.id,
          result: { createdAt: chat.createdAt, updatedAt: chat.updatedAt, mode: chat.mode },
        })
      }
      return document
    })
    return interrupted.length
  }

  async findOpenSession(sessionId: string): Promise<ChatShellAssociation | undefined> {
    const association = (await this.store.load()).associations.find(item => item.sessionId === sessionId && item.status === 'open')
    if (!association) return undefined
    return {
      id: association.id,
      chatId: association.chatId,
      ...(association.sessionId ? { sessionId: association.sessionId } : {}),
      historyId: association.historyId,
      hostname: association.hostname,
      title: association.title,
      status: association.status,
      associatedAt: association.associatedAt,
      ...(association.closedAt ? { closedAt: association.closedAt } : {}),
    }
  }

  async findSessionRequest(request: ChatBindSessionRequest): Promise<boolean> {
    const operation = (await this.store.load()).operations.find(item => item.requestId === request.requestId)
    if (!operation) return false
    if (!isBindSessionOperation(operation, bindSessionFingerprint(request))) {
      throw new Error('Chat request idempotency conflict')
    }
    return true
  }

  async recordSessionRequest(request: ChatBindSessionRequest): Promise<ChatMutation<ChatWorkspace> | null> {
    const parsed = chatBindSessionRequestSchema.parse(request)
    const fingerprint = bindSessionFingerprint(parsed)
    let changed = false
    let resultChatId: string | undefined
    try {
      const document = await this.store.update(current => {
        const existing = current.operations.find(operation => operation.requestId === parsed.requestId)
        if (existing) {
          if (!isBindSessionOperation(existing, fingerprint)) throw new Error('Chat request idempotency conflict')
          throw new DuplicateRequest(existing)
        }
        const association = current.associations.find(item => (
          item.chatId === parsed.chatId && item.sessionId === parsed.sessionId && item.status === 'open'
        ))
        if (!association) throw new NoMatchingSessionOwner()
        const chat = requireChat(current, association.chatId)
        const appliedAt = nextLogicalTimestamp(this.now(), current)
        changed = true
        resultChatId = chat.id
        chat.updatedAt = appliedAt
        current.liveChatId = chat.id
        current.operations.push({
          requestId: parsed.requestId,
          kind: 'bindSession',
          chatId: chat.id,
          fingerprint,
          appliedAt,
          result: { createdAt: chat.createdAt, updatedAt: appliedAt, mode: chat.mode },
        })
        return current
      })
      return { value: toWorkspace(document, resultChatId!), changed, liveChatId: document.liveChatId }
    } catch (error) {
      if (error instanceof NoMatchingSessionOwner) return null
      if (error instanceof DuplicateRequest) {
        const document = await this.store.load()
        const operation = document.operations.find(item => item.requestId === parsed.requestId)
        if (!operation || !isBindSessionOperation(operation, fingerprint)) throw error
        const currentOwner = document.associations.find(association => (
          association.sessionId === parsed.sessionId && association.status === 'open'
        ))
        return {
          value: toWorkspace(document, currentOwner?.chatId ?? operation.chatId),
          changed: false,
          liveChatId: document.liveChatId,
        }
      }
      throw error
    }
  }

  async openSessionIds(): Promise<string[]> {
    return (await this.store.load()).associations
      .filter(association => association.status === 'open' && association.sessionId)
      .map(association => association.sessionId!)
  }

  async create(request: ChatCreateRequest): Promise<ChatMutation<ChatWorkspace>> {
    const parsed = chatCreateRequestSchema.parse(request)
    const fingerprint = requestFingerprint('create', [parsed.title ?? null])
    return this.mutate(parsed.requestId, 'create', undefined, fingerprint, (document, timestamp) => {
      const id = this.createId()
      document.chats.push({
        id,
        title: parsed.title ?? fallbackTitle(new Date(timestamp)),
        createdAt: timestamp,
        updatedAt: timestamp,
        mode: 'copilot',
      })
      document.liveChatId = id
      return { chatId: id }
    })
  }

  async appendMessage(request: ChatAppendMessageRequest): Promise<ChatMutation<ChatWorkspace>> {
    const parsed = chatAppendMessageRequestSchema.parse(request)
    const fingerprint = requestFingerprint('appendMessage', [parsed.chatId, parsed.role, parsed.content, parsed.state, ...(parsed.retryable === undefined ? [] : [parsed.retryable])])
    return this.mutate(parsed.requestId, 'appendMessage', parsed.chatId, fingerprint, (document, timestamp) => {
      const chat = requireChat(document, parsed.chatId)
      const id = this.createId()
      document.messages.push({ ...parsed, id, createdAt: timestamp })
      chat.updatedAt = timestamp
      return { chatId: chat.id, resultId: id }
    })
  }

  async updateMessage(request: ChatUpdateMessageRequest): Promise<ChatMutation<ChatWorkspace>> {
    const parsed = chatUpdateMessageRequestSchema.parse(request)
    const fingerprint = requestFingerprint('updateMessage', [parsed.chatId, parsed.messageId, parsed.content, parsed.state, ...(parsed.retryable === undefined ? [] : [parsed.retryable])])
    return this.mutate(parsed.requestId, 'updateMessage', parsed.chatId, fingerprint, (document, timestamp) => {
      const chat = requireChat(document, parsed.chatId)
      const message = document.messages.find(item => item.id === parsed.messageId && item.chatId === parsed.chatId)
      if (!message) throw new Error('Unknown chat message')
      message.content = parsed.content
      message.state = parsed.state
      if (parsed.retryable === undefined) delete message.retryable
      else message.retryable = parsed.retryable
      chat.updatedAt = timestamp
      return { chatId: chat.id, resultId: message.id }
    })
  }

  async updateTitle(request: ChatUpdateTitleRequest): Promise<ChatMutation<ChatWorkspace>> {
    const parsed = chatUpdateTitleRequestSchema.parse(request)
    const fingerprint = requestFingerprint('updateTitle', [parsed.chatId, parsed.title])
    return this.mutate(parsed.requestId, 'updateTitle', parsed.chatId, fingerprint, (document, timestamp) => {
      const chat = requireChat(document, parsed.chatId)
      chat.title = parsed.title
      chat.updatedAt = timestamp
      return { chatId: chat.id }
    })
  }

  async setMode(request: ChatSetModeRequest): Promise<ChatMutation<ChatWorkspace>> {
    const parsed = chatSetModeRequestSchema.parse(request)
    const fingerprint = requestFingerprint('setMode', [parsed.chatId, parsed.mode])
    return this.mutate(parsed.requestId, 'setMode', parsed.chatId, fingerprint, (document, timestamp) => {
      const chat = requireChat(document, parsed.chatId)
      chat.mode = parsed.mode
      chat.updatedAt = timestamp
      return { chatId: chat.id }
    })
  }

  async associateShell(request: ChatAssociateShellRequest): Promise<ChatMutation<ChatWorkspace>> {
    const parsed = sanitizeChatShellMetadata(chatAssociateShellRequestSchema.parse(request))
    const fingerprint = requestFingerprint('associateShell', [
      parsed.chatId, parsed.sessionId ?? null, parsed.historyId, parsed.hostname, parsed.title,
    ])
    return this.mutate(parsed.requestId, 'associateShell', parsed.chatId, fingerprint, (document, timestamp) => {
      const chat = requireChat(document, parsed.chatId)
      if (parsed.sessionId && document.associations.some(association => association.sessionId === parsed.sessionId && association.status === 'open')) {
        throw new Error('Terminal session already belongs to a chat')
      }
      const id = this.createId()
      document.associations.push({ ...parsed, id, status: 'open', associatedAt: timestamp })
      chat.updatedAt = timestamp
      document.liveChatId = chat.id
      return { chatId: chat.id, resultId: id }
    })
  }

  async associateOrCreateShell(request: ChatAssociateShellRequest): Promise<ChatMutation<ChatWorkspace>> {
    const parsed = sanitizeChatShellMetadata(chatAssociateShellRequestSchema.parse(request))
    const fingerprint = parsed.sessionId
      ? bindSessionFingerprint({ chatId: parsed.chatId, sessionId: parsed.sessionId })
      : requestFingerprint('associateShell', [parsed.chatId, null, parsed.historyId, parsed.hostname, parsed.title])
    let changed = false
    let resultChatId: string | undefined
    try {
      const document = await this.store.update(current => {
        const existingOperation = current.operations.find(operation => operation.requestId === parsed.requestId)
        if (existingOperation) {
          const matches = parsed.sessionId
            ? isBindSessionOperation(existingOperation, fingerprint)
            : existingOperation.kind === 'associateShell' && existingOperation.fingerprint === fingerprint
          if (!matches) throw new Error('Chat request idempotency conflict')
          throw new DuplicateRequest(existingOperation)
        }

        let target = current.chats.find(chat => chat.id === parsed.chatId && !chat.deletedAt)
        if (!target && current.liveChatId) {
          target = current.chats.find(chat => chat.id === current.liveChatId && !chat.deletedAt)
        }
        if (!target) {
          target = current.chats.find(chat => !chat.deletedAt
            && current.associations.some(association => association.chatId === chat.id && association.status === 'open'))
        }
        if (!target) {
          const createdAt = nextLogicalTimestamp(this.now(), current)
          const id = this.createId()
          target = {
            id,
            title: fallbackTitle(new Date(createdAt)),
            createdAt,
            updatedAt: createdAt,
            mode: 'copilot',
          }
          current.chats.push(target)
          current.operations.push({
            requestId: derivedRequestId(parsed.requestId, 'create', 0),
            kind: 'create',
            chatId: target.id,
            fingerprint: requestFingerprint('create', [target.title]),
            appliedAt: createdAt,
            result: { createdAt, updatedAt: createdAt, mode: target.mode },
          })
        }
        resultChatId = target.id

        const existing = parsed.sessionId
          ? current.associations.find(association => association.sessionId === parsed.sessionId && association.status === 'open')
          : undefined
        if (existing) {
          if (existing.chatId === target.id) {
            const appliedAt = nextLogicalTimestamp(this.now(), current)
            changed = true
            target.updatedAt = appliedAt
            current.liveChatId = target.id
            current.operations.push({
              requestId: parsed.requestId,
              kind: 'bindSession',
              chatId: target.id,
              fingerprint,
              appliedAt,
              result: { createdAt: target.createdAt, updatedAt: appliedAt, mode: target.mode },
            })
            return current
          }
          throw new Error('Terminal session already belongs to a chat')
        }

        const associatedAt = nextLogicalTimestamp(this.now(), current)
        const id = this.createId()
        changed = true
        current.associations.push({ ...parsed, chatId: target.id, id, status: 'open', associatedAt })
        target.updatedAt = associatedAt
        current.liveChatId = target.id
        current.operations.push({
          requestId: parsed.requestId,
          kind: 'associateShell',
          chatId: target.id,
          fingerprint,
          appliedAt: associatedAt,
          resultId: id,
          result: { createdAt: target.createdAt, updatedAt: target.updatedAt, mode: target.mode },
        })
        return current
      })
      const operation = document.operations.find(item => item.requestId === parsed.requestId)
      return { value: toWorkspace(document, operation?.chatId ?? resultChatId!), changed, liveChatId: document.liveChatId }
    } catch (error) {
      if (!(error instanceof DuplicateRequest)) throw error
      const document = await this.store.load()
      const operation = document.operations.find(item => item.requestId === parsed.requestId)
      const matches = operation && (parsed.sessionId
        ? isBindSessionOperation(operation, fingerprint)
        : operation.kind === 'associateShell' && operation.fingerprint === fingerprint)
      if (!operation || !matches) throw error
      const currentOwner = parsed.sessionId
        ? document.associations.find(association => association.sessionId === parsed.sessionId && association.status === 'open')
        : undefined
      return { value: toWorkspace(document, currentOwner?.chatId ?? operation.chatId), changed: false, liveChatId: document.liveChatId }
    }
  }

  async transferSessions(
    request: ChatTransferSessionsRequest,
    sessions: readonly TransferSessionMetadata[],
    bindRequest?: ChatBindSessionRequest,
  ): Promise<ChatTransferMutation> {
    const parsed = chatTransferSessionsRequestSchema.parse(request)
    const metadataById = new Map(sessions.map(session => [session.sessionId, sanitizeChatShellMetadata(session)]))
    if (metadataById.size !== sessions.length || parsed.sessionIds.some(sessionId => !metadataById.has(sessionId))) {
      throw new Error('Transfer metadata does not match requested sessions')
    }
    const transferIds = parsed.sessionIds.map((_, index) => ({
      closeRequestId: derivedRequestId(parsed.requestId, 'close', index),
      associateRequestId: index === 0 ? parsed.requestId : derivedRequestId(parsed.requestId, 'associate', index),
    }))
    const fingerprint = bindRequest
      ? bindSessionFingerprint(bindRequest)
      : requestFingerprint('associateShell', [parsed.sourceChatId, parsed.targetChatId, parsed.sessionIds])
    let changed = false
    let targetChatId = parsed.targetChatId
    try {
      const document = await this.store.update(current => {
        const duplicateOperations = transferIds.map(ids => findDuplicate(
          current, ids.associateRequestId, 'associateShell', parsed.targetChatId, fingerprint,
        ))
        if (duplicateOperations.every(Boolean)) throw new DuplicateRequest(duplicateOperations[0]!)
        if (duplicateOperations.some(Boolean)) throw new Error('Chat transfer batch partially applied')

        const source = requireChat(current, parsed.sourceChatId)
        let target = targetChatId ? requireChat(current, targetChatId) : undefined
        if (!target) {
          const createdAt = nextLogicalTimestamp(this.now(), current)
          const id = this.createId()
          target = {
            id,
            title: fallbackTitle(new Date(createdAt)),
            createdAt,
            updatedAt: createdAt,
            mode: 'copilot',
          }
          targetChatId = id
          current.chats.push(target)
          current.operations.push({
            requestId: derivedRequestId(parsed.requestId, 'create', 0),
            kind: 'create',
            chatId: id,
            fingerprint: requestFingerprint('create', [target.title]),
            appliedAt: createdAt,
            result: { createdAt, updatedAt: createdAt, mode: target.mode },
          })
        }
        const associations = parsed.sessionIds.map(sessionId => {
          const association = current.associations.find(item => item.chatId === source.id
            && item.sessionId === sessionId && item.status === 'open')
          if (!association) throw new Error('Unknown source terminal session')
          return association
        })

        changed = true
        let closedAt = nextLogicalTimestamp(this.now(), current)
        for (const [index, association] of associations.entries()) {
          const closeRequestId = transferIds[index].closeRequestId
          association.status = 'closed'
          association.closedAt = closedAt
          association.closeRequestId = closeRequestId
          current.operations.push({
            requestId: closeRequestId,
            kind: 'closeAssociation',
            chatId: source.id,
            fingerprint: requestFingerprint('closeAssociation', [source.id, association.id]),
            appliedAt: closedAt,
            resultId: association.id,
            result: { createdAt: source.createdAt, updatedAt: closedAt, mode: source.mode },
          })
          closedAt = nextLogicalTimestamp(this.now(), current)
        }
        source.updatedAt = associations.length > 0
          ? current.operations.at(-1)!.appliedAt
          : source.updatedAt

        let associatedAt = nextLogicalTimestamp(this.now(), current)
        for (const [index, sessionId] of parsed.sessionIds.entries()) {
          const metadata = metadataById.get(sessionId)!
          const id = this.createId()
          current.associations.push({
            id,
            chatId: target.id,
            sessionId,
            historyId: metadata.historyId,
            hostname: metadata.hostname,
            title: metadata.title,
            status: 'open',
            associatedAt,
            requestId: transferIds[index].associateRequestId,
          })
          current.operations.push({
            requestId: transferIds[index].associateRequestId,
            kind: 'associateShell',
            chatId: target.id,
            fingerprint,
            appliedAt: associatedAt,
            resultId: id,
            result: { createdAt: target.createdAt, updatedAt: associatedAt, mode: target.mode },
          })
          associatedAt = nextLogicalTimestamp(this.now(), current)
        }
        target.updatedAt = current.operations.at(-1)!.appliedAt
        if (current.liveChatId === source.id) current.liveChatId = target.id
        return current
      })
      targetChatId ??= document.operations.find(operation => (
        operation.requestId === transferIds[0].associateRequestId
      ))?.chatId
      if (!targetChatId) throw new Error('Chat transfer result is missing its target')
      return {
        value: {
          source: toWorkspaceOrTombstone(document, parsed.sourceChatId),
          target: toWorkspace(document, targetChatId),
        },
        changed,
        liveChatId: document.liveChatId,
      }
    } catch (error) {
      if (!(error instanceof DuplicateRequest)) throw error
      const document = await this.store.load()
      targetChatId ??= document.operations.find(operation => (
        operation.requestId === transferIds[0].associateRequestId
      ))?.chatId
      const allApplied = transferIds.every(ids => {
        const operation = document.operations.find(item => item.requestId === ids.associateRequestId)
        return operation?.kind === 'associateShell'
          && operation.chatId === targetChatId
          && operation.fingerprint === fingerprint
      })
      if (!allApplied || !targetChatId) throw error
      return {
        value: {
          source: toWorkspaceOrTombstone(document, parsed.sourceChatId),
          target: toWorkspace(document, targetChatId),
        },
        changed: false,
        liveChatId: document.liveChatId,
      }
    }
  }

  async closeSession(sessionId: string, requestId: string): Promise<ChatMutation<ChatWorkspace> | null> {
    let chatId: string | undefined
    try {
      const document = await this.store.update(current => {
        const association = current.associations.find(item => item.sessionId === sessionId && item.status === 'open')
        if (!association) throw new NoOpenSession()
        chatId = association.chatId
        const fingerprint = requestFingerprint('closeAssociation', [association.chatId, association.id])
        const duplicate = findDuplicate(current, requestId, 'closeAssociation', association.chatId, fingerprint)
        if (duplicate) throw new DuplicateRequest(duplicate)
        const chat = requireChat(current, association.chatId)
        const timestamp = nextLogicalTimestamp(this.now(), current)
        association.status = 'closed'
        association.closedAt = timestamp
        association.closeRequestId = requestId
        chat.updatedAt = timestamp
        replaceLiveChatIfCurrent(current, chat.id)
        current.operations.push({
          requestId,
          kind: 'closeAssociation',
          chatId: chat.id,
          fingerprint,
          appliedAt: timestamp,
          resultId: association.id,
          result: { createdAt: chat.createdAt, updatedAt: timestamp, mode: chat.mode },
        })
        return current
      })
      return { value: toWorkspace(document, chatId!), changed: true, liveChatId: document.liveChatId }
    } catch (error) {
      if (error instanceof NoOpenSession) return null
      if (!(error instanceof DuplicateRequest)) throw error
      const document = await this.store.load()
      const operation = document.operations.find(item => item.requestId === requestId)
      if (!operation) throw error
      return { value: toWorkspace(document, operation.chatId), changed: false, liveChatId: document.liveChatId }
    }
  }

  async closeAssociation(request: ChatCloseAssociationRequest): Promise<ChatMutation<ChatWorkspace>> {
    const parsed = chatCloseAssociationRequestSchema.parse(request)
    const fingerprint = requestFingerprint('closeAssociation', [parsed.chatId, parsed.associationId])
    return this.mutate(parsed.requestId, 'closeAssociation', parsed.chatId, fingerprint, (document, timestamp) => {
      const chat = requireChat(document, parsed.chatId)
      const association = document.associations.find(item => item.id === parsed.associationId && item.chatId === parsed.chatId)
      if (!association) throw new Error('Unknown chat shell association')
      association.status = 'closed'
      association.closedAt = timestamp
      association.closeRequestId = parsed.requestId
      chat.updatedAt = timestamp
      replaceLiveChatIfCurrent(document, chat.id)
      return { chatId: chat.id, resultId: association.id }
    })
  }

  async remove(request: ChatRemoveRequest): Promise<ChatMutation<void>> {
    const parsed = chatRemoveRequestSchema.parse(request)
    const fingerprint = requestFingerprint('remove', [parsed.chatId])
    let changed = false
    try {
      const document = await this.store.update(current => {
        const duplicate = findDuplicate(current, parsed.requestId, 'remove', parsed.chatId, fingerprint)
        if (duplicate) throw new DuplicateRequest(duplicate)
        const existing = current.chats.find(chat => chat.id === parsed.chatId)
        if (existing && !existing.deletedAt && current.associations.some(association => (
          association.chatId === parsed.chatId && association.status === 'open'
        ))) {
          throw new Error('Cannot remove a chat with open terminal sessions')
        }
        const timestamp = nextLogicalTimestamp(this.now(), current)
        changed = Boolean(existing && !existing.deletedAt)
        if (existing) {
          existing.title = '已删除聊天'
          existing.updatedAt = timestamp
          existing.deletedAt = timestamp
        } else {
          current.chats.push({
            id: parsed.chatId,
            title: '已删除聊天',
            createdAt: timestamp,
            updatedAt: timestamp,
            mode: 'copilot',
            deletedAt: timestamp,
          })
        }
        replaceLiveChatIfCurrent(current, parsed.chatId)
        current.messages = current.messages.filter(message => message.chatId !== parsed.chatId)
        current.associations = current.associations.filter(association => association.chatId !== parsed.chatId)
        current.operations = current.operations.map(operation => operation.chatId === parsed.chatId
          ? { requestId: operation.requestId, kind: operation.kind, chatId: operation.chatId, fingerprint: operation.fingerprint, appliedAt: operation.appliedAt }
          : operation)
        current.operations.push({ requestId: parsed.requestId, kind: 'remove', chatId: parsed.chatId, fingerprint, appliedAt: timestamp })
        return current
      })
      return { value: undefined, changed, liveChatId: document.liveChatId }
    } catch (error) {
      if (error instanceof DuplicateRequest) {
        if (error.operation.chatId !== parsed.chatId) {
          throw new Error('requestId already belongs to another chat', { cause: error })
        }
        return { value: undefined, changed: false, liveChatId: (await this.store.load()).liveChatId }
      }
      throw error
    }
  }

  private async mutate(
    requestId: string,
    kind: Exclude<ChatOperation['kind'], 'remove'>,
    requestedChatId: string | undefined,
    fingerprint: string,
    change: (document: ChatDocument, appliedAt: string) => { chatId: string; resultId?: string },
  ): Promise<ChatMutation<ChatWorkspace>> {
    try {
      const document = await this.store.update(current => {
        const duplicate = findDuplicate(current, requestId, kind, requestedChatId, fingerprint)
        if (duplicate) throw new DuplicateRequest(duplicate)
        const appliedAt = nextLogicalTimestamp(this.now(), current)
        const result = change(current, appliedAt)
        const chat = requireChat(current, result.chatId)
        current.operations.push({
          requestId,
          kind,
          fingerprint,
          appliedAt,
          ...result,
          result: { createdAt: chat.createdAt, updatedAt: chat.updatedAt, mode: chat.mode },
        })
        return current
      })
      const operation = document.operations.find(item => item.requestId === requestId)!
      return { value: toWorkspace(document, operation.chatId), changed: true, liveChatId: document.liveChatId }
    } catch (error) {
      if (!(error instanceof DuplicateRequest)) throw error
      const document = await this.store.load()
      const operation = document.operations.find(item => item.requestId === requestId)
      if (!operation) throw error
      if (requestedChatId && operation.chatId !== requestedChatId) {
        throw new Error('requestId already belongs to another chat', { cause: error })
      }
      if (!document.chats.some(chat => chat.id === operation.chatId)) throw error
      return {
        value: toWorkspaceOrTombstone(document, operation.chatId),
        changed: false,
        liveChatId: document.liveChatId,
      }
    }
  }
}

function replaceLiveChatIfCurrent(document: ChatDocument, previousChatId: string): void {
  if (document.liveChatId !== previousChatId) return
  if (document.associations.some(association => (
    association.chatId === previousChatId && association.status === 'open'
  ))) return
  const replacement = document.chats
    .filter(chat => !chat.deletedAt && chat.id !== previousChatId)
    .filter(chat => document.associations.some(association => (
      association.chatId === chat.id && association.status === 'open'
    )))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))[0]
  document.liveChatId = replacement?.id ?? null
}

function findDuplicate(
  document: ChatDocument,
  requestId: string,
  kind: ChatOperation['kind'],
  requestedChatId: string | undefined,
  fingerprint: string,
): ChatOperation | undefined {
  const existing = document.operations.find(operation => operation.requestId === requestId)
  if (existing && (
    existing.kind !== kind
    || (requestedChatId !== undefined && existing.chatId !== requestedChatId)
    || existing.fingerprint !== fingerprint
  )) {
    throw new Error('Chat request idempotency conflict')
  }
  return existing
}

function bindSessionFingerprint(request: Pick<ChatBindSessionRequest, 'chatId' | 'sessionId'>): string {
  return requestFingerprint('bindSession', [request.chatId, request.sessionId])
}

function isBindSessionOperation(operation: ChatOperation, fingerprint: string): boolean {
  return (operation.kind === 'associateShell' || operation.kind === 'bindSession')
    && operation.fingerprint === fingerprint
}

function requestFingerprint(kind: ChatOperation['kind'] | 'bindSession', payload: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify([kind, ...payload])).digest('hex')
}

function derivedRequestId(requestId: string, kind: string, index: number): string {
  return createHash('sha256').update(`${requestId}:${kind}:${index}`).digest('hex')
}

function interruptedStreamRecoveryRequestId(messageId: string): string {
  return createHash('sha256').update(`chat-stream-recovery:${messageId}`).digest('hex')
}

function requireChat(document: ChatDocument, chatId: string) {
  const chat = document.chats.find(item => item.id === chatId && !item.deletedAt)
  if (!chat) throw new Error('Unknown chat')
  return chat
}

function toWorkspace(document: ChatDocument, chatId: string): ChatWorkspace {
  const chat = requireChat(document, chatId)
  const messages: ChatMessageRecord[] = document.messages
    .filter(message => message.chatId === chatId)
    .map(message => ({
      id: message.id,
      chatId: message.chatId,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
      state: message.state,
      ...(message.retryable === undefined ? {} : { retryable: message.retryable }),
    }))
  const shells: ChatShellAssociation[] = document.associations
    .filter(association => association.chatId === chatId)
    .map(association => ({
      id: association.id,
      chatId: association.chatId,
      ...(association.sessionId ? { sessionId: association.sessionId } : {}),
      historyId: association.historyId,
      hostname: association.hostname,
      title: association.title,
      status: association.status,
      associatedAt: association.associatedAt,
      ...(association.closedAt ? { closedAt: association.closedAt } : {}),
    }))
  return {
    ...chat,
    shellCount: shells.length,
    live: shells.some(shell => shell.status === 'open'),
    messages,
    shells,
  }
}

function toWorkspaceOrTombstone(document: ChatDocument, chatId: string): ChatWorkspace {
  const tombstone = document.chats.find(chat => chat.id === chatId && chat.deletedAt)
  if (!tombstone) return toWorkspace(document, chatId)
  return {
    id: chatId,
    title: '已删除聊天',
    createdAt: tombstone.createdAt,
    updatedAt: tombstone.updatedAt,
    mode: tombstone.mode,
    shellCount: 0,
    live: false,
    messages: [],
    shells: [],
  }
}

export function summarizeChats(
  chats: readonly PersistedChat[],
  associations: readonly PersistedAssociation[],
): ChatSummary[] {
  const shellsByChat = new Map<string, { count: number; live: boolean }>()
  for (const association of associations) {
    const current = shellsByChat.get(association.chatId)
    shellsByChat.set(association.chatId, {
      count: (current?.count ?? 0) + 1,
      live: (current?.live ?? false) || association.status === 'open',
    })
  }
  return chats.filter(chat => !chat.deletedAt).map(chat => {
    const shells = shellsByChat.get(chat.id)
    return {
      id: chat.id,
      title: chat.title,
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
      shellCount: shells?.count ?? 0,
      mode: chat.mode,
      live: shells?.live ?? false,
    }
  }).sort(compareChats)
}

function compareChats(left: ChatSummary, right: ChatSummary): number {
  return right.updatedAt.localeCompare(left.updatedAt)
    || left.createdAt.localeCompare(right.createdAt)
    || left.id.localeCompare(right.id)
}

function sanitizeChatShellMetadata<T extends { hostname: string; title: string }>(metadata: T): T {
  return {
    ...metadata,
    hostname: sanitizeShellHistoryDisplay(metadata.hostname),
    title: sanitizeShellHistoryDisplay(metadata.title),
  }
}

function fallbackTitle(now: Date): string {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(now)
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? ''
  return `新建聊天 ${value('year')}-${value('month')}-${value('day')} ${value('hour')}:${value('minute')}:${value('second')}`
}

const minimumCanonicalTimestamp = Date.parse('0000-01-01T00:00:00.000Z')
const maximumCanonicalTimestamp = Date.parse('9999-12-31T23:59:59.999Z')

export function nextLogicalTimestamp(now: Date, document: ChatDocument): string {
  const physicalTime = now.getTime()
  if (!Number.isFinite(physicalTime) || physicalTime < minimumCanonicalTimestamp || physicalTime > maximumCanonicalTimestamp) {
    throw new Error('Invalid chat clock')
  }

  let watermark = Number.NEGATIVE_INFINITY
  const observe = (timestamp: string | undefined): void => {
    if (timestamp === undefined) return
    const persistedTime = Date.parse(timestamp)
    if (!Number.isFinite(persistedTime) || persistedTime < minimumCanonicalTimestamp || persistedTime > maximumCanonicalTimestamp) {
      throw new Error('Invalid persisted chat timestamp')
    }
    if (persistedTime > watermark) watermark = persistedTime
  }

  for (const chat of document.chats) {
    observe(chat.createdAt)
    observe(chat.updatedAt)
    observe(chat.deletedAt)
  }
  for (const message of document.messages) observe(message.createdAt)
  for (const association of document.associations) {
    observe(association.associatedAt)
    observe(association.closedAt)
  }
  for (const operation of document.operations) {
    observe(operation.appliedAt)
    observe(operation.result?.createdAt)
    observe(operation.result?.updatedAt)
  }

  if (watermark === Number.NEGATIVE_INFINITY) return now.toISOString()
  if (watermark >= maximumCanonicalTimestamp) throw new Error('Chat logical timestamp exhausted')
  const next = Math.max(physicalTime, watermark + 1)
  if (next > maximumCanonicalTimestamp) throw new Error('Chat logical timestamp exhausted')
  return new Date(next).toISOString()
}
