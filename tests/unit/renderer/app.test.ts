import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { canOpenSkills, resolveRootSurface } from '../../../src/renderer/src/sso-login-controller'

describe('renderer auth gate', () => {
  it('maps every SSO state to one root surface and protects skills navigation', () => {
    expect(resolveRootSurface('configuration-required')).toBe('configuration')
    for (const state of ['login-required', 'authenticating', 'error'] as const) expect(resolveRootSurface(state)).toBe('login')
    for (const state of ['authenticated', 'login-disabled'] as const) expect(resolveRootSurface(state)).toBe('workbench')
    expect(canOpenSkills('authenticated')).toBe(true)
    expect(canOpenSkills('login-disabled')).toBe(false)
  })

  it('keeps locked settings back navigation inert and includes user-facing login errors', () => {
    const settings = readFileSync(new URL('../../../src/renderer/src/views/SettingsView.vue', import.meta.url), 'utf8')
    const login = readFileSync(new URL('../../../src/renderer/src/views/LoginView.vue', import.meta.url), 'utf8')

    expect(settings).toContain('lockNavigation')
    expect(settings).toContain('!props.lockNavigation')
    expect(login).toContain('<SsoSettings')
    expect(login).toContain('返回登录页')
  })
})
