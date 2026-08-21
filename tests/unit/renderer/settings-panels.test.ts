import { describe, expect, it } from 'vitest'
import { applyInitialTheme } from '../../../src/renderer/src/theme'
import { createInitialRenderGate } from '../../../src/renderer/src/render-gate'
import { SETTINGS_TABS } from '../../../src/renderer/src/views/settings-tabs'

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
})
