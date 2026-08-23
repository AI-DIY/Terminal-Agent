import { expect, test } from '@playwright/test'
import { _electron as electron } from '@playwright/test'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('opens real settings with ordered panels, host memory controls, and terminal return', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'terminal-agent-settings-e2e-'))
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined
  try {
    app = await electron.launch({ args: [`--user-data-dir=${userDataDir}`, join(process.cwd(), 'out/main/main.js')] })
    const page = await app.firstWindow()
    await expect(page.getByRole('button', { name: '设置', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '设置', exact: true }).click()

    const panels = page.getByRole('navigation', { name: '设置面板' }).getByRole('button')
    await expect(panels).toHaveCount(6)
    await expect(panels).toHaveText(['模型选择', '大语言模型配置', '视觉语言模型配置', '安全围栏', '本地主机记忆', '外观'])
    await expect(panels.nth(0)).toHaveAttribute('aria-current', 'page')
    await expect(panels.nth(1)).not.toHaveAttribute('aria-current', 'page')

    await panels.nth(4).click()
    await expect(page.getByRole('heading', { name: '本地主机记忆', exact: true })).toBeVisible()
    await expect(page.getByLabel('启用本地主机记忆')).toBeVisible()
    for (const label of [
      '主机名、连接 IP、操作系统和基础版本',
      'CPU、内存、磁盘、网络等基础信息',
      '运行进程名称、PID 和进程工作目录',
      '当前用户、工作目录和常用服务状态',
    ]) await expect(page.getByLabel(label)).toBeVisible()
    const catalog = page.getByRole('region', { name: '采集命令清单', exact: true })
    await expect(catalog).toBeVisible()
    for (const heading of ['身份与系统', '硬件', '进程', '运行环境']) {
      await expect(catalog.getByRole('heading', { name: heading, exact: true })).toBeVisible()
    }
    await expect(catalog.locator('code')).toHaveCount(13)
    await expect(catalog.locator('code').nth(0)).toHaveText('hostname')
    await expect(catalog.locator('code').nth(1)).toHaveText('uname -s')
    await expect(catalog.getByRole('listitem')).toHaveCount(13)
    await expect(catalog.getByRole('listitem').filter({ hasText: '当前不执行' })).toHaveCount(13)
    await page.getByLabel('启用本地主机记忆').check()
    await expect(catalog.getByRole('listitem').filter({ hasText: '始终执行' })).toHaveCount(2)
    await page.getByLabel('运行进程名称、PID 和进程工作目录').uncheck()
    const processCommand = catalog.getByRole('listitem').filter({ hasText: '运行进程' })
    await expect(processCommand).toHaveClass(/disabled/)
    await expect(processCommand.getByText('当前不执行', { exact: true })).toBeVisible()

    await panels.nth(1).click()
    const apiKeyInput = page.getByLabel('API Key', { exact: true })
    await expect(apiKeyInput).toBeEditable()
    await expect(apiKeyInput).toHaveAttribute('type', 'password')
    await page.getByRole('button', { name: '显示 API Key', exact: true }).click()
    await expect(apiKeyInput).toHaveAttribute('type', 'text')
    await page.getByRole('button', { name: '隐藏 API Key', exact: true }).click()
    await expect(apiKeyInput).toHaveAttribute('type', 'password')
    await expect(page.getByText('密钥仅在保存或测试时发送给主进程；已保存密钥不会回填。', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '导入密钥', exact: true })).toHaveCount(0)

    await panels.nth(2).click()
    await expect(page.getByLabel('API Key', { exact: true })).toBeEditable()
    await expect(page.getByText('LLM 密钥引用', { exact: true })).toHaveCount(0)

    await panels.nth(1).click()
    const draftName = '保留的未保存模型草稿'
    const draftEndpoint = 'http://127.0.0.1:18080/v1/chat/completions'
    await page.getByLabel('连接名称').fill(draftName)
    await page.getByLabel('接口类型').selectOption('openai')
    await page.getByLabel('模型', { exact: true }).fill('preserved-draft-model')
    await page.getByLabel('接口地址').fill(draftEndpoint)
    await page.getByLabel('上下文长度').fill('32768')
    const apiKeyBeforeLeavingSettings = page.getByLabel('API Key', { exact: true })
    await apiKeyBeforeLeavingSettings.fill('session-only-key')

    await page.getByRole('button', { name: '返回工作台', exact: true }).click()
    await expect(page.getByRole('button', { name: '设置', exact: true })).toBeVisible()
    await expect(page.locator('[data-testid^="terminal-pane-"]')).toHaveCount(0)

    await page.getByRole('button', { name: '设置', exact: true }).click()
    const apiKeyAfterReopeningSettings = page.getByLabel('API Key', { exact: true })
    await expect(apiKeyAfterReopeningSettings).toHaveValue('')
    await expect(apiKeyAfterReopeningSettings).toHaveAttribute('type', 'password')
    await expect(page.getByLabel('连接名称')).toHaveValue(draftName)
    await expect(page.getByLabel('接口类型')).toHaveValue('openai')
    await expect(page.getByLabel('模型', { exact: true })).toHaveValue('preserved-draft-model')
    await expect(page.getByLabel('接口地址')).toHaveValue(draftEndpoint)
    await expect(page.getByLabel('上下文长度')).toHaveValue('32768')
  } finally {
    await app?.close()
    await rm(userDataDir, { recursive: true, force: true })
  }
})

test('runs the direct model key lifecycle through real Electron without exposing or retaining cleared keys', async () => {
  const testModel = await startKeyedModelServer()
  const userDataDir = await mkdtemp(join(tmpdir(), 'terminal-agent-model-key-editor-e2e-'))
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined
  try {
    app = await electron.launch({ args: [`--user-data-dir=${userDataDir}`, join(process.cwd(), 'out/main/main.js')] })
    const page = await app.firstWindow()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('navigation', { name: '设置面板' }).getByRole('button', { name: '大语言模型配置', exact: true }).click()

    const apiKey = page.getByLabel('API Key', { exact: true })
    await expect(apiKey).toBeEditable()
    await expect(page.getByRole('button', { name: '清除已保存密钥', exact: true })).toHaveCount(0)
    await page.getByLabel('连接名称').fill('临时密钥测试模型')
    await page.getByLabel('接口类型').selectOption('openai')
    await page.getByLabel('模型', { exact: true }).fill('transient-e2e')
    await page.getByLabel('接口地址').fill(`http://127.0.0.1:${testModel.port}/v1/chat/completions`)
    testModel.expectAuthorization('temporary-e2e-key')
    await apiKey.fill('temporary-e2e-key')
    await page.getByRole('button', { name: '测试连接', exact: true }).click()

    await expect(page.getByRole('status')).toContainText('连接成功：transient-e2e')
    await expect(apiKey).toHaveValue('')
    expect(testModel.authorizations).toEqual(['Bearer temporary-e2e-key'])
    await expect(page.locator('.profile-item')).toHaveCount(0)

    await apiKey.fill('saved-e2e-key')
    await page.getByRole('button', { name: '保存大语言模型配置', exact: true }).click()
    const savedProfile = page.locator('.profile-item').filter({ hasText: '临时密钥测试模型' })
    await expect(savedProfile).toContainText('已配置密钥')
    await expect(savedProfile).toContainText('已激活')
    await expect(apiKey).toHaveValue('')
    const clearSavedKey = page.getByRole('button', { name: '清除已保存密钥', exact: true })
    await expect(clearSavedKey).toBeVisible()

    await savedProfile.getByRole('button', { name: '编辑', exact: true }).click()
    await expect(apiKey).toHaveValue('')
    await expect(apiKey).toHaveAttribute('placeholder', '已配置密钥，留空则保留')
    await expect(page.locator('body')).not.toContainText('saved-e2e-key')

    testModel.expectAuthorization('saved-e2e-key')
    await page.getByRole('button', { name: '测试连接', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('连接成功：transient-e2e')
    await expect(apiKey).toHaveValue('')
    expect(testModel.authorizations).toEqual(['Bearer temporary-e2e-key', 'Bearer saved-e2e-key'])

    await apiKey.fill('replacement-e2e-key')
    await page.getByRole('button', { name: '保存大语言模型配置', exact: true }).click()
    await expect(apiKey).toHaveValue('')
    await expect(page.locator('body')).not.toContainText('replacement-e2e-key')
    testModel.expectAuthorization('replacement-e2e-key')
    await page.getByRole('button', { name: '测试连接', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('连接成功：transient-e2e')
    expect(testModel.authorizations).toEqual([
      'Bearer temporary-e2e-key',
      'Bearer saved-e2e-key',
      'Bearer replacement-e2e-key',
    ])

    page.once('dialog', dialog => dialog.accept())
    await clearSavedKey.click()
    await expect(savedProfile).toContainText('未配置密钥')
    await expect(savedProfile).toContainText('未激活')
    await expect(page.getByRole('button', { name: '清除已保存密钥', exact: true })).toHaveCount(0)
    const requestCountAfterClear = testModel.requestCount
    await page.getByRole('button', { name: '测试连接', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('An API key is required for this model provider')
    expect(testModel.requestCount).toBe(requestCountAfterClear)
  } finally {
    await app?.close()
    await closeServer(testModel.server)
    await rm(userDataDir, { recursive: true, force: true })
  }
})

function closeServer(server: { close(callback: (error?: Error) => void): void }): Promise<void> {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

async function startKeyedModelServer(): Promise<{
  server: HttpServer
  port: number
  authorizations: string[]
  requestCount: number
  expectAuthorization(apiKey: string): void
}> {
  const authorizations: string[] = []
  let expectedAuthorization: string | undefined
  const server = createHttpServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.statusCode = 404
      response.end()
      return
    }
    const authorization = request.headers.authorization ?? ''
    authorizations.push(authorization)
    request.resume()
    request.on('end', () => {
      if (authorization !== expectedAuthorization) {
        response.statusCode = 401
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify({ error: { message: 'invalid API key', type: 'authentication_error' } }))
        return
      }
      response.statusCode = 200
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({
        id: 'model-key-lifecycle-e2e',
        object: 'chat.completion',
        created: 0,
        model: 'transient-e2e',
        choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
      }))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    server,
    port: (server.address() as AddressInfo).port,
    authorizations,
    get requestCount() { return authorizations.length },
    expectAuthorization(apiKey: string) { expectedAuthorization = `Bearer ${apiKey}` },
  }
}
