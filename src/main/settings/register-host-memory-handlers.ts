import { ipcMain, type WebContents } from 'electron'
import { hostMemoryConsentTokenSchema, hostMemoryHostnameSchema, hostMemoryRecordUpdateSchema, hostMemorySettingsSchema, type HostMemoryDisclosure, type HostMemoryRecord, type HostMemorySettings } from '../../shared/contracts'
import { normalizeHostname } from '../facts/host-facts-service'
import type { HostMemoryAuthorizationUndo } from './host-memory-settings-service'

type HostMemorySettingsSource = { load(): Promise<HostMemorySettings>; save(input: HostMemorySettings): Promise<HostMemorySettings> }
type HostFactsSource = { list(): Promise<HostMemoryRecord[]>; snapshot?(hostname: string): Promise<HostMemoryRecord | null>; update(hostname: string, record: HostMemoryRecord): Promise<HostMemoryRecord>; restore?(hostname: string, record: HostMemoryRecord): Promise<HostMemoryRecord>; remove(hostname: string): Promise<void> }
type HostMemoryConsentController = { acknowledge(token: string): Promise<void>; dismiss(token: string): Promise<void>; revokeHost?(hostIdentity: string): Promise<HostMemoryAuthorizationUndo | undefined>; restoreHostAuthorization?(undo: HostMemoryAuthorizationUndo): Promise<void>; pending?(): HostMemoryDisclosure[] }
const channels = ['settings:host-memory:get', 'settings:host-memory:save', 'settings:host-memory:list', 'settings:host-memory:get-host', 'settings:host-memory:update', 'settings:host-memory:remove', 'host-memory:acknowledge', 'host-memory:dismiss', 'host-memory:pending'] as const

export function registerHostMemoryHandlers(settings: HostMemorySettingsSource, facts: HostFactsSource, trustedSender: WebContents, consent?: HostMemoryConsentController): () => void {
  const removalTails = new Map<string, Promise<void>>()
  ipcMain.handle('settings:host-memory:get', event => { assertTrustedSender(event, trustedSender); return settings.load() })
  ipcMain.handle('settings:host-memory:save', (event, input: unknown) => { assertTrustedSender(event, trustedSender); return settings.save(hostMemorySettingsSchema.parse(input)) })
  ipcMain.handle('settings:host-memory:list', event => { assertTrustedSender(event, trustedSender); return facts.list() })
  ipcMain.handle('settings:host-memory:get-host', (event, hostname: unknown) => { assertTrustedSender(event, trustedSender); return facts.snapshot?.(hostMemoryHostnameSchema.parse(hostname)) ?? null })
  ipcMain.handle('settings:host-memory:update', (event, input: unknown) => { assertTrustedSender(event, trustedSender); const { hostname, record } = hostMemoryRecordUpdateSchema.parse(input); return facts.update(hostname, record) })
  ipcMain.handle('settings:host-memory:remove', async (event, hostname: unknown) => {
    assertTrustedSender(event, trustedSender)
    const parsed = normalizeHostname(hostMemoryHostnameSchema.parse(hostname))
    const previous = removalTails.get(parsed) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>(resolve => { release = resolve })
    removalTails.set(parsed, current)
    await previous
    try {
      const undo = await consent?.revokeHost?.(parsed)
      try {
        await facts.remove(parsed)
      } catch (error) {
        if (undo && consent?.restoreHostAuthorization) {
          try {
            await consent.restoreHostAuthorization(undo)
          } catch (rollbackError) {
            throw new AggregateError([error, rollbackError], 'Failed to keep host memory removal consistent', { cause: rollbackError })
          }
        }
        throw error
      }
    } finally {
      release()
      if (removalTails.get(parsed) === current) removalTails.delete(parsed)
    }
  })
  ipcMain.handle('host-memory:acknowledge', async (event, token: unknown) => {
    assertTrustedSender(event, trustedSender)
    if (!consent) throw new Error('Host memory consent is unavailable')
    await consent.acknowledge(hostMemoryConsentTokenSchema.parse(token))
  })
  ipcMain.handle('host-memory:dismiss', async (event, token: unknown) => { assertTrustedSender(event, trustedSender); if (!consent) throw new Error('Host memory consent is unavailable'); await consent.dismiss(hostMemoryConsentTokenSchema.parse(token)) })
  ipcMain.handle('host-memory:pending', event => { assertTrustedSender(event, trustedSender); return consent?.pending?.() ?? [] })
  return () => { for (const channel of channels) ipcMain.removeHandler(channel) }
}
function assertTrustedSender(event: { sender: WebContents }, trustedSender: WebContents): void { if (event.sender !== trustedSender) throw new Error('Untrusted renderer') }
