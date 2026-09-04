import { describe, expect, it } from 'vitest'
import { applyInitialTheme } from '../../../src/renderer/src/theme'
import { createInitialRenderGate } from '../../../src/renderer/src/render-gate'
import { SETTINGS_TABS } from '../../../src/renderer/src/views/settings-tabs'
import { readFileSync } from 'node:fs'

describe('settings panels', () => {
  it('keeps prototype navigation order with host memory ready', () => {
    expect(SETTINGS_TABS.map(tab => tab.id)).toEqual(['routing', 'llm', 'vlm', 'fence', 'memory', 'appearance', 'sso'])
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

  it('uses the same font-size and percentage layout presets in Appearance and Shell workspace', () => {
    const appearance = readFileSync(new URL('../../../src/renderer/src/components/settings/AppearanceSettings.vue', import.meta.url), 'utf8')
    const canvas = readFileSync(new URL('../../../src/renderer/src/components/workbench/ShellCanvas.vue', import.meta.url), 'utf8')

    expect(appearance).toContain('SHELL_ROW_HEIGHT_OPTIONS')
    expect(appearance).toContain('SHELL_FONT_SIZE_OPTIONS')
    expect(appearance).toContain('单行高度（占工作区）')
    expect(appearance).toContain('SSH 字体大小')
    expect(canvas).toContain('SHELL_ROW_HEIGHT_OPTIONS')
    expect(canvas).toContain('SHELL_FONT_SIZE_OPTIONS')
    expect(canvas).toContain('单行高度（占工作区）')
    expect(canvas).toContain('SSH 字体大小')
  })

  it('themes the settings and host-memory surfaces through shared tokens', () => {
    const settings = readFileSync(new URL('../../../src/renderer/src/views/SettingsView.vue', import.meta.url), 'utf8')
    const memory = readFileSync(new URL('../../../src/renderer/src/components/settings/HostMemorySettings.vue', import.meta.url), 'utf8')
    const settingsRule = /\.settings\s*\{([^}]*)\}/.exec(settings)?.[1] ?? ''
    const settingsTopRule = /\.settings-top\s*\{([^}]*)\}/.exec(settings)?.[1] ?? ''
    const backButtonRule = /\.back-button\s*\{([^}]*)\}/.exec(settings)?.[1] ?? ''

    expect(settingsRule).toContain('grid-template-rows: 56px minmax(0, 1fr);')
    expect(settingsRule).toContain('--window-controls-inset: max(138px, calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, calc(100vw - 138px))));')
    expect(settingsRule).toContain('background: var(--surface);')
    expect(settingsTopRule).toContain('padding: 0 calc(16px + var(--window-controls-inset)) 0 16px;')
    expect(settingsTopRule).toContain('-webkit-app-region: drag;')
    expect(settingsTopRule).toContain('background: var(--chrome);')
    expect(backButtonRule).toContain('-webkit-app-region: no-drag;')
    expect(memory).toContain('memory-status')
    expect(memory).toContain('scope-card')
  })

  it('left-aligns all model profile text inside selectable connection rows', () => {
    const profiles = readFileSync(new URL('../../../src/renderer/src/components/settings/ModelProfileManager.vue', import.meta.url), 'utf8')
    const profileSelectRule = /\.profile-select\s*\{([^}]*)\}/.exec(profiles)?.[1] ?? ''
    const profileTextRule = /\.profile-select strong,\.profile-select span,\.profile-select small\s*\{([^}]*)\}/.exec(profiles)?.[1] ?? ''

    expect(profileSelectRule).toContain('align-content: start;')
    expect(profileSelectRule).toContain('justify-content: start;')
    expect(profileSelectRule).toContain('justify-items: start;')
    expect(profileSelectRule).toContain('width: 100%;')
    expect(profileSelectRule).toContain('text-align: left;')
    expect(profileTextRule).toContain('width: 100%;')
    expect(profileTextRule).toContain('text-align: left;')
  })

  it('includes the SSO panel and the mandated disabled warning', () => {
    const tabs = readFileSync(new URL('../../../src/renderer/src/views/settings-tabs.ts', import.meta.url), 'utf8')
    const panel = readFileSync(new URL('../../../src/renderer/src/components/settings/SsoSettings.vue', import.meta.url), 'utf8')
    const settings = readFileSync(new URL('../../../src/renderer/src/views/SettingsView.vue', import.meta.url), 'utf8')

    expect(tabs).toContain("id: 'sso'")
    expect(panel).toContain('启用单点登录门控')
    expect(panel).toContain('登录页 URL')
    expect(panel).toContain('平台 URL 匹配方式')
    expect(panel).toContain('平台 URL / 正则')
    expect(panel).toContain('用户信息接口 URL 匹配方式')
    expect(panel).toContain('用户信息接口 URL / 正则')
    expect(panel).toContain('工号字段路径')
    expect(panel).toContain('姓名字段路径')
    expect(panel).toContain('关闭登录门控后，应用将以未登录状态运行，内置技能不可使用。')
    expect(panel).toContain('Object Path')
    expect(panel).toContain('保存草稿')
    expect(panel).toContain('保存并继续')
    expect(panel).toContain('保存并进入工作台')
    expect(panel).toContain('<option value="exact">')
    expect(panel).toContain('<option value="regex">')
    expect(settings).toContain('initialTab?: SettingsTabId')
    expect(settings).toContain('lockNavigation?: boolean')
    expect(settings).toContain('normalizeTab(props.initialTab)')
  })
})
