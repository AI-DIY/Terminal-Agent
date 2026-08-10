import { ipcMain, type WebContents } from 'electron'
import type { DirectSessionRequest, SessionService } from '../ssh/session-service'
import {
  rendererSessionRequestSchema,
  terminalResizeSchema,
  terminalSessionIdSchema,
  terminalWriteSchema,
  type RendererSessionRequest,
} from '../../shared/contracts'
import { KeyMaterialStore } from '../ssh/key-material-store'

export function registerSessionHandlers(sessions: SessionService, keyMaterials: KeyMaterialStore, sender: WebContents): () => void {
  ipcMain.handle('sessions:connect', async (event, request: unknown) => {
    assertTrustedSender(event, sender)
    const parsed = rendererSessionRequestSchema.parse(request)
    return sessions.connect(toDirectRequest(parsed, keyMaterials))
  })
  ipcMain.handle('sessions:selectPrivateKey', event => {
    assertTrustedSender(event, sender)
    return keyMaterials.select()
  })
  ipcMain.handle('sessions:write', (event, sessionId: unknown, data: unknown) => {
    assertTrustedSender(event, sender)
    const parsed = terminalWriteSchema.parse({ sessionId, data })
    sessions.write(parsed.sessionId, parsed.data)
  })
  ipcMain.handle('sessions:resize', (event, sessionId: unknown, columns: unknown, rows: unknown) => {
    assertTrustedSender(event, sender)
    const parsed = terminalResizeSchema.parse({ sessionId, columns, rows })
    sessions.resize(parsed.sessionId, parsed.columns, parsed.rows)
  })
  ipcMain.handle('sessions:close', (event, sessionId: unknown) => {
    assertTrustedSender(event, sender)
    sessions.close(terminalSessionIdSchema.parse(sessionId))
  })
  ipcMain.handle('sessions:list', event => {
    assertTrustedSender(event, sender)
    return sessions.snapshot()
  })

  const unsubscribe = sessions.onData(event => sender.send('sessions:data', event))
  const unsubscribeClosed = sessions.onClosed(event => sender.send('sessions:closed', event))
  const unsubscribeOpened = sessions.onOpened(session => sender.send('sessions:opened', session))
  const unsubscribeUpdated = sessions.onUpdated(session => sender.send('sessions:updated', session))
  return () => {
    unsubscribe()
    unsubscribeClosed()
    unsubscribeOpened()
    unsubscribeUpdated()
    sessions.closeAll()
    keyMaterials.clear()
    ipcMain.removeHandler('sessions:connect')
    ipcMain.removeHandler('sessions:selectPrivateKey')
    ipcMain.removeHandler('sessions:write')
    ipcMain.removeHandler('sessions:resize')
    ipcMain.removeHandler('sessions:close')
    ipcMain.removeHandler('sessions:list')
  }
}

function assertTrustedSender(event: { sender: WebContents }, trustedSender: WebContents): void {
  if (event.sender !== trustedSender) throw new Error('Untrusted renderer')
}

function toDirectRequest(request: RendererSessionRequest, keyMaterials: KeyMaterialStore): DirectSessionRequest {
  const common = { host: request.host, port: request.port, username: request.username }
  if (request.auth.kind === 'password') return { ...common, auth: request.auth }
  return { ...common, auth: { kind: 'privateKey', key: keyMaterials.take(request.auth.keyReference, request.auth.passphrase) } }
}
