import { ipcMain, type WebContents } from 'electron'
import {
  chatCreateRequestSchema,
  chatCreateConversationSessionRequestSchema,
  chatBindSessionRequestSchema,
  chatIdentifierSchema,
  chatListRequestSchema,
  chatRemoveRequestSchema,
  chatResolveSessionRequestSchema,
  chatSetModeRequestSchema,
  chatSwitchConversationSessionRequestSchema,
  chatTransferSessionsRequestSchema,
  chatRunRequestSchema,
  chatCompactRequestSchema,
  chatRuntimeEventSchema,
  chatPinRequestSchema,
  chatUnpinRequestSchema,
  chatUpdateTitleRequestSchema,
} from '../../shared/contracts'
import type { ChatService } from './chat-service'
import type { ConnectedSession, SessionService } from '../ssh/session-service'
import type { ChatRuntime } from './chat-runtime'
import { chatPlanEditStepRequestSchema, chatPlanRemoveStepRequestSchema, chatPlanCancelRequestSchema, chatPlanExecuteRequestSchema } from '../../shared/chat-plan'
import type { ExecutionPlanService } from './execution-plan-service'

const channels = ['chats:list', 'chats:create', 'chats:get', 'chats:conversation-sessions:list', 'chats:conversation-sessions:create', 'chats:conversation-sessions:switch', 'chats:resolve-session', 'chats:set-mode', 'chats:update-title', 'chats:pin', 'chats:unpin', 'chats:remove', 'chats:bind-session', 'chats:transfer-sessions'] as const

type ChatHandlerService = Pick<ChatService, 'list' | 'create' | 'get' | 'listConversationSessions' | 'createConversationSession' | 'switchConversationSession' | 'resolveSession' | 'setMode' | 'updateTitle' | 'pin' | 'unpin' | 'remove' | 'associateSession' | 'transferSessions' | 'closeSession' | 'reconcileSessions' | 'onChanged'>
  & Pick<ChatService, 'appendMessage'>
  & Partial<Pick<ChatService, 'syncSessionMetadata'>>
type SessionLookup = Pick<SessionService, 'snapshot' | 'onClosed'> & Partial<Pick<SessionService, 'onUpdated'>>
type ChatHandlerOptions = { skillAuthorization?: { isAuthenticated(): boolean } }

export function registerChatHandlers(service: ChatHandlerService, trustedSender: WebContents, sessions: SessionLookup, runtime?: ChatRuntime, plans?: ExecutionPlanService, options: ChatHandlerOptions = {}): () => void {
  plans ??= (runtime as ChatRuntime & { planService?: ExecutionPlanService } | undefined)?.planService
  ipcMain.handle('chats:list', async (event, request: unknown) => {
    assertTrustedSender(event, trustedSender)
    const parsed = chatListRequestSchema.parse(request === undefined ? {} : request)
    // Reconciliation belongs to the startup page. Repeating it for every
    // history page would turn sidebar scrolling into a session-wide scan.
    if (!parsed.cursor) await service.reconcileSessions(() => sessions.snapshot())
    return service.list(parsed)
  })
  ipcMain.handle('chats:create', (event, request: unknown) => {
    assertTrustedSender(event, trustedSender)
    return service.create(chatCreateRequestSchema.parse(request))
  })
  ipcMain.handle('chats:get', (event, chatId: unknown) => {
    assertTrustedSender(event, trustedSender)
    return service.get(chatIdentifierSchema.parse(chatId))
  })
  ipcMain.handle('chats:conversation-sessions:list', (event, chatId: unknown) => {
    assertTrustedSender(event, trustedSender)
    return service.listConversationSessions(chatIdentifierSchema.parse(chatId))
  })
  ipcMain.handle('chats:conversation-sessions:create', async (event, request: unknown) => {
    assertTrustedSender(event, trustedSender)
    const parsed = chatCreateConversationSessionRequestSchema.parse(request)
    // A stream is keyed only by task today.  Finish its cancellation before
    // changing the active inner conversation so delayed output cannot land in
    // the conversation the user just opened.
    await runtime?.cancel(parsed.chatId)
    return service.createConversationSession(parsed)
  })
  ipcMain.handle('chats:conversation-sessions:switch', async (event, request: unknown) => {
    assertTrustedSender(event, trustedSender)
    const parsed = chatSwitchConversationSessionRequestSchema.parse(request)
    // See create: cancellation is intentionally ordered before this atomic
    // persistence mutation, not delegated to the renderer.
    await runtime?.cancel(parsed.chatId)
    return service.switchConversationSession(parsed)
  })
  ipcMain.handle('chats:resolve-session', (event, request: unknown) => {
    assertTrustedSender(event, trustedSender)
    return service.resolveSession(chatResolveSessionRequestSchema.parse(request).sessionId)
  })
  ipcMain.handle('chats:set-mode', (event, request: unknown) => {
    assertTrustedSender(event, trustedSender)
    return service.setMode(chatSetModeRequestSchema.parse(request))
  })
  ipcMain.handle('chats:update-title', (event, request: unknown) => {
    assertTrustedSender(event, trustedSender)
    return service.updateTitle(chatUpdateTitleRequestSchema.parse(request))
  })
  ipcMain.handle('chats:pin', (event, request: unknown) => {
    assertTrustedSender(event, trustedSender)
    return service.pin(chatPinRequestSchema.parse(request))
  })
  ipcMain.handle('chats:unpin', (event, request: unknown) => {
    assertTrustedSender(event, trustedSender)
    return service.unpin(chatUnpinRequestSchema.parse(request))
  })
  ipcMain.handle('chats:remove', async (event, request: unknown) => {
    assertTrustedSender(event, trustedSender)
    const parsed = chatRemoveRequestSchema.parse(request)
    await runtime?.cancel(parsed.chatId)
    await service.remove(parsed)
  })
  ipcMain.handle('chats:bind-session', async (event, request: unknown) => {
    assertTrustedSender(event, trustedSender)
    const parsed = chatBindSessionRequestSchema.parse(request)
    const session = sessions.snapshot().find(item => item.id === parsed.sessionId)
    if (!session) throw new Error('Unknown terminal session')
    let workspace = await service.associateSession(parsed, session as ConnectedSession)
    const latest = sessions.snapshot().find(item => item.id === parsed.sessionId)
    if (!latest) {
      await service.closeSession(parsed.sessionId)
    } else if (service.syncSessionMetadata && latest.observedHostname !== session.observedHostname) {
      try {
        const refreshed = await service.syncSessionMetadata(latest as ConnectedSession)
        if (refreshed) workspace = refreshed
      } catch (error) {
        console.error('Failed to synchronize observed Shell hostname after binding', error)
      }
    }
    return workspace
  })
  ipcMain.handle('chats:transfer-sessions', async (event, request: unknown) => {
    assertTrustedSender(event, trustedSender)
    const parsed = chatTransferSessionsRequestSchema.parse(request)
    const sessionsById = new Map(sessions.snapshot().map(session => [session.id, session]))
    const selected = parsed.sessionIds.map(sessionId => {
      const session = sessionsById.get(sessionId)
      if (!session) throw new Error('Unknown terminal session')
      return session as ConnectedSession
    })
    const workspace = await service.transferSessions(parsed, selected)
    const activeSessionIds = new Set(sessions.snapshot().map(session => session.id))
    for (const sessionId of parsed.sessionIds) {
      if (!activeSessionIds.has(sessionId)) await service.closeSession(sessionId)
    }
    return workspace
  })
  if (runtime) {
    ipcMain.handle('chat:send', async (event, request: unknown) => {
      assertTrustedSender(event, trustedSender)
      const parsed = chatRunRequestSchema.parse(request)
      const guarded = skillsAuthenticated(options)
        ? parsed
        : { ...parsed, skillIds: [], selectedSkillIds: [] }
      await runtime.send(guarded, payload => {
        const safe = chatRuntimeEventSchema.parse(payload)
        if (!trustedSender.isDestroyed()) trustedSender.send('chat:event', safe)
      })
    })
    ipcMain.handle('chat:cancel', async (event, chatId: unknown) => {
      assertTrustedSender(event, trustedSender)
      await runtime.cancel(chatIdentifierSchema.parse(chatId))
    })
    ipcMain.handle('chat:compact', async (event, request: unknown) => {
      assertTrustedSender(event, trustedSender)
      const parsed = chatCompactRequestSchema.parse(request)
      const guarded = skillsAuthenticated(options)
        ? parsed
        : { ...parsed, skillIds: [], selectedSkillIds: [] }
      const persistSummary = (summary: string) => service.appendMessage({
        requestId: parsed.requestId,
        chatId: parsed.chatId,
        role: 'system',
        content: summary,
        state: 'complete',
        messageType: 'context_summary',
      })
      // Keep compatibility with lightweight test/adaptor runtimes that only
      // expose the original compact() method.  The production ChatRuntime
      // always provides compactAndPersist, which holds its lock through this
      // callback and closes the snapshot race.
      if (typeof runtime.compactAndPersist === 'function') return runtime.compactAndPersist(guarded, persistSummary)
      const summary = await runtime.compact(guarded)
      return persistSummary(summary)
    })
  }
  if (plans) {
    ipcMain.handle('chat:plan:edit-step', (event, request: unknown) => { assertTrustedSender(event, trustedSender); return plans.editStep(chatPlanEditStepRequestSchema.parse(request)) })
    ipcMain.handle('chat:plan:remove-step', (event, request: unknown) => { assertTrustedSender(event, trustedSender); return plans.removeStep(chatPlanRemoveStepRequestSchema.parse(request)) })
    ipcMain.handle('chat:plan:cancel', (event, request: unknown) => { assertTrustedSender(event, trustedSender); return plans.cancel(chatPlanCancelRequestSchema.parse(request)) })
    ipcMain.handle('chat:plan:execute', (event, request: unknown) => {
      assertTrustedSender(event, trustedSender)
      const parsed = chatPlanExecuteRequestSchema.parse(request)
      // A confirmed plan can carry the renderer's enabled skills into its
      // result-analysis turn. Apply the same authentication gate as ordinary
      // chat sends so a forged IPC payload cannot enable product skills.
      return plans.execute(skillsAuthenticated(options)
        ? parsed
        : { ...parsed, skillIds: [], selectedSkillIds: [] })
    })
  }

  const unsubscribeChanged = service.onChanged(event => trustedSender.send('chats:changed', event))
  const observedMetadata = new Map<string, string | undefined>()
  const unsubscribeUpdated = sessions.onUpdated?.(session => {
    const hadObservedState = observedMetadata.has(session.id)
    const observedHostname = Object.prototype.hasOwnProperty.call(session, 'observedHostname')
      ? session.observedHostname
      : undefined
    const previous = observedMetadata.get(session.id)
    observedMetadata.set(session.id, observedHostname)
    if (!service.syncSessionMetadata || (!hadObservedState && observedHostname === undefined) || previous === observedHostname) return
    void service.syncSessionMetadata(session).catch(error => {
      console.error('Failed to synchronize observed Shell hostname', error)
    })
  })
  const unsubscribeClosed = sessions.onClosed(event => {
    observedMetadata.delete(event.sessionId)
    void service.closeSession(event.sessionId).catch(error => {
      console.error('Failed to close chat session association', error)
    })
  })
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    unsubscribeChanged()
    unsubscribeUpdated?.()
    unsubscribeClosed()
    for (const channel of channels) ipcMain.removeHandler(channel)
    if (runtime) for (const channel of ['chat:send', 'chat:cancel', 'chat:compact'] as const) ipcMain.removeHandler(channel)
    if (plans) for (const channel of ['chat:plan:edit-step', 'chat:plan:remove-step', 'chat:plan:cancel', 'chat:plan:execute'] as const) ipcMain.removeHandler(channel)
  }
}

function assertTrustedSender(event: { sender: WebContents }, trustedSender: WebContents): void {
  if (event.sender !== trustedSender) throw new Error('Untrusted renderer')
}

function skillsAuthenticated(options: ChatHandlerOptions): boolean {
  try {
    return options.skillAuthorization?.isAuthenticated() === true
  } catch {
    return false
  }
}
