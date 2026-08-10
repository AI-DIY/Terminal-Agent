import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { generateKeyPairSync } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Server } from 'ssh2'

test('renders two real SSH sessions in separate terminal panes with isolated output', async () => {
  const sshServer = await startSshServer()
  let app: ElectronApplication | undefined

  try {
    app = await electron.launch({ args: [join(process.cwd(), 'out/main/main.js')] })
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

test('keeps an existing SSH terminal mounted after visiting settings and returning to the workbench', async () => {
  const sshServer = await startSshServer()
  let app: ElectronApplication | undefined

  try {
    app = await electron.launch({ args: [join(process.cwd(), 'out/main/main.js')] })
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

test('renders an AccessClient Raw startup session from the initial session snapshot', async () => {
  const rawServer = createServer()
  rawServer.listen(0, '127.0.0.1')
  await once(rawServer, 'listening')
  let app: ElectronApplication | undefined

  try {
    const port = (rawServer.address() as AddressInfo).port
    app = await electron.launch({ args: [join(process.cwd(), 'out/main/main.js'), '-raw', '-P', String(port)] })
    const page = await app.firstWindow()

    await expect(page.locator('[data-testid^="terminal-pane-"]')).toHaveCount(1)
    await expect(page.getByRole('button', { name: `选择终端会话 Raw ${port}` })).toBeVisible()
  } finally {
    await app?.close()
    await closeServer(rawServer)
  }
})

test('shows a sanitized local error for an invalid AccessClient startup without exposing temporary credentials', async () => {
  const temporaryPath = 'C:\\Users\\test-user\\AppData\\Local\\Temp\\secret-session.conf'
  const temporaryPassword = 'temporary-secret'
  let app: ElectronApplication | undefined

  try {
    app = await electron.launch({
      args: [join(process.cwd(), 'out/main/main.js'), '--', '-load', `tmp:${temporaryPath}`, '-pw', temporaryPassword],
    })
    const page = await app.firstWindow()

    await expect(page.getByRole('alert')).toHaveText('无法读取堡垒机临时配置。')
    await expect(page.locator('body')).not.toContainText(temporaryPassword)
    await expect(page.locator('body')).not.toContainText(temporaryPath)
  } finally {
    await app?.close()
  }
})

test('opens an AccessClient temporary SSH session with its title and initial terminal dimensions', async () => {
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
    app = await electron.launch({
      args: [join(process.cwd(), 'out/main/main.js'), '--', '-load', `tmp:${profilePath}`, '-pw', 'secret'],
    })
    const page = await app.firstWindow()

    await expect(page.locator('[data-testid^="terminal-pane-"]')).toHaveCount(1)
    await expect(page.getByRole('button', { name: '选择终端会话 生产终端' })).toBeVisible()
    await expect.poll(() => sshServer.ptySizes).toContainEqual({ columns: 120, rows: 40 })
  } finally {
    await app?.close()
    await closeServer(sshServer.server)
    await rm(directory, { recursive: true, force: true })
  }
})

test('adds a visible terminal session when AccessClient starts a second Electron instance', async () => {
  const rawServer = createServer()
  rawServer.listen(0, '127.0.0.1')
  await once(rawServer, 'listening')
  let app: ElectronApplication | undefined

  try {
    const port = (rawServer.address() as AddressInfo).port
    const mainEntry = join(process.cwd(), 'out/main/main.js')
    app = await electron.launch({ args: [mainEntry, '-raw', '-P', String(port)] })
    const page = await app.firstWindow()
    const panes = page.locator('[data-testid^="terminal-pane-"]')
    await expect(panes).toHaveCount(1)

    const second = spawn(join(process.cwd(), 'node_modules/electron/dist/electron.exe'), [mainEntry, '--', '-raw', '-P', String(port)], {
      windowsHide: true,
      stdio: 'ignore',
    })
    await once(second, 'exit')

    await expect(panes).toHaveCount(2)
  } finally {
    await app?.close()
    await closeServer(rawServer)
  }
})

async function connect(page: Awaited<ReturnType<ElectronApplication['firstWindow']>>, port: number): Promise<void> {
  const panes = page.locator('[data-testid^="terminal-pane-"]')
  const previousPaneCount = await panes.count()
  await page.getByRole('button', { name: '新建 SSH 连接' }).click()
  await page.getByLabel('主机地址').fill('127.0.0.1')
  await page.getByLabel('端口').fill(String(port))
  await page.getByRole('textbox', { name: '用户名', exact: true }).fill('ops')
  await page.getByRole('textbox', { name: '密码', exact: true }).fill('secret')
  await page.getByRole('button', { name: '连接', exact: true }).click()
  await expect(panes).toHaveCount(previousPaneCount + 1)
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

async function startSshServer(): Promise<{ server: Server; port: number; ptySizes: Array<{ columns: number; rows: number }> }> {
  const ptySizes: Array<{ columns: number; rows: number }> = []
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2_048 })
  const server = new Server({ hostKeys: [privateKey.export({ type: 'pkcs1', format: 'pem' })] }, client => {
    client.on('authentication', context => {
      if (context.method === 'password' && context.username === 'ops' && context.password === 'secret') {
        context.accept()
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
              stream.write(`echo:${command.trim()}\r\n`)
              command = ''
            }
          })
        })
      })
    })
  })

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { server, port: (server.address() as AddressInfo).port, ptySizes }
}

function closeServer(server: { close(callback: (error?: Error) => void): void }): Promise<void> {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}
