import { ipcMain, type WebContents } from 'electron'
import type { DirectSessionRequest, SessionService } from '../ssh/session-service'
import {
  rendererSessionRequestSchema,
  savedDirectSessionInputSchema,
  terminalResizeSchema,
  terminalSessionIdSchema,
  terminalWriteSchema,
  type RendererSessionRequest,
  type SavedDirectSessionInput,
} from '../../shared/contracts'
import { KeyMaterialStore } from '../ssh/key-material-store'
import type { DirectSessionProfile, DirectSessionSummary } from '../ssh/direct-session-repository'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'

type DirectSessionProfiles = {
  list(): Promise<DirectSessionSummary[]>
  save(profile: DirectSessionProfile): Promise<void>
  load(id: string): Promise<DirectSessionProfile>
  remove(id: string): Promise<void>
}

export function registerSessionHandlers(
  sessions: SessionService,
  keyMaterials: KeyMaterialStore,
  sender: WebContents,
  directProfiles?: DirectSessionProfiles,
): () => void {
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
  if (directProfiles) {
    ipcMain.handle('sessions:profiles:list', async event => {
      assertTrustedSender(event, sender)
      return directProfiles.list()
    })
    ipcMain.handle('sessions:profiles:save', async (event, profile: unknown) => {
      assertTrustedSender(event, sender)
      await directProfiles.save(await profileWithRetainedCredentials(savedDirectSessionInputSchema.parse(profile), directProfiles))
    })
    ipcMain.handle('sessions:profiles:open', async (event, id: unknown) => {
      assertTrustedSender(event, sender)
      const profile = await directProfiles.load(terminalSessionIdSchema.parse(id))
      return sessions.connect(await toSavedDirectRequest(profile))
    })
    ipcMain.handle('sessions:profiles:delete', async (event, id: unknown) => {
      assertTrustedSender(event, sender)
      await directProfiles.remove(terminalSessionIdSchema.parse(id))
    })
  }

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
    if (directProfiles) {
      ipcMain.removeHandler('sessions:profiles:list')
      ipcMain.removeHandler('sessions:profiles:save')
      ipcMain.removeHandler('sessions:profiles:open')
      ipcMain.removeHandler('sessions:profiles:delete')
    }
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

async function toSavedDirectRequest(profile: DirectSessionProfile): Promise<DirectSessionRequest> {
  const common = { host: profile.host, port: profile.port, username: profile.username }
  if (profile.auth.kind === 'password') return { ...common, auth: profile.auth }
  return {
    ...common,
    auth: {
      kind: 'privateKey',
      key: {
        fileName: basename(profile.auth.privateKeyPath),
        content: await readFile(profile.auth.privateKeyPath),
        ...(profile.auth.passphrase ? { passphrase: profile.auth.passphrase } : {}),
      },
    },
  }
}

async function profileWithRetainedCredentials(
  profile: SavedDirectSessionInput,
  directProfiles: DirectSessionProfiles,
): Promise<DirectSessionProfile> {
  if (profile.auth.kind === 'password') {
    if (profile.auth.password !== undefined) return profile as DirectSessionProfile
    const existing = await directProfiles.load(profile.id).catch(() => undefined)
    if (!existing || existing.auth.kind !== 'password') {
      throw new Error('请输入密码后再保存新的 SSH 会话。')
    }
    return { ...profile, auth: existing.auth }
  }

  if (profile.auth.passphrase !== undefined) return profile as DirectSessionProfile
  const existing = await directProfiles.load(profile.id).catch(() => undefined)
  if (existing?.auth.kind === 'privateKey' && existing.auth.privateKeyPath === profile.auth.privateKeyPath) {
    return { ...profile, auth: existing.auth }
  }
  return profile as DirectSessionProfile
}
