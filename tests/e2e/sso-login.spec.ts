import { expect, test } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type SsoFixture = {
  server: HttpServer
  loginUrl: string
  platformUrl: string
  userInfoUrl: string
  loginRequests: number
  userInfoRequests: number
}

type Launch = { app: ElectronApplication; userDataDir: string }

test('captures the platform natural user-info response exactly once', async () => {
  const fixture = await startSsoFixture()
  const launch = await launchFreshElectron()
  try {
    const page = await launch.app.firstWindow()
    await reachSsoSettings(page)
    await configureCompleteSso(page, fixture, launch.app)
    await expect(page.getByText('欢迎回来，张三（E-1001）', { exact: true })).toBeVisible()
    expect(fixture.userInfoRequests).toBe(1)
    await disableSsoGate(page)
  } finally {
    await closeE2eResources(launch.app, fixture.server, launch.userDataDir)
  }
})

test('supports regex platform and user-info URL matchers with query strings', async () => {
  const fixture = await startSsoFixture()
  const launch = await launchFreshElectron()
  try {
    const page = await launch.app.firstWindow()
    await reachSsoSettings(page)
    await configureCompleteSso(page, fixture, launch.app, true)
    await expect(page.getByText('欢迎回来，张三（E-1001）', { exact: true })).toBeVisible()
    expect(fixture.userInfoRequests).toBe(1)
    await disableSsoGate(page)
  } finally {
    await closeE2eResources(launch.app, fixture.server, launch.userDataDir)
  }
})

test('disables skill controls while SSO gate is disabled', async () => {
  const fixture = await startSsoFixture()
  const launch = await launchFreshElectron()
  try {
    const page = await launch.app.firstWindow()
    await reachSsoSettings(page)
    await disableSsoGate(page)
    await expect(page.locator('.workbench-shell')).toHaveAttribute('data-workbench-ready', 'true')

    const skillsButton = page.getByRole('button', { name: '技能（未登录状态不能使用技能）', exact: true })
    await expect(skillsButton).toBeDisabled()
    await expect(skillsButton).toHaveAttribute('title', '未登录状态不能使用技能')
  } finally {
    await closeE2eResources(launch.app, fixture.server, launch.userDataDir)
  }
})

async function startSsoFixture(): Promise<SsoFixture> {
  let loginRequests = 0
  let userInfoRequests = 0
  const server = createHttpServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/login') {
      loginRequests += 1
      response.statusCode = 200
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      response.end('<!doctype html><script>location.href="/platform?tenant=e2e"</script>')
      return
    }
    if (url.pathname === '/platform') {
      response.statusCode = 200
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      response.end('<!doctype html><h1>Platform</h1><script>fetch("/userinfo?request=natural")</script>')
      return
    }
    if (url.pathname === '/userinfo') {
      userInfoRequests += 1
      response.statusCode = 200
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ data: { employeeId: 'E-1001', name: '张三' } }))
      return
    }
    response.statusCode = 404
    response.end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as AddressInfo).port
  return {
    server,
    loginUrl: `http://127.0.0.1:${port}/login`,
    platformUrl: `http://127.0.0.1:${port}/platform?tenant=e2e`,
    userInfoUrl: `http://127.0.0.1:${port}/userinfo?request=natural`,
    get loginRequests() { return loginRequests },
    get userInfoRequests() { return userInfoRequests },
  }
}

async function launchFreshElectron(): Promise<Launch> {
  const userDataDir = await mkdtemp(join(tmpdir(), 'terminal-agent-sso-e2e-'))
  try {
    const app = await electron.launch({
      args: [`--user-data-dir=${userDataDir}`, join(process.cwd(), 'out/main/main.js')],
      env: { ...process.env, HOME: userDataDir, USERPROFILE: userDataDir },
    })
    return { app, userDataDir }
  } catch (error) {
    await rm(userDataDir, { recursive: true, force: true })
    throw error
  }
}

async function configureCompleteSso(page: Page, fixture: SsoFixture, app: ElectronApplication, regex = false): Promise<void> {
  // SsoSettings hydrates its draft asynchronously on mount.  Wait for that
  // renderer-side read before filling, otherwise hydration may overwrite an
  // otherwise complete test configuration.
  await page.evaluate(() => window.terminalAgent.sso.getConfig())
  await page.waitForTimeout(50)
  const gate = page.getByLabel('启用单点登录门控')
  if (!(await gate.isChecked())) await gate.check()
  await page.getByLabel('登录页 URL').fill(fixture.loginUrl)
  await page.getByLabel('平台 URL 匹配方式').selectOption(regex ? 'regex' : 'exact')
  await page.getByLabel('平台 URL / 正则').fill(regex ? `${fixture.platformUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` : fixture.platformUrl)
  await page.getByLabel('用户信息接口 URL 匹配方式').selectOption(regex ? 'regex' : 'exact')
  await page.getByLabel('用户信息接口 URL / 正则').fill(regex ? `${fixture.userInfoUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` : fixture.userInfoUrl)
  await page.getByLabel('工号字段路径').fill('data.employeeId')
  await page.getByLabel('姓名字段路径').fill('data.name')
  await page.getByRole('button', { name: '保存并继续', exact: true }).click()
  await expect(page.getByRole('heading', { name: '需要登录', exact: true })).toBeVisible()
  const authWindowPromise = app.waitForEvent('window')
  await page.getByRole('button', { name: '重试', exact: true }).click()
  await authWindowPromise
  await expect.poll(() => fixture.loginRequests).toBe(1)
}

async function reachSsoSettings(page: Page): Promise<void> {
  const settingsTitle = page.getByRole('heading', { name: '单点登录', exact: true })
  await expect(page.locator('main')).toBeVisible()
  if (await settingsTitle.isVisible().catch(() => false)) return
  const openLoginSettings = page.getByRole('button', { name: '打开单点登录设置', exact: true })
  if (await openLoginSettings.isVisible().catch(() => false)) await openLoginSettings.click()
  else {
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('navigation', { name: '设置面板', exact: true }).getByRole('button', { name: '单点登录', exact: true }).click()
  }
  await expect(settingsTitle).toBeVisible()
}

async function disableSsoGate(page: Page): Promise<void> {
  const gate = page.getByLabel('启用单点登录门控')
  if (!(await gate.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('navigation', { name: '设置面板', exact: true }).getByRole('button', { name: '单点登录', exact: true }).click()
  }
  if (await gate.isChecked()) await gate.uncheck()
  await expect(page.getByRole('note')).toHaveText('关闭登录门控后，应用将以未登录状态运行，内置技能不可使用。')
  await page.getByRole('button', { name: '保存并进入工作台', exact: true }).click()
  await expect(page.locator('.workbench-shell')).toHaveAttribute('data-workbench-ready', 'true')
}

async function closeE2eResources(app: ElectronApplication, server: HttpServer, userDataDir: string): Promise<void> {
  await app.close().catch(() => undefined)
  await new Promise<void>(resolve => server.close(() => resolve()))
  await rm(userDataDir, { recursive: true, force: true })
}
