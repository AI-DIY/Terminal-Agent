import { expect, test } from '@playwright/test'
import { _electron as electron } from '@playwright/test'
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

const removedImportButton = ['导入', '密钥'].join('')

test('opens real settings with the user-facing panels and preserves drafts on return', async () => {
  const directories = await createSsoE2eDirectories('terminal-agent-settings-e2e-')
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined
  let primaryFailure: E2ePrimaryFailure | undefined
  try {
    app = await electron.launch({
      args: [`--user-data-dir=${directories.userDataDir}`, join(process.cwd(), 'out/main/main.js')],
      env: ssoE2eEnvironment(directories.ssoHomeDir),
    })
    const page = await app.firstWindow()
    await ensureLegacyWorkbench(page)
    await expect(page.getByRole('button', { name: '设置', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '设置', exact: true }).click()

    const panels = page.getByRole('navigation', { name: '设置面板' }).getByRole('button')
    await expect(panels).toHaveCount(4)
    await expect(panels).toHaveText(['大语言模型配置', '安全围栏', '外观', '单点登录'])
    await expect(page.getByRole('button', { name: '本地主机记忆', exact: true })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: '本地主机记忆', exact: true })).toHaveCount(0)
    await expect(panels.nth(0)).toHaveAttribute('aria-current', 'page')
    await expect(panels.nth(1)).not.toHaveAttribute('aria-current', 'page')

    await page.getByRole('navigation', { name: '设置面板' }).getByRole('button', { name: '外观', exact: true }).click()
    const themeGroup = page.getByRole('group', { name: '工作台主题', exact: true })
    await expect(themeGroup.getByRole('button')).toHaveCount(5)
    const themeColumns = await themeGroup.evaluate(node => getComputedStyle(node).gridTemplateColumns.trim().split(/\s+/).length)
    expect(themeColumns).toBe(5)

    await page.getByRole('navigation', { name: '设置面板' }).getByRole('button', { name: '大语言模型配置', exact: true }).click()
    const apiKeyInput = page.getByLabel('API Key', { exact: true })
    await expect(apiKeyInput).toBeEditable()
    await expect(apiKeyInput).toHaveAttribute('type', 'password')
    await page.getByRole('button', { name: '显示 API Key', exact: true }).click()
    await expect(apiKeyInput).toHaveAttribute('type', 'text')
    await page.getByRole('button', { name: '隐藏 API Key', exact: true }).click()
    await expect(apiKeyInput).toHaveAttribute('type', 'password')
    await expect(page.getByText('密钥仅在保存或测试时发送给主进程；已保存密钥不会回填。', { exact: true })).toBeVisible()
    await expect(page.locator('.profile-editor').getByRole('button')).toHaveCount(4)
    await expect(page.locator('.profile-editor').locator('select')).toHaveCount(1)
    await expect(page.getByRole('button', { name: removedImportButton, exact: true })).toHaveCount(0)

    await expect(page.getByRole('navigation', { name: '设置面板' }).getByRole('button', { name: '视觉语言模型配置', exact: true })).toHaveCount(0)

    await panels.nth(0).click()
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
    await page.getByRole('navigation', { name: '设置面板', exact: true }).getByRole('button', { name: '大语言模型配置', exact: true }).click()
    const apiKeyAfterReopeningSettings = page.getByLabel('API Key', { exact: true })
    await expect(apiKeyAfterReopeningSettings).toHaveValue('')
    await expect(apiKeyAfterReopeningSettings).toHaveAttribute('type', 'password')
    await expect(page.getByLabel('连接名称')).toHaveValue(draftName)
    await expect(page.getByLabel('接口类型')).toHaveValue('openai')
    await expect(page.getByLabel('模型', { exact: true })).toHaveValue('preserved-draft-model')
    await expect(page.getByLabel('接口地址')).toHaveValue(draftEndpoint)
    await expect(page.getByLabel('上下文长度')).toHaveValue('32768')
  } catch (error) {
    primaryFailure = { error }
    throw error
  } finally {
    const cleanupFailures = await closeE2eResources(
      async () => { await app?.close() },
      async () => { await removeSsoE2eDirectories(directories) },
    )
    throwCleanupFailures(primaryFailure, cleanupFailures)
  }
})

test('left-aligns LLM and VLM model profile rows', async () => {
  const directories = await createSsoE2eDirectories('terminal-agent-model-alignment-e2e-')
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined
  let primaryFailure: E2ePrimaryFailure | undefined
  try {
    app = await electron.launch({
      args: [`--user-data-dir=${directories.userDataDir}`, join(process.cwd(), 'out/main/main.js')],
      env: ssoE2eEnvironment(directories.ssoHomeDir),
    })
    const page = await app.firstWindow()
    await ensureLegacyWorkbench(page)
    await page.evaluate(async () => {
      await window.terminalAgent.settings.models.save({
        name: '左对齐文本模型', kind: 'llm', provider: 'ollama', model: 'llm-left', endpoint: 'http://127.0.0.1:11434/api/chat', contextLimit: 1_024,
      })
    })
    await page.getByRole('button', { name: '设置', exact: true }).click()

    for (const [panelName, profileName] of [
      ['大语言模型配置', '左对齐文本模型'],
    ]) {
      await page.getByRole('navigation', { name: '设置面板' }).getByRole('button', { name: panelName, exact: true }).click()
      const profile = page.locator('.profile-item').filter({ hasText: profileName })
      await expect(profile).toBeVisible()
      const alignment = await profile.locator('.profile-select').evaluate(node => ({
        contentLeftInset: node.querySelector('strong')!.getBoundingClientRect().left - node.closest('.profile-item')!.getBoundingClientRect().left,
        justifyItems: getComputedStyle(node).justifyItems,
        textAlign: getComputedStyle(node).textAlign,
      }))
      const leftEdges = await profile.locator('.profile-select strong,.profile-select span,.profile-select small').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().left))
      expect(alignment.justifyItems).toBe('start')
      expect(alignment.textAlign).toBe('left')
      expect(alignment.contentLeftInset).toBeLessThanOrEqual(11)
      expect(leftEdges).toHaveLength(3)
      expect(Math.max(...leftEdges) - Math.min(...leftEdges)).toBeLessThanOrEqual(1)
    }
  } catch (error) {
    primaryFailure = { error }
    throw error
  } finally {
    const cleanupFailures = await closeE2eResources(
      async () => { await app?.close() },
      async () => { await removeSsoE2eDirectories(directories) },
    )
    throwCleanupFailures(primaryFailure, cleanupFailures)
  }
})

test('runs the direct model key lifecycle through real Electron without exposing or retaining cleared keys', async () => {
  let testModel: Awaited<ReturnType<typeof startKeyedModelServer>> | undefined
  let directories: SsoE2eDirectories | undefined
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined
  let primaryFailure: E2ePrimaryFailure | undefined
  try {
    const startedTestModel = await startKeyedModelServer()
    testModel = startedTestModel
    const temporaryDirectories = await createSsoE2eDirectories('terminal-agent-model-key-editor-e2e-')
    directories = temporaryDirectories
    app = await electron.launch({
      args: [`--user-data-dir=${temporaryDirectories.userDataDir}`, join(process.cwd(), 'out/main/main.js')],
      env: ssoE2eEnvironment(temporaryDirectories.ssoHomeDir),
    })
    const page = await app.firstWindow()
    await ensureLegacyWorkbench(page)
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('navigation', { name: '设置面板' }).getByRole('button', { name: '大语言模型配置', exact: true }).click()

    const apiKey = page.getByLabel('API Key', { exact: true })
    await expect(apiKey).toBeEditable()
    await expect(page.getByRole('button', { name: '清除已保存密钥', exact: true })).toHaveCount(0)
    await page.getByLabel('连接名称').fill('临时密钥测试模型')
    await page.getByLabel('接口类型').selectOption('openai')
    await page.getByLabel('模型', { exact: true }).fill('transient-e2e')
    await page.getByLabel('接口地址').fill(`http://127.0.0.1:${startedTestModel.port}/v1/chat/completions`)
    startedTestModel.expectAuthorization('temporary-e2e-key')
    await apiKey.fill('temporary-e2e-key')
    await page.getByRole('button', { name: '测试连接', exact: true }).click()

    await expect(page.getByRole('status')).toContainText('连接成功：transient-e2e')
    await expect(apiKey).toHaveValue('')
    expect(startedTestModel.authorizations).toEqual(['Bearer temporary-e2e-key'])
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

    startedTestModel.expectAuthorization('saved-e2e-key')
    await page.getByRole('button', { name: '测试连接', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('连接成功：transient-e2e')
    await expect(apiKey).toHaveValue('')
    expect(startedTestModel.authorizations).toEqual(['Bearer temporary-e2e-key', 'Bearer saved-e2e-key'])

    await apiKey.fill('replacement-e2e-key')
    await page.getByRole('button', { name: '保存大语言模型配置', exact: true }).click()
    await expect(apiKey).toHaveValue('')
    await expect(page.locator('body')).not.toContainText('replacement-e2e-key')
    startedTestModel.expectAuthorization('replacement-e2e-key')
    await page.getByRole('button', { name: '测试连接', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('连接成功：transient-e2e')
    expect(startedTestModel.authorizations).toEqual([
      'Bearer temporary-e2e-key',
      'Bearer saved-e2e-key',
      'Bearer replacement-e2e-key',
    ])

    const dismissedDialogPromise = new Promise<{ type: string; message: string }>((resolve, reject) => {
      page.once('dialog', dialog => {
        const result = { type: dialog.type(), message: dialog.message() }
        void dialog.dismiss().then(() => resolve(result), reject)
      })
    })
    await clearSavedKey.click()
    const dismissedDialog = await dismissedDialogPromise
    expect(dismissedDialog.type).toBe('confirm')
    expect(dismissedDialog.message).toBe('清除“临时密钥测试模型”已保存的 API Key？')
    await expect(savedProfile).toContainText('已配置密钥')
    await expect(savedProfile).toContainText('已激活')
    await expect(clearSavedKey).toBeVisible()
    startedTestModel.expectAuthorization('replacement-e2e-key')
    await page.getByRole('button', { name: '测试连接', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('连接成功：transient-e2e')
    expect(startedTestModel.authorizations).toEqual([
      'Bearer temporary-e2e-key',
      'Bearer saved-e2e-key',
      'Bearer replacement-e2e-key',
      'Bearer replacement-e2e-key',
    ])

    const acceptedDialogPromise = new Promise<{ type: string; message: string }>((resolve, reject) => {
      page.once('dialog', dialog => {
        const result = { type: dialog.type(), message: dialog.message() }
        void dialog.accept().then(() => resolve(result), reject)
      })
    })
    await clearSavedKey.click()
    const acceptedDialog = await acceptedDialogPromise
    expect(acceptedDialog.type).toBe('confirm')
    expect(acceptedDialog.message).toBe('清除“临时密钥测试模型”已保存的 API Key？')
    await expect(savedProfile).toContainText('未配置密钥')
    await expect(savedProfile).toContainText('未激活')
    await expect(page.getByRole('button', { name: '清除已保存密钥', exact: true })).toHaveCount(0)
    const requestCountAfterClear = startedTestModel.requestCount
    await page.getByRole('button', { name: '测试连接', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('An API key is required for this model provider')
    expect(startedTestModel.requestCount).toBe(requestCountAfterClear)
  } catch (error) {
    primaryFailure = { error }
    throw error
  } finally {
    const cleanupFailures = await closeE2eResources(
      async () => { await app?.close() },
      async () => { if (testModel) await closeServer(testModel.server) },
      async () => { if (directories) await removeSsoE2eDirectories(directories) },
    )
    throwCleanupFailures(primaryFailure, cleanupFailures)
  }
})

function closeServer(server: { close(callback: (error?: Error) => void): void }): Promise<void> {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

async function ensureLegacyWorkbench(page: import('@playwright/test').Page): Promise<void> {
  await expect(page.locator('main')).toBeVisible()
  const ssoTitle = page.getByRole('heading', { name: '单点登录', exact: true })
  if (!(await ssoTitle.isVisible().catch(() => false))) {
    const loginSettings = page.getByRole('button', { name: '打开单点登录设置', exact: true })
    if (await loginSettings.isVisible().catch(() => false)) await loginSettings.click()
  }
  if (await ssoTitle.isVisible().catch(() => false)) {
    const gate = page.getByLabel('启用单点登录门控')
    if (await gate.isChecked()) await gate.uncheck()
    await page.getByRole('button', { name: '保存并进入工作台', exact: true }).click()
  }
  await expect(page.getByRole('button', { name: '设置', exact: true })).toBeVisible()
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
