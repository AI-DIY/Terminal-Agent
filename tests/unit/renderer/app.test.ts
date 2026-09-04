import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

describe('renderer auth gate', () => {
  it('maps every SSO state to one root surface and protects skills navigation', () => {
    const source = readFileSync(new URL('../../../src/renderer/src/App.vue', import.meta.url), 'utf8')

    for (const state of ['configuration-required', 'login-required', 'authenticating', 'authenticated', 'login-disabled', 'error']) {
      expect(source).toContain(state)
    }
    expect(source).toContain('getSsoStore()')
    expect(source).toContain('<LoginView')
    expect(source).toContain('initial-tab="sso"')
    expect(source).toContain(':lock-navigation="true"')
    expect(source).toContain('skillsAvailable')
    expect(source).toContain('return')
  })

  it('keeps locked settings back navigation inert and includes user-facing login errors', () => {
    const settings = readFileSync(new URL('../../../src/renderer/src/views/SettingsView.vue', import.meta.url), 'utf8')
    const login = readFileSync(new URL('../../../src/renderer/src/views/LoginView.vue', import.meta.url), 'utf8')

    expect(settings).toContain('lockNavigation')
    expect(settings).toContain('!props.lockNavigation')
    expect(login).toContain('登录窗口已关闭')
    expect(login).toContain('role="alert"')
  })
})
