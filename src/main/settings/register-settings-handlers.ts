import { ipcMain, type WebContents } from 'electron'
import { rendererModelSettingsInputSchema, type ModelSettingsInput } from '../../shared/validation'
import { validateRegexFenceRules, type RegexFenceRule } from '../agent/regex-fence-service'

type ModelSettingsSource = {
  loadForRenderer(): Promise<unknown>
  saveFromRenderer(input: { endpoint: string; model: string; contextLimit: number; apiKey?: string }): Promise<void>
  prepareForConnectionTest?(input: { endpoint: string; model: string; contextLimit: number; apiKey?: string }): Promise<ModelSettingsInput>
}
type RegexRuleSource = {
  list(): RegexFenceRule[]
  save(rules: RegexFenceRule[]): Promise<void>
}
type ModelConnectionTester = { verify(settings: ModelSettingsInput): Promise<{ model: string }> }

export function registerSettingsHandlers(
  models: ModelSettingsSource,
  rules: RegexRuleSource,
  sender: WebContents,
  tester?: ModelConnectionTester,
): () => void {
  ipcMain.handle('settings:model:get', event => {
    assertTrustedSender(event, sender)
    return models.loadForRenderer()
  })
  ipcMain.handle('settings:model:save', async (event, input: unknown) => {
    assertTrustedSender(event, sender)
    await models.saveFromRenderer(rendererModelSettingsInputSchema.parse(input))
  })
  if (tester && models.prepareForConnectionTest) {
    ipcMain.handle('settings:model:test', async (event, input: unknown) => {
      assertTrustedSender(event, sender)
      return tester.verify(await models.prepareForConnectionTest!(rendererModelSettingsInputSchema.parse(input)))
    })
  }
  ipcMain.handle('settings:regex-rules:get', event => {
    assertTrustedSender(event, sender)
    return rules.list()
  })
  ipcMain.handle('settings:regex-rules:save', async (event, input: unknown) => {
    assertTrustedSender(event, sender)
    await rules.save(validateRegexFenceRules(input))
  })

  return () => {
    ipcMain.removeHandler('settings:model:get')
    ipcMain.removeHandler('settings:model:save')
    if (tester && models.prepareForConnectionTest) ipcMain.removeHandler('settings:model:test')
    ipcMain.removeHandler('settings:regex-rules:get')
    ipcMain.removeHandler('settings:regex-rules:save')
  }
}

function assertTrustedSender(event: { sender: WebContents }, sender: WebContents): void {
  if (event.sender !== sender) throw new Error('Untrusted renderer')
}
