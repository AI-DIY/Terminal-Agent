import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { loginErrorCopy, loginStatusCopy, shouldRetryOnMount } from '../../../src/renderer/src/sso-login-controller'

describe('login view', () => {
  it('keeps login local and retries only through the SSO store', () => {
    const source = readFileSync(new URL('../../../src/renderer/src/views/LoginView.vue', import.meta.url), 'utf8')

    expect(source).toContain('sso.retry()')
    expect(source).toContain('openSettings')
    expect(source).not.toMatch(/<iframe|<webview|fetch\s*\(|document\.createElement\(['"]iframe['"]\)/)
  })

  it('executes status, retry, and bounded error decisions', () => {
    expect(shouldRetryOnMount('login-required')).toBe(true)
    expect(shouldRetryOnMount('authenticating')).toBe(false)
    expect(loginStatusCopy('login-required')).toBe('正在打开登录页')
    expect(loginStatusCopy('authenticating')).toBe('等待平台加载用户信息')
    expect(loginErrorCopy('SSO sign-in window closed')).toBe('登录窗口已关闭')
  })
})
