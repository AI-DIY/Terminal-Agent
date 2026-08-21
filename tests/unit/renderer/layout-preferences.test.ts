import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createDefaultWorkbenchPreferences } from '../../../src/shared/contracts'
import { createTerminalAgentApi } from '../../../src/preload/api'
import {
  createLayoutPreferencesStore,
  createDelayedLayoutSaver,
  createShellCanvasState,
  keyboardSidebarWidth,
  shellPanePresentations,
} from '../../../src/renderer/src/stores/layout-preferences'

describe('renderer layout preferences', () => {
  it('provides static pearl and graphite startup backgrounds consumed by the restored data theme', () => {
    const html = readFileSync(new URL('../../../src/renderer/index.html', import.meta.url), 'utf8')
    expect(html).toContain(':root[data-theme="pearl"]')
    expect(html).toContain(':root[data-theme="graphite"]')
    expect(html).toContain('color-scheme: dark')
  })

  it('coalesces repeated width changes before persisting the newest patch', async () => {
    vi.useFakeTimers()
    const save = vi.fn().mockResolvedValue(undefined)
    const saver = createDelayedLayoutSaver(save, 180)

    saver.queue({ leftWidth: 230 })
    saver.queue({ leftWidth: 240 })
    saver.queue({ leftCollapsed: false })
    expect(save).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(179)
    expect(save).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(save).toHaveBeenCalledOnce()
    expect(save).toHaveBeenCalledWith({ leftWidth: 240, leftCollapsed: false })
    vi.useRealTimers()
  })

  it('uses a frozen typed preload namespace for workbench persistence', async () => {
    const ipc = { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }
    const api = createTerminalAgentApi(ipc)
    const patch = { visibleCount: 2, columns: 1 }

    expect(Object.isFrozen(api.settings.appearance)).toBe(true)
    await api.settings.appearance.ready()
    await api.settings.appearance.get()
    await api.settings.appearance.saveLayout(patch)
    await api.settings.appearance.saveTheme('graphite')

    expect(ipc.invoke).toHaveBeenNthCalledWith(1, 'settings:workbench:ready')
    expect(ipc.invoke).toHaveBeenNthCalledWith(2, 'settings:workbench:get')
    expect(ipc.invoke).toHaveBeenNthCalledWith(3, 'settings:workbench:save-layout', patch)
    expect(ipc.invoke).toHaveBeenNthCalledWith(4, 'settings:workbench:save-theme', 'graphite')
  })

  it('loads once and accepts normalized authoritative values from main after saving', async () => {
    const authoritative = { ...createDefaultWorkbenchPreferences(), leftWidth: 275, visibleCount: 4 as const }
    const api = {
      get: vi.fn().mockResolvedValue(createDefaultWorkbenchPreferences()),
      saveLayout: vi.fn().mockResolvedValue(authoritative),
      saveTheme: vi.fn(),
    }
    const store = createLayoutPreferencesStore(api)

    await Promise.all([store.load(), store.load()])
    expect(api.get).toHaveBeenCalledOnce()

    await store.saveLayout({ leftWidth: 274, visibleCount: 4 })
    expect(api.saveLayout).toHaveBeenCalledWith({ leftWidth: 274, visibleCount: 4 })
    expect(store.state.leftWidth).toBe(275)
    expect(store.state.visibleCount).toBe(4)
  })

  it('does not let an older authoritative save response overwrite a newer local preview', async () => {
    const first = deferred<ReturnType<typeof createDefaultWorkbenchPreferences>>()
    const second = deferred<ReturnType<typeof createDefaultWorkbenchPreferences>>()
    const api = {
      get: vi.fn().mockResolvedValue(createDefaultWorkbenchPreferences()),
      saveLayout: vi.fn()
        .mockImplementationOnce(() => first.promise)
        .mockImplementationOnce(() => second.promise),
      saveTheme: vi.fn(),
    }
    const store = createLayoutPreferencesStore(api)
    await store.load()

    store.previewLayout({ rightWidth: 400 })
    const firstSave = store.saveLayout({ rightWidth: 400 })
    store.previewLayout({ rightWidth: 410 })
    const secondSave = store.saveLayout({ rightWidth: 410 })
    first.resolve({ ...createDefaultWorkbenchPreferences(), rightWidth: 400 })
    await firstSave

    expect(store.state.rightWidth).toBe(410)
    second.resolve({ ...createDefaultWorkbenchPreferences(), rightWidth: 410 })
    await secondSave
    expect(store.state.rightWidth).toBe(410)
  })

  it('keeps a newer preview when an older save resolves before the preview is persisted', async () => {
    const first = deferred<ReturnType<typeof createDefaultWorkbenchPreferences>>()
    const api = {
      get: vi.fn().mockResolvedValue(createDefaultWorkbenchPreferences()),
      saveLayout: vi.fn().mockImplementationOnce(() => first.promise),
      saveTheme: vi.fn(),
    }
    const store = createLayoutPreferencesStore(api)
    await store.load()

    store.previewLayout({ leftWidth: 250 })
    const firstSave = store.saveLayout({ leftWidth: 250 })
    store.previewLayout({ leftWidth: 270 })
    first.resolve({ ...createDefaultWorkbenchPreferences(), leftWidth: 250 })
    await firstSave

    expect(store.state.leftWidth).toBe(270)
  })

  it('restores pearl or graphite before exposing a ready state', async () => {
    const api = {
      get: vi.fn().mockResolvedValue({ ...createDefaultWorkbenchPreferences(), theme: 'graphite' as const }),
      saveLayout: vi.fn(),
      saveTheme: vi.fn(),
    }
    const store = createLayoutPreferencesStore(api)

    expect(store.state.ready).toBe(false)
    await store.load()
    expect(store.state).toMatchObject({ ready: true, theme: 'graphite' })
  })

  it('maximizes and restores without changing the prior pane grid', () => {
    const canvas = createShellCanvasState()
    const before = ['s1', 's2', 's3']

    canvas.toggleMaximize('s2')
    expect(canvas.maximizedSessionId.value).toBe('s2')
    expect(shellPanePresentations(before, before, canvas.maximizedSessionId.value)).toEqual([
      { sessionId: 's1', visible: false },
      { sessionId: 's2', visible: true },
      { sessionId: 's3', visible: false },
    ])

    canvas.restore()
    expect(canvas.maximizedSessionId.value).toBeNull()
    expect(shellPanePresentations(before, before, canvas.maximizedSessionId.value).map(item => item.visible)).toEqual([true, true, true])
  })

  it('keeps hidden terminal entries mounted in the pane presentation model', () => {
    expect(shellPanePresentations(['s1', 's2', 's3', 's4'], ['s1', 's3'], null)).toEqual([
      { sessionId: 's1', visible: true },
      { sessionId: 's2', visible: false },
      { sessionId: 's3', visible: true },
      { sessionId: 's4', visible: false },
    ])
  })

  it('adjusts keyboard separators in the visual direction and clamps both boundaries', () => {
    expect(keyboardSidebarWidth('left', 210, 'ArrowLeft')).toBe(210)
    expect(keyboardSidebarWidth('left', 359, 'ArrowRight')).toBe(360)
    expect(keyboardSidebarWidth('right', 519, 'ArrowLeft')).toBe(520)
    expect(keyboardSidebarWidth('right', 340, 'ArrowRight')).toBe(340)
    expect(keyboardSidebarWidth('left', 222, 'Enter')).toBeNull()
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}
