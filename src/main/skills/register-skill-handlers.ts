import { ipcMain, type WebContents } from 'electron'
import { SkillService } from './skill-service'
import {
  skillCatalogSchema,
  skillCommandRequestSchema,
  skillFileReadRequestSchema,
  skillLoadRequestSchema,
  skillSetEnabledRequestSchema,
  type SkillCommandRequest,
} from '../../shared/skill-contracts'

const channels = [
  'skills:list',
  'skills:refresh',
  'skills:set-enabled',
  'skills:load',
  'skills:read-file',
  'skills:run',
  'skills:cancel',
] as const

export type SkillHandlerOptions = {
  /** Existing SSO gate; command/read operations fail closed when absent. */
  skillAuthorization?: { isAuthenticated(): boolean }
}

/** Register the renderer boundary for dynamic standard Skills. */
export function registerSkillHandlers(
  service: Pick<SkillService, 'list' | 'refresh' | 'setEnabled' | 'load' | 'readFile' | 'runCommand' | 'cancelCommand' | 'onChanged'>,
  trustedSender: WebContents,
  options: SkillHandlerOptions = {},
): () => void {
  const invocations = new Map<string, AbortController>()
  const authenticated = (): boolean => {
    try { return options.skillAuthorization?.isAuthenticated() === true } catch { return false }
  }
  const requireAuthentication = (): void => {
    if (!authenticated()) throw new Error('未登录状态不能使用技能')
  }

  ipcMain.handle('skills:list', async event => {
    assertTrustedSender(event, trustedSender)
    // Listing is safe before login and allows the page to explain why actions
    // are unavailable.  The existing navigation gate still hides this view.
    return skillCatalogSchema.parse(await service.list())
  })
  ipcMain.handle('skills:refresh', async event => {
    assertTrustedSender(event, trustedSender)
    return skillCatalogSchema.parse(await service.refresh())
  })
  ipcMain.handle('skills:set-enabled', async (event, input: unknown) => {
    assertTrustedSender(event, trustedSender)
    requireAuthentication()
    return skillCatalogSchema.parse(await service.setEnabled(skillSetEnabledRequestSchema.parse(input)))
  })
  ipcMain.handle('skills:load', async (event, input: unknown) => {
    assertTrustedSender(event, trustedSender)
    requireAuthentication()
    return service.load(skillLoadRequestSchema.parse(input))
  })
  ipcMain.handle('skills:read-file', async (event, input: unknown) => {
    assertTrustedSender(event, trustedSender)
    requireAuthentication()
    return service.readFile(skillFileReadRequestSchema.parse(input))
  })
  ipcMain.handle('skills:run', async (event, input: unknown) => {
    assertTrustedSender(event, trustedSender)
    requireAuthentication()
    const request = skillCommandRequestSchema.parse(input)
    const controller = new AbortController()
    invocations.set(request.invocationId, controller)
    try {
      return await service.runCommand(request, controller.signal)
    } finally {
      if (invocations.get(request.invocationId) === controller) invocations.delete(request.invocationId)
    }
  })
  ipcMain.handle('skills:cancel', (event, invocationId: unknown) => {
    assertTrustedSender(event, trustedSender)
    requireAuthentication()
    if (typeof invocationId !== 'string') return false
    const controller = invocations.get(invocationId)
    if (controller) controller.abort()
    return service.cancelCommand(invocationId) || Boolean(controller)
  })

  const unsubscribe = service.onChanged(catalog => {
    if (!trustedSender.isDestroyed()) trustedSender.send('skills:changed', skillCatalogSchema.parse(catalog))
  })
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    unsubscribe()
    for (const controller of invocations.values()) controller.abort()
    invocations.clear()
    for (const channel of channels) ipcMain.removeHandler(channel)
  }
}

function assertTrustedSender(event: { sender: WebContents }, trustedSender: WebContents): void {
  if (event.sender !== trustedSender) throw new Error('Untrusted renderer')
}

// Keep this import-only alias for test/adaptor code that wants to describe a
// command without importing the whole service module.
export type { SkillCommandRequest }
