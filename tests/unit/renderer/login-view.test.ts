import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { loginErrorCopy, loginStatusCopy, shouldRetryOnMount } from '../../../src/renderer/src/sso-login-controller'

describe('login view', () => {
  it('keeps login local and retries only through the SSO store', () => {
    const source = readFileSync(new URL('../../../src/renderer/src/views/LoginView.vue', import.meta.url), 'utf8')

    expect(source).toContain('sso.retry()')
    expect(source).toContain('consumeAutoRetrySuppression')
    expect(source).toContain('embedded-login')
    expect(source).toContain('openSettings')
    expect(source).toContain('sso.state.state === \'authenticating\'')
    expect(source).toContain('登录进行中')
    expect(source).toContain('正在安全获取用户信息')
    expect(source).toContain('class="login-spinner"')
    expect(source).toContain('class="login-progress-dots"')
    expect(source).toContain('aria-busy="true"')
    expect(source).not.toMatch(/<iframe|<webview|fetch\s*\(|document\.createElement\(['"]iframe['"]\)/)
  })

  it('executes status, retry, and bounded error decisions', () => {
    expect(shouldRetryOnMount('login-required')).toBe(true)
    expect(shouldRetryOnMount('authenticating')).toBe(false)
    expect(loginStatusCopy('login-required')).toBe('正在打开登录页')
    expect(loginStatusCopy('authenticating')).toBe('正在安全获取用户信息')
    expect(loginErrorCopy('SSO sign-in window closed')).toBe('登录窗口已关闭')
  })
})
