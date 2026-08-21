import { ipcMain, type WebContents } from 'electron'
import {
  bastionIdentifierSchema,
  bastionLaunchRequestSchema,
  type BastionCatalogSnapshot,
  type BastionHostSummary,
  type BastionLaunchRequest,
  type BastionLaunchResult,
} from '../../shared/contracts'

type BastionLaunchSource = {
  catalog(): Promise<BastionCatalogSnapshot>
  hosts(systemId: string): Promise<BastionHostSummary[]>
  launch(request: BastionLaunchRequest): Promise<BastionLaunchResult>
}

export function registerBastionLaunchHandlers(source: BastionLaunchSource, sender: WebContents): () => void {
  ipcMain.handle('access-client:bastion:catalog', event => {
    assertTrustedSender(event, sender)
    return source.catalog()
  })
  ipcMain.handle('access-client:bastion:hosts', (event, systemId: unknown) => {
    assertTrustedSender(event, sender)
    return source.hosts(bastionIdentifierSchema.parse(systemId))
  })
  ipcMain.handle('access-client:bastion:launch', (event, request: unknown) => {
    assertTrustedSender(event, sender)
    return source.launch(bastionLaunchRequestSchema.parse(request))
  })

  return () => {
    ipcMain.removeHandler('access-client:bastion:catalog')
    ipcMain.removeHandler('access-client:bastion:hosts')
    ipcMain.removeHandler('access-client:bastion:launch')
  }
}

function assertTrustedSender(event: { sender: WebContents }, sender: WebContents): void {
  if (event.sender !== sender) throw new Error('Untrusted renderer')
}
