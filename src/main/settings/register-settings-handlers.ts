import { ipcMain, type WebContents } from 'electron'
import { z } from 'zod'
import { rendererModelProfileInputSchema, rendererModelSettingsInputSchema, modelProfileKindSchema, modelRoutingSchema, type RendererModelSettingsInput } from '../../shared/validation'
import { validateRegexFenceRules, type RegexFenceRule } from '../agent/regex-fence-service'
import type { ModelProfileService } from './model-profile-service'
import type { ModelConnectionTestSettings } from './model-settings-service'
import type { ModelApiKeyEntryService } from './model-api-key-entry-service'

type ModelSettingsSource = {
  loadForRenderer(): Promise<unknown>
  saveFromRenderer(input: RendererModelSettingsInput): Promise<void>
  prepareForConnectionTest?(input: RendererModelSettingsInput): Promise<ModelConnectionTestSettings>
}
type RegexRuleSource = {
  list(): RegexFenceRule[]
  save(rules: RegexFenceRule[]): Promise<void>
}
type ModelConnectionTester = { verify(settings: ModelConnectionTestSettings): Promise<{ model: string }> }

export function registerSettingsHandlers(
  models: ModelSettingsSource,
  rules: RegexRuleSource,
  sender: WebContents,
  tester?: ModelConnectionTester,
  profiles?: Pick<ModelProfileService, 'list' | 'get' | 'save' | 'activate' | 'delete' | 'prepareForConnectionTest' | 'getRouting' | 'setRouting'>,
  apiKeys?: Pick<ModelApiKeyEntryService, 'importFromFile'>,
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

  if (profiles) registerProfileHandlers(profiles, sender, tester, apiKeys)

  return () => {
    ipcMain.removeHandler('settings:model:get')
    ipcMain.removeHandler('settings:model:save')
    if (tester && models.prepareForConnectionTest) ipcMain.removeHandler('settings:model:test')
    ipcMain.removeHandler('settings:regex-rules:get')
    ipcMain.removeHandler('settings:regex-rules:save')
    if (profiles) unregisterProfileHandlers()
  }
}

function registerProfileHandlers(
  profiles: Pick<ModelProfileService, 'list' | 'get' | 'save' | 'activate' | 'delete' | 'prepareForConnectionTest' | 'getRouting' | 'setRouting'>,
  sender: WebContents,
  tester?: ModelConnectionTester,
  apiKeys?: Pick<ModelApiKeyEntryService, 'importFromFile'>,
): void {
  ipcMain.handle('settings:models:list', (event, input: unknown) => {
    assertTrustedSender(event, sender)
    const parsed = input === undefined ? {} : modelProfileListRequestSchema.parse(input)
    return profiles.list(parsed.kind)
  })
  ipcMain.handle('settings:models:get', (event, input: unknown) => {
    assertTrustedSender(event, sender)
    return profiles.get(modelProfileIdSchema.parse(input))
  })
  ipcMain.handle('settings:models:save', async (event, input: unknown) => {
    assertTrustedSender(event, sender)
    return profiles.save(rendererModelProfileInputSchema.parse(input))
  })
  if (apiKeys) {
    ipcMain.handle('settings:models:key:import', async (event, input: unknown) => {
      assertTrustedSender(event, sender)
      const parsed = z.object({ id: modelProfileIdSchema }).strict().parse(input)
      return apiKeys.importFromFile(parsed.id)
    })
  }
  if (tester) {
    ipcMain.handle('settings:models:test', async (event, input: unknown) => {
      assertTrustedSender(event, sender)
      const prepared = await profiles.prepareForConnectionTest(rendererModelProfileInputSchema.parse(input))
      return tester.verify(prepared)
    })
  }
  ipcMain.handle('settings:models:activate', async (event, input: unknown) => {
    assertTrustedSender(event, sender)
    return profiles.activate(modelProfileIdSchema.parse(input))
  })
  ipcMain.handle('settings:models:delete', async (event, input: unknown) => {
    assertTrustedSender(event, sender)
    const parsed = modelProfileDeleteRequestSchema.parse(input)
    await profiles.delete(parsed.id, { replacementId: parsed.replacementId, allowNoActive: parsed.allowNoActive })
  })
  ipcMain.handle('settings:models:routing:get', event => {
    assertTrustedSender(event, sender)
    return profiles.getRouting()
  })
  ipcMain.handle('settings:models:routing:set', async (event, input: unknown) => {
    assertTrustedSender(event, sender)
    return profiles.setRouting(modelRoutingSchema.parse(input))
  })
}

function unregisterProfileHandlers(): void {
  ipcMain.removeHandler('settings:models:list')
  ipcMain.removeHandler('settings:models:get')
  ipcMain.removeHandler('settings:models:save')
  ipcMain.removeHandler('settings:models:test')
  ipcMain.removeHandler('settings:models:key:import')
  ipcMain.removeHandler('settings:models:activate')
  ipcMain.removeHandler('settings:models:delete')
  ipcMain.removeHandler('settings:models:routing:get')
  ipcMain.removeHandler('settings:models:routing:set')
}

const modelProfileIdSchema = z.string().trim().min(1).max(128)
// IPC IDs are parsed separately from profile kind so malformed values never
// reach the service. Keeping these schemas local avoids widening shared DTOs.
const modelProfileListRequestSchema = z.object({ kind: modelProfileKindSchema.optional() }).strict()
const modelProfileDeleteRequestSchema = z.object({
  id: z.string().trim().min(1).max(128),
  replacementId: z.string().trim().min(1).max(128).nullable().optional(),
  allowNoActive: z.boolean().optional(),
}).strict().superRefine((request, context) => {
  if (request.replacementId === null && request.allowNoActive !== true) {
    context.addIssue({ code: 'custom', path: ['allowNoActive'], message: 'Explicit no-route authorization is required' })
  }
})

function assertTrustedSender(event: { sender: WebContents }, sender: WebContents): void {
  if (event.sender !== sender) throw new Error('Untrusted renderer')
}
