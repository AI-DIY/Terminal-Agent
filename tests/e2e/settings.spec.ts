import { expect, test } from '@playwright/test'
import { _electron as electron } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
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

    await page.getByRole('button', { name: '返回工作台', exact: true }).click()
    await expect(page.getByRole('button', { name: '设置', exact: true })).toBeVisible()
    await expect(page.locator('[data-testid^="terminal-pane-"]')).toHaveCount(0)
  } finally {
    await app?.close()
    await rm(userDataDir, { recursive: true, force: true })
  }
})
