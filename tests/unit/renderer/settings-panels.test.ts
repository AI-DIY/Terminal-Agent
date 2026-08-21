import { describe, expect, it } from 'vitest'
import { applyInitialTheme } from '../../../src/renderer/src/theme'
import { createInitialRenderGate } from '../../../src/renderer/src/render-gate'
import { SETTINGS_TABS } from '../../../src/renderer/src/views/settings-tabs'
import { readFileSync } from 'node:fs'

describe('settings panels', () => {
  it('keeps prototype navigation order with host memory ready', () => {
    expect(SETTINGS_TABS.map(tab => tab.id)).toEqual(['routing', 'llm', 'vlm', 'fence', 'memory', 'appearance'])
    expect(SETTINGS_TABS.find(tab => tab.id === 'memory')?.status).toBe('ready')
  })

  it('applies the persisted theme before the first renderer mount', () => {
    const root = { dataset: {} as Record<string, string> }
    applyInitialTheme(root, 'graphite')
    expect(root.dataset.theme).toBe('graphite')
  })

  it('keeps the document hidden until persisted appearance is applied', () => {
    const root = { dataset: {} as Record<string, string> }
    const gate = createInitialRenderGate(root)

    expect(root.dataset.renderReady).toBe('false')
    expect(gate.isReady()).toBe(false)
    gate.release()
    expect(root.dataset.renderReady).toBe('true')
    expect(gate.isReady()).toBe(true)
  })

  it('uses the same percentage layout presets in Appearance and Shell workspace', () => {
    const appearance = readFileSync(new URL('../../../src/renderer/src/components/settings/AppearanceSettings.vue', import.meta.url), 'utf8')
    const canvas = readFileSync(new URL('../../../src/renderer/src/components/workbench/ShellCanvas.vue', import.meta.url), 'utf8')

    expect(appearance).toContain('SHELL_ROW_HEIGHT_PRESETS')
    expect(appearance).toContain('单行高度（占工作区）')
    expect(canvas).toContain('SHELL_ROW_HEIGHT_PRESETS')
    expect(canvas).toContain('单行高度（占工作区）')
  })

  it('themes the settings and host-memory surfaces for pearl and graphite', () => {
    const settings = readFileSync(new URL('../../../src/renderer/src/views/SettingsView.vue', import.meta.url), 'utf8')
    const memory = readFileSync(new URL('../../../src/renderer/src/components/settings/HostMemorySettings.vue', import.meta.url), 'utf8')

    expect(settings).toContain(':global(:root[data-theme="graphite"])')
    expect(memory).toContain('memory-status')
    expect(memory).toContain('scope-card')
  })
})
