import { describe, expect, it, vi } from 'vitest'
import { createDefaultSsoConfiguration, type SsoConfiguration } from '../../../src/shared/sso-contracts'
import { canOpenSkills, initializeSsoFailClosed, loginErrorCopy, loginStatusCopy, resolveRootSurface, shouldRetryOnMount } from '../../../src/renderer/src/sso-login-controller'
import { getSsoDraftErrors, isDisabledWorkbenchReady, isEnabledContinueReady } from '../../../src/renderer/src/sso-settings-model'

const complete: SsoConfiguration = {
  enabled: true,
  loginPageUrl: 'https://login.example.test',
  platformUrlMatcher: { mode: 'exact', value: 'https://platform.example.test' },
  userInfoUrlMatcher: { mode: 'regex', value: '^https://platform\\.example\\.test/api/me$' },
  employeeIdField: 'employee.id',
  nameField: 'profile.name',
}

describe('SSO renderer behavior', () => {
  it('maps all auth states to the approved root surfaces', () => {
    expect(resolveRootSurface('configuration-required')).toBe('configuration')
    for (const state of ['login-required', 'authenticating', 'error'] as const) expect(resolveRootSurface(state)).toBe('login')
    for (const state of ['authenticated', 'login-disabled'] as const) expect(resolveRootSurface(state)).toBe('workbench')
    expect(canOpenSkills('authenticated')).toBe(true)
    expect(canOpenSkills('login-disabled')).toBe(false)
    expect(canOpenSkills('login-required')).toBe(false)
  })

  it('controls retry and local status/error copy', () => {
    expect(shouldRetryOnMount('login-required')).toBe(true)
    expect(shouldRetryOnMount('authenticating')).toBe(false)
    expect(loginStatusCopy('login-required')).toBe('正在打开登录页')
    expect(loginStatusCopy('authenticating')).toBe('正在安全获取用户信息')
    expect(loginErrorCopy('SSO sign-in window closed')).toBe('登录窗口已关闭')
    expect(loginErrorCopy('backend details '.repeat(40)).length).toBeLessThanOrEqual(247)
  })

  it('validates hydrated drafts and separates enabled continue from disabled workbench predicates', () => {
    expect(getSsoDraftErrors(complete)).toEqual({})
    expect(isEnabledContinueReady(complete)).toBe(true)
    expect(isDisabledWorkbenchReady({ ...complete, enabled: false })).toBe(true)

    const disabledDraft = createDefaultSsoConfiguration()
    disabledDraft.enabled = false
    expect(getSsoDraftErrors(disabledDraft)).toEqual({})
    expect(isEnabledContinueReady(disabledDraft)).toBe(false)
    expect(isDisabledWorkbenchReady(disabledDraft)).toBe(true)

    expect(getSsoDraftErrors({ ...complete, loginPageUrl: 'not-a-url' }).loginPageUrl).toBeTruthy()
    expect(getSsoDraftErrors({ ...complete, platformUrlMatcher: { mode: 'regex', value: '[' } }).platformUrlMatcher).toBeTruthy()
    expect(getSsoDraftErrors({ ...complete, employeeIdField: 'a..b' }).employeeIdField).toBeTruthy()
  })

  it('contains initialization rejection and still releases the fail-closed gate', async () => {
    const ready = vi.fn()
    const store = { initialize: vi.fn().mockRejectedValue(new Error('hydrate failed')) }
    await expect(initializeSsoFailClosed(store, ready)).resolves.toBeUndefined()
    expect(ready).toHaveBeenCalledOnce()
  })
})
