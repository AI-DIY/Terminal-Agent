/* global require, process, setTimeout */
/* eslint-disable @typescript-eslint/no-require-imports */

const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')

let mainWindowObserved = false
let authenticationWindowObserved = false

app.on('browser-window-created', () => {
  if (mainWindowObserved) authenticationWindowObserved = true
})

require(join(process.cwd(), 'out/main/main.js'))

const WORKBENCH_READY_EXPRESSION = "document.body?.innerText.includes('欢迎回来，张三（E-1001）') === true"
const SURFACE_EXPRESSION = `(() => {
  if (document.querySelector('.workbench-shell')) return 'workbench-surface'
  const text = document.body?.innerText ?? ''
  if (text.includes('Unable to start SSO sign-in')) return 'login-start-error-surface'
  if (text.includes('Unable to continue SSO sign-in')) return 'login-continue-error-surface'
  if (text.includes('SSO sign-in connection closed')) return 'login-connection-error-surface'
  if (document.querySelector('.login-view [role="alert"]')) return 'login-error-surface'
  if (document.querySelector('.login-view')) return 'login-surface'
  if (document.querySelector('.settings-view')) return 'settings-surface'
  return 'unknown-surface'
})()`

function report(event) {
  process.stdout.write(`terminal-agent-sso-harness:${event}\n`)
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitForCondition(condition, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await condition()) return true
    await wait(50)
  }
  return false
}

function mainWindow() {
  return BrowserWindow.getAllWindows().find(window => !window.isDestroyed() && window.webContents.getURL().startsWith('file:'))
}

function authenticationWindowDebuggerState() {
  const window = BrowserWindow.getAllWindows().find(candidate => candidate !== mainWindow() && !candidate.isDestroyed())
  if (!window) return 'authentication-window-absent'
  return window.webContents.debugger.isAttached() ? 'authentication-debugger-attached' : 'authentication-debugger-detached'
}

app.whenReady().then(async () => {
  try {
    report(app.commandLine.hasSwitch('remote-debugging-port') ? 'remote-debugging-enabled' : 'remote-debugging-disabled')
    const foundMainWindow = await waitForCondition(() => Boolean(mainWindow()))
    if (!foundMainWindow) throw new Error('main window was not created')
    mainWindowObserved = true
    report('main-window-ready')
    const window = mainWindow()
    if (window) report(await window.webContents.executeJavaScript(SURFACE_EXPRESSION, true))

    const foundAuthenticationWindow = await waitForCondition(() => authenticationWindowObserved, 5_000)
    report(foundAuthenticationWindow ? 'authentication-window-created' : 'authentication-window-not-observed')
    if (foundAuthenticationWindow) report(authenticationWindowDebuggerState())

    const renderedWelcome = await waitForCondition(async () => {
      const window = mainWindow()
      return Boolean(window && await window.webContents.executeJavaScript(WORKBENCH_READY_EXPRESSION, true))
    })
    if (!renderedWelcome) {
      const currentWindow = mainWindow()
      if (currentWindow) report(await currentWindow.webContents.executeJavaScript(SURFACE_EXPRESSION, true))
      throw new Error('authenticated workbench did not render')
    }

    const authWindowClosed = await waitForCondition(() => BrowserWindow.getAllWindows().every(window => window === mainWindow() || window.isDestroyed()))
    if (!authWindowClosed) throw new Error('authentication window did not close')
    report('workbench-ready')
  } catch {
    report('failed')
  }
})
