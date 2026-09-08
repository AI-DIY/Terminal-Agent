import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createDefaultWorkbenchPreferences } from '../../../src/shared/contracts'
import { createTerminalAgentApi } from '../../../src/preload/api'
import {
  createLayoutPreferencesStore,
  createDelayedLayoutSaver,
  clampSidebarWidth,
  keyboardSidebarWidth,
  SHELL_FONT_SIZE_PRESETS,
  SHELL_ROW_HEIGHT_PRESETS,
  shellGridStyle,
} from '../../../src/renderer/src/stores/layout-preferences'

describe('renderer layout preferences', () => {
  it('provides static pearl and graphite startup backgrounds consumed by the restored data theme', () => {
    const html = readFileSync(new URL('../../../src/renderer/index.html', import.meta.url), 'utf8')
    expect(html).toContain(':root[data-theme="pearl"]')
    expect(html).toContain(':root[data-theme="graphite"]')
    expect(html).toContain(':root[data-theme="imperial-gold"]')
    expect(html).toContain(':root[data-theme="sakura-pink"]')
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

  it('adjusts keyboard separators in the visual direction and clamps both boundaries', () => {
    expect(keyboardSidebarWidth('left', 210, 'ArrowLeft')).toBe(210)
    expect(keyboardSidebarWidth('left', 359, 'ArrowRight')).toBe(360)
    expect(keyboardSidebarWidth('right', 899, 'ArrowLeft')).toBe(900)
    expect(keyboardSidebarWidth('right', 340, 'ArrowRight')).toBe(340)
    expect(clampSidebarWidth('right', 9_000)).toBe(900)
    expect(keyboardSidebarWidth('left', 222, 'Enter')).toBeNull()
  })

  it('uses persistent terminal font sizes and percentage-based row heights without an individual maximize mode', () => {
    expect(SHELL_ROW_HEIGHT_PRESETS).toEqual([
      { label: '紧凑', value: 48 },
      { label: '标准', value: 64 },
      { label: '宽松', value: 80 },
      { label: '占满', value: 100 },
    ])
    expect(SHELL_FONT_SIZE_PRESETS).toEqual([
      { label: '小', value: 11 },
      { label: '标准', value: 12 },
      { label: '大', value: 13 },
    ])
    expect(createDefaultWorkbenchPreferences()).toMatchObject({ rowHeightPercent: 100, fontSize: 13 })
    expect(shellGridStyle(3, 100)).toEqual({
      gridTemplateColumns: 'repeat(3, minmax(210px, 1fr))',
      gridAutoRows: '100%',
    })
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}
