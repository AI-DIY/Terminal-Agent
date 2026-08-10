import { expect, test } from '@playwright/test'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const pageUrl = pathToFileURL(join(process.cwd(), 'docs', 'terminal-agent-blueprint.html')).href

test.use({ channel: 'chrome' })

test('产品蓝图页将产品转折和当前功能收敛为两页', async ({ page }) => {
  await page.goto(pageUrl)

  await expect(page).toHaveTitle('Terminal-Agent | 产品蓝图')
  await expect(page.locator('.slide')).toHaveCount(2)
  await expect(page.getByRole('heading', { name: '从“会分析”，到“在终端里真正干活”' })).toBeVisible()
  await expect(page.getByText(/自动巡检已经体现出实际价值/)).toBeVisible()
  await expect(page.getByText(/告警分析 Agent 具备 ReAct 的环境理解与推理基础/)).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Terminal-Agent 当前产品设计' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '进入终端工作现场' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '理解主机环境' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '围绕目标协作' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '两种驾驶模式' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '安全控制' })).toBeVisible()
  await expect(page.locator('link[rel="stylesheet"]')).toHaveCount(0)
})
