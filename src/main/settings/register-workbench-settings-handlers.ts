import { ipcMain, type WebContents } from 'electron'
import {
  workbenchLayoutPatchSchema,
  workbenchThemeSchema,
  type WorkbenchLayoutPatch,
  type WorkbenchPreferences,
  type WorkbenchTheme,
} from '../../shared/contracts'

const channels = [
  'settings:workbench:ready',
  'settings:workbench:get',
  'settings:workbench:save-layout',
  'settings:workbench:save-theme',
] as const

type WorkbenchSettingsSource = {
  load(): Promise<WorkbenchPreferences>
  saveLayout(input: WorkbenchLayoutPatch): Promise<WorkbenchPreferences>
  saveTheme(theme: WorkbenchTheme): Promise<WorkbenchPreferences>
}

export function registerWorkbenchSettingsHandlers(
  service: WorkbenchSettingsSource,
  trustedSender: WebContents,
  onRendererReady: () => void,
  onThemeSaved: (theme: WorkbenchTheme) => void = () => undefined,
): () => void {
  ipcMain.handle('settings:workbench:ready', event => {
    assertTrustedSender(event, trustedSender)
    onRendererReady()
  })
  ipcMain.handle('settings:workbench:get', event => {
    assertTrustedSender(event, trustedSender)
    return service.load()
  })
  ipcMain.handle('settings:workbench:save-layout', (event, input: unknown) => {
    assertTrustedSender(event, trustedSender)
    return service.saveLayout(workbenchLayoutPatchSchema.parse(input))
  })
  ipcMain.handle('settings:workbench:save-theme', async (event, input: unknown) => {
    assertTrustedSender(event, trustedSender)
    const preferences = await service.saveTheme(workbenchThemeSchema.parse(input))
    onThemeSaved(preferences.theme)
    return preferences
  })

  return () => {
    for (const channel of channels) ipcMain.removeHandler(channel)
  }
}

function assertTrustedSender(event: { sender: WebContents }, trustedSender: WebContents): void {
  if (event.sender !== trustedSender) throw new Error('Untrusted renderer')
}
