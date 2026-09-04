import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import electronExecutablePathValue from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import {
  closeE2eResources,
  createSsoE2eDirectories,
  removeSsoE2eDirectories,
  ssoE2eEnvironment,
  throwCleanupFailures,
  type E2ePrimaryFailure,
  type SsoE2eDirectories,
} from './sso-e2e-environment'

const electronExecutablePath = electronExecutablePathValue as unknown as string
const mainEntry = join(process.cwd(), 'out/main/main.js')
const harnessEntry = join(process.cwd(), 'tests/e2e/sso-electron-harness.cjs')

type SsoFixture = {
  server: HttpServer
  origin: string
  loginUrl: string
  platformUrl: string
  userInfoUrl: string
  readonly requestEntries: readonly string[]
  readonly userInfoRequestEntries: readonly string[]
  activate(): void
}

type PlaywrightLaunch = {
  app: ElectronApplication
  directories: SsoE2eDirectories
}

type DirectElectronLaunch = {
  process: ChildProcess
  directories: SsoE2eDirectories
  workbenchReady: Promise<void>
}

test('shows the forced SSO configuration screen on a fresh isolated home before any navigation', async () => {
  const launch = await launchFreshElectron()
  let primaryFailure: E2ePrimaryFailure | undefined
  try {
    const page = await launch.app.firstWindow()
    await expect(page.getByRole('heading', { name: '单点登录', exact: true })).toBeVisible()
    await expect(page.locator('.workbench-shell')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '设置', exact: true })).toHaveCount(0)
  } catch (error) {
    primaryFailure = { error }
    throw error
  } finally {
    const cleanupFailures = await closeE2eResources(
      async () => { await launch.app.close() },
      async () => { await removeSsoE2eDirectories(launch.directories) },
    )
    throwCleanupFailures(primaryFailure, cleanupFailures)
  }
})

test('captures the platform natural user-info response exactly once', async () => {
  await verifyPassiveCapture('exact')
})

test('supports nontrivial regex platform and user-info URL matchers', async () => {
  await verifyPassiveCapture('regex')
})

test('disables skills through the real Electron gate without opening the unavailable skills view', async () => {
  const launch = await launchFreshElectron()
  let primaryFailure: E2ePrimaryFailure | undefined
  try {
    const page = await launch.app.firstWindow()
    await expect(page.getByRole('heading', { name: '单点登录', exact: true })).toBeVisible()
    await expect(page.locator('.workbench-shell')).toHaveCount(0)

    await disableSsoGate(page)

    const skillsButton = page.getByRole('button', { name: '技能（未登录状态不能使用技能）', exact: true })
    await expect(skillsButton).toBeDisabled()
    await expect(skillsButton).toHaveAttribute('title', '未登录状态不能使用技能')
    await expect(page.locator('main.skills')).toBeHidden()
    await expect(page.getByRole('alert', { name: '未登录状态不能使用技能' })).toHaveCount(0)
  } catch (error) {
    primaryFailure = { error }
    throw error
  } finally {
    const cleanupFailures = await closeE2eResources(
      async () => { await launch.app.close() },
      async () => { await removeSsoE2eDirectories(launch.directories) },
    )
    throwCleanupFailures(primaryFailure, cleanupFailures)
  }
})

async function verifyPassiveCapture(mode: 'exact' | 'regex'): Promise<void> {
  let fixture: SsoFixture | undefined
  let configurationLaunch: PlaywrightLaunch | undefined
  let configurationAppClosed = false
  let directories: SsoE2eDirectories | undefined
  let launch: DirectElectronLaunch | undefined
  let primaryFailure: E2ePrimaryFailure | undefined
  try {
    fixture = await startSsoFixture()
    configurationLaunch = await launchFreshElectron()
    directories = configurationLaunch.directories
    const configurationPage = await configurationLaunch.app.firstWindow()
    await expect(configurationPage.getByRole('heading', { name: '单点登录', exact: true })).toBeVisible()
    await expect(configurationPage.locator('.workbench-shell')).toHaveCount(0)
    await configureCompleteSsoDraft(configurationPage, fixture, mode)
    await expect(configurationPage.getByRole('heading', { name: '需要登录', exact: true })).toBeVisible()
    await closeElectronApplication(configurationLaunch.app)
    configurationAppClosed = true

    fixture.activate()
    launch = await launchDirectElectron(directories)

    await Promise.all([
      expect.poll(() => fixture!.requestEntries.includes('GET /login'), { timeout: 20_000 }).toBe(true),
      expect.poll(() => fixture!.userInfoRequestEntries, { timeout: 20_000 }).toEqual(['GET /userinfo?request=natural']),
      launch.workbenchReady,
    ])
    expect(fixture.userInfoRequestEntries).toEqual(['GET /userinfo?request=natural'])
  } catch (error) {
    primaryFailure = { error }
    throw error
  } finally {
    const cleanupFailures = await closeE2eResources(
      async () => { if (configurationLaunch && !configurationAppClosed) await configurationLaunch.app.close() },
      async () => { if (launch) await stopDirectElectron(launch.process) },
      async () => { if (directories) await removeSsoE2eDirectories(directories) },
      async () => { if (fixture) await closeServer(fixture.server) },
    )
    throwCleanupFailures(primaryFailure, cleanupFailures)
  }
}

async function startSsoFixture(): Promise<SsoFixture> {
  const requestEntries: string[] = []
  let active = false
  const server = createHttpServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (!active) {
      response.statusCode = 204
      response.end()
      return
    }
    requestEntries.push(`${request.method ?? 'GET'} ${url.pathname}${url.search}`)
    if (url.pathname === '/login') {
      response.statusCode = 200
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      response.end('<!doctype html><script>location.replace("/platform?tenant=e2e")</script>')
      return
    }
    if (url.pathname === '/platform') {
      response.statusCode = 200
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      response.end('<!doctype html><h1>Platform</h1><script>void fetch("/userinfo?request=natural")</script>')
      return
    }
    if (url.pathname === '/userinfo') {
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
  const origin = `http://127.0.0.1:${port}`
  return {
    server,
    origin,
    loginUrl: `${origin}/login`,
    platformUrl: `${origin}/platform?tenant=e2e`,
    userInfoUrl: `${origin}/userinfo?request=natural`,
    get requestEntries() { return [...requestEntries] },
    get userInfoRequestEntries() { return requestEntries.filter(entry => /^[^ ]+ \/userinfo(?:\?|$)/.test(entry)) },
    activate() { active = true; requestEntries.splice(0) },
  }
}

async function launchFreshElectron(): Promise<PlaywrightLaunch> {
  const directories = await createSsoE2eDirectories('terminal-agent-sso-e2e-')
  try {
    const app = await electron.launch({
      args: [`--user-data-dir=${directories.userDataDir}`, mainEntry],
      env: ssoE2eEnvironment(directories.ssoHomeDir),
    })
    return { app, directories }
  } catch (error) {
    const cleanupFailures = await closeE2eResources(async () => { await removeSsoE2eDirectories(directories) })
    throwCleanupFailures({ error }, cleanupFailures)
    throw error
  }
}

async function launchDirectElectron(directories: SsoE2eDirectories): Promise<DirectElectronLaunch> {
  let child: ChildProcess | undefined
  try {
    child = spawn(electronExecutablePath, [
      `--user-data-dir=${directories.userDataDir}`,
      harnessEntry,
    ], {
      env: ssoE2eEnvironment(directories.ssoHomeDir),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    return { process: child, directories, workbenchReady: waitForHarnessReady(child) }
  } catch (error) {
    const cleanupFailures = await closeE2eResources(async () => { if (child) await stopDirectElectron(child) })
    throwCleanupFailures({ error }, cleanupFailures)
    throw error
  }
}

async function configureCompleteSsoDraft(page: Page, fixture: SsoFixture, mode: 'exact' | 'regex'): Promise<void> {
  const platformMatcher = mode === 'exact'
    ? fixture.platformUrl
    : `^${escapeRegularExpression(fixture.origin)}/platform\\?tenant=(?:e2e|backup)$`
  const userInfoMatcher = mode === 'exact'
    ? fixture.userInfoUrl
    : `^${escapeRegularExpression(fixture.origin)}/userinfo\\?request=natural$`

  const gate = page.getByLabel('启用单点登录门控')
  await expect(gate).toBeChecked()
  await page.getByLabel('登录页 URL').fill(fixture.loginUrl)
  await page.getByLabel('平台 URL 匹配方式').selectOption(mode)
  await page.getByLabel('平台 URL / 正则').fill(platformMatcher)
  await page.getByLabel('用户信息接口 URL 匹配方式').selectOption(mode)
  await page.getByLabel('用户信息接口 URL / 正则').fill(userInfoMatcher)
  await page.getByLabel('工号字段路径').fill('data.employeeId')
  await page.getByLabel('姓名字段路径').fill('$.data.name')
  await page.getByRole('button', { name: '保存草稿', exact: true }).click()
  await expect.poll(async () => await page.evaluate(() => window.terminalAgent.sso.getConfig())).toMatchObject({
    enabled: true,
    loginPageUrl: fixture.loginUrl,
    platformUrlMatcher: { mode, value: platformMatcher },
    userInfoUrlMatcher: { mode, value: userInfoMatcher },
    employeeIdField: 'data.employeeId',
    nameField: '$.data.name',
  })
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function waitForHarnessReady(child: ChildProcess): Promise<void> {
  const stdout = child.stdout
  const stderr = child.stderr
  if (!stdout || !stderr) throw new Error('Electron harness did not expose output streams')
  return new Promise((resolve, reject) => {
    let buffer = ''
    let stderrTail = ''
    const harnessMarkers: string[] = []
    let settled = false
    const timeout = setTimeout(() => finish(new Error('Electron harness did not reach the authenticated workbench')), 45_000)
    const onData = (chunk: Buffer | string): void => {
      buffer += String(chunk)
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line.startsWith('terminal-agent-sso-harness:')) harnessMarkers.push(line.slice('terminal-agent-sso-harness:'.length))
        if (line === 'terminal-agent-sso-harness:workbench-ready') finish()
        if (line === 'terminal-agent-sso-harness:failed') finish(new Error('Electron harness failed before the authenticated workbench'))
      }
    }
    const onStderr = (chunk: Buffer | string): void => {
      stderrTail = `${stderrTail}${String(chunk)}`.slice(-2_048)
    }
    const onExit = (): void => finish(new Error('Electron harness exited before the authenticated workbench'))
    const onError = (): void => finish(new Error('Electron harness process failed to start'))
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      stdout.removeListener('data', onData)
      stderr.removeListener('data', onStderr)
      child.removeListener('exit', onExit)
      child.removeListener('error', onError)
      const markerSummary = harnessMarkers.length > 0 ? harnessMarkers.join(', ') : 'none'
      if (error && stderrTail) reject(new Error(`${error.message} (harness markers: ${markerSummary}; sanitized stderr: ${sanitizeHarnessStderr(stderrTail)})`))
      else if (error && harnessMarkers.length > 0) reject(new Error(`${error.message} (harness markers: ${markerSummary})`))
      else if (error) reject(error)
      else resolve()
    }
    stdout.on('data', onData)
    stderr.on('data', onStderr)
    child.once('exit', onExit)
    child.once('error', onError)
  })
}

function sanitizeHarnessStderr(value: string): string {
  return value
    .replace(/https?:\/\/[^\s'"`]+/giu, '<url>')
    .replace(/[A-Za-z]:\\[^\r\n'"`]+/gu, '<path>')
    .replace(/\b(token|authorization|cookie|password|secret|api[ _-]?key)\b\s*[:=]\s*[^\s,;]+/giu, '$1=<redacted>')
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/\s{2,}/gu, ' ')
    .trim()
    .slice(-2_048)
}

async function stopDirectElectron(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return
  const exited = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.removeListener('exit', onExit)
      reject(new Error('Direct Electron process did not exit during cleanup'))
    }, 15_000)
    const onExit = (): void => {
      clearTimeout(timeout)
      resolve()
    }
    child.once('exit', onExit)
  })
  if (!child.kill() && child.exitCode === null) throw new Error('Unable to stop direct Electron process')
  await exited
}

async function closeElectronApplication(app: ElectronApplication): Promise<void> {
  if (app.process().exitCode !== null) return
  const closed = app.waitForEvent('close', { timeout: 15_000 })
  await app.close()
  await closed
}

async function disableSsoGate(page: Page): Promise<void> {
  const gate = page.getByLabel('启用单点登录门控')
  await expect(gate).toBeChecked()
  await gate.uncheck()
  await expect(page.getByRole('note')).toHaveText('关闭登录门控后，应用将以未登录状态运行，内置技能不可使用。')
  await page.getByRole('button', { name: '保存并进入工作台', exact: true }).click()
  await expect(page.locator('.workbench-shell')).toHaveAttribute('data-workbench-ready', 'true')
}

function closeServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}
