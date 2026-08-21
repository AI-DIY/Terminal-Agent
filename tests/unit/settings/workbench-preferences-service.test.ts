import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDefaultWorkbenchPreferences,
  workbenchPreferencesDocumentSchema,
  workbenchPreferencesSchema,
} from '../../../src/shared/contracts'
import { WorkbenchPreferencesService } from '../../../src/main/settings/workbench-preferences-service'

const ipc = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, input?: unknown) => unknown>(),
  handle: vi.fn((channel: string, handler: (event: unknown, input?: unknown) => unknown) => {
    ipc.handlers.set(channel, handler)
  }),
  removeHandler: vi.fn((channel: string) => { ipc.handlers.delete(channel) }),
}))

vi.mock('electron', () => ({ ipcMain: { handle: ipc.handle, removeHandler: ipc.removeHandler } }))

const temporaryDirectories: string[] = []

afterEach(async () => {
  ipc.handlers.clear()
  ipc.handle.mockClear()
  ipc.removeHandler.mockClear()
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('workbench preference validation', () => {
  it('accepts the V18 layout vocabulary and rejects out-of-range widths', () => {
    const valid = {
      theme: 'pearl' as const,
      leftWidth: 222,
      rightWidth: 390,
      leftCollapsed: false,
      rightCollapsed: false,
      visibleCount: 3,
      columns: 3,
      rowHeight: 330 as const,
    }

    expect(workbenchPreferencesSchema.parse(valid)).toMatchObject({ visibleCount: 3, columns: 3 })
    expect(() => workbenchPreferencesSchema.parse({ ...valid, leftWidth: 9_000 })).toThrow()
  })

  it.each([1, 2, 3, 4])('accepts %i visible panels and columns', value => {
    const defaults = createDefaultWorkbenchPreferences()
    expect(workbenchPreferencesSchema.parse({ ...defaults, visibleCount: value, columns: value })).toMatchObject({
      visibleCount: value,
      columns: value,
    })
  })

  it.each([260, 330, 410] as const)('accepts the documented %i row height', rowHeight => {
    expect(workbenchPreferencesSchema.parse({ ...createDefaultWorkbenchPreferences(), rowHeight }).rowHeight).toBe(rowHeight)
  })
})

describe('WorkbenchPreferencesService', () => {
  it('persists the versioned preference envelope and returns flattened renderer values', async () => {
    const { service, filePath } = await createService()

    await expect(service.load()).resolves.toEqual(createDefaultWorkbenchPreferences())
    await expect(service.saveLayout({ leftWidth: 248, visibleCount: 4, columns: 2, rowHeight: 410 })).resolves.toMatchObject({
      theme: 'pearl',
      leftWidth: 248,
      rightWidth: 390,
      visibleCount: 4,
      columns: 2,
      rowHeight: 410,
    })

    const persisted = workbenchPreferencesDocumentSchema.parse(JSON.parse(await readFile(filePath, 'utf8')))
    expect(persisted).toEqual({
      version: 1,
      appearance: { theme: 'pearl' },
      layout: {
        leftWidth: 248,
        rightWidth: 390,
        leftCollapsed: false,
        rightCollapsed: false,
        visibleCount: 4,
        columns: 2,
        rowHeight: 410,
      },
      routing: {},
      memory: {},
    })
  })

  it('merges only validated layout fields and leaves the last authoritative value intact after rejection', async () => {
    const { service } = await createService()
    await service.saveLayout({ rightCollapsed: true })

    await expect(service.saveLayout({ leftWidth: 9_000 })).rejects.toThrow()
    await expect(service.saveLayout({ password: 'must-not-persist' })).rejects.toThrow()
    await expect(service.load()).resolves.toEqual({
      ...createDefaultWorkbenchPreferences(),
      rightCollapsed: true,
    })
  })

  it('persists only a validated V18 theme name', async () => {
    const { service } = await createService()

    await expect(service.saveTheme('graphite')).resolves.toMatchObject({ theme: 'graphite' })
    await expect(service.saveTheme('dark')).rejects.toThrow()
    await expect(service.load()).resolves.toMatchObject({ theme: 'graphite' })
  })
})

describe('workbench preference IPC', () => {
  it('validates a trusted renderer and removes every registered handler', async () => {
    const { registerWorkbenchSettingsHandlers } = await import('../../../src/main/settings/register-workbench-settings-handlers')
    const sender = { id: 1 }
    const service = {
      load: vi.fn().mockResolvedValue(createDefaultWorkbenchPreferences()),
      saveLayout: vi.fn().mockResolvedValue({ ...createDefaultWorkbenchPreferences(), leftWidth: 260 }),
      saveTheme: vi.fn().mockResolvedValue({ ...createDefaultWorkbenchPreferences(), theme: 'graphite' }),
    }
    const onRendererReady = vi.fn()
    const dispose = registerWorkbenchSettingsHandlers(service, sender as never, onRendererReady)

    await ipc.handlers.get('settings:workbench:ready')?.({ sender })
    await expect(ipc.handlers.get('settings:workbench:get')?.({ sender })).resolves.toEqual(createDefaultWorkbenchPreferences())
    await expect(ipc.handlers.get('settings:workbench:save-layout')?.({ sender }, { leftWidth: 260 })).resolves.toMatchObject({ leftWidth: 260 })
    await expect(ipc.handlers.get('settings:workbench:save-theme')?.({ sender }, 'graphite')).resolves.toMatchObject({ theme: 'graphite' })
    expect(service.saveLayout).toHaveBeenCalledWith({ leftWidth: 260 })
    expect(service.saveTheme).toHaveBeenCalledWith('graphite')
    expect(onRendererReady).toHaveBeenCalledOnce()

    expect(() => ipc.handlers.get('settings:workbench:ready')?.({ sender: { id: 2 } })).toThrow('Untrusted renderer')
    expect(() => ipc.handlers.get('settings:workbench:get')?.({ sender: { id: 2 } })).toThrow('Untrusted renderer')
    expect(() => ipc.handlers.get('settings:workbench:save-layout')?.({ sender }, { leftWidth: 9_000 })).toThrow()
    expect(() => ipc.handlers.get('settings:workbench:save-theme')?.({ sender }, 'dark')).toThrow()

    dispose()
    expect(ipc.removeHandler).toHaveBeenCalledTimes(4)
  })
})

async function createService(): Promise<{ service: WorkbenchPreferencesService; filePath: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-workbench-preferences-'))
  temporaryDirectories.push(directory)
  const filePath = join(directory, 'workbench-preferences.json')
  return { service: new WorkbenchPreferencesService(filePath), filePath }
}
