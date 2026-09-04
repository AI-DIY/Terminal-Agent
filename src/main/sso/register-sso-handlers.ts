import { ipcMain, type WebContents } from 'electron'
import { ssoAuthSnapshotSchema, ssoConfigurationSchema, ssoSaveIntentSchema } from '../../shared/sso-contracts'
import type { SsoConfigService } from '../settings/sso-config-service'
import type { SsoAuthenticationService } from './sso-authentication-service'

const channels = ['sso:config:get', 'sso:config:save', 'sso:state:get', 'sso:retry'] as const

export function registerSsoHandlers(config: Pick<SsoConfigService, 'get'>, auth: Pick<SsoAuthenticationService, 'getState' | 'saveConfiguration' | 'retry'>, trustedSender: WebContents): () => void {
  ipcMain.handle('sso:config:get', event => {
    assertTrustedSender(event, trustedSender)
    return Promise.resolve(config.get()).then(value => ssoConfigurationSchema.parse(value))
  })
  ipcMain.handle('sso:config:save', async (event, input: unknown, intent: unknown) => {
    assertTrustedSender(event, trustedSender)
    await auth.saveConfiguration(ssoConfigurationSchema.parse(input), ssoSaveIntentSchema.parse(intent ?? 'draft'))
    return ssoConfigurationSchema.parse(await config.get())
  })
  ipcMain.handle('sso:state:get', event => {
    assertTrustedSender(event, trustedSender)
    return ssoAuthSnapshotSchema.parse(auth.getState())
  })
  ipcMain.handle('sso:retry', async (event, ...args: unknown[]) => {
    assertTrustedSender(event, trustedSender)
    if (args.length !== 0) throw new Error('sso:retry does not accept arguments')
    await auth.retry()
  })

  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    for (const channel of channels) ipcMain.removeHandler(channel)
  }
}

function assertTrustedSender(event: { sender: WebContents }, trustedSender: WebContents): void {
  if (event.sender !== trustedSender) throw new Error('Untrusted renderer')
}
