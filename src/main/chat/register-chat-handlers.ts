import { ipcMain, type WebContents } from 'electron'
import {
  chatCreateRequestSchema,
  chatBindSessionRequestSchema,
  chatIdentifierSchema,
  chatRemoveRequestSchema,
  chatResolveSessionRequestSchema,
  chatSetModeRequestSchema,
  chatTransferSessionsRequestSchema,
  chatRunRequestSchema,
  chatRuntimeEventSchema,
} from '../../shared/contracts'
import type { ChatService } from './chat-service'
import type { ConnectedSession, SessionService } from '../ssh/session-service'
import type { ChatRuntime } from './chat-runtime'

const channels = ['chats:list', 'chats:create', 'chats:get', 'chats:resolve-session', 'chats:set-mode', 'chats:remove', 'chats:bind-session', 'chats:transfer-sessions'] as const

type ChatHandlerService = Pick<ChatService, 'list' | 'create' | 'get' | 'resolveSession' | 'setMode' | 'remove' | 'associateSession' | 'transferSessions' | 'closeSession' | 'reconcileSessions' | 'onChanged'>
type SessionLookup = Pick<SessionService, 'snapshot' | 'onClosed'>

export function registerChatHandlers(service: ChatHandlerService, trustedSender: WebContents, sessions: SessionLookup, runtime?: ChatRuntime): () => void {
  ipcMain.handle('chats:list', async event => {
    assertTrustedSender(event, trustedSender)
    await service.reconcileSessions(() => sessions.snapshot())
    return service.list()
  })
  ipcMain.handle('chats:create', (event, request: unknown) => {
    assertTrustedSender(event, trustedSender)
    return service.create(chatCreateRequestSchema.parse(request))
  })
  ipcMain.handle('chats:get', (event, chatId: unknown) => {
    assertTrustedSender(event, trustedSender)
    return service.get(chatIdentifierSchema.parse(chatId))
  })
  ipcMain.handle('chats:resolve-session', (event, request: unknown) => {
    assertTrustedSender(event, trustedSender)
    return service.resolveSession(chatResolveSessionRequestSchema.parse(request).sessionId)
  })
  ipcMain.handle('chats:set-mode', (event, request: unknown) => {
    assertTrustedSender(event, trustedSender)
    return service.setMode(chatSetModeRequestSchema.parse(request))
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
    const workspace = await service.associateSession(parsed, session as ConnectedSession)
    if (!sessions.snapshot().some(item => item.id === parsed.sessionId)) await service.closeSession(parsed.sessionId)
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
      await runtime.send(parsed, payload => {
        const safe = chatRuntimeEventSchema.parse(payload)
        if (!trustedSender.isDestroyed()) trustedSender.send('chat:event', safe)
      })
    })
    ipcMain.handle('chat:cancel', async (event, chatId: unknown) => {
      assertTrustedSender(event, trustedSender)
      await runtime.cancel(chatIdentifierSchema.parse(chatId))
    })
  }

  const unsubscribeChanged = service.onChanged(event => trustedSender.send('chats:changed', event))
  const unsubscribeClosed = sessions.onClosed(event => {
    void service.closeSession(event.sessionId).catch(error => {
      console.error('Failed to close chat session association', error)
    })
  })
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    unsubscribeChanged()
    unsubscribeClosed()
    for (const channel of channels) ipcMain.removeHandler(channel)
    if (runtime) for (const channel of ['chat:send', 'chat:cancel'] as const) ipcMain.removeHandler(channel)
  }
}

function assertTrustedSender(event: { sender: WebContents }, trustedSender: WebContents): void {
  if (event.sender !== trustedSender) throw new Error('Untrusted renderer')
}
