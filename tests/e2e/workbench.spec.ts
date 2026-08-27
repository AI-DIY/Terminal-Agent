import { _electron as electron, expect, test as base, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import electronExecutablePathValue from 'electron'
import { generateKeyPairSync } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Server } from 'ssh2'
import { evaluateNodeInspector } from '../helpers/node-inspector-client'
import {
  linuxCpuModelCommand,
  linuxDiskCommand,
  linuxMemoryCommand,
  linuxNetworkCommand,
  linuxProcessCommand,
  linuxServiceCommand,
} from '../../src/main/observation/observation-runner'

const electronExecutablePath = electronExecutablePathValue as unknown as string

type LaunchedTerminalAgent = {
  app: ElectronApplication
  userDataDir: string
  mainEntry: string
}

const test = base.extend<{
  launchApp: (appArguments?: string[]) => Promise<LaunchedTerminalAgent>
}>({
  launchApp: async ({ playwright: _playwright }, use) => {
    void _playwright
    const launches: LaunchedTerminalAgent[] = []
    await use(async (appArguments = []) => {
      const userDataDir = await mkdtemp(join(tmpdir(), 'terminal-agent-e2e-'))
      const mainEntry = join(process.cwd(), 'out/main/main.js')
      try {
        const app = await electron.launch({ args: [`--user-data-dir=${userDataDir}`, mainEntry, ...appArguments] })
        const launched = { app, userDataDir, mainEntry }
        launches.push(launched)
        return launched
      } catch (error) {
        await rm(userDataDir, { recursive: true, force: true })
        throw error
      }
    })
    for (const launch of launches.reverse()) {
      await launch.app.close().catch(() => undefined)
      await rm(launch.userDataDir, { recursive: true, force: true })
    }
  },
})

test('opens independent DevTools and an automatically attached Node Inspector', async ({ launchApp }) => {
  test.setTimeout(60_000)
  let app: ElectronApplication | undefined

  try {
    const electronApp = (await launchApp()).app
    app = electronApp
    const page = await electronApp.firstWindow()
    const mainBounds = await mainWindowBounds(electronApp)
    if (!mainBounds) throw new Error('Expected the Terminal-Agent main window')

    await page.getByRole('button', { name: 'DevTools', exact: true }).click()
    const rendererDevTools = await waitForElectronWindow(electronApp, url => url.startsWith('devtools://'))
    const rendererDevToolsCount = (await electronApp.windows()).length
    await page.getByRole('button', { name: 'DevTools', exact: true }).click()
    expect((await electronApp.windows()).length).toBe(rendererDevToolsCount)
    await rendererDevTools.close()
    await expect.poll(async () => (await electronApp.windows()).filter(window => window.url().startsWith('devtools://')).length).toBe(0)

    await sendRendererDevToolsShortcut(electronApp)
    const reopenedDevTools = await waitForElectronWindow(electronApp, url => url.startsWith('devtools://'))
    await reopenedDevTools.close()
    await expect.poll(async () => (await electronApp.windows()).filter(window => window.url().startsWith('devtools://')).length).toBe(0)

    await page.getByRole('button', { name: 'Node Inspector', exact: true }).click()
    const nodeInspector = await waitForElectronWindow(electronApp, url => url.startsWith('devtools://devtools/bundled/js_app.html'))
    await expect(nodeInspector.locator('body')).toBeVisible()
    const inspectorPid = await evaluateNodeInspector<number>(nodeInspector.url(), 'process.pid')
    const mainPid = await electronApp.evaluate(() => process.pid)
    expect(inspectorPid).toBe(mainPid)

    const inspectorWindowCount = (await electronApp.windows()).length
    await page.getByRole('button', { name: 'Node Inspector', exact: true }).click()
    expect((await electronApp.windows()).length).toBe(inspectorWindowCount)
    await nodeInspector.close()
    await expect.poll(async () => (await electronApp.windows()).filter(window => window.url().startsWith('devtools://devtools/bundled/js_app.html')).length).toBe(0)

    await page.getByRole('button', { name: 'Node Inspector', exact: true }).click()
    const reopenedInspector = await waitForElectronWindow(electronApp, url => url.startsWith('devtools://devtools/bundled/js_app.html'))
    await expect(reopenedInspector.locator('body')).toBeVisible()
    const afterBounds = await mainWindowBounds(electronApp)
    expect(afterBounds).toEqual(mainBounds)
  } finally {
    await app?.close()
  }
})

async function waitForElectronWindow(app: ElectronApplication, accepts: (url: string) => boolean): Promise<Page> {
  await expect.poll(async () => (await app.windows()).some(window => accepts(window.url()))).toBe(true)
  const window = (await app.windows()).find(candidate => accepts(candidate.url()))
  if (!window) throw new Error('Expected a matching Electron window')
  return window
}

async function sendRendererDevToolsShortcut(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    const mainWindow = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('file:'))
    if (!mainWindow) throw new Error('Expected the Terminal-Agent main window')
    mainWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'I', modifiers: ['control', 'shift'] })
  })
}

async function mainWindowBounds(app: ElectronApplication): Promise<{ x: number; y: number; width: number; height: number } | undefined> {
  return app.evaluate(({ BrowserWindow }) => (
    BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('file:'))?.getBounds()
  ))
}

async function historyScrollMetrics(history: Locator): Promise<{ clientHeight: number; scrollHeight: number; scrollTop: number }> {
  return history.evaluate(node => ({ clientHeight: node.clientHeight, scrollHeight: node.scrollHeight, scrollTop: node.scrollTop }))
}

test('keeps a short task history from overflowing during task actions', async ({ launchApp }) => {
  let app: ElectronApplication | undefined

  try {
    app = (await launchApp()).app
    const page = await app.firstWindow()
    const history = page.getByRole('navigation', { name: '任务历史列表', exact: true })

    await page.getByRole('button', { name: '新建任务', exact: true }).click()
    const task = page.locator('.history-item.active')
    await task.getByRole('button', { name: /^任务操作 / }).click()
    await expect(task.getByRole('menu', { name: '任务操作菜单', exact: true })).toBeVisible()
    const actionMenuMetrics = await historyScrollMetrics(history)
    expect(actionMenuMetrics.scrollHeight).toBe(actionMenuMetrics.clientHeight)

    await task.getByRole('menuitem', { name: '重命名', exact: true }).click()
    await expect(task.getByRole('textbox', { name: '任务名称', exact: true })).toBeVisible()
    const renameMetrics = await historyScrollMetrics(history)
    expect(renameMetrics.scrollHeight).toBe(renameMetrics.clientHeight)

    await page.keyboard.press('Escape')
    await expect(task.getByRole('button', { name: /^任务操作 / })).toBeVisible()
    await task.getByRole('button', { name: /^任务操作 / }).click()
    await task.getByRole('menuitem', { name: '删除', exact: true }).click()
    await expect(page.locator('.history-item')).toHaveCount(0)
    const deletionMetrics = await historyScrollMetrics(history)
    expect(deletionMetrics.scrollHeight).toBe(deletionMetrics.clientHeight)
  } finally {
    await app?.close()
  }
})

test('keeps a long task history scrollable', async ({ launchApp }) => {
  let app: ElectronApplication | undefined

  try {
    app = (await launchApp()).app
    const page = await app.firstWindow()
    const history = page.getByRole('navigation', { name: '任务历史列表', exact: true })

    await page.evaluate(async () => {
      await Promise.all(Array.from({ length: 16 }, async (_, index) => {
        await window.terminalAgent.chats.create({ requestId: crypto.randomUUID(), title: `滚动任务 ${index + 1}` })
      }))
    })
    await expect(page.locator('.history-item')).toHaveCount(16)

    const beforeScroll = await historyScrollMetrics(history)
    expect(beforeScroll.scrollHeight).toBeGreaterThan(beforeScroll.clientHeight)
    const afterScroll = await history.evaluate(node => {
      node.scrollTop = node.scrollHeight
      return node.scrollTop
    })
    expect(afterScroll).toBeGreaterThan(0)
  } finally {
    await app?.close()
  }
})

test('vertically centers the closed-Shell history heading and summary', async ({ launchApp }) => {
  const sshServer = await startSshServer()
  let app: ElectronApplication | undefined

  try {
    app = (await launchApp()).app
    const page = await app.firstWindow()

    await connect(page, sshServer.port)
    await page.getByRole('button', { name: '关闭终端会话 127.0.0.1', exact: true }).click()

    const toolbar = page.locator('.shell-toolbar-content')
    await expect(toolbar).toBeVisible()
    await expect(toolbar.getByText('Shell 历史回放', { exact: true })).toBeVisible()
    const centers = await toolbar.evaluate(node => {
      const toolbarBox = node.getBoundingClientRect()
      const titleParts = [...node.querySelectorAll<HTMLElement>('.history-toolbar-title strong,.history-toolbar-title span')]
      return {
        toolbar: toolbarBox.top + toolbarBox.height / 2,
        titleParts: titleParts.map(part => {
          const box = part.getBoundingClientRect()
          return box.top + box.height / 2
        }),
      }
    })

    expect(centers.titleParts).toHaveLength(2)
    for (const center of centers.titleParts) expect(Math.abs(center - centers.toolbar)).toBeLessThanOrEqual(1)
  } finally {
    await app?.close()
    await closeServer(sshServer.server)
  }
})

test('persists chat navigation across renderer reload with the real Shell count', async ({ launchApp }) => {
  const sshServer = await startSshServer()
  let app: ElectronApplication | undefined

  try {
    app = (await launchApp()).app
    const page = await app.firstWindow()

    await page.getByRole('button', { name: '新建任务', exact: true }).click()
    const activeChat = page.locator('.history-item.active')
    await connect(page, sshServer.port)
    await expect(activeChat.getByText('1 个 Shell', { exact: true })).toBeVisible()
    const title = (await activeChat.locator('strong').textContent())?.trim()
    if (!title) throw new Error('Expected a durable task title after its first Shell association')

    await page.reload()

    const restoredChat = page.getByRole('button', { name: `选择任务 ${title}`, exact: true })
    await expect(restoredChat).toHaveAttribute('aria-current', 'page')
    await expect(restoredChat.getByText('1 个 Shell', { exact: true })).toBeVisible()
  } finally {
    await app?.close()
    await closeServer(sshServer.server)
  }
})

test('restores a newly created zero-Shell chat as a connectable live workspace after reload', async ({ launchApp }) => {
  const sshServer = await startSshServer()
  let app: ElectronApplication | undefined

  try {
    app = (await launchApp()).app
    const page = await app.firstWindow()

    await page.getByRole('button', { name: '新建任务', exact: true }).click()
    const activeChat = page.locator('.history-item.active')
    const title = (await activeChat.locator('strong').textContent())?.trim()
    if (!title) throw new Error('Expected a durable chat title')

    await page.reload()

    const restoredChat = page.getByRole('button', { name: `选择任务 ${title}`, exact: true })
    await expect(restoredChat).toHaveAttribute('aria-current', 'page')
    await expect(page.getByRole('tab', { name: '主机用户名 + 密码连接', exact: true })).toBeVisible()
    await expect(page.getByLabel('任务 Shell 历史回放')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '返回实时任务', exact: true })).toHaveCount(0)

    await connect(page, sshServer.port)
    await expect(page.getByRole('button', { name: '选择终端会话 127.0.0.1', exact: true })).toBeVisible()
    await expect(page.locator('.history-item.active').getByText('1 个 Shell', { exact: true })).toBeVisible()
  } finally {
    await app?.close()
    await closeServer(sshServer.server)
  }
})

test('restores an empty live workspace while another chat keeps a running Shell', async ({ launchApp }) => {
  const sshServer = await startSshServer()
  let app: ElectronApplication | undefined

  try {
    app = (await launchApp()).app
    const page = await app.firstWindow()

    await page.getByRole('button', { name: '新建任务', exact: true }).click()
    await connect(page, sshServer.port)
    await sendCommand(page.locator('[data-testid^="terminal-pane-"]:visible'), page, 'before-empty-reload')

    await page.getByRole('button', { name: '新建任务', exact: true }).click()

    await page.reload()

    await expect(page.locator('.history-item.active')).toContainText('0 个 Shell')
    await expect(page.getByRole('tab', { name: '主机用户名 + 密码连接', exact: true })).toBeVisible()
    await page.locator('.history-item').filter({ hasText: '1 个 Shell' }).locator('.chat-select').click()
    await expect(page.getByRole('button', { name: '选择终端会话 127.0.0.1', exact: true })).toBeVisible()
    await sendCommand(page.locator('[data-testid^="terminal-pane-"]:visible'), page, 'after-empty-reload')
    await expect(page.locator('[data-testid^="terminal-pane-"]:visible')).toContainText('echo:after-empty-reload')
  } finally {
    await app?.close()
    await closeServer(sshServer.server)
  }
})

test('restores the current empty workspace after a background chat closes', async ({ launchApp }) => {
  const sshServer = await startSshServer()
  let app: ElectronApplication | undefined

  try {
    app = (await launchApp()).app
    const page = await app.firstWindow()

    await page.getByRole('button', { name: '新建任务', exact: true }).click()
    await connect(page, sshServer.port)
    await page.getByRole('button', { name: '新建任务', exact: true }).click()

    await page.evaluate(async () => {
      const session = (await window.terminalAgent.sessions.list())[0]
      if (!session) throw new Error('Expected a background terminal session')
      await window.terminalAgent.sessions.close(session.id)
    })
    await expect(page.getByRole('button', { name: '选择终端会话 127.0.0.1', exact: true })).toHaveCount(0)

    await page.reload()

    await expect(page.locator('.history-item.active')).toContainText('0 个 Shell')
    await expect(page.getByRole('tab', { name: '主机用户名 + 密码连接', exact: true })).toBeVisible()
    await expect(page.getByLabel('任务 Shell 历史回放')).toHaveCount(0)
  } finally {
    await app?.close()
    await closeServer(sshServer.server)
  }
})

test('restores a chat with only closed Shells as history playback after reload', async ({ launchApp }) => {
  const sshServer = await startSshServer()
  let app: ElectronApplication | undefined

  try {
    app = (await launchApp()).app
    const page = await app.firstWindow()

    await page.getByRole('button', { name: '新建任务', exact: true }).click()
    const activeChat = page.locator('.history-item.active')
    await connect(page, sshServer.port)
    await page.getByRole('button', { name: '关闭终端会话 127.0.0.1', exact: true }).click()
    await expect(page.getByRole('button', { name: '选择终端会话 127.0.0.1', exact: true })).toHaveCount(0)
    const title = (await activeChat.locator('strong').textContent())?.trim()
    if (!title) throw new Error('Expected a durable task title after its first Shell association')

    await page.reload()

    const chat = page.getByRole('button', { name: `选择任务 ${title}`, exact: true })
    await expect(chat).toHaveAttribute('aria-current', 'page')
    await expect(page.getByLabel('任务 Shell 历史回放')).toBeVisible()
    await expect(page.getByText('已关闭 · 只读历史', { exact: true })).toBeVisible()
    await expect(page.locator('.empty-state')).toHaveCount(0)

    await chat.click()
    await expect(page.getByLabel('任务 Shell 历史回放')).toBeVisible()
    await expect(page.locator('.empty-state')).toHaveCount(0)
  } finally {
    await app?.close()
    await closeServer(sshServer.server)
  }
})

test('filters historical hosts as a multi-select workspace with shared layout and reconnect actions', async ({ launchApp }) => {
  const sshServer = await startSshServer()
  let app: ElectronApplication | undefined

  try {
    app = (await launchApp()).app
    const page = await app.firstWindow()

    await createNamedChat(page, '多主机历史')
    await connect(page, sshServer.port, '127.0.0.1')
    await connect(page, sshServer.port, '127.0.0.2')
    await page.getByRole('button', { name: '关闭画布终端会话 127.0.0.1', exact: true }).click()
    await page.getByRole('button', { name: '关闭画布终端会话 127.0.0.2', exact: true }).click()

    const firstHost = page.getByRole('button', { name: '筛选历史 Shell 127.0.0.1', exact: true })
    const secondHost = page.getByRole('button', { name: '筛选历史 Shell 127.0.0.2', exact: true })
    const historicalCards = page.locator('.history-shell-card')
    await expect(firstHost).toHaveAttribute('aria-pressed', 'true')
    await expect(secondHost).toHaveAttribute('aria-pressed', 'true')
    await expect(historicalCards).toHaveCount(2)
    await expect(page.getByText('Shell 历史回放', { exact: true })).toBeVisible()
    await expect(page.getByText('2 台主机 · 2 条记录', { exact: true })).toBeVisible()
    await expect(page.getByText('以下 Shell 已关闭，仅提供只读回放', { exact: true })).toBeVisible()
    await expect(page.locator('.shell-title')).toHaveCount(0)

    await firstHost.click()
    await expect(firstHost).toHaveAttribute('aria-pressed', 'false')
    await expect(historicalCards).toHaveCount(1)
    await expect(page.getByLabel('只读终端历史 127.0.0.2', { exact: true })).toBeVisible()

    await secondHost.click()
    await expect(secondHost).toHaveAttribute('aria-pressed', 'true')
    await expect(historicalCards).toHaveCount(1)
    await firstHost.click()
    await expect(historicalCards).toHaveCount(2)

    await page.getByRole('button', { name: '历史 Shell 布局', exact: true }).click()
    const historyLayout = page.getByLabel('历史 Shell 布局设置')
    await historyLayout.getByLabel('每行数量').selectOption('1')
    await historyLayout.getByLabel('单行高度（占工作区）').selectOption('48')
    const grid = page.locator('.history-shell-grid')
    await expect(grid).toHaveAttribute('data-columns', '1')
    await expect(grid).toHaveAttribute('data-row-height-percent', '48')

    await firstHost.click({ button: 'right' })
    const menu = page.getByRole('menu', { name: '历史 Shell 操作 127.0.0.1', exact: true })
    await expect(menu.getByRole('menuitem', { name: '重连', exact: true })).toBeEnabled()
  } finally {
    await app?.close()
    await closeServer(sshServer.server)
  }
})

test('duplicates a live terminal, previews read-only history, and reconnects it into the selected history chat', async ({ launchApp }) => {
  const sshServer = await startSshServer()
  let app: ElectronApplication | undefined

  try {
    app = (await launchApp()).app
    const page = await app.firstWindow()

    await createNamedChat(page, '历史重连')
    await connect(page, sshServer.port, '127.0.0.1')
    const originalPane = page.locator('[data-testid^="terminal-pane-"]:visible').first()
    await sendCommand(originalPane, page, 'history-preview')
    await expect(originalPane).toContainText('echo:history-preview')

    await page.getByRole('button', { name: '终端操作 127.0.0.1', exact: true }).click()
    const terminalMenu = page.getByRole('menu', { name: '终端操作 127.0.0.1', exact: true })
    await expect(terminalMenu.getByRole('menuitem', { name: '重新连接', exact: true })).toBeDisabled()
    await terminalMenu.getByRole('menuitem', { name: '复制 SSH 通道', exact: true }).click()
    await expect(page.locator('[data-testid^="terminal-pane-"]')).toHaveCount(2)
    const copyPane = page.locator('[data-testid^="terminal-pane-"]:visible').last()
    await sendCommand(copyPane, page, 'history-preview-copy')
    await expect(copyPane).toContainText('echo:history-preview-copy')

    const closeButtons = page.getByRole('button', { name: '关闭画布终端会话 127.0.0.1', exact: true })
    await closeButtons.last().click()
    await closeButtons.first().click()
    await expect(page.getByLabel('任务 Shell 历史回放')).toBeVisible()
    const historyPreview = page.getByLabel('只读终端历史 127.0.0.1', { exact: true })
    await expect(historyPreview).toHaveAttribute('data-read-only', 'true')
    await expect(historyPreview).toContainText('echo:history-preview')

    const historyTab = page.locator('.history-shell-tab').first()
    await historyTab.click({ button: 'right' })
    const historyMenu = page.getByRole('menu', { name: '历史 Shell 操作 127.0.0.1', exact: true })
    await expect(historyMenu.getByRole('menuitem', { name: '重连', exact: true })).toBeEnabled()
    await historyMenu.getByRole('menuitem', { name: '查看 Shell 历史', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Shell 历史', exact: true })).toBeVisible()
    await page.getByRole('dialog', { name: 'Shell 历史', exact: true }).getByRole('button', { name: '关闭 Shell 历史', exact: true }).click()

    const historyButton = page.getByRole('button', { name: '查看 Shell 历史 127.0.0.1', exact: true })
    await historyButton.click()
    const dialog = page.getByRole('dialog', { name: 'Shell 历史', exact: true })
    const firstHistoryRecord = dialog.getByRole('option', { name: /选择 Shell 历史 127\.0\.0\.1/ }).first()
    await expect(firstHistoryRecord).toBeFocused()
    const dialogClose = dialog.getByRole('button', { name: '关闭 Shell 历史', exact: true })
    await dialogClose.focus()
    await page.keyboard.press('Shift+Tab')
    await expect(dialog.getByRole('button', { name: '重新连接', exact: true })).toBeFocused()
    await firstHistoryRecord.focus()
    await page.keyboard.press('Escape')
    await expect(historyButton).toBeFocused()

    await historyButton.click()
    await expect(dialog.getByRole('button', { name: '重新连接', exact: true })).toBeEnabled()
    await dialog.getByRole('button', { name: '重新连接', exact: true }).click()
    const reconnectedPane = page.locator('[data-testid^="terminal-pane-"]:visible')
    await expect(reconnectedPane).toHaveCount(1)
    await sendCommand(reconnectedPane, page, 'after-reconnect')
    await expect(reconnectedPane).toContainText('echo:after-reconnect')

    const retainedHistoryTab = page.locator('.history-shell-tab').first()
    await expect(retainedHistoryTab).toBeVisible()
    await retainedHistoryTab.click({ button: 'right' })
    const hybridHistoryMenu = page.getByRole('menu', { name: '历史 Shell 操作 127.0.0.1', exact: true })
    await expect(hybridHistoryMenu.getByRole('menuitem', { name: '重连', exact: true })).toBeEnabled()
    await hybridHistoryMenu.getByRole('menuitem', { name: '查看 Shell 历史', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Shell 历史', exact: true })).toBeVisible()
    await expect(page.locator('[data-testid^="terminal-pane-"]:visible')).toHaveCount(1)
    await page.getByRole('dialog', { name: 'Shell 历史', exact: true }).getByRole('button', { name: '关闭 Shell 历史', exact: true }).click()

    await createNamedChat(page, '另一实时聊天')
    await connect(page, sshServer.port, '127.0.0.2')
    await expect(page.getByRole('button', { name: '选择终端会话 127.0.0.2', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '选择任务 历史重连', exact: true }).click()
    await expect(page.getByRole('button', { name: '选择终端会话 127.0.0.1', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '选择终端会话 127.0.0.2', exact: true })).toHaveCount(0)
  } finally {
    await app?.close()
    await closeServer(sshServer.server)
  }
})

test('transfers a running Shell before deleting its live chat', async ({ launchApp }) => {
  const sshServer = await startSshServer()
  let app: ElectronApplication | undefined

  try {
    app = (await launchApp()).app
    const page = await app.firstWindow()

    await page.getByRole('button', { name: '新建任务', exact: true }).click()
    await connect(page, sshServer.port)
    await connect(page, sshServer.port, '127.0.0.2')
    await removeActiveTask(page)

    const firstSessionTab = page.getByRole('button', { name: '选择终端会话 127.0.0.1', exact: true })
    const secondSessionTab = page.getByRole('button', { name: '选择终端会话 127.0.0.2', exact: true })
    const panes = page.locator('[data-testid^="terminal-pane-"]:visible')
    await expect(page.locator('.history-item')).toHaveCount(1)
    await expect(firstSessionTab).toBeVisible()
    await expect(secondSessionTab).toBeVisible()
    await expect(panes).toHaveCount(2)
    await firstSessionTab.click()
    await sendCommand(panes.first(), page, 'first-after-delete')
    await expect(panes.first()).toContainText('echo:first-after-delete')
    await secondSessionTab.click()
    await sendCommand(panes.last(), page, 'second-after-delete')
    await expect(panes.last()).toContainText('echo:second-after-delete')

    await page.reload()

    await expect(firstSessionTab).toBeVisible()
    await expect(secondSessionTab).toBeVisible()
    await expect(panes).toHaveCount(2)
    await secondSessionTab.click()
    await sendCommand(panes.last(), page, 'after-reload')
    await expect(panes.last()).toContainText('echo:after-reload')
    await page.getByRole('button', { name: '关闭终端会话 127.0.0.2', exact: true }).click()
    await expect(secondSessionTab).toHaveCount(0)
    await page.getByRole('button', { name: '关闭终端会话 127.0.0.1', exact: true }).click()
    await expect(firstSessionTab).toHaveCount(0)
  } finally {
    await app?.close()
    await closeServer(sshServer.server)
  }
})

test('restores authoritative multi-chat session ownership and fallback layouts', async ({ launchApp }) => {
  const sshServer = await startSshServer()
  let app: ElectronApplication | undefined

  try {
    app = (await launchApp()).app
    const page = await app.firstWindow()

    await page.getByRole('button', { name: '新建任务', exact: true }).click()
    await connect(page, sshServer.port, '127.0.0.1')

    await page.getByRole('button', { name: '新建任务', exact: true }).click()
    await connect(page, sshServer.port, '127.0.0.2')
    await connect(page, sshServer.port, '127.0.0.3')

    await page.reload()

    await expect(page.locator('.history-item')).toHaveCount(2)
    await expect(page.locator('.history-item.active .chat-select')).toHaveAttribute('aria-current', 'page')
    await expect(page.getByRole('button', { name: '选择终端会话 127.0.0.2', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '选择终端会话 127.0.0.3', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '选择终端会话 127.0.0.1', exact: true })).toHaveCount(0)
    await expect(page.locator('body')).not.toContainText('无法同步已有终端会话。')

    const secondBSession = page.getByRole('button', { name: '选择终端会话 127.0.0.3', exact: true })
    await secondBSession.click()
    await expect(secondBSession.locator('..')).toHaveClass(/active/)

    await page.locator('.history-item:not(.active) .chat-select').click()
    await expect(page.getByRole('button', { name: '选择终端会话 127.0.0.1', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '选择终端会话 127.0.0.2', exact: true })).toHaveCount(0)
    await expect(page.locator('[data-testid^="terminal-pane-"]:visible')).toHaveCount(1)

    await page.locator('.history-item:not(.active) .chat-select').click()
    await expect(page.getByRole('button', { name: '选择终端会话 127.0.0.2', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '选择终端会话 127.0.0.3', exact: true })).toBeVisible()
    await expect(secondBSession.locator('..')).toHaveClass(/active/)
    await expect(page.locator('[data-testid^="terminal-pane-"]:visible')).toHaveCount(2)

    await page.getByRole('button', { name: '关闭终端会话 127.0.0.3', exact: true }).click()
    await page.getByRole('button', { name: '关闭终端会话 127.0.0.2', exact: true }).click()
    await expect(page.getByRole('button', { name: '选择终端会话 127.0.0.2', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '选择终端会话 127.0.0.3', exact: true })).toHaveCount(0)
    await expect(page.getByText('辅助驾驶 - 变更需人工确认', { exact: true })).toHaveCount(0)

    await removeActiveTask(page)
    await expect(page.locator('.history-item')).toHaveCount(1)
    await expect(page.locator('.history-item.active .chat-select')).toHaveAttribute('aria-current', 'page')
    await expect(page.getByRole('button', { name: '选择终端会话 127.0.0.1', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '选择终端会话 127.0.0.2', exact: true })).toHaveCount(0)
  } finally {
    await app?.close()
    await closeServer(sshServer.server)
  }
})

test('preserves the authoritative workspace layout across another live chat and history', async ({ launchApp }) => {
  const sshServer = await startSshServer()
  let app: ElectronApplication | undefined

  try {
    app = (await launchApp()).app
    const page = await app.firstWindow()

    await createNamedChat(page, '聊天 B')
    await connect(page, sshServer.port, '127.0.0.1')
    await createNamedChat(page, '聊天 A')
    await connect(page, sshServer.port, '127.0.0.2')
    await createNamedChat(page, '历史 H')
    await connect(page, sshServer.port, '127.0.0.3')
    await page.getByRole('button', { name: '关闭终端会话 127.0.0.3', exact: true }).click()
    await page.getByRole('button', { name: '选择任务 历史 H', exact: true }).click()
    await expect(page.getByLabel('任务 Shell 历史回放')).toBeVisible()

    await page.getByRole('button', { name: '选择任务 聊天 B', exact: true }).click()
    await connect(page, sshServer.port, '127.0.0.4')
    const activeBSession = page.getByRole('button', { name: '选择终端会话 127.0.0.4', exact: true })
    await expect(activeBSession.locator('..')).toHaveClass(/active/)

    await page.getByRole('button', { name: 'Shell 布局', exact: true }).click()
    await expect(page.getByLabel('Shell 布局设置')).toBeVisible()
    await page.getByRole('button', { name: '选择任务 聊天 A', exact: true }).click()
    await expect(page.getByRole('button', { name: '选择终端会话 127.0.0.2', exact: true })).toBeVisible()
    await expect(page.locator('[data-testid^="terminal-pane-"]:visible')).toHaveCount(1)
    await expect(page.getByLabel('Shell 布局设置')).toHaveCount(0)

    await page.getByRole('button', { name: '选择任务 聊天 B', exact: true }).click()
    await page.getByRole('button', { name: '最大化终端会话 127.0.0.4', exact: true }).click()
    await page.getByRole('button', { name: '选择任务 聊天 A', exact: true }).click()
    await expect(page.getByRole('button', { name: '选择终端会话 127.0.0.2', exact: true })).toBeVisible()
    await expect(page.locator('[data-testid^="terminal-pane-"]:visible')).toHaveCount(1)

    await page.getByRole('button', { name: '选择任务 历史 H', exact: true }).click()
    await expect(page.getByLabel('任务 Shell 历史回放')).toBeVisible()
    await page.getByRole('button', { name: '选择任务 聊天 B', exact: true }).click()

    await expect(page.getByRole('button', { name: '选择终端会话 127.0.0.1', exact: true })).toBeVisible()
    await expect(activeBSession).toBeVisible()
    await expect(activeBSession.locator('..')).toHaveClass(/active/)
    await expect(page.locator('[data-testid^="terminal-pane-"]:visible')).toHaveCount(2)
  } finally {
    await app?.close()
    await closeServer(sshServer.server)
  }
})

test('layout controls persist while hidden terminals remain mounted and online', async ({ launchApp }) => {
  const sshServer = await startSshServer()
  let app: ElectronApplication | undefined

  try {
    app = (await launchApp()).app
    const page = await app.firstWindow()
    for (const host of ['127.0.0.1', '127.0.0.2', '127.0.0.3', '127.0.0.4']) {
      await connect(page, sshServer.port, host)
    }

    const allPanes = page.locator('[data-testid^="terminal-pane-"]')
    const originalPanes = await allPanes.elementHandles()
    await expect(allPanes).toHaveCount(4)
    await page.getByRole('button', { name: 'Shell 布局', exact: true }).click()
    await page.getByLabel('当前展示数量').selectOption('2')
    await page.getByLabel('每行数量').selectOption('1')
    await page.getByLabel('单行高度（占工作区）').selectOption('48')

    const grid = page.getByLabel('可见终端面板')
    await expect(allPanes.filter({ visible: true })).toHaveCount(2)
    await expect(grid).toHaveAttribute('data-columns', '1')
    await expect(grid).toHaveAttribute('data-row-height-percent', '48')
    for (const pane of originalPanes) expect(await pane.evaluate(node => node.isConnected)).toBe(true)

    await page.getByRole('button', { name: 'Shell 布局', exact: true }).click()
    await page.getByRole('button', { name: '选择终端会话 127.0.0.4', exact: true }).click()
    const fourthPane = page.getByLabel('终端会话 127.0.0.4', { exact: true })
    await expect(fourthPane).toBeVisible()
    await sendCommand(fourthPane, page, 'after-layout-hide')
    await expect(fourthPane).toContainText('echo:after-layout-hide')

    await expect.poll(() => page.evaluate(() => window.terminalAgent.settings.appearance.get())).toMatchObject({
      visibleCount: 2,
      columns: 1,
      rowHeightPercent: 48,
    })
    await page.evaluate(() => window.terminalAgent.settings.appearance.saveTheme('graphite'))
    const activeTaskButton = page.locator('button.chat-select[aria-current="page"]')
    const activeTaskName = await activeTaskButton.getAttribute('aria-label')
    expect(activeTaskName).toBeTruthy()
    await page.reload()

    await expect(page.locator('.workbench-shell')).toHaveClass(/theme-graphite/)
    await page.getByRole('button', { name: activeTaskName!, exact: true }).click()
    await page.getByRole('button', { name: 'Shell 布局', exact: true }).click()
    await expect(page.getByLabel('当前展示数量')).toHaveValue('2')
    await expect(page.getByLabel('每行数量')).toHaveValue('1')
    await expect(page.getByLabel('单行高度（占工作区）')).toHaveValue('48')
    await page.setViewportSize({ width: 900, height: 700 })
    const narrowGeometry = await page.evaluate(() => {
      const element = (selector: string): HTMLElement => {
        const element = document.querySelector(selector)
        if (!(element instanceof HTMLElement)) throw new Error(`Missing visual element: ${selector}`)
        return element
      }
      const bounds = (selector: string): DOMRect => element(selector).getBoundingClientRect()
      const appActions = bounds('.app-header-actions')
      const headerStyle = getComputedStyle(element('.app-header'))
      // padding-right is the browser-resolved pixel value; the custom property may remain a max(...) expression.
      const controlsInset = Number.parseFloat(headerStyle.paddingRight) - 14
      const diagnostics = (selector: string) => {
        const target = element(selector)
        const box = target.getBoundingClientRect()
        const style = getComputedStyle(target)
        return {
          left: box.left,
          right: box.right,
          width: box.width,
          clientWidth: target.clientWidth,
          scrollWidth: target.scrollWidth,
          position: style.position,
          minWidth: style.minWidth,
          flexGrow: style.flexGrow,
          flexShrink: style.flexShrink,
          flexBasis: style.flexBasis,
          overflowX: style.overflowX,
        }
      }
      const shellToolbar = bounds('.shell-toolbar-content')
      const hostbarTools = bounds('.hostbar-tools')
      const chatPanel = bounds('.global-chat-panel')
       const safetyBadge = bounds('.ai-safety-badge')
      const chatInput = bounds('.global-chat-panel textarea')
      const sendButton = bounds('.global-chat-panel .send-button')
      const withinPanel = (item: DOMRect) => item.left >= chatPanel.left && item.right <= chatPanel.right
      return {
        toolbarHeight: shellToolbar.height,
        appHeaderHeight: bounds('.app-header').height,
        controlsInset,
        appActionsClearControls: appActions.right <= window.innerWidth - controlsInset + 0.5,
        hostbarToolsOverflowPx: Math.max(0, hostbarTools.right - shellToolbar.right),
        chatPanelFitsViewport: chatPanel.left >= 0 && chatPanel.right <= window.innerWidth,
         safetyBadgeFits: withinPanel(safetyBadge),
        inputFits: withinPanel(chatInput),
        sendFits: withinPanel(sendButton),
        noPageOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        shellRegion: diagnostics('.shell-region'),
        shellToolbar: diagnostics('.shell-toolbar-content'),
        sessionTabs: diagnostics('.session-tabs'),
        hostbarTools: diagnostics('.hostbar-tools'),
      }
    })
    expect(narrowGeometry.toolbarHeight).toBeLessThanOrEqual(43)
    expect(narrowGeometry.appHeaderHeight).toBe(48)
    expect(narrowGeometry.controlsInset).toBeGreaterThanOrEqual(138)
    expect(narrowGeometry.appActionsClearControls).toBe(true)
    expect(narrowGeometry.hostbarTools.left).toBeGreaterThanOrEqual(narrowGeometry.shellToolbar.left)
    expect(narrowGeometry.hostbarToolsOverflowPx, JSON.stringify(narrowGeometry, null, 2)).toBeLessThan(0.5)
    expect(narrowGeometry.sessionTabs.scrollWidth).toBeGreaterThan(narrowGeometry.sessionTabs.clientWidth)
    expect(narrowGeometry.chatPanelFitsViewport).toBe(true)
    expect(narrowGeometry.safetyBadgeFits).toBe(true)
    expect(narrowGeometry.inputFits).toBe(true)
    expect(narrowGeometry.sendFits).toBe(true)
    expect(narrowGeometry.noPageOverflow).toBe(true)
  } finally {
    await app?.close()
    await closeServer(sshServer.server)
  }
})

test('opens terminal clipboard actions from a right click and routes them through xterm', async ({ launchApp }) => {
  const sshServer = await startSshServer()
  let app: ElectronApplication | undefined

  try {
    app = (await launchApp()).app
    const page = await app.firstWindow()
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          readText: () => Promise.resolve('clipboard-paste\r'),
          writeText: (value: string) => {
            ;(window as Window & { __terminalAgentClipboardWrite?: string }).__terminalAgentClipboardWrite = value
            return Promise.resolve()
          },
        },
      })
    })
    await page.reload()
    await connect(page, sshServer.port)

    const pane = page.getByLabel('终端会话 127.0.0.1', { exact: true })
    const menu = page.getByRole('menu', { name: '终端剪贴板操作', exact: true })
    await pane.click({ button: 'right' })
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: '复制', exact: true })).toBeDisabled()
    await expect(menu.getByRole('menuitem', { name: '粘贴', exact: true })).toBeEnabled()
    await expect(menu.getByRole('menuitem', { name: '全选', exact: true })).toBeEnabled()
    await expect(menu.getByRole('menuitem', { name: '取消选择', exact: true })).toBeDisabled()

    await menu.getByRole('menuitem', { name: '粘贴', exact: true }).click()
    await expect(pane).toContainText('echo:clipboard-paste')

    await pane.click({ button: 'right' })
    await menu.getByRole('menuitem', { name: '全选', exact: true }).click()
    await pane.click({ button: 'right' })
    await expect(menu.getByRole('menuitem', { name: '复制', exact: true })).toBeEnabled()
    await expect(menu.getByRole('menuitem', { name: '取消选择', exact: true })).toBeEnabled()
    await menu.getByRole('menuitem', { name: '复制', exact: true }).click()
    await expect.poll(() => page.evaluate(() => (window as Window & { __terminalAgentClipboardWrite?: string }).__terminalAgentClipboardWrite ?? '')).not.toBe('')

    await pane.click({ button: 'right' })
    await expect(menu.getByRole('menuitem', { name: '复制', exact: true })).toBeDisabled()
    await expect(menu.getByRole('menuitem', { name: '取消选择', exact: true })).toBeDisabled()
  } finally {
    await app?.close()
    await closeServer(sshServer.server)
  }
})

test('captures WebContents layouts across persisted themes with native-control safe-area checks', async ({ launchApp }, testInfo) => {
  test.setTimeout(90_000)
  let app: ElectronApplication | undefined

  try {
    app = (await launchApp()).app
    const page = await app.firstWindow()
    await createNamedChat(page, '标题栏布局 E2E')
    const globalChatInput = page.getByLabel('聊天输入', { exact: true })

    for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }] as const) {
      await page.setViewportSize(viewport)
      for (const theme of [
        { id: 'pearl', control: '珍珠白' },
        { id: 'graphite', control: '石墨黑' },
      ] as const) {
        const continuingDraft = `切换设置后继续保留的聊天草稿 ${theme.id} ${viewport.width}`
        await globalChatInput.fill(continuingDraft)
        const settingsButton = page.getByRole('button', { name: '设置', exact: true })
        const settingsButtonBox = await settingsButton.boundingBox()
        if (!settingsButtonBox) throw new Error('Expected the workbench settings action to be visible')
        await page.mouse.click(settingsButtonBox.x + settingsButtonBox.width / 2, settingsButtonBox.y + settingsButtonBox.height / 2)
        await expect(page.locator('.settings')).toBeVisible()
        await page.getByRole('navigation', { name: '设置面板' }).getByRole('button', { name: '外观', exact: true }).click()
        await page.getByRole('group', { name: '工作台主题', exact: true }).getByRole('button', { name: theme.control }).click()
        await expect(page.getByRole('status')).toContainText('外观已保存')
        await expect.poll(() => page.evaluate(() => window.terminalAgent.settings.appearance.get())).toMatchObject({ theme: theme.id })

        // These PNGs capture renderer WebContents only. Task 9 verifies packaged Windows frame controls separately.
        const settingsScreenshot = await page.screenshot({ path: testInfo.outputPath(`webcontents-settings-${theme.id}-${viewport.width}x${viewport.height}.png`) })
        assertViewportPng(settingsScreenshot, viewport)
        expect(await webContentsSafeAreaGeometry(page, '.settings-top', 16)).toMatchObject({
          controlsInsetAtLeastMinimum: true,
          rightmostHeaderContentClearsNativeControlSafeArea: true,
          noHorizontalOverflow: true,
        })

        const backButton = page.getByRole('button', { name: '返回工作台', exact: true })
        const backButtonBox = await backButton.boundingBox()
        if (!backButtonBox) throw new Error('Expected the settings back action to be visible')
        await page.mouse.click(backButtonBox.x + backButtonBox.width / 2, backButtonBox.y + backButtonBox.height / 2)
        await expect(page.locator('.workbench-shell')).toBeVisible()
        await expect(page.locator('.workbench-shell')).toHaveClass(new RegExp(`theme-${theme.id}`))
        await expect(globalChatInput).toHaveValue(continuingDraft)

        await page.reload()
        await expect(page.locator('.workbench-shell')).toHaveClass(new RegExp(`theme-${theme.id}`))
        await expect(globalChatInput).toBeEnabled()
        const workbenchScreenshot = await page.screenshot({ path: testInfo.outputPath(`webcontents-workbench-${theme.id}-${viewport.width}x${viewport.height}.png`) })
        assertViewportPng(workbenchScreenshot, viewport)
        expect(await webContentsSafeAreaGeometry(page, '.app-header', 14)).toMatchObject({
          controlsInsetAtLeastMinimum: true,
          rightmostHeaderContentClearsNativeControlSafeArea: true,
          noHorizontalOverflow: true,
        })
      }
    }
  } finally {
    await app?.close()
  }
})

test('collapse rails and separator keyboard bounds persist after reload', async ({ launchApp }) => {
  let app: ElectronApplication | undefined

  try {
    app = (await launchApp()).app
    const page = await app.firstWindow()
    const leftSeparator = page.getByRole('separator', { name: '调整任务历史区宽度' })
    const rightSeparator = page.getByRole('separator', { name: '调整 AI工作区宽度' })

    await expect(leftSeparator).toHaveAttribute('aria-valuenow', '222')
    const leftBox = await leftSeparator.boundingBox()
    if (!leftBox) throw new Error('Expected a visible left separator')
    await page.mouse.move(leftBox.x + leftBox.width / 2, leftBox.y + leftBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(leftBox.x + leftBox.width / 2 + 24, leftBox.y + leftBox.height / 2)
    await page.mouse.up()
    const draggedLeftWidth = Number(await leftSeparator.getAttribute('aria-valuenow'))
    expect(draggedLeftWidth).toBeGreaterThan(222)
    await expect.poll(() => page.evaluate(() => window.terminalAgent.settings.appearance.get().then(value => value.leftWidth))).toBe(draggedLeftWidth)

    await leftSeparator.focus()
    for (let index = 0; index < 16; index += 1) await page.keyboard.press('ArrowLeft')
    await expect(leftSeparator).toHaveAttribute('aria-valuenow', '210')

    await rightSeparator.focus()
    for (let index = 0; index < 16; index += 1) await page.keyboard.press('ArrowLeft')
    await expect(rightSeparator).toHaveAttribute('aria-valuenow', '520')

    await page.getByRole('button', { name: '收起任务历史区', exact: true }).click()
    await page.getByRole('button', { name: '收起 AI工作区', exact: true }).click()
    await expect(page.getByRole('button', { name: '展开任务历史区', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '展开 AI工作区', exact: true })).toBeVisible()
    await expect.poll(() => page.evaluate(() => window.terminalAgent.settings.appearance.get())).toMatchObject({
      leftWidth: 210,
      rightWidth: 520,
      leftCollapsed: true,
      rightCollapsed: true,
    })

    await page.reload()
    await expect(page.getByRole('button', { name: '展开任务历史区', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '展开 AI工作区', exact: true })).toBeVisible()
    await expect(leftSeparator).toHaveAttribute('aria-valuenow', '210')
    await expect(rightSeparator).toHaveAttribute('aria-valuenow', '520')
  } finally {
    await app?.close()
  }
})

test('maximize and restore preserve every connected terminal DOM node', async ({ launchApp }) => {
  const sshServer = await startSshServer()
  let app: ElectronApplication | undefined

  try {
    app = (await launchApp()).app
    const page = await app.firstWindow()
    await connect(page, sshServer.port, '127.0.0.1')
    await connect(page, sshServer.port, '127.0.0.2')
    await connect(page, sshServer.port, '127.0.0.3')
    const panes = page.locator('[data-testid^="terminal-pane-"]')
    const originalPanes = await panes.elementHandles()

    await page.getByRole('button', { name: '最大化终端会话 127.0.0.2', exact: true }).click()
    await expect(panes.filter({ visible: true })).toHaveCount(1)
    await expect(page.getByRole('button', { name: '还原终端会话 127.0.0.2', exact: true })).toBeVisible()
    await expect(page.locator('.shell-toolbar-content')).toBeHidden()
    await expect(page.locator('.session-tabs')).toBeHidden()
    const canvasBox = await page.locator('.canvas-content').boundingBox()
    const maximizedFrameBox = await page.locator('.terminal-frame:visible').boundingBox()
    if (!canvasBox || !maximizedFrameBox) throw new Error('Expected maximized Shell canvas geometry')
    expect(maximizedFrameBox.height).toBeGreaterThanOrEqual(canvasBox.height - 22)
    expect(maximizedFrameBox.width).toBeGreaterThanOrEqual(canvasBox.width - 22)
    for (const pane of originalPanes) expect(await pane.evaluate(node => node.isConnected)).toBe(true)

    await page.getByRole('button', { name: '还原终端会话 127.0.0.2', exact: true }).click()
    await expect(panes.filter({ visible: true })).toHaveCount(3)
    for (const pane of originalPanes) expect(await pane.evaluate(node => node.isConnected)).toBe(true)

    await page.getByRole('button', { name: '关闭画布终端会话 127.0.0.3', exact: true }).click()
    await expect(panes).toHaveCount(2)
  } finally {
    await app?.close()
    await closeServer(sshServer.server)
  }
})

test('shows all four SSH connection modes and a safe unavailable CMDB state', async ({ launchApp }) => {
  let app: ElectronApplication | undefined

  try {
    app = (await launchApp()).app
    const page = await app.firstWindow()

    await expect(page.getByRole('tab', { name: '堡垒机 CMDB 唤起', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('tab', { name: '堡垒机主机唤起', exact: true })).toBeVisible()
    await expect(page.getByRole('tab', { name: '主机用户名 + 密码连接', exact: true })).toBeVisible()
    await expect(page.getByRole('tab', { name: '主机私钥连接', exact: true })).toBeVisible()
    await expect(page.getByText('未配置堡垒机目录来源。', { exact: true })).toBeVisible()
  } finally {
    await app?.close()
  }
})

test('opens the unified launcher over an existing terminal without unmounting it', async ({ launchApp }) => {
  const sshServer = await startSshServer()
  let app: ElectronApplication | undefined

  try {
    app = (await launchApp()).app
    const page = await app.firstWindow()
    const panes = page.locator('[data-testid^="terminal-pane-"]')
    await connect(page, sshServer.port)
    const originalPane = await panes.first().elementHandle()
    if (!originalPane) throw new Error('Expected the connected SSH terminal pane')

    await page.locator('.shell-toolbar-content').getByRole('button', { name: '新建 SSH 连接', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '新建 SSH 连接', exact: true })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('未配置堡垒机目录来源。', { exact: true })).toBeVisible()
    expect(await originalPane.evaluate(node => node.isConnected)).toBe(true)
    await dialog.getByRole('tab', { name: '主机用户名 + 密码连接', exact: true }).click()
    await expect(dialog.getByLabel('主机地址')).toBeVisible()
  } finally {
    await app?.close()
    await closeServer(sshServer.server)
  }
})

test('ignores a late direct connection after newer chat navigation and dialog generations', async ({ launchApp }) => {
  const initialServer = await startSshServer()
  const firstAuthenticationStarted = deferred<void>()
  const releaseFirstAuthentication = deferred<void>()
  const firstDelayedServer = await startSshServer(async () => {
    firstAuthenticationStarted.resolve(undefined)
    await releaseFirstAuthentication.promise
  })
  const secondAuthenticationStarted = deferred<void>()
  const releaseSecondAuthentication = deferred<void>()
  const secondDelayedServer = await startSshServer(async () => {
    secondAuthenticationStarted.resolve(undefined)
    await releaseSecondAuthentication.promise
  })
  let app: ElectronApplication | undefined

  try {
    app = (await launchApp()).app
    const page = await app.firstWindow()
    await connect(page, initialServer.port)
    await page.getByRole('button', { name: '新建任务', exact: true }).click()
    await page.locator('.history-item:not(.active) .chat-select').click()

    const openButton = page.locator('.shell-toolbar-content').getByRole('button', { name: '新建 SSH 连接', exact: true })
    await openButton.click()
    const dialog = page.getByRole('dialog', { name: '新建 SSH 连接', exact: true })
    await dialog.getByRole('tab', { name: '主机用户名 + 密码连接', exact: true }).click()
    await dialog.getByLabel('主机地址').fill('127.0.0.2')
    await dialog.getByLabel('端口').fill(String(firstDelayedServer.port))
    await dialog.getByRole('textbox', { name: '用户名', exact: true }).fill('ops')
    await dialog.getByRole('textbox', { name: '密码', exact: true }).fill('secret')
    await dialog.getByRole('button', { name: '连接', exact: true }).click()
    await firstAuthenticationStarted.promise

    await dialog.getByRole('button', { name: '关闭新建 SSH 连接', exact: true }).click()
    await page.locator('.history-item:not(.active) .chat-select').click()
    const selectedHistory = page.locator('.history-item.active .chat-select')
    const selectedHistoryLabel = await selectedHistory.getAttribute('aria-label')
    releaseFirstAuthentication.resolve(undefined)

    await expect(selectedHistory).toHaveAttribute('aria-current', 'page')
    await expect(selectedHistory).toHaveAttribute('aria-label', selectedHistoryLabel!)
    await expect(page.getByRole('button', { name: '返回实时任务', exact: true })).toHaveCount(0)
    await expect(page.locator('.history-item.active')).toContainText('1 个 Shell')
    await expect(page.locator('.history-item:not(.active)')).toContainText('1 个 Shell')

    await openButton.click()
    await dialog.getByRole('tab', { name: '主机用户名 + 密码连接', exact: true }).click()
    await dialog.getByLabel('主机地址').fill('127.0.0.3')
    await dialog.getByLabel('端口').fill(String(secondDelayedServer.port))
    await dialog.getByRole('textbox', { name: '用户名', exact: true }).fill('ops')
    await dialog.getByRole('textbox', { name: '密码', exact: true }).fill('secret')
    await dialog.getByRole('button', { name: '连接', exact: true }).click()
    await secondAuthenticationStarted.promise

    await dialog.getByRole('button', { name: '关闭新建 SSH 连接', exact: true }).click()
    await openButton.click()
    releaseSecondAuthentication.resolve(undefined)

    await expect(dialog).toBeVisible()
    await expect(page.locator('.history-item.active')).toContainText('2 个 Shell')
  } finally {
    releaseFirstAuthentication.resolve(undefined)
    releaseSecondAuthentication.resolve(undefined)
    await app?.close()
    await closeServer(initialServer.server)
    await closeServer(firstDelayedServer.server)
    await closeServer(secondDelayedServer.server)
  }
})

test('validates the private-key mode without exposing a file path in renderer text', async ({ launchApp }) => {
  let app: ElectronApplication | undefined

  try {
    app = (await launchApp()).app
    const page = await app.firstWindow()
    await page.getByRole('tab', { name: '主机私钥连接', exact: true }).click()
    await page.getByLabel('主机地址').fill('server.example.com')
    await page.getByLabel('端口').fill('22')
    await page.getByRole('textbox', { name: '用户名', exact: true }).fill('ops')
    await expect(page.getByRole('button', { name: '选择私钥文件', exact: true })).toBeVisible()
    await expect(page.getByLabel('私钥密码短语')).toBeVisible()
    await page.getByRole('button', { name: '连接', exact: true }).click()
    await expect(page.getByRole('alert')).toHaveText('请选择私钥文件。')
    await expect(page.locator('body')).not.toContainText('temporaryProfilePath')
  } finally {
    await app?.close()
  }
})

test('clears direct-connection secrets when switching authentication modes', async ({ launchApp }) => {
  let app: ElectronApplication | undefined

  try {
    app = (await launchApp()).app
    const page = await app.firstWindow()
    await page.getByRole('tab', { name: '主机用户名 + 密码连接', exact: true }).click()
    await page.getByRole('textbox', { name: '密码', exact: true }).fill('switch-only-password')
    await page.getByRole('tab', { name: '主机私钥连接', exact: true }).click()
    await page.getByRole('tab', { name: '主机用户名 + 密码连接', exact: true }).click()
    await expect(page.getByRole('textbox', { name: '密码', exact: true })).toHaveValue('')
  } finally {
    await app?.close()
  }
})

test('keeps focus inside and restores focus from the unified connection dialog', async ({ launchApp }) => {
  const sshServer = await startSshServer()
  let app: ElectronApplication | undefined

  try {
    app = (await launchApp()).app
    const page = await app.firstWindow()
    await connect(page, sshServer.port)
    const openButton = page.locator('.shell-toolbar-content').getByRole('button', { name: '新建 SSH 连接', exact: true })
    await openButton.click()
    const dialog = page.getByRole('dialog', { name: '新建 SSH 连接', exact: true })
    const closeButton = dialog.getByRole('button', { name: '关闭新建 SSH 连接', exact: true })
    await expect(dialog.getByRole('tab', { name: '堡垒机 CMDB 唤起', exact: true })).toBeFocused()
    await closeButton.focus()
    await page.keyboard.press('Shift+Tab')
    await expect(dialog.getByRole('tab', { name: '主机私钥连接', exact: true })).toBeFocused()
    await closeButton.click()
    await expect(openButton).toBeFocused()
  } finally {
    await app?.close()
    await closeServer(sshServer.server)
  }
})

test('renders two real SSH sessions in separate terminal panes with isolated output', async ({ launchApp }) => {
  const sshServer = await startSshServer()
  let app: ElectronApplication | undefined

  try {
    app = (await launchApp()).app
    const page = await app.firstWindow()

    await connect(page, sshServer.port)
    await connect(page, sshServer.port)

    const panes = page.locator('[data-testid^="terminal-pane-"]')
    await expect(panes).toHaveCount(2)
    await expect(page.getByRole('button', { name: '选择终端会话 127.0.0.1' })).toHaveCount(2)

    await sendCommand(panes.nth(0), page, 'alpha')
    await sendCommand(panes.nth(1), page, 'beta')

    await expect(panes.nth(0)).toContainText('echo:alpha')
    await expect(panes.nth(0)).not.toContainText('echo:beta')
    await expect(panes.nth(1)).toContainText('echo:beta')
    await expect(panes.nth(1)).not.toContainText('echo:alpha')
  } finally {
    await app?.close()
    await closeServer(sshServer.server)
  }
})

test('host memory settings expose the four scope controls', async ({ launchApp }) => {
  let app: ElectronApplication | undefined
  try {
    app = (await launchApp()).app
    const page = await app.firstWindow()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '本地主机记忆', exact: true }).click()
    await expect(page.getByRole('heading', { name: '本地主机记忆' })).toBeVisible()
    await expect(page.getByLabel('启用本地主机记忆')).toBeVisible()
    for (const label of [
      '主机名、连接 IP、操作系统和基础版本',
      'CPU、内存、磁盘、网络等基础信息',
      '运行进程名称、PID 和进程工作目录',
      '当前用户、工作目录和常用服务状态',
    ]) await expect(page.getByLabel(label)).toBeVisible()
  } finally { await app?.close() }
})

test('memory disclosure controls keep the workbench terminal mount intact', async ({ launchApp }) => {
  const sshServer = await startSshServer()
  let app: ElectronApplication | undefined
  try {
    app = (await launchApp()).app
    const page = await app.firstWindow()
    await connect(page, sshServer.port)
    const pane = page.locator('[data-testid^="terminal-pane-"]').first()
    await expect(pane).toBeVisible()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '本地主机记忆', exact: true }).click()
    await page.getByRole('button', { name: '返回工作台', exact: true }).click()
    await expect(pane).toBeVisible()
  } finally { await app?.close(); await closeServer(sshServer.server) }
})

test('streams fake global AI chat, retries a failed request, and restores messages after reload', async ({ launchApp }) => {
  const fakeModel = await startFakeOllamaServer()
  let app: ElectronApplication | undefined
  try {
    app = (await launchApp()).app
    const page = await app.firstWindow()
    const endpoint = `http://127.0.0.1:${fakeModel.port}/api/chat`
    const tested = await page.evaluate(async endpointValue => {
      const input = {
        name: 'E2E Fake Ollama', kind: 'llm', provider: 'ollama', model: 'fake-e2e', endpoint: endpointValue, contextLimit: 1024,
      } as const
      const result = await window.terminalAgent.settings.models.test(input)
      const profile = await window.terminalAgent.settings.models.save(input)
      if (!profile.active) await window.terminalAgent.settings.models.activate(profile.id)
      return result
    }, endpoint)
    expect(tested).toEqual({ model: 'fake-e2e' })
    expect(fakeModel.connectionTests).toBe(1)
    await createNamedChat(page, 'AI 聊天 E2E')

    const aiWorkspace = page.getByRole('region', { name: 'AI工作区', exact: true })
    await expect(aiWorkspace).toBeVisible()
    const input = aiWorkspace.getByLabel('聊天输入')
    await expect(input).toBeEnabled()
    await input.fill('第一条消息')
    await aiWorkspace.getByRole('button', { name: '发送', exact: true }).click()
    await expect(aiWorkspace.locator('.message.assistant')).toContainText('你好，世界')

    await page.reload()
    await expect(aiWorkspace.locator('.message.user')).toContainText('第一条消息')
    await expect(aiWorkspace.locator('.message.assistant')).toContainText('你好，世界')

    await input.fill('第二条消息')
    await aiWorkspace.getByRole('button', { name: '发送', exact: true }).click()
    await expect(aiWorkspace.getByRole('alert')).toContainText('聊天运行失败，请检查模型连接后重试。')
    await aiWorkspace.getByRole('button', { name: '重试', exact: true }).click()
    await expect(aiWorkspace.locator('.message.assistant').last()).toContainText('重试成功')
    await expect(aiWorkspace.getByRole('alert')).toHaveCount(0)
    expect(fakeModel.chatRequests).toBeGreaterThanOrEqual(3)
    expect(fakeModel.requests).toBeGreaterThanOrEqual(4)
  } finally {
    await app?.close()
    await closeHttpServer(fakeModel.server)
  }
})

test('cancels a streaming global AI chat and restores its durable cancelled state', async ({ launchApp }) => {
  const fakeModel = await startCancellableOllamaServer()
  let app: ElectronApplication | undefined
  try {
    app = (await launchApp()).app
    const page = await app.firstWindow()
    const endpoint = `http://127.0.0.1:${fakeModel.port}/api/chat`
    await page.evaluate(async endpointValue => {
      const profile = await window.terminalAgent.settings.models.save({
        name: 'E2E Cancellable Ollama', kind: 'llm', provider: 'ollama', model: 'cancellable-e2e', endpoint: endpointValue, contextLimit: 1024,
      })
      if (!profile.active) await window.terminalAgent.settings.models.activate(profile.id)
    }, endpoint)
    const chatId = await createNamedChat(page, 'AI 取消 E2E')

    const input = page.getByLabel('聊天输入')
    await input.fill('取消这一条消息')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await expect(page.getByRole('button', { name: '取消', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '取消', exact: true }).click()
    await expect(page.getByRole('button', { name: '取消', exact: true })).toHaveCount(0)
    await expect(input).toBeEnabled()
    await expect(page.locator('.message.assistant')).toContainText('已取消。')
    await expect(page.getByRole('alert')).toContainText('已取消。')
    await expect(page.getByRole('button', { name: '重试', exact: true })).toHaveCount(0)
    await expect.poll(async () => page.evaluate(async id => (await window.terminalAgent.chats.get(id)).chat.messages, chatId)).toContainEqual(
      expect.objectContaining({ role: 'assistant', content: '已取消。', state: 'error', retryable: false }),
    )

    await page.reload()
    await expect(page.locator('.message.assistant')).toContainText('已取消。')
    await expect(page.getByRole('alert')).toContainText('已取消。')
    await expect(page.getByRole('button', { name: '重试', exact: true })).toHaveCount(0)
  } finally {
    fakeModel.release()
    await app?.close()
    await closeHttpServer(fakeModel.server)
  }
})

test('supersedes a streaming global AI chat from the same input and retains only the second completion', async ({ launchApp }) => {
  const fakeModel = await startSupersedingOllamaServer()
  let app: ElectronApplication | undefined
  try {
    app = (await launchApp()).app
    const page = await app.firstWindow()
    const endpoint = `http://127.0.0.1:${fakeModel.port}/api/chat`
    await page.evaluate(async endpointValue => {
      const profile = await window.terminalAgent.settings.models.save({
        name: 'E2E Superseding Ollama', kind: 'llm', provider: 'ollama', model: 'superseding-e2e', endpoint: endpointValue, contextLimit: 1024,
      })
      if (!profile.active) await window.terminalAgent.settings.models.activate(profile.id)
    }, endpoint)
    const chatId = await createNamedChat(page, 'AI 覆盖 E2E')

    const input = page.getByLabel('聊天输入')
    await input.fill('第一条会被覆盖的消息')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await expect(page.locator('.message.assistant')).toContainText('第一条响应片段')
    await expect(input).toBeEnabled()

    await input.fill('第二条替换消息')
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await expect.poll(() => fakeModel.requests).toBe(2)
    await expect.poll(() => fakeModel.firstAborted).toBe(1)
    await expect(page.locator('.message.assistant').last()).toContainText('第二条响应完成')
    await expect(page.getByRole('button', { name: '取消', exact: true })).toHaveCount(0)

    const durableMessages = await page.evaluate(async id => (await window.terminalAgent.chats.get(id)).chat.messages, chatId)
    const assistantMessages = durableMessages.filter(message => message.role === 'assistant')
    expect(assistantMessages).toEqual([
      expect.objectContaining({ content: '已取消。', state: 'error' }),
      expect.objectContaining({ content: '第二条响应完成', state: 'complete' }),
    ])
    expect(JSON.stringify(durableMessages)).not.toContain('第一条响应片段')
  } finally {
    fakeModel.release()
    await app?.close()
    await closeHttpServer(fakeModel.server)
  }
})

test('authoritatively cancels global AI before deleting its chat', async ({ launchApp }) => {
  const fakeModel = await startCancellableOllamaServer()
  let app: ElectronApplication | undefined
  try {
    app = (await launchApp()).app
    const page = await app.firstWindow()
    const endpoint = `http://127.0.0.1:${fakeModel.port}/api/chat`
    await page.evaluate(async endpointValue => {
      const profile = await window.terminalAgent.settings.models.save({
        name: 'E2E Delete Ollama', kind: 'llm', provider: 'ollama', model: 'delete-e2e', endpoint: endpointValue, contextLimit: 1024,
      })
      if (!profile.active) await window.terminalAgent.settings.models.activate(profile.id)
    }, endpoint)
    await createNamedChat(page, '待删除 AI 聊天')

    await page.getByLabel('聊天输入').fill('删除前取消')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await expect(page.getByRole('button', { name: '取消', exact: true })).toBeVisible()
    await removeActiveTask(page)
    await expect(page.getByRole('button', { name: '选择任务 待删除 AI 聊天', exact: true })).toHaveCount(0)
    await expect.poll(() => fakeModel.aborted).toBeGreaterThan(0)
  } finally {
    fakeModel.release()
    await app?.close()
    await closeHttpServer(fakeModel.server)
  }
})

test('acknowledging host memory resumes observation for the open SSH session', async ({ launchApp }) => {
  const sshServer = await startSshServer()
  let app: ElectronApplication | undefined
  try {
    app = (await launchApp()).app
    const page = await app.firstWindow()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '本地主机记忆', exact: true }).click()
    await page.getByLabel('启用本地主机记忆').check()
    await page.waitForTimeout(250)
    await expect.poll(async () => await page.evaluate(() => window.terminalAgent.settings.memory.get())).toMatchObject({ enabled: true })
    await page.getByRole('button', { name: '返回工作台', exact: true }).click()

    await connect(page, sshServer.port)
    const disclosure = page.getByRole('dialog', { name: '允许本地主机记忆？', exact: true })
    await expect(disclosure).toBeVisible()
    await expect(disclosure).toContainText('127.0.0.1')
    await expect(disclosure).not.toContainText('api-prod')
    await page.getByRole('button', { name: '我已知道', exact: true }).click()
    await expect(page.getByRole('heading', { name: '允许本地主机记忆？', exact: true })).toHaveCount(0)

    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '本地主机记忆', exact: true }).click()
    await page.getByRole('button', { name: '刷新主机记忆', exact: true }).click()
    const rememberedHosts = page.getByRole('list', { name: '已记忆主机' })
    await expect(rememberedHosts.getByText('api-prod', { exact: true })).toBeVisible({ timeout: 15000 })
    await expect(rememberedHosts.getByText('身份 3 项；硬件 4 项；进程 1 项；运行环境 3 项', { exact: true })).toBeVisible()
    await rememberedHosts.getByRole('button', { name: '查看缓存', exact: true }).click()
    for (const label of ['连接 IP', 'CPU 型号', '进程 PID', '当前用户']) {
      await expect(rememberedHosts.getByText(label, { exact: true })).toBeVisible()
    }
    await expect(rememberedHosts.getByText('Example CPU', { exact: true })).toBeVisible()
    await expect(rememberedHosts.getByText('appuser', { exact: true })).toBeVisible()
    await rememberedHosts.getByRole('button', { name: '编辑', exact: true }).click()
    const editor = rememberedHosts.getByRole('form', { name: '编辑主机记忆' })
    await editor.getByLabel('当前用户', { exact: true }).fill('deployuser')
    await editor.getByRole('button', { name: '保存', exact: true }).click()
    await expect(editor).toHaveCount(0)
    await expect(rememberedHosts.getByText('deployuser', { exact: true })).toBeVisible()
    const clear = page.getByRole('button', { name: '清除', exact: true })
    await clear.focus()
    await clear.click()
    const clearDialog = page.getByRole('dialog', { name: '确认清除主机记忆', exact: true })
    await expect(clearDialog).toBeVisible()
    await expect(page.getByRole('button', { name: '确认清除', exact: true })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(page.getByRole('button', { name: '取消', exact: true })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(page.getByRole('button', { name: '确认清除', exact: true })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(clearDialog).toHaveCount(0)
    await expect(clear).toBeFocused()
  } finally { await app?.close(); await closeServer(sshServer.server) }
})

test('clearing acknowledged host memory persists removal and requires fresh SSH disclosure after restart', async ({ launchApp }) => {
  test.setTimeout(60_000)
  const sshServer = await startSshServer()
  let app: ElectronApplication | undefined
  let restarted: ElectronApplication | undefined
  try {
    const launch = await launchApp()
    app = launch.app
    const initialApp = launch.app
    const page = await app.firstWindow()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '本地主机记忆', exact: true }).click()
    await page.getByLabel('启用本地主机记忆').check()
    await expect.poll(async () => await page.evaluate(() => window.terminalAgent.settings.memory.get())).toMatchObject({ enabled: true })
    await page.getByRole('button', { name: '返回工作台', exact: true }).click()

    await connect(page, sshServer.port)
    const disclosure = page.getByRole('dialog', { name: '允许本地主机记忆？', exact: true })
    await expect(disclosure).toBeVisible()
    await page.getByRole('button', { name: '我已知道', exact: true }).click()

    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '本地主机记忆', exact: true }).click()
    await page.getByRole('button', { name: '刷新主机记忆', exact: true }).click()
    const rememberedHosts = page.getByRole('list', { name: '已记忆主机' })
    await expect(rememberedHosts.getByText('api-prod', { exact: true })).toBeVisible({ timeout: 15_000 })
    await rememberedHosts.getByRole('button', { name: '清除', exact: true }).click()
    const clearDialog = page.getByRole('dialog', { name: '确认清除主机记忆', exact: true })
    await expect(clearDialog).toBeVisible()
    await page.getByRole('button', { name: '确认清除', exact: true }).click()
    await expect(clearDialog).toHaveCount(0)
    await expect(rememberedHosts.getByText('api-prod', { exact: true })).toHaveCount(0)
    await expect.poll(async () => await page.evaluate(() => window.terminalAgent.settings.memory.getHost('api-prod'))).toBeNull()

    await test.step('closes the cleared SSH session before restart', async () => {
      await page.getByRole('button', { name: '返回工作台', exact: true }).click()
      await page.getByRole('button', { name: '关闭终端会话 127.0.0.1', exact: true }).click()
      await expect(page.locator('[data-testid^="terminal-pane-"]')).toHaveCount(0)
    }, { timeout: 10_000 })

    let restartedPage: Awaited<ReturnType<ElectronApplication['firstWindow']>>
    await test.step('restarts the same user-data directory', async () => {
      await within(10_000, 'Electron did not close after the cleared SSH session ended', initialApp.close())
      app = undefined
      restarted = await within(10_000, 'Electron did not restart from the cleared user-data directory', electron.launch({ args: [`--user-data-dir=${launch.userDataDir}`, launch.mainEntry] }))
      restartedPage = await restarted.firstWindow()
      restartedPage.setDefaultTimeout(10_000)
      await expect.poll(async () => await restartedPage.evaluate(() => window.terminalAgent.settings.memory.getHost('api-prod'))).toBeNull()
      await restartedPage.waitForTimeout(1_000)
      expect(restarted.process().exitCode).toBeNull()
    }, { timeout: 15_000 })

    await test.step('reconnects the same endpoint through the visible SSH form', async () => {
      const newChat = restartedPage.getByRole('button', { name: '新建任务', exact: true })
      await expect(newChat).toBeVisible()
      await newChat.click()
      await expect(restartedPage.getByRole('tab', { name: '主机用户名 + 密码连接', exact: true })).toBeVisible()
      await connect(restartedPage, sshServer.port)
      const freshDisclosure = restartedPage.getByRole('dialog', { name: '允许本地主机记忆？', exact: true })
      await expect(freshDisclosure).toBeVisible()
      await expect(freshDisclosure).toContainText('127.0.0.1')
      await expect(freshDisclosure).not.toContainText('api-prod')
      await freshDisclosure.getByRole('button', { name: '暂不允许', exact: true }).click()
      await restartedPage.getByRole('button', { name: '关闭终端会话 127.0.0.1', exact: true }).click()
      await expect(restartedPage.locator('[data-testid^="terminal-pane-"]')).toHaveCount(0)
    }, { timeout: 20_000 })
  } finally { await restarted?.close(); await app?.close(); await closeServer(sshServer.server) }
})

test('keeps an existing SSH terminal mounted after visiting settings and returning to the workbench', async ({ launchApp }) => {
  const sshServer = await startSshServer()
  let app: ElectronApplication | undefined

  try {
    app = (await launchApp()).app
    const page = await app.firstWindow()
    const panes = page.locator('[data-testid^="terminal-pane-"]')

    await connect(page, sshServer.port)
    const originalPane = await panes.first().elementHandle()
    if (!originalPane) throw new Error('Expected the connected SSH terminal pane')
    await expect(panes).toHaveCount(1)
    await expect(panes.first()).toContainText('ready')

    await page.getByRole('button', { name: '设置', exact: true }).click()
    await expect(page.getByRole('heading', { name: '设置' })).toBeVisible()
    await page.getByRole('button', { name: '返回工作台', exact: true }).click()

    await expect(panes).toHaveCount(1)
    expect(await originalPane.evaluate(node => node.isConnected)).toBe(true)
    await sendCommand(panes.first(), page, 'after-settings')
    await expect(panes.first()).toContainText('echo:after-settings')
  } finally {
    await app?.close()
    await closeServer(sshServer.server)
  }
})

test('renders an AccessClient Raw startup session from the initial session snapshot', async ({ launchApp }) => {
  const rawServer = createServer()
  rawServer.listen(0, '127.0.0.1')
  await once(rawServer, 'listening')
  let app: ElectronApplication | undefined

  try {
    const port = (rawServer.address() as AddressInfo).port
    app = (await launchApp(['-raw', '-P', String(port)])).app
    const page = await app.firstWindow()

    await expect(page.locator('[data-testid^="terminal-pane-"]')).toHaveCount(1)
    await expect(page.getByRole('button', { name: `选择终端会话 Raw ${port}` })).toBeVisible()
  } finally {
    await app?.close()
    await closeServer(rawServer)
  }
})

test('selects an unowned startup session over persisted history', async ({ launchApp }) => {
  const historyServer = await startSshServer()
  const rawServer = createServer()
  rawServer.listen(0, '127.0.0.1')
  await once(rawServer, 'listening')
  let restarted: ElectronApplication | undefined

  try {
    const launch = await launchApp()
    const page = await launch.app.firstWindow()
    await connect(page, historyServer.port)
    const historyTitle = (await page.locator('.history-item.active strong').textContent())?.trim()
    if (!historyTitle) throw new Error('Expected a persisted history title')
    await page.getByRole('button', { name: '关闭终端会话 127.0.0.1', exact: true }).click()
    await expect(page.getByLabel('任务 Shell 历史回放')).toBeVisible()
    await launch.app.close()

    const rawPort = (rawServer.address() as AddressInfo).port
    restarted = await electron.launch({
      args: [`--user-data-dir=${launch.userDataDir}`, launch.mainEntry, '-raw', '-P', String(rawPort)],
    })
    const restoredPage = await restarted.firstWindow()

    await expect(restoredPage.getByRole('button', { name: `选择终端会话 Raw ${rawPort}` })).toBeVisible()
    const restoredHistory = restoredPage.locator('.history-item:not(.active)').filter({
      has: restoredPage.getByRole('button', { name: `选择任务 ${historyTitle}`, exact: true }),
    })
    await expect(restoredHistory).toHaveCount(1)
    await expect(restoredHistory.getByRole('button', { name: `选择任务 ${historyTitle}`, exact: true })).not.toHaveAttribute('aria-current', 'page')
    await expect(restoredPage.locator('.history-item.active')).toContainText('1 个 Shell')
  } finally {
    await restarted?.close()
    await closeServer(historyServer.server)
    await closeServer(rawServer)
  }
})

test('shows a sanitized local error for an invalid AccessClient startup without exposing temporary credentials', async ({ launchApp }) => {
  const temporaryPath = 'C:\\Users\\test-user\\AppData\\Local\\Temp\\secret-session.conf'
  const temporaryPassword = 'temporary-secret'
  let app: ElectronApplication | undefined

  try {
    app = (await launchApp(['--', '-load', `tmp:${temporaryPath}`, '-pw', temporaryPassword])).app
    const page = await app.firstWindow()

    await expect(page.getByRole('alert')).toHaveText('无法读取堡垒机临时配置。')
    await expect(page.locator('body')).not.toContainText(temporaryPassword)
    await expect(page.locator('body')).not.toContainText(temporaryPath)
  } finally {
    await app?.close()
  }
})

test('opens an AccessClient temporary SSH session with its title and initial terminal dimensions', async ({ launchApp }) => {
  const sshServer = await startSshServer()
  const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-access-client-'))
  const profilePath = join(directory, 'session.conf')
  let app: ElectronApplication | undefined

  try {
    await writeFile(profilePath, [
      'HostName=127.0.0.1',
      `PortNumber=${sshServer.port}`,
      'UserName=ops',
      'Protocol=ssh',
      'WinTitle=生产终端',
      'TermWidth=120',
      'TermHeight=40',
    ].join('\n'), 'utf8')
    app = (await launchApp(['--', '-load', `tmp:${profilePath}`, '-pw', 'secret'])).app
    const page = await app.firstWindow()

    await expect(page.locator('[data-testid^="terminal-pane-"]')).toHaveCount(1)
    await expect(page.getByRole('button', { name: '选择终端会话 127.0.0.1' })).toBeVisible()
    await expect.poll(() => sshServer.ptySizes).toContainEqual({ columns: 120, rows: 40 })
  } finally {
    await app?.close()
    await closeServer(sshServer.server)
    await rm(directory, { recursive: true, force: true })
  }
})

test('displays a CP936 AccessClient temporary session title without garbling', async ({ launchApp }) => {
  const sshServer = await startSshServer()
  const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-access-client-cp936-'))
  const profilePath = join(directory, 'session.conf')
  let app: ElectronApplication | undefined

  try {
    await writeFile(profilePath, Buffer.concat([
      Buffer.from([
        'HostName=127.0.0.1',
        `PortNumber=${sshServer.port}`,
        'UserName=ops',
        'Protocol=ssh',
        'LineCodePage=CP936',
        'WinTitle=AI',
      ].join('\n'), 'ascii'),
      Buffer.from('d6d0cca8', 'hex'),
      Buffer.from('_10.54.98.34\nTermWidth=120\nTermHeight=40', 'ascii'),
    ]))
    app = (await launchApp(['--', '-load', `tmp:${profilePath}`, '-pw', 'secret'])).app
    const page = await app.firstWindow()

    await expect(page.locator('[data-testid^="terminal-pane-"]')).toHaveCount(1)
    await expect(page.getByRole('button', { name: '选择终端会话 127.0.0.1' })).toBeVisible()
    await expect.poll(() => sshServer.ptySizes).toContainEqual({ columns: 120, rows: 40 })
  } finally {
    await app?.close()
    await closeServer(sshServer.server)
    await rm(directory, { recursive: true, force: true })
  }
})

test('adds a visible terminal session when AccessClient starts a second Electron instance', async ({ launchApp }) => {
  const rawServer = createServer()
  rawServer.listen(0, '127.0.0.1')
  await once(rawServer, 'listening')
  let app: ElectronApplication | undefined

  try {
    const port = (rawServer.address() as AddressInfo).port
    const launch = await launchApp(['-raw', '-P', String(port)])
    const { mainEntry, userDataDir } = launch
    app = launch.app
    const page = await app.firstWindow()
    const panes = page.locator('[data-testid^="terminal-pane-"]')
    await expect(panes).toHaveCount(1)

    const second = spawn(electronExecutablePath, [`--user-data-dir=${userDataDir}`, mainEntry, '--', '-raw', '-P', String(port)], {
      windowsHide: true,
      stdio: 'ignore',
    })
    await once(second, 'exit')

    await expect(panes).toHaveCount(2)
    await expect(page.locator('[data-testid^="terminal-pane-"]:visible')).toHaveCount(2)
  } finally {
    await app?.close()
    await closeServer(rawServer)
  }
})

async function connect(page: Awaited<ReturnType<ElectronApplication['firstWindow']>>, port: number, host = '127.0.0.1'): Promise<void> {
  const panes = page.locator('[data-testid^="terminal-pane-"]')
  const previousPaneCount = await panes.count()
  const embeddedLauncher = page.locator('.empty-slot')
  const embeddedLauncherTab = embeddedLauncher.getByRole('tab', { name: '主机用户名 + 密码连接', exact: true })
  const connectionDialog = page.getByRole('dialog', { name: '新建 SSH 连接', exact: true })
  const connectButton = page.locator('.shell-toolbar-content').getByRole('button', { name: '新建 SSH 连接', exact: true })
  await expect(embeddedLauncherTab.or(connectButton)).toBeVisible()
  const opensDialog = !await embeddedLauncherTab.isVisible()
  if (opensDialog) {
    await connectButton.click()
    await expect(connectionDialog).toBeVisible()
  }
  const launcher = opensDialog ? connectionDialog : embeddedLauncher
  const launcherTab = launcher.getByRole('tab', { name: '主机用户名 + 密码连接', exact: true })
  await expect(launcherTab).toBeVisible()
  await launcherTab.click()
  await launcher.getByLabel('主机地址').fill(host)
  await launcher.getByLabel('端口').fill(String(port))
  await launcher.getByRole('textbox', { name: '用户名', exact: true }).fill('ops')
  await launcher.getByRole('textbox', { name: '密码', exact: true }).fill('secret')
  await launcher.getByRole('button', { name: '连接', exact: true }).click()
  await expect(panes).toHaveCount(previousPaneCount + 1)
  if (opensDialog) await expect(connectionDialog).toHaveCount(0)
}

async function removeActiveTask(page: Awaited<ReturnType<ElectronApplication['firstWindow']>>): Promise<void> {
  const activeTask = page.locator('.history-item.active')
  await activeTask.getByRole('button', { name: /^任务操作 / }).click()
  await activeTask.getByRole('menuitem', { name: '删除', exact: true }).click()
}

async function createNamedChat(
  page: Awaited<ReturnType<ElectronApplication['firstWindow']>>,
  title: string,
): Promise<string> {
  const chatId = await page.evaluate(async chatTitle => {
    return (await window.terminalAgent.chats.create({ requestId: crypto.randomUUID(), title: chatTitle })).chat.id
  }, title)
  const chat = page.getByRole('button', { name: `选择任务 ${title}`, exact: true })
  await expect(chat).toBeVisible()
  await chat.click()
  await expect(chat).toHaveAttribute('aria-current', 'page')
  const connectButton = page.locator('.shell-toolbar-content').getByRole('button', { name: '新建 SSH 连接', exact: true })
  const launcherTab = page.getByRole('tab', { name: '主机用户名 + 密码连接', exact: true })
  const restoreButton = page.getByRole('button', { name: '返回实时任务', exact: true })
  await expect(connectButton.or(launcherTab).or(restoreButton)).toBeVisible()
  if (await restoreButton.isVisible()) await restoreButton.click()
  await expect(connectButton.or(launcherTab)).toBeVisible()
  return chatId
}

async function sendCommand(
  pane: ReturnType<Awaited<ReturnType<ElectronApplication['firstWindow']>>['locator']>,
  page: Awaited<ReturnType<ElectronApplication['firstWindow']>>,
  command: string,
): Promise<void> {
  await pane.click()
  await pane.locator('.xterm-helper-textarea').focus()
  await page.keyboard.type(command)
  await page.keyboard.press('Enter')
}

async function startSshServer(
  beforeAuthenticationAccept?: () => Promise<void>,
): Promise<{ server: Server; port: number; ptySizes: Array<{ columns: number; rows: number }> }> {
  const ptySizes: Array<{ columns: number; rows: number }> = []
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2_048 })
  const server = new Server({ hostKeys: [privateKey.export({ type: 'pkcs1', format: 'pem' })] }, client => {
    client.on('authentication', context => {
      if (context.method === 'password' && context.username === 'ops' && context.password === 'secret') {
        if (beforeAuthenticationAccept) {
          void beforeAuthenticationAccept().then(() => context.accept(), () => context.reject())
        } else {
          context.accept()
        }
        return
      }
      context.reject()
    }).on('ready', () => {
      client.on('session', accept => {
        const session = accept()
        session.on('pty', (acceptPty, _rejectPty, info) => {
          ptySizes.push({ columns: info.cols, rows: info.rows })
          acceptPty()
        }).on('shell', acceptShell => {
          const stream = acceptShell()
          let command = ''
          stream.write('ready\r\n')
          stream.on('data', (data: Buffer) => {
            command += data.toString('utf8')
            if (command.endsWith('\r') || command.endsWith('\n')) {
              stream.write(command.trim() === 'hostname' ? 'api-prod\r\n' : `echo:${command.trim()}\r\n`)
              command = ''
            }
          })
        }).on('exec', (acceptExec, _rejectExec, info) => {
          const stream = acceptExec()
          const command = info.command
          const output = command === 'hostname'
            ? 'api-prod\n'
            : command === 'uname -s'
              ? 'Linux\n'
              : command === 'uname -r'
                ? '6.1.0\n'
                : command === linuxCpuModelCommand
                  ? 'Example CPU\n'
                  : command === 'uname -m'
                    ? 'x86_64\n'
                    : command === 'getconf _NPROCESSORS_ONLN'
                      ? '8\n'
                      : command === linuxMemoryCommand
                        ? '8388608\n'
                        : command === linuxDiskCommand
                          ? 'sda 128000000000 disk\n'
                          : command === linuxNetworkCommand
                            ? '2: eth0 inet 192.0.2.10/24 brd 192.0.2.255 scope global eth0\n'
                            : command === linuxProcessCommand
                              ? '42\tnginx\t/usr/sbin\n'
                              : command === 'id -un'
                                ? 'appuser\n'
                                : command === 'pwd -P'
                                  ? '/srv/apps/api\n'
                                  : command === linuxServiceCommand
                                    ? 'nginx.service loaded active running nginx\n'
                                    : ''
          stream.write(output)
          stream.exit(0)
          stream.end()
        })
      })
    })
  })

  server.listen(0, '0.0.0.0')
  await once(server, 'listening')
  return { server, port: (server.address() as AddressInfo).port, ptySizes }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}

async function within<T>(timeoutMs: number, message: string, operation: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error(message)), timeoutMs) }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

async function webContentsSafeAreaGeometry(
  page: Awaited<ReturnType<ElectronApplication['firstWindow']>>,
  headerSelector: string,
  edgePadding: number,
): Promise<{
  controlsInset: number
  controlsInsetAtLeastMinimum: boolean
  rightmostHeaderContentClearsNativeControlSafeArea: boolean
  noHorizontalOverflow: boolean
}> {
  return page.evaluate(({ headerSelector, edgePadding }) => {
    const header = document.querySelector(headerSelector)
    if (!(header instanceof HTMLElement)) throw new Error(`Missing WebContents header: ${headerSelector}`)
    const controlsInset = Number.parseFloat(getComputedStyle(header).paddingRight) - edgePadding
    const nativeControlsSafeX = window.innerWidth - controlsInset
    const rightmostVisibleContent = Math.max(...[...header.children]
      .filter(child => {
        const style = getComputedStyle(child)
        const bounds = child.getBoundingClientRect()
        return style.display !== 'none' && style.visibility !== 'hidden' && bounds.width > 0 && bounds.height > 0
      })
      .map(child => child.getBoundingClientRect().right))
    return {
      controlsInset,
      controlsInsetAtLeastMinimum: controlsInset >= 138,
      rightmostHeaderContentClearsNativeControlSafeArea: rightmostVisibleContent <= nativeControlsSafeX + 0.5,
      noHorizontalOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    }
  }, { headerSelector, edgePadding })
}

function assertViewportPng(image: Buffer, viewport: { width: number; height: number }): void {
  expect(image.length).toBeGreaterThan(24)
  expect(image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe(true)
  expect(image.readUInt32BE(16)).toBe(viewport.width)
  expect(image.readUInt32BE(20)).toBe(viewport.height)
}

function closeServer(server: { close(callback: (error?: Error) => void): void }): Promise<void> {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

async function startFakeOllamaServer(): Promise<{ server: HttpServer; port: number; requests: number; connectionTests: number; chatRequests: number }> {
  let requests = 0
  let connectionTests = 0
  let chatRequests = 0
  const server = createHttpServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/api/chat') {
      response.statusCode = 404
      response.end()
      return
    }
    requests += 1
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { stream?: unknown }
      if (body.stream === false) {
        connectionTests += 1
        response.statusCode = 200
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify({ model: 'fake-e2e', done: true }))
        return
      }
      chatRequests += 1
      if (chatRequests === 2) {
        response.statusCode = 503
        response.end('temporary fake model outage')
        return
      }
      response.statusCode = 200
      response.setHeader('Content-Type', 'application/x-ndjson')
      const text = chatRequests >= 3 ? '重试成功' : '你好，世界'
      const parts = [...text]
      response.write(JSON.stringify({ message: { content: parts.shift() ?? '' } }) + '\n')
      setTimeout(() => {
        response.write(JSON.stringify({ message: { content: parts.join('') } }) + '\n')
        response.end(JSON.stringify({ done: true }) + '\n')
      }, 20)
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as AddressInfo).port
  return {
    server,
    port,
    get requests() { return requests },
    get connectionTests() { return connectionTests },
    get chatRequests() { return chatRequests },
  }
}

async function startCancellableOllamaServer(): Promise<{ server: HttpServer; port: number; release: () => void; aborted: number }> {
  let releaseResponse: (() => void) | undefined
  let aborted = 0
  let observedAbort = false
  const server = createHttpServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/api/chat') {
      response.statusCode = 404
      response.end()
      return
    }
    request.resume()
    response.statusCode = 200
    response.setHeader('Content-Type', 'application/x-ndjson')
    response.write(JSON.stringify({ message: { content: '正在生成' } }) + '\n')
    const waitForRelease = new Promise<void>(resolve => { releaseResponse = resolve })
    const markAborted = () => {
      if (observedAbort || response.writableEnded) return
      observedAbort = true
      aborted += 1
      releaseResponse?.()
    }
    request.on('aborted', markAborted)
    response.on('close', markAborted)
    void waitForRelease.then(() => {
      if (!response.writableEnded) response.end(JSON.stringify({ done: true }) + '\n')
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { server, port: (server.address() as AddressInfo).port, release: () => releaseResponse?.(), get aborted() { return aborted } }
}

async function startSupersedingOllamaServer(): Promise<{ server: HttpServer; port: number; release: () => void; requests: number; firstAborted: number }> {
  let requests = 0
  let firstAborted = 0
  let releaseFirstResponse: (() => void) | undefined
  const server = createHttpServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/api/chat') {
      response.statusCode = 404
      response.end()
      return
    }
    requests += 1
    request.resume()
    response.statusCode = 200
    response.setHeader('Content-Type', 'application/x-ndjson')
    if (requests === 1) {
      let countedAbort = false
      const markAborted = () => {
        if (countedAbort || response.writableEnded) return
        countedAbort = true
        firstAborted += 1
      }
      request.on('aborted', markAborted)
      response.on('close', markAborted)
      response.write(JSON.stringify({ message: { content: '第一条响应片段' } }) + '\n')
      releaseFirstResponse = () => {
        if (!response.writableEnded) response.end(JSON.stringify({ done: true }) + '\n')
      }
      return
    }
    response.write(JSON.stringify({ message: { content: '第二条响应完成' } }) + '\n')
    response.end(JSON.stringify({ done: true }) + '\n')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    server,
    port: (server.address() as AddressInfo).port,
    release: () => releaseFirstResponse?.(),
    get requests() { return requests },
    get firstAborted() { return firstAborted },
  }
}

function closeHttpServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}
