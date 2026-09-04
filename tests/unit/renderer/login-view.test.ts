import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

describe('login view', () => {
  it('keeps login local and retries only through the SSO store', () => {
    const source = readFileSync(new URL('../../../src/renderer/src/views/LoginView.vue', import.meta.url), 'utf8')

    expect(source).toContain('正在打开登录页')
    expect(source).toContain('等待平台加载用户信息')
    expect(source).toContain('登录窗口已关闭')
    expect(source).toContain('sso.retry()')
    expect(source).toContain('openSettings')
    expect(source).not.toMatch(/<iframe|<webview|fetch\s*\(|document\.createElement\(['"]iframe['"]\)/)
  })
})
