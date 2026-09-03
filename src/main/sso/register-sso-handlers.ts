import { ipcMain, type WebContents } from 'electron'
import { ssoAuthSnapshotSchema, ssoConfigurationSchema } from '../../shared/sso-contracts'
import type { SsoConfigService } from '../settings/sso-config-service'
import type { SsoAuthenticationService } from './sso-authentication-service'

const channels = ['sso:config:get', 'sso:config:save', 'sso:state:get', 'sso:retry'] as const

export function registerSsoHandlers(config: Pick<SsoConfigService, 'get'>, auth: Pick<SsoAuthenticationService, 'getState' | 'saveConfiguration' | 'retry' | 'onState'>, trustedSender: WebContents): () => void {
  ipcMain.handle('sso:config:get', event => {
    assertTrustedSender(event, trustedSender)
    return Promise.resolve(config.get()).then(value => ssoConfigurationSchema.parse(value))
  })
  ipcMain.handle('sso:config:save', async (event, input: unknown) => {
    assertTrustedSender(event, trustedSender)
    await auth.saveConfiguration(ssoConfigurationSchema.parse(input))
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

  const unsubscribe = auth.onState(snapshot => {
    const safe = ssoAuthSnapshotSchema.parse(snapshot)
    if (!trustedSender.isDestroyed()) trustedSender.send('sso:state', safe)
  })
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    unsubscribe()
    for (const channel of channels) ipcMain.removeHandler(channel)
  }
}

function assertTrustedSender(event: { sender: WebContents }, trustedSender: WebContents): void {
  if (event.sender !== trustedSender) throw new Error('Untrusted renderer')
}
