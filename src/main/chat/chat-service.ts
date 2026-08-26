import {
  chatAppendMessageRequestSchema,
  chatAssociateShellRequestSchema,
  chatChangedEventSchema,
  chatBindSessionRequestSchema,
  chatCloseAssociationRequestSchema,
  chatCreateRequestSchema,
  chatPinRequestSchema,
  chatRemoveRequestSchema,
  chatSetModeRequestSchema,
  chatTransferSessionsRequestSchema,
  type ChatTransferSessionsRequest,
  chatUpdateTitleRequestSchema,
  chatUnpinRequestSchema,
  type ChatAppendMessageRequest,
  type ChatUpdateMessageRequest,
  type ChatAssociateShellRequest,
  type ChatChangedEvent,
  type ChatBindSessionRequest,
  type ChatCloseAssociationRequest,
  type ChatCreateRequest,
  type ChatPinRequest,
  type ChatRemoveRequest,
  type ChatSessionResolution,
  type ChatSetModeRequest,
  type ChatUpdateTitleRequest,
  type ChatUnpinRequest,
  type ChatWorkspace,
  type ChatWorkspaceSnapshot,
} from '../../shared/contracts'
import type { ConnectedSession } from '../ssh/session-service'
import type { ChatMessageContent } from '../../shared/chat-content'
import { sanitizeShellHistoryDisplay } from '../shell-history/shell-history-contracts'
import { createHash, randomUUID } from 'node:crypto'
import type { ChatMutation, ChatRepository, ChatTransferMutation } from './chat-repository'

type ChatRepositoryPort = Pick<ChatRepository, 'listSnapshot' | 'get' | 'findRetryMessage' | 'recoverInterruptedStreams' | 'create' | 'appendMessage' | 'updateMessage' | 'updateTitle' | 'pin' | 'unpin' | 'setMode' | 'associateShell' | 'associateOrCreateShell' | 'recordSessionRequest' | 'transferSessions' | 'closeAssociation' | 'closeSession' | 'findOpenSession' | 'findSessionRequest' | 'openSessionIds' | 'remove'>

export class ChatService {
  private readonly changedListeners = new Set<(event: ChatChangedEvent) => void>()
  private readonly pendingMutations = new Set<Promise<unknown>>()
  private readonly pendingHistoryAssociations = new Map<string, Promise<unknown>>()
  private revision = 0

  constructor(private readonly repository: ChatRepositoryPort) {}

  async list() {
    while (true) {
      await this.waitForMutations()
      const revision = this.revision
      const snapshot = await this.repository.listSnapshot()
      if (revision === this.revision && this.pendingMutations.size === 0) return { revision, ...snapshot }
    }
  }

  async get(chatId: string): Promise<ChatWorkspaceSnapshot> {
    while (true) {
      await this.waitForMutations()
      const revision = this.revision
      const [chat, snapshot] = await Promise.all([this.repository.get(chatId), this.repository.listSnapshot()])
      if (revision === this.revision && this.pendingMutations.size === 0) {
        return { revision, chat, liveChatId: snapshot.liveChatId }
      }
    }
  }

  async findRetryMessage(chatId: string, content?: ChatMessageContent): Promise<string | undefined> {
    await this.waitForMutations()
    return this.repository.findRetryMessage(chatId, content)
  }

  async recoverInterruptedStreams(): Promise<void> {
    await this.trackMutation(async () => {
      await this.repository.recoverInterruptedStreams()
    })
  }

  async create(request: ChatCreateRequest): Promise<ChatWorkspaceSnapshot> {
    const parsed = chatCreateRequestSchema.parse(request)
    return this.trackMutation(() => this.apply(this.repository.create(parsed), 'created'))
  }

  async appendMessage(request: ChatAppendMessageRequest): Promise<ChatWorkspaceSnapshot> {
    const parsed = chatAppendMessageRequestSchema.parse(request)
    return this.trackMutation(() => this.apply(this.repository.appendMessage(parsed), 'updated'))
  }

  async updateMessage(request: ChatUpdateMessageRequest): Promise<ChatWorkspaceSnapshot> {
    return this.trackMutation(() => this.apply(this.repository.updateMessage(request), 'updated'))
  }

  async updateTitle(request: ChatUpdateTitleRequest): Promise<ChatWorkspaceSnapshot> {
    const parsed = chatUpdateTitleRequestSchema.parse(request)
    return this.trackMutation(() => this.apply(this.repository.updateTitle(parsed), 'updated'))
  }

  async pin(request: ChatPinRequest): Promise<ChatWorkspaceSnapshot> {
    const parsed = chatPinRequestSchema.parse(request)
    return this.trackMutation(() => this.apply(this.repository.pin(parsed), 'updated'))
  }

  async unpin(request: ChatUnpinRequest): Promise<ChatWorkspaceSnapshot> {
    const parsed = chatUnpinRequestSchema.parse(request)
    return this.trackMutation(() => this.apply(this.repository.unpin(parsed), 'updated'))
  }

  async setMode(request: ChatSetModeRequest): Promise<ChatWorkspaceSnapshot> {
    const parsed = chatSetModeRequestSchema.parse(request)
    return this.trackMutation(() => this.apply(this.repository.setMode(parsed), 'updated'))
  }

  async associateShell(request: ChatAssociateShellRequest): Promise<ChatWorkspaceSnapshot> {
    const parsed = sanitizeChatShellMetadata(chatAssociateShellRequestSchema.parse(request))
    return this.trackMutation(() => this.apply(this.repository.associateShell(parsed), 'updated'))
  }

  async associateSession(request: ChatBindSessionRequest, session: ConnectedSession): Promise<ChatWorkspaceSnapshot> {
    const parsed = chatBindSessionRequestSchema.parse(request)
    return this.trackMutation(async () => {
      const priorRequest = await this.repository.findSessionRequest(parsed)
      if (priorRequest) {
        const recorded = await this.repository.recordSessionRequest(parsed)
        if (!recorded) throw new Error('Recorded terminal session request has no workspace')
        return { revision: this.revision, chat: recorded.value, liveChatId: recorded.liveChatId }
      }
      let existing = await this.repository.findOpenSession(parsed.sessionId)
      if (existing) {
        if (existing.chatId === parsed.chatId) {
          const recorded = await this.repository.recordSessionRequest(parsed)
          if (recorded) return this.apply(Promise.resolve(recorded), 'updated')
          existing = await this.repository.findOpenSession(parsed.sessionId)
        }
      }
      const association = sanitizeChatShellMetadata({
        requestId: parsed.requestId,
        chatId: parsed.chatId,
        sessionId: session.id,
        historyId: stableHistoryId(parsed.requestId, session.id),
        hostname: session.hostname,
        title: session.title ?? session.hostname,
      })
      if (existing && existing.chatId !== parsed.chatId) {
        const transferRequest: ChatTransferSessionsRequest = {
          requestId: parsed.requestId,
          sourceChatId: existing.chatId,
          targetChatId: parsed.chatId,
          sessionIds: [parsed.sessionId],
        }
        try {
          return await this.applyTransfer(this.repository.transferSessions(transferRequest, [association], parsed))
        } catch (error) {
          const message = error instanceof Error ? error.message : ''
          if (!message.includes('Unknown chat') && !message.includes('Unknown source terminal session')) throw error
        }
      }
      return this.apply(this.repository.associateOrCreateShell(association), 'updated')
    })
  }

  async transferSessions(request: ChatTransferSessionsRequest, sessions: readonly ConnectedSession[]): Promise<ChatWorkspaceSnapshot> {
    const parsed = chatTransferSessionsRequestSchema.parse(request)
    const sessionById = new Map(sessions.map(session => [session.id, session]))
    if (sessionById.size !== sessions.length || parsed.sessionIds.some(sessionId => !sessionById.has(sessionId))) {
      throw new Error('Unknown terminal session')
    }
    const metadata = parsed.sessionIds.map(sessionId => {
      const session = sessionById.get(sessionId)!
      return sanitizeChatShellMetadata({
        sessionId,
        historyId: stableHistoryId(parsed.requestId, sessionId),
        hostname: session.hostname,
        title: session.title ?? session.hostname,
      })
    })
    return this.trackMutation(() => this.applyTransfer(this.repository.transferSessions(parsed, metadata)))
  }

  ensureClosedHistoryAssociation(session: ConnectedSession): Promise<{ chatId: string; historyId: string }> {
    const existing = this.pendingHistoryAssociations.get(session.id)
    if (existing) return existing as Promise<{ chatId: string; historyId: string }>
    const operation = this.trackMutation(async () => {
      const openAssociation = await this.repository.findOpenSession(session.id)
      if (openAssociation) return { chatId: openAssociation.chatId, historyId: openAssociation.historyId }

      const snapshot = await this.repository.listSnapshot()
      const requestId = stableHistoryAssociationRequestId(session.id)
      const mutation = await this.repository.associateOrCreateShell(sanitizeChatShellMetadata({
        requestId,
        chatId: snapshot.liveChatId ?? stableFallbackChatId(session.id),
        sessionId: session.id,
        historyId: stableHistoryId(requestId, session.id),
        hostname: session.hostname,
        title: session.title ?? session.hostname,
      }))
      this.publishWorkspace(mutation, 'updated')
      const association = mutation.value.shells.find(shell => shell.sessionId === session.id)
      if (!association) throw new Error('Closed terminal session has no history association')
      return { chatId: association.chatId, historyId: association.historyId }
    })
    this.pendingHistoryAssociations.set(session.id, operation)
    void operation.then(() => {
      if (this.pendingHistoryAssociations.get(session.id) === operation) this.pendingHistoryAssociations.delete(session.id)
    }, () => {
      if (this.pendingHistoryAssociations.get(session.id) === operation) this.pendingHistoryAssociations.delete(session.id)
    })
    return operation
  }

  async resolveSession(sessionId: string): Promise<ChatSessionResolution> {
    while (true) {
      await this.waitForMutations()
      const revision = this.revision
      const association = await this.repository.findOpenSession(sessionId)
      const [chat, snapshot] = await Promise.all([
        association ? this.repository.get(association.chatId) : Promise.resolve(null),
        this.repository.listSnapshot(),
      ])
      if (revision === this.revision && this.pendingMutations.size === 0) {
        return { revision, sessionId, chat, liveChatId: snapshot.liveChatId }
      }
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.pendingHistoryAssociations.get(sessionId)?.catch(() => undefined)
    await this.trackMutation(async () => {
      const mutation = await this.repository.closeSession(sessionId, randomUUID())
      if (mutation) this.publishWorkspace(mutation, 'updated')
    })
  }

  async reconcileSessions(activeSessions: () => readonly ConnectedSession[]): Promise<void> {
    const openSessionIds = await this.repository.openSessionIds()
    const activeIds = new Set(activeSessions().map(session => session.id))
    for (const sessionId of openSessionIds) {
      if (!activeIds.has(sessionId)) await this.closeSession(sessionId)
    }
  }

  async closeAssociation(request: ChatCloseAssociationRequest): Promise<ChatWorkspaceSnapshot> {
    const parsed = chatCloseAssociationRequestSchema.parse(request)
    return this.trackMutation(() => this.apply(this.repository.closeAssociation(parsed), 'updated'))
  }

  async remove(request: ChatRemoveRequest): Promise<void> {
    const parsed = chatRemoveRequestSchema.parse(request)
    await this.trackMutation(async () => {
      const result = await this.repository.remove(parsed)
      if (result.changed) {
        this.publish({ revision: ++this.revision, chatId: parsed.chatId, kind: 'removed', liveChatId: result.liveChatId })
      }
    })
  }

  onChanged(listener: (event: ChatChangedEvent) => void): () => void {
    this.changedListeners.add(listener)
    return () => this.changedListeners.delete(listener)
  }

  private async apply(result: Promise<ChatMutation<ChatWorkspace>>, kind: 'created' | 'updated'): Promise<ChatWorkspaceSnapshot> {
    const mutation = await result
    this.publishWorkspace(mutation, kind)
    return { revision: this.revision, chat: mutation.value, liveChatId: mutation.liveChatId }
  }

  private async applyTransfer(result: Promise<ChatTransferMutation>): Promise<ChatWorkspaceSnapshot> {
    const mutation = await result
    if (mutation.changed) {
      const revision = ++this.revision
      this.publish({ revision, kind: 'updated', chat: mutation.value.source, liveChatId: mutation.liveChatId })
      this.publish({ revision, kind: 'updated', chat: mutation.value.target, liveChatId: mutation.liveChatId })
    }
    return { revision: this.revision, chat: mutation.value.target, liveChatId: mutation.liveChatId }
  }

  private trackMutation<T>(operation: () => Promise<T>): Promise<T> {
    const pending = operation()
    this.pendingMutations.add(pending)
    const remove = () => this.pendingMutations.delete(pending)
    void pending.then(remove, remove)
    return pending
  }

  private async waitForMutations(): Promise<void> {
    while (this.pendingMutations.size > 0) await Promise.allSettled([...this.pendingMutations])
  }

  private publishWorkspace(mutation: ChatMutation<ChatWorkspace>, kind: 'created' | 'updated'): void {
    if (mutation.changed) {
      this.publish({ revision: ++this.revision, kind, chat: mutation.value, liveChatId: mutation.liveChatId })
    }
  }

  private publish(event: ChatChangedEvent): void {
    const parsed = chatChangedEventSchema.parse(event)
    for (const listener of this.changedListeners) listener(parsed)
  }
}

function stableHistoryId(requestId: string, sessionId: string): string {
  return createHash('sha256').update(`${requestId}:${sessionId}:history`).digest('hex')
}

function stableHistoryAssociationRequestId(sessionId: string): string {
  return createHash('sha256').update(`${sessionId}:closed-history-association`).digest('hex')
}

function stableFallbackChatId(sessionId: string): string {
  return createHash('sha256').update(`${sessionId}:closed-history-chat`).digest('hex')
}

function sanitizeChatShellMetadata<T extends { hostname: string; title: string }>(metadata: T): T {
  return {
    ...metadata,
    hostname: sanitizeShellHistoryDisplay(metadata.hostname),
    title: sanitizeShellHistoryDisplay(metadata.title),
  }
}
