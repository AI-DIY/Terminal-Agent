# CETA 本轮微调实施计划

> **供代理执行者使用：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`，严格按任务逐项执行。所有执行步骤均使用复选框（`- [ ]`）跟踪。

**目标：** 消除顶部重复品牌栏，将模型 API Key 改为在线直接编辑并移除密钥引用功能，在保留原生窗口按钮和现有产品能力的前提下生成可测试的 Windows `1.0.8` 安装包。

**架构：** 使用 Electron `titleBarStyle: 'hidden'` 和 `titleBarOverlay` 将原生窗口按钮合并进现有应用栏；使用组件局部状态承载临时 API Key，经受信 preload/IPC 传给主进程并继续使用 Windows 受保护存储。模型配置文档升级到版本 2，先把旧 VLM-to-LLM 密钥引用迁移为 VLM 自有密钥，再从当前类型、运行时和界面中完整移除引用功能。

**技术栈：** Electron 43、Vue 3、TypeScript 6、Zod 4、Vitest 4、Playwright Electron、Windows `safeStorage`、electron-builder/NSIS、PowerShell。

---

## 文件结构与职责

- 新建 `src/main/windows/title-bar-overlay.ts`：唯一的标题栏覆盖层主题配色和高度目录。
- 新建 `tests/unit/windows/title-bar-overlay.test.ts`：验证珍珠白/石墨黑配色、固定高度和输入校验。
- 修改 `src/main/main.ts`：以持久化主题创建隐藏标题栏窗口，并在主题变化后更新覆盖层。
- 修改 `src/main/settings/register-workbench-settings-handlers.ts`：主题保存成功后通知窗口层。
- 修改 `WorkbenchShell.vue`、`SettingsView.vue`：声明拖动/非拖动区域并动态避让原生窗口按钮。
- 修改 `src/main/settings/model-profile-repository.ts`：定义无引用字段的版本 2 文档，并把版本 1 引用转换为待复制迁移元数据。
- 修改 `src/main/settings/model-profile-service.ts`：执行幂等密钥复制、使用配置自有密钥、支持清除密钥和失败回滚。
- 修改 `src/shared/validation.ts`、`src/shared/contracts.ts`：允许请求携带临时密钥，但保证返回 DTO 和当前配置文档不含密钥或引用。
- 修改 `src/preload/api.ts`、`register-settings-handlers.ts`：验证保存/测试请求，公开清除密钥，删除导入通道。
- 修改 `src/renderer/src/stores/model-profiles.ts`：只转发临时密钥，不把密钥写入共享响应式状态。
- 修改 `ModelProfileManager.vue`：在线密钥输入、显示/隐藏、替换、清除，以及移除导入/引用界面。
- 删除 `model-api-key-entry-service.ts` 及其测试：彻底移除文件选择与密钥文件读取。
- 修改单元、E2E、发布说明和版本文件：提供行为证据并生成 `1.0.8` 发布产物。

### 任务 1：建立可复现的干净基线

**文件：**
- 检查：`package.json`
- 检查：`package-lock.json`
- 检查：`docs/superpowers/specs/2026-08-23-ceta-follow-up-polish-design.md`
- 检查：`tests/**/*.test.ts`

- [ ] **步骤 1：确认分支和工作区**

运行：

```powershell
git branch --show-current
git status --short
git log -3 --oneline
```

预期：当前分支为 `codex/ceta-current-polish`，工作区没有未提交文件，最近两个设计提交为 `cd20c69` 和 `e2ef662`。

- [ ] **步骤 2：按锁文件恢复依赖**

运行：

```powershell
npm ci
```

预期：退出码为 0，`package-lock.json` 不发生变化。

- [ ] **步骤 3：运行基线单元测试和生产构建**

分别运行：

```powershell
npm test
npm run build
```

预期：两个命令均退出 0；如果基线失败，先记录并按 `superpowers:systematic-debugging` 查明原因，不在失败基线上继续实施。

### 任务 2：合并原生标题栏并同步主题配色

**文件：**
- 新建：`src/main/windows/title-bar-overlay.ts`
- 新建：`tests/unit/windows/title-bar-overlay.test.ts`
- 修改：`tests/unit/electron-startup.test.ts`
- 修改：`tests/unit/settings/workbench-preferences-service.test.ts`
- 修改：`tests/unit/main/chat-main-lifecycle.test.ts`
- 修改：`src/main/settings/register-workbench-settings-handlers.ts`
- 修改：`src/main/main.ts`

- [ ] **步骤 1：为标题栏配色目录编写失败测试**

创建 `tests/unit/windows/title-bar-overlay.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { TITLE_BAR_OVERLAY_HEIGHT, titleBarOverlayForTheme } from '../../../src/main/windows/title-bar-overlay'

describe('title bar overlay', () => {
  it('matches the renderer chrome tokens for both themes', () => {
    expect(TITLE_BAR_OVERLAY_HEIGHT).toBe(48)
    expect(titleBarOverlayForTheme('pearl')).toEqual({
      color: '#f0f3f6', symbolColor: '#1d242c', height: 48,
    })
    expect(titleBarOverlayForTheme('graphite')).toEqual({
      color: '#25292e', symbolColor: '#f0f3f6', height: 48,
    })
  })

  it('rejects an unknown theme before it reaches BrowserWindow', () => {
    expect(() => titleBarOverlayForTheme('dark' as never)).toThrow()
  })
})
```

在 `tests/unit/electron-startup.test.ts` 的窗口测试中增加：

```ts
expect(source).toContain("titleBarStyle: 'hidden'")
expect(source).toContain('titleBarOverlay: titleBarOverlayForTheme(initialTheme)')
expect(source).toContain('setTitleBarOverlay(titleBarOverlayForTheme(theme))')
expect(source).not.toContain('frame: false')
```

- [ ] **步骤 2：运行测试并确认按预期失败**

运行：

```powershell
npx vitest run tests/unit/windows/title-bar-overlay.test.ts tests/unit/electron-startup.test.ts
```

预期：失败原因为标题栏配色模块不存在，且 `BrowserWindow` 尚未配置隐藏标题栏覆盖层。

- [ ] **步骤 3：创建唯一标题栏配色目录**

创建 `src/main/windows/title-bar-overlay.ts`：

```ts
import type { TitleBarOverlay } from 'electron'
import { workbenchThemeSchema, type WorkbenchTheme } from '../../shared/contracts'

export const TITLE_BAR_OVERLAY_HEIGHT = 48

export function titleBarOverlayForTheme(input: WorkbenchTheme): TitleBarOverlay {
  const theme = workbenchThemeSchema.parse(input)
  return theme === 'graphite'
    ? { color: '#25292e', symbolColor: '#f0f3f6', height: TITLE_BAR_OVERLAY_HEIGHT }
    : { color: '#f0f3f6', symbolColor: '#1d242c', height: TITLE_BAR_OVERLAY_HEIGHT }
}
```

- [ ] **步骤 4：让主题保存处理器通知窗口层**

将 `registerWorkbenchSettingsHandlers` 签名扩展为可选主题回调，并把保存处理器改为异步：

```ts
export function registerWorkbenchSettingsHandlers(
  service: WorkbenchSettingsSource,
  trustedSender: WebContents,
  onRendererReady: () => void,
  onThemeSaved: (theme: WorkbenchTheme) => void = () => undefined,
): () => void {
  ipcMain.handle('settings:workbench:ready', event => {
    assertTrustedSender(event, trustedSender)
    onRendererReady()
  })
  ipcMain.handle('settings:workbench:get', event => {
    assertTrustedSender(event, trustedSender)
    return service.load()
  })
  ipcMain.handle('settings:workbench:save-layout', (event, input: unknown) => {
    assertTrustedSender(event, trustedSender)
    return service.saveLayout(workbenchLayoutPatchSchema.parse(input))
  })
  ipcMain.handle('settings:workbench:save-theme', async (event, input: unknown) => {
    assertTrustedSender(event, trustedSender)
    const preferences = await service.saveTheme(workbenchThemeSchema.parse(input))
    onThemeSaved(preferences.theme)
    return preferences
  })

  return () => {
    for (const channel of channels) ipcMain.removeHandler(channel)
  }
}
```

在 `workbench-preferences-service.test.ts` 的 IPC 测试中传入 `onThemeSaved`，并断言成功保存 `graphite` 后调用一次、非法主题时不调用：

```ts
const onThemeSaved = vi.fn()
const dispose = registerWorkbenchSettingsHandlers(service, sender as never, onRendererReady, onThemeSaved)
await expect(ipc.handlers.get('settings:workbench:save-theme')?.({ sender }, 'graphite'))
  .resolves.toMatchObject({ theme: 'graphite' })
expect(onThemeSaved).toHaveBeenCalledWith('graphite')
```

- [ ] **步骤 5：将持久化主题接入 `BrowserWindow`**

在 `src/main/main.ts` 导入 `WorkbenchTheme`、默认偏好和标题栏目录，并修改窗口函数：

```ts
export function createMainWindow(
  initialTheme: WorkbenchTheme = createDefaultWorkbenchPreferences().theme,
): BrowserWindow {
  Menu.setApplicationMenu(null)
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarOverlayForTheme(initialTheme),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
```

注册外观处理器时同步更新覆盖层：

```ts
unregisterWorkbenchSettingsHandlers = registerWorkbenchSettingsHandlers(
  workbenchPreferences,
  mainWindow.webContents,
  () => {
    if (mainWindow === rendererWindow) rendererWindow.show()
  },
  theme => rendererWindow.setTitleBarOverlay(titleBarOverlayForTheme(theme)),
)
```

在首次创建窗口和 `activate` 恢复窗口时先读取持久化主题：

```ts
const initialPreferences = await workbenchPreferences.load().catch(createDefaultWorkbenchPreferences)
await recoverChatStreamsBeforeCreatingMainWindow(
  () => chats.recoverInterruptedStreams(),
  () => createMainWindow(initialPreferences.theme),
)

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void workbenchPreferences.load()
      .then(preferences => { createMainWindow(preferences.theme) })
      .catch(() => { createMainWindow() })
  }
})
```

更新 `chat-main-lifecycle.test.ts`：`registerWorkbenchSettingsHandlers` 应接收第四个函数参数，并调用该回调验证 `window.setTitleBarOverlay` 使用新的配色对象。

- [ ] **步骤 6：运行聚焦测试和构建**

运行：

```powershell
npx vitest run tests/unit/windows/title-bar-overlay.test.ts tests/unit/electron-startup.test.ts tests/unit/settings/workbench-preferences-service.test.ts tests/unit/main/chat-main-lifecycle.test.ts tests/unit/main/chat-main-startup-order.test.ts
npm run build
```

预期：全部通过；TypeScript 接受 `TitleBarOverlay` 和新的处理器签名。

- [ ] **步骤 7：提交窗口层修改**

```powershell
git add src/main/windows/title-bar-overlay.ts tests/unit/windows/title-bar-overlay.test.ts tests/unit/electron-startup.test.ts tests/unit/settings/workbench-preferences-service.test.ts tests/unit/main/chat-main-lifecycle.test.ts src/main/settings/register-workbench-settings-handlers.ts src/main/main.ts
git commit -m "fix: merge native controls into the app header"
```

### 任务 3：为原生窗口按钮建立无重叠的拖动区域

**文件：**
- 修改：`src/renderer/src/components/workbench/WorkbenchShell.vue`
- 修改：`src/renderer/src/views/SettingsView.vue`
- 修改：`tests/unit/windows/app-branding.test.ts`
- 修改：`tests/unit/renderer/settings-panels.test.ts`
- 修改：`tests/e2e/workbench.spec.ts`

- [ ] **步骤 1：编写失败的静态视觉契约**

在 `app-branding.test.ts` 和 `settings-panels.test.ts` 增加以下断言：

```ts
expect(shell).toContain('--window-controls-inset')
expect(shell).toContain('-webkit-app-region: drag')
expect(shell).toContain('-webkit-app-region: no-drag')
expect(shell).toContain('env(titlebar-area-width')
expect(settings).toContain('--window-controls-inset')
expect(settings).toContain('-webkit-app-region: drag')
expect(settings).toContain('-webkit-app-region: no-drag')
expect(settings).toContain('env(titlebar-area-width')
```

在 `workbench.spec.ts` 现有窄窗口几何检查中加入：

```ts
const appActions = bounds('.app-header-actions')
const headerStyle = getComputedStyle(element('.app-header'))
// padding-right 是浏览器已经解析完成的像素值；自定义属性本身可能仍是 max(...) 表达式。
const controlsInset = Number.parseFloat(headerStyle.paddingRight) - 14

return {
  controlsInset,
  appActionsClearControls: appActions.right <= window.innerWidth - controlsInset + 0.5,
}
```

并断言：

```ts
expect(narrowGeometry.controlsInset).toBeGreaterThanOrEqual(138)
expect(narrowGeometry.appActionsClearControls).toBe(true)
```

- [ ] **步骤 2：运行聚焦测试并确认失败**

```powershell
npx vitest run tests/unit/windows/app-branding.test.ts tests/unit/renderer/settings-panels.test.ts
```

预期：失败原因为两个顶部栏尚未声明拖动区域和窗口按钮避让变量。

- [ ] **步骤 3：修改工作台顶部栏**

在 `.workbench-shell` 中增加动态窗口按钮宽度，并修改相关规则：

```css
.workbench-shell {
  --window-controls-inset: max(
    138px,
    calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, calc(100vw - 138px)))
  );
}
.app-header {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  padding: 0 calc(14px + var(--window-controls-inset)) 0 14px;
  border-bottom: 1px solid var(--line);
  background: var(--chrome);
  -webkit-app-region: drag;
}
.app-header-actions,
.app-header-actions :deep(*) {
  -webkit-app-region: no-drag;
}
```

保留现有 48px 应用栏高度、品牌尺寸和工作台网格规则。

- [ ] **步骤 4：修改设置页顶部栏**

在 `.settings` 和 `.settings-top` 中使用同一动态宽度公式：

```css
.settings {
  --window-controls-inset: max(
    138px,
    calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, calc(100vw - 138px)))
  );
}
.settings-top {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  padding: 0 calc(16px + var(--window-controls-inset)) 0 16px;
  border-bottom: 1px solid var(--line);
  background: var(--chrome);
  -webkit-app-region: drag;
}
.back-button {
  -webkit-app-region: no-drag;
}
```

设置页仍保持 56px 顶部行；覆盖层高度保持 48px，原生按钮不会遮挡返回按钮和标题。

- [ ] **步骤 5：运行静态、E2E 和构建验证**

```powershell
npx vitest run tests/unit/windows/app-branding.test.ts tests/unit/renderer/settings-panels.test.ts
npx playwright test tests/e2e/workbench.spec.ts --grep "layout preferences"
npm run build
```

预期：应用操作右边界始终位于原生窗口按钮左侧，页面无水平溢出。

- [ ] **步骤 6：提交渲染层窗口布局**

```powershell
git add src/renderer/src/components/workbench/WorkbenchShell.vue src/renderer/src/views/SettingsView.vue tests/unit/windows/app-branding.test.ts tests/unit/renderer/settings-panels.test.ts tests/e2e/workbench.spec.ts
git commit -m "fix: reserve native window control space"
```

### 任务 4：迁移旧密钥引用并建立配置自有密钥模型

**文件：**
- 修改：`src/main/settings/model-profile-repository.ts`
- 修改：`src/main/settings/model-profile-service.ts`
- 修改：`src/main/settings/model-api-key-validation.ts`
- 修改：`tests/unit/settings/model-profile-repository.test.ts`
- 修改：`tests/unit/settings/model-profile-service.test.ts`

- [ ] **步骤 1：为版本 1 到版本 2 的引用迁移编写失败测试**

在 `model-profile-repository.test.ts` 写入真实版本 1 JSON，并验证迁移结果：

```ts
it('migrates version-1 key references into version-2 pending copy metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-model-reference-migration-'))
  const path = join(directory, 'model-profiles.json')
  try {
    await writeFile(path, JSON.stringify({
      version: 1,
      profiles: [
        { id: 'llm', kind: 'llm', name: 'LLM', provider: 'openai', model: 'gpt-5', endpoint: 'https://api.openai.com/v1/chat/completions', contextLimit: 8_000 },
        { id: 'vlm', kind: 'vlm', name: 'VLM', provider: 'openai', model: 'gpt-vision', endpoint: 'https://api.openai.com/v1/chat/completions', maxImages: 4, apiKeyProfileId: 'llm' },
      ],
      activeLlmId: 'llm', activeVlmId: 'vlm', routing: 'combined', migrations: {},
    }), 'utf8')

    const migrated = await new ModelProfileRepository(path).load()
    expect(migrated).toMatchObject({
      version: 2,
      migrations: { apiKeyReferences: [{ sourceProfileId: 'llm', targetProfileId: 'vlm' }] },
    })
    expect(migrated.profiles.find(profile => profile.id === 'vlm')).not.toHaveProperty('apiKeyProfileId')
    expect(await readFile(path, 'utf8')).not.toContain('apiKeyProfileId')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
```

- [ ] **步骤 2：为服务迁移、清除和回滚编写失败测试**

将服务测试夹具默认文档改为版本 2，并添加以下核心测试：

```ts
it('copies a referenced LLM key into VLM protected storage and clears pending metadata', async () => {
  const harness = createService({
    version: 2,
    profiles: [
      { id: 'llm', kind: 'llm', name: 'LLM', provider: 'openai', model: 'gpt-5', endpoint, contextLimit: 8_000 },
      { id: 'vlm', kind: 'vlm', name: 'VLM', provider: 'openai', model: 'gpt-vision', endpoint, maxImages: 4 },
    ],
    activeLlmId: 'llm', activeVlmId: 'vlm', routing: 'combined',
    migrations: { apiKeyReferences: [{ sourceProfileId: 'llm', targetProfileId: 'vlm' }] },
  })
  const protectedKeys = new Map([['model-profile.llm.apiKey', 'shared-key']])
  harness.secrets.load.mockImplementation(async key => protectedKeys.get(key) ?? null)
  harness.secrets.save.mockImplementation(async (key, value) => { protectedKeys.set(key, value) })

  await expect(harness.service.list('vlm')).resolves.toMatchObject([{ id: 'vlm', hasApiKey: true, active: true }])
  expect(protectedKeys.get('model-profile.vlm.apiKey')).toBe('shared-key')
  expect(protectedKeys.get('model-profile.llm.apiKey')).toBe('shared-key')
  expect(harness.getDocument().migrations).not.toHaveProperty('apiKeyReferences')
})

it('keeps an existing VLM key instead of overwriting it during migration', async () => {
  const harness = createService({
    version: 2,
    profiles: [
      { id: 'llm', kind: 'llm', name: 'LLM', provider: 'openai', model: 'gpt-5', endpoint, contextLimit: 8_000 },
      { id: 'vlm', kind: 'vlm', name: 'VLM', provider: 'openai', model: 'gpt-vision', endpoint, maxImages: 4 },
    ],
    activeLlmId: 'llm', activeVlmId: 'vlm', routing: 'combined',
    migrations: { apiKeyReferences: [{ sourceProfileId: 'llm', targetProfileId: 'vlm' }] },
  })
  const protectedKeys = new Map([
    ['model-profile.llm.apiKey', 'llm-key'],
    ['model-profile.vlm.apiKey', 'vlm-own-key'],
  ])
  harness.secrets.load.mockImplementation(async key => protectedKeys.get(key) ?? null)
  harness.secrets.save.mockImplementation(async (key, value) => { protectedKeys.set(key, value) })

  await harness.service.list('vlm')
  expect(protectedKeys.get('model-profile.vlm.apiKey')).toBe('vlm-own-key')
  expect(harness.secrets.save).not.toHaveBeenCalled()
})

it('deactivates an active non-Ollama VLM when its referenced key is unavailable', async () => {
  const harness = createService({
    version: 2,
    profiles: [
      { id: 'llm', kind: 'llm', name: 'LLM', provider: 'openai', model: 'gpt-5', endpoint, contextLimit: 8_000 },
      { id: 'vlm', kind: 'vlm', name: 'VLM', provider: 'openai', model: 'gpt-vision', endpoint, maxImages: 4 },
    ],
    activeLlmId: 'llm', activeVlmId: 'vlm', routing: 'combined',
    migrations: { apiKeyReferences: [{ sourceProfileId: 'llm', targetProfileId: 'vlm' }] },
  })
  await expect(harness.service.list('vlm')).resolves.toMatchObject([{ id: 'vlm', hasApiKey: false, active: false }])
  expect(harness.getDocument()).toMatchObject({ activeVlmId: null, autoActivateVlm: false })
  expect(harness.getDocument().migrations).not.toHaveProperty('apiKeyReferences')
})

it('does not copy an invalid referenced key or delete the LLM source value', async () => {
  const harness = createService({
    version: 2,
    profiles: [
      { id: 'llm', kind: 'llm', name: 'LLM', provider: 'openai', model: 'gpt-5', endpoint, contextLimit: 8_000 },
      { id: 'vlm', kind: 'vlm', name: 'VLM', provider: 'openai', model: 'gpt-vision', endpoint, maxImages: 4 },
    ],
    activeLlmId: 'llm', activeVlmId: 'vlm', routing: 'combined',
    migrations: { apiKeyReferences: [{ sourceProfileId: 'llm', targetProfileId: 'vlm' }] },
  })
  const rejectedSource = '-----BEGIN PRIVATE KEY-----\nmaterial\n-----END PRIVATE KEY-----'
  const protectedKeys = new Map([['model-profile.llm.apiKey', rejectedSource]])
  harness.secrets.load.mockImplementation(async key => protectedKeys.get(key) ?? null)
  harness.secrets.save.mockImplementation(async (key, value) => { protectedKeys.set(key, value) })

  await expect(harness.service.list('vlm')).resolves.toMatchObject([{ id: 'vlm', hasApiKey: false, active: false }])
  expect(protectedKeys.get('model-profile.vlm.apiKey')).toBeUndefined()
  expect(protectedKeys.get('model-profile.llm.apiKey')).toBe(rejectedSource)
  expect(harness.getDocument().migrations).not.toHaveProperty('apiKeyReferences')
})

it('clears a protected key and deactivates an active key-required profile', async () => {
  const harness = createService({
    version: 2,
    profiles: [
      { id: 'llm', kind: 'llm', name: 'LLM', provider: 'openai', model: 'gpt-5', endpoint, contextLimit: 8_000 },
    ],
    activeLlmId: 'llm', activeVlmId: null, routing: 'combined', migrations: {},
  })
  await expect(harness.service.clearApiKey('llm')).resolves.toMatchObject({ id: 'llm', hasApiKey: false, active: false })
  expect(harness.getDocument()).toMatchObject({ activeLlmId: null, autoActivateLlm: false })
  expect(harness.secrets.remove).toHaveBeenCalledWith('model-profile.llm.apiKey')
})

it('keeps the copied target key and retries pending metadata in a fresh service after repository failure', async () => {
  const harness = createService({
    version: 2,
    profiles: [
      { id: 'llm', kind: 'llm', name: 'LLM', provider: 'openai', model: 'gpt-5', endpoint, contextLimit: 8_000 },
      { id: 'vlm', kind: 'vlm', name: 'VLM', provider: 'openai', model: 'gpt-vision', endpoint, maxImages: 4 },
    ],
    activeLlmId: 'llm', activeVlmId: 'vlm', routing: 'combined',
    migrations: { apiKeyReferences: [{ sourceProfileId: 'llm', targetProfileId: 'vlm' }] },
  })
  const protectedKeys = new Map([['model-profile.llm.apiKey', 'shared-key']])
  harness.secrets.load.mockImplementation(async key => protectedKeys.get(key) ?? null)
  harness.secrets.save.mockImplementation(async (key, value) => { protectedKeys.set(key, value) })
  harness.repository.save.mockRejectedValueOnce(new Error('disk unavailable'))

  await expect(harness.service.list('vlm')).rejects.toThrow('disk unavailable')
  expect(protectedKeys.get('model-profile.vlm.apiKey')).toBe('shared-key')
  expect(harness.getDocument().migrations).toHaveProperty('apiKeyReferences')

  const retry = new ModelProfileService(harness.repository, harness.secrets)
  await expect(retry.list('vlm')).resolves.toMatchObject([{ id: 'vlm', hasApiKey: true, active: true }])
  expect(harness.secrets.save).toHaveBeenCalledTimes(1)
  expect(harness.getDocument().migrations).not.toHaveProperty('apiKeyReferences')
})

it('restores the active document when protected key removal fails', async () => {
  const harness = createService({
    version: 2,
    profiles: [
      { id: 'llm', kind: 'llm', name: 'LLM', provider: 'openai', model: 'gpt-5', endpoint, contextLimit: 8_000 },
    ],
    activeLlmId: 'llm', activeVlmId: null, routing: 'combined', migrations: {},
  })
  harness.secrets.remove.mockRejectedValueOnce(new Error('keychain unavailable'))

  await expect(harness.service.clearApiKey('llm')).rejects.toThrow('keychain unavailable')
  expect(harness.getDocument()).toMatchObject({ activeLlmId: 'llm' })
  expect(harness.repository.save).toHaveBeenNthCalledWith(1, expect.objectContaining({ activeLlmId: null }))
  expect(harness.repository.save).toHaveBeenNthCalledWith(2, expect.objectContaining({ activeLlmId: 'llm' }))
})
```

- [ ] **步骤 3：运行聚焦测试并确认失败**

```powershell
npx vitest run tests/unit/settings/model-profile-repository.test.ts tests/unit/settings/model-profile-service.test.ts
```

预期：失败原因为当前文档仍为版本 1、当前配置仍包含 `apiKeyProfileId`，且服务没有 `clearApiKey` 或待复制迁移逻辑。

- [ ] **步骤 4：定义版本 2 当前文档和版本 1 输入文档**

在 `model-profile-repository.ts` 中：

```ts
const pendingApiKeyReferenceSchema = z.object({
  sourceProfileId: z.string().trim().min(1).max(128),
  targetProfileId: z.string().trim().min(1).max(128),
}).strict()

const persistedModelProfileFields = {
  id: z.string().trim().min(1).max(128),
  name: z.string().trim().min(1).max(255),
  kind: modelProfileKindSchema,
  provider: modelProviderSchema,
  model: z.string().trim().min(1).max(255),
  endpoint: modelEndpointSchema,
  contextLimit: z.number().int().min(1_024).max(1_000_000).optional(),
  maxImages: z.number().int().min(1).max(128).optional(),
}

const persistedModelProfileBaseSchema = z.object(persistedModelProfileFields).strict()

type PersistedModelProfileValidationFields = {
  kind: z.infer<typeof modelProfileKindSchema>
  provider: z.infer<typeof modelProviderSchema>
  endpoint: string
  contextLimit?: number
  maxImages?: number
}

function validatePersistedModelProfile(
  profile: PersistedModelProfileValidationFields,
  context: z.RefinementCtx,
): void {
  if (profile.kind === 'llm' && profile.contextLimit === undefined) {
    context.addIssue({ code: 'custom', path: ['contextLimit'], message: 'LLM contextLimit is required' })
  }
  if (profile.kind === 'llm' && profile.maxImages !== undefined) {
    context.addIssue({ code: 'custom', path: ['maxImages'], message: 'LLM profiles cannot define maxImages' })
  }
  if (profile.kind === 'vlm' && profile.maxImages === undefined) {
    context.addIssue({ code: 'custom', path: ['maxImages'], message: 'VLM maxImages is required' })
  }
  if (profile.kind === 'vlm' && profile.contextLimit !== undefined) {
    context.addIssue({ code: 'custom', path: ['contextLimit'], message: 'VLM profiles cannot define contextLimit' })
  }
  const pathname = new URL(profile.endpoint).pathname
  if (profile.provider === 'ollama' && !pathname.endsWith('/api/chat')) {
    context.addIssue({ code: 'custom', path: ['endpoint'], message: 'Ollama endpoint must target /api/chat' })
  }
  if (profile.provider !== 'ollama' && !pathname.endsWith('/chat/completions')) {
    context.addIssue({ code: 'custom', path: ['endpoint'], message: 'Endpoint must target OpenAI Chat Completions' })
  }
}

const persistedModelProfileSchema = persistedModelProfileBaseSchema
  .superRefine(validatePersistedModelProfile)

const versionOnePersistedModelProfileSchema = z.object({
  ...persistedModelProfileFields,
  apiKeyProfileId: z.string().trim().min(1).max(128).optional(),
}).strict().superRefine(validatePersistedModelProfile)

export type PersistedModelProfile = z.infer<typeof persistedModelProfileSchema>

const modelProfileMigrationsSchema = z.object({
  legacyModelSettings: z.literal(1).optional(),
  legacyModelProfileId: z.string().trim().min(1).max(128).optional(),
  apiKeyReferences: z.array(pendingApiKeyReferenceSchema).max(256).optional(),
}).strict()

const versionOneModelProfileMigrationsSchema = z.object({
  legacyModelSettings: z.literal(1).optional(),
  legacyModelProfileId: z.string().trim().min(1).max(128).optional(),
}).strict()

const modelProfileDocumentStateFields = {
  activeLlmId: z.string().trim().min(1).max(128).nullable(),
  activeVlmId: z.string().trim().min(1).max(128).nullable(),
  autoActivateLlm: z.boolean().optional(),
  autoActivateVlm: z.boolean().optional(),
  routing: modelRoutingSchema,
}

type ModelProfileDocumentValidationFields = {
  profiles: Array<{ id: string; kind: z.infer<typeof modelProfileKindSchema> }>
  activeLlmId: string | null
  activeVlmId: string | null
}

function validateModelProfileDocument(
  document: ModelProfileDocumentValidationFields,
  context: z.RefinementCtx,
): void {
  const ids = new Set(document.profiles.map(profile => profile.id))
  if (document.activeLlmId && document.profiles.find(profile => profile.id === document.activeLlmId)?.kind !== 'llm') {
    context.addIssue({ code: 'custom', path: ['activeLlmId'], message: 'activeLlmId must reference an LLM profile' })
  }
  if (document.activeVlmId && document.profiles.find(profile => profile.id === document.activeVlmId)?.kind !== 'vlm') {
    context.addIssue({ code: 'custom', path: ['activeVlmId'], message: 'activeVlmId must reference a VLM profile' })
  }
  if (ids.size !== document.profiles.length) {
    context.addIssue({ code: 'custom', path: ['profiles'], message: 'profile IDs must be unique' })
  }
}

export const modelProfileDocumentSchema = z.object({
  version: z.literal(2),
  profiles: z.array(persistedModelProfileSchema).max(256),
  ...modelProfileDocumentStateFields,
  migrations: modelProfileMigrationsSchema,
}).strict().superRefine(validateModelProfileDocument)

const versionOneModelProfileDocumentSchema = z.object({
  version: z.literal(1),
  profiles: z.array(versionOnePersistedModelProfileSchema).max(256),
  ...modelProfileDocumentStateFields,
  migrations: versionOneModelProfileMigrationsSchema,
}).strict().superRefine(validateModelProfileDocument)

export type ModelProfileDocument = z.infer<typeof modelProfileDocumentSchema>
type VersionOneModelProfileDocument = z.infer<typeof versionOneModelProfileDocumentSchema>
```

版本 1 迁移函数使用以下转换：

```ts
function migrateVersionOneDocument(document: VersionOneModelProfileDocument): ModelProfileDocument {
  const apiKeyReferences = document.profiles.flatMap(profile => profile.apiKeyProfileId
    ? [{ sourceProfileId: profile.apiKeyProfileId, targetProfileId: profile.id }]
    : [])
  const profiles = document.profiles.map(profile => {
    const { apiKeyProfileId: _removed, ...current } = profile
    return current
  })
  return {
    ...document,
    version: 2,
    profiles,
    migrations: {
      ...document.migrations,
      ...(apiKeyReferences.length > 0 ? { apiKeyReferences } : {}),
    },
  }
}

export function emptyModelProfileDocument(): ModelProfileDocument {
  return {
    version: 2,
    profiles: [],
    activeLlmId: null,
    activeVlmId: null,
    autoActivateLlm: true,
    autoActivateVlm: true,
    routing: 'combined',
    migrations: {},
  }
}

function migrateModelProfileDocument(persisted: unknown): { value: unknown; changed: boolean } {
  if (!isRecord(persisted)) return { value: persisted, changed: false }
  if (persisted.version === 2) return { value: persisted, changed: false }
  if (persisted.version === 1) {
    return {
      value: migrateVersionOneDocument(versionOneModelProfileDocumentSchema.parse(persisted)),
      changed: true,
    }
  }
  if ('endpoint' in persisted && 'model' in persisted) {
    return { value: emptyModelProfileDocument(), changed: true }
  }
  return { value: persisted, changed: false }
}
```

- [ ] **步骤 5：实现服务层幂等复制和配置自有密钥解析**

让现有迁移入口即使没有旧单模型设置源也执行引用迁移，新增以下方法：

```ts
private async completeApiKeyReferenceMigration(document: ModelProfileDocument): Promise<ModelProfileDocument> {
  const pending = document.migrations.apiKeyReferences
  if (!pending?.length) return document

  let activeVlmId = document.activeVlmId
  for (const copy of pending) {
    const target = document.profiles.find(profile => profile.id === copy.targetProfileId && profile.kind === 'vlm')
    if (!target) continue
    const targetSecretKey = secretKey(target.id)
    let targetValue = await this.secrets.load(targetSecretKey)
    if (!targetValue) {
      const source = document.profiles.find(profile => profile.id === copy.sourceProfileId && profile.kind === 'llm')
      const sourceValue = source ? await this.secrets.load(secretKey(source.id)) : null
      let validatedSource: string | null = null
      if (sourceValue) {
        try { validatedSource = validateModelApiKey(sourceValue) } catch { validatedSource = null }
      }
      if (validatedSource) {
        await this.secrets.save(targetSecretKey, validatedSource)
        targetValue = validatedSource
      }
    }
    if (target.id === activeVlmId && target.provider !== 'ollama' && !targetValue) activeVlmId = null
  }

  const { apiKeyReferences: _completed, ...migrations } = document.migrations
  const next: ModelProfileDocument = {
    ...document,
    activeVlmId,
    ...(document.activeVlmId !== null && activeVlmId === null ? { autoActivateVlm: false } : {}),
    migrations,
  }
  await this.repository.save(next)
  return next
}
```

在类字段中加入独立检查标记，并让现有 `ensureLegacyMigration` 无论是否注入旧设置源，都先完成版本 1 引用迁移：

```ts
private apiKeyReferenceMigrationChecked = false

private async ensureApiKeyReferenceMigration(): Promise<void> {
  if (this.apiKeyReferenceMigrationChecked) return
  await this.mutate(async () => {
    const document = await this.repository.load()
    await this.completeApiKeyReferenceMigration(document)
    this.apiKeyReferenceMigrationChecked = true
  })
}
```

将当前 `ensureLegacyMigration` 的开头精确改为：

```diff
 private async ensureLegacyMigration(): Promise<void> {
+  await this.ensureApiKeyReferenceMigration()
   if (this.migrationChecked || !this.legacySettings) return
```

这样引用迁移失败时检查标记不会提前置位，新服务或下一次调用仍可重试；旧单模型迁移的现有顺序不变。

从 `save`、`prepareForConnectionTest`、`delete` 和 `toRendererProfile` 中删除全部引用分支；任务 4 暂时保留文件导入服务仍会调用的 `saveApiKey`，但将它改为只处理配置自有密钥：

```ts
async saveApiKey(id: string, apiKey: string): Promise<RendererModelProfile> {
  await this.ensureLegacyMigration()
  return this.mutate(async () => {
    const document = await this.loadDocumentInMutation()
    const profile = document.profiles.find(candidate => candidate.id === id)
    if (!profile) throw new Error('Unknown model profile')
    const value = validateModelApiKey(apiKey)
    const previousApiKey = await this.secrets.load(secretKey(id))
    await this.secrets.save(secretKey(id), value)
    const next = profile.kind === 'llm'
      && document.activeLlmId === null
      && document.autoActivateLlm !== false
      && await this.isValidForActivation(profile, document, value)
      ? { ...document, activeLlmId: id }
      : profile.kind === 'vlm'
        && document.activeVlmId === null
        && document.autoActivateVlm !== false
        && await this.isValidForActivation(profile, document, value)
        ? { ...document, activeVlmId: id }
        : document
    try {
      if (next !== document) await this.repository.save(next)
    } catch (error) {
      await this.restoreSecret(secretKey(id), previousApiKey)
      throw error
    }
    return this.toRendererProfile(profile, next, value)
  })
}
```

密钥解析及其两个调用辅助器改为以下签名；保留 `_document` 参数可让现有调用点不发生无关改写，但解析只读取 `model-profile.<id>.apiKey`：

```ts
private async isValidForActivation(
  profile: PersistedModelProfile,
  _document: ModelProfileDocument,
  currentApiKey?: string,
): Promise<boolean> {
  return profile.provider === 'ollama'
    || Boolean(currentApiKey ?? await this.resolveApiKey(profile))
}

private async toProtectedProfile(
  profile: PersistedModelProfile,
  _document: ModelProfileDocument,
): Promise<ProtectedModelProfile> {
  return { ...profile, apiKey: await this.resolveApiKey(profile) }
}

private async resolveApiKey(profile: PersistedModelProfile): Promise<string | null> {
  return this.secrets.load(secretKey(profile.id))
}
```

- [ ] **步骤 6：实现密钥清除及失败回滚**

在 `ModelProfileService` 新增：

```ts
async clearApiKey(id: string): Promise<RendererModelProfile> {
  await this.ensureLegacyMigration()
  return this.mutate(async () => {
    const document = await this.loadDocumentInMutation()
    const profile = document.profiles.find(candidate => candidate.id === id)
    if (!profile) throw new Error('Unknown model profile')

    const isActive = profile.kind === 'llm'
      ? document.activeLlmId === id
      : document.activeVlmId === id
    const next = isActive && profile.provider !== 'ollama'
      ? profile.kind === 'llm'
        ? { ...document, activeLlmId: null, autoActivateLlm: false }
        : { ...document, activeVlmId: null, autoActivateVlm: false }
      : document

    if (next !== document) await this.repository.save(next)
    try {
      await this.secrets.remove(secretKey(id))
    } catch (error) {
      if (next !== document) await this.repository.save(document).catch(() => undefined)
      throw error
    }
    return this.toRendererProfile(profile, next, null)
  })
}
```

将 `toRendererProfile` 的第三个参数改为 `knownApiKey?: string | null`。这里必须区分“未提供已知值”和“明确知道密钥为空”，否则清除后会重新读取旧值并错误返回 `hasApiKey: true`：

```ts
private async toRendererProfile(
  profile: PersistedModelProfile,
  document: ModelProfileDocument,
  knownApiKey?: string | null,
): Promise<RendererModelProfile> {
  const apiKey = knownApiKey === undefined
    ? await this.resolveApiKey(profile)
    : knownApiKey
  return {
    id: profile.id,
    name: profile.name,
    kind: profile.kind,
    provider: profile.provider,
    model: profile.model,
    endpoint: profile.endpoint,
    ...(profile.contextLimit === undefined ? {} : { contextLimit: profile.contextLimit }),
    ...(profile.maxImages === undefined ? {} : { maxImages: profile.maxImages }),
    hasApiKey: Boolean(apiKey),
    active: profile.kind === 'llm'
      ? document.activeLlmId === profile.id
      : document.activeVlmId === profile.id,
  }
}
```

在任务 4 删除不再使用的 `requireLlmKeyProfile` 和 `omitApiKeyReference`；`resolveApiKey` 只接收当前配置并读取其自有受保护密钥。`saveApiKey` 在任务 5 与文件导入服务一起删除，避免任务 4 的中间提交出现悬空类型依赖。

- [ ] **步骤 7：更新现有测试夹具并运行完整后端聚焦套件**

正常当前文档夹具统一改为 `version: 2`；只在仓库迁移输入中保留 `version: 1` 和 `apiKeyProfileId`。删除“引用存在时禁止删除 LLM”和“导入密钥时删除引用”两个旧功能测试，以新迁移测试替代。

运行：

```powershell
npx vitest run tests/unit/settings/model-profile-repository.test.ts tests/unit/settings/model-profile-service.test.ts tests/unit/settings/model-api-key-entry-service.test.ts tests/unit/settings/model-settings-service.test.ts tests/unit/model/model-provider-router.test.ts
npm run build
```

预期：所有保留的后端模型测试通过；当前文档和 DTO 中不存在 `apiKeyProfileId`。

- [ ] **步骤 8：提交模型迁移与服务修改**

```powershell
git add src/main/settings/model-profile-repository.ts src/main/settings/model-profile-service.ts src/main/settings/model-api-key-validation.ts tests/unit/settings/model-profile-repository.test.ts tests/unit/settings/model-profile-service.test.ts
git commit -m "refactor: migrate model keys to profile ownership"
```

### 任务 5：开放受控的在线密钥请求并删除文件导入

**文件：**
- 修改：`src/shared/validation.ts`
- 修改：`src/shared/contracts.ts`
- 修改：`src/preload/api.ts`
- 修改：`src/main/settings/register-settings-handlers.ts`
- 修改：`src/main/main.ts`
- 修改：`src/main/settings/model-profile-service.ts`
- 修改：`src/renderer/src/stores/model-profiles.ts`
- 修改：`tests/unit/preload/api.test.ts`
- 修改：`tests/unit/settings/register-settings-handlers.test.ts`
- 修改：`tests/unit/settings/model-profile-service.test.ts`
- 修改：`tests/unit/renderer/model-profiles.test.ts`
- 删除：`src/main/settings/model-api-key-entry-service.ts`
- 删除：`tests/unit/settings/model-api-key-entry-service.test.ts`

- [ ] **步骤 1：编写失败的请求边界测试**

将原先“拒绝 profile API Key”的测试替换为：

```ts
it('accepts a transient profile API key on save and test without returning it', async () => {
  const input = {
    name: 'Primary', kind: 'llm', provider: 'openai', model: 'gpt-5',
    endpoint: 'https://api.openai.com/v1/chat/completions', contextLimit: 8_000,
    apiKey: 'transient-key',
  } as const
  const savedProfile = {
    id: 'llm-1', name: input.name, kind: input.kind, provider: input.provider,
    model: input.model, endpoint: input.endpoint, contextLimit: input.contextLimit,
    hasApiKey: true, active: true,
  }
  const profiles = {
    list: vi.fn(), get: vi.fn(),
    save: vi.fn().mockResolvedValue(savedProfile),
    clearApiKey: vi.fn(), activate: vi.fn(), delete: vi.fn(),
    prepareForConnectionTest: vi.fn().mockResolvedValue({ ...input, profileId: 'llm-1' }),
    getRouting: vi.fn(), setRouting: vi.fn(),
  }

  await expect(handler('settings:models:save')({ sender }, input)).resolves.not.toHaveProperty('apiKey')
  await handler('settings:models:test')({ sender }, input)
  expect(profiles.save).toHaveBeenCalledWith(input)
  expect(profiles.prepareForConnectionTest).toHaveBeenCalledWith(input)
})
```

在 preload 测试中验证保存/测试会先校验输入，并验证清除通道只发送配置 ID：

```ts
await api.settings.models.save(input)
await api.settings.models.test(input)
await api.settings.models.clearApiKey('llm-1')
expect(ipc.invoke).toHaveBeenNthCalledWith(1, 'settings:models:save', input)
expect(ipc.invoke).toHaveBeenNthCalledWith(2, 'settings:models:test', input)
expect(ipc.invoke).toHaveBeenNthCalledWith(3, 'settings:models:key:clear', { id: 'llm-1' })
```

- [ ] **步骤 2：运行聚焦测试并确认失败**

```powershell
npx vitest run tests/unit/preload/api.test.ts tests/unit/settings/register-settings-handlers.test.ts tests/unit/renderer/model-profiles.test.ts
```

预期：保存/测试 schema 仍拒绝密钥，清除 API 不存在，状态仓库仍公开 `importApiKey`。

- [ ] **步骤 3：重构共享请求 schema 和返回 DTO**

在 `validation.ts` 中把当前配置字段与临时密钥分离：

```ts
export const modelApiKeySchema = z.string().trim().min(1).max(4_096).refine(
  value => new TextEncoder().encode(value).byteLength <= 4_096,
  'API key exceeds the maximum supported size',
)

export const modelProfileIdSchema = z.string().trim().min(1).max(128)

const modelProfileBaseSchema = z.object({
  id: modelProfileIdSchema.optional(),
  name: z.string().trim().min(1).max(255),
  kind: modelProfileKindSchema,
  provider: modelProviderSchema,
  model: z.string().trim().min(1).max(255),
  endpoint: modelEndpointSchema,
  contextLimit: z.number().int().min(1_024).max(1_000_000).optional(),
  maxImages: z.number().int().min(1).max(128).optional(),
}).strict()

export const modelProfileInputSchema = modelProfileBaseSchema.extend({
  apiKey: modelApiKeySchema.optional(),
}).strict().superRefine(validateModelProfile)
export const rendererModelProfileInputSchema = modelProfileInputSchema
export type ModelProfileInput = z.infer<typeof modelProfileInputSchema>
export type RendererModelProfileInput = ModelProfileInput
```

删除 `rendererModelProfileUpdateSchema`、`ModelProfileValidationFields.apiKeyProfileId` 和 `validateModelProfile` 中的两个引用验证分支。在 `RendererModelProfile` DTO 中删除 `apiKeyProfileId`，保留 `hasApiKey`。`preload/api.ts` 和 `register-settings-handlers.ts` 都从共享验证模块导入 `modelProfileIdSchema`，并删除设置处理器底部的同名本地 schema，确保渲染边界与主进程边界使用同一 ID 约束。

- [ ] **步骤 4：更新 preload 和 IPC 通道**

preload 方法必须在调用 IPC 前解析：

```ts
save: (input: RendererModelProfileInput) => ipcRenderer.invoke(
  'settings:models:save', rendererModelProfileInputSchema.parse(input),
) as Promise<RendererModelProfile>,
test: (input: RendererModelProfileInput) => ipcRenderer.invoke(
  'settings:models:test', rendererModelProfileInputSchema.parse(input),
) as Promise<{ model: string }>,
clearApiKey: (id: string) => ipcRenderer.invoke(
  'settings:models:key:clear', { id: modelProfileIdSchema.parse(id) },
) as Promise<RendererModelProfile>,
```

`registerProfileHandlers` 的 profile service 类型加入 `clearApiKey`，并注册：

```ts
ipcMain.handle('settings:models:key:clear', async (event, input: unknown) => {
  assertTrustedSender(event, sender)
  const parsed = z.object({ id: modelProfileIdSchema }).strict().parse(input)
  return profiles.clearApiKey(parsed.id)
})
```

注销列表删除 `settings:models:key:import`，加入 `settings:models:key:clear`。

- [ ] **步骤 5：删除文件导入服务和主进程接线**

删除以下生产代码：

```diff
- import { ModelApiKeyEntryService } from './settings/model-api-key-entry-service'
- const modelApiKeys = new ModelApiKeyEntryService(modelProfiles)
- unregisterSettingsHandlers = registerSettingsHandlers(modelSettings, regexRules, mainWindow.webContents, chatCompletions, modelProfiles, modelApiKeys)
+ unregisterSettingsHandlers = registerSettingsHandlers(modelSettings, regexRules, mainWindow.webContents, chatCompletions, modelProfiles)
```

使用 `apply_patch` 删除 `model-api-key-entry-service.ts` 和其单元测试。保留 `model-api-key-validation.ts`，但将错误文案中的 `file` 删除，使其适用于在线输入。

删除 `ModelProfileService.saveApiKey`，并把服务测试中仍通过该方法写入密钥的用例改为当前统一的 `save` 请求。四个调用点分别替换为：

```ts
await expect(service.save({
  id: 'existing', kind: 'llm', name: 'existing', provider: 'openai', model: 'gpt-5',
  endpoint, contextLimit: 8_000, apiKey: value,
})).rejects.toThrow()

await expect(service.save({
  id: 'existing', kind: 'llm', name: 'existing', provider: 'openai', model: 'gpt-5',
  endpoint, contextLimit: 8_000, apiKey: 'new-secret',
})).rejects.toThrow('disk unavailable')

await expect(service.save({
  id: 'later-llm', kind: 'llm', name: 'Later LLM', provider: 'openai', model: 'gpt-5',
  endpoint, contextLimit: 8_000, apiKey: 'later-llm-key',
})).resolves.toMatchObject({ active: false })

await expect(service.save({
  id: 'later-vlm', kind: 'vlm', name: 'Later VLM', provider: 'openai', model: 'gpt-vision',
  endpoint, maxImages: 4, apiKey: 'later-vlm-key',
})).resolves.toMatchObject({ active: false })
```

运行 `rg -n "saveApiKey" src tests`，预期无结果；这证明在线保存已成为唯一密钥写入入口。

- [ ] **步骤 6：让渲染状态仓库只转发临时密钥**

状态仓库 API 用 `clearApiKey` 替换 `importApiKey`：

```ts
async function clearApiKey(profileId: string): Promise<RendererModelProfile> {
  const cleared = await api.clearApiKey(profileId)
  await load(cleared.kind)
  return cleared
}

return {
  state, load, loadAll, profilesForKind,
  save, test, activate, remove, setRouting, clearApiKey,
}
```

草稿类型明确排除临时密钥：

```ts
export type ProfileDraft = Omit<RendererModelProfileInput, 'apiKey'>

export function createProfileDraft(
  profile?: RendererModelProfile,
  kind: ModelProfileKind = profile?.kind ?? 'llm',
): ProfileDraft {
  return profile
    ? {
        id: profile.id,
        name: profile.name,
        kind: profile.kind,
        provider: profile.provider,
        model: profile.model,
        endpoint: profile.endpoint,
        contextLimit: profile.contextLimit,
        maxImages: profile.maxImages,
      }
    : {
        name: '',
        kind,
        provider: 'ollama',
        model: '',
        endpoint: 'http://127.0.0.1:11434/api/chat',
        contextLimit: kind === 'llm' ? 12_000 : undefined,
        maxImages: kind === 'vlm' ? 4 : undefined,
      }
}

export function profileDraftInput(draft: ProfileDraft, apiKey = ''): RendererModelProfileInput {
  const value = apiKey.trim()
  return value ? { ...draft, apiKey: value } : { ...draft }
}
```

- [ ] **步骤 7：运行边界测试、敏感信息检查和构建**

```powershell
npx vitest run tests/unit/preload/api.test.ts tests/unit/settings/register-settings-handlers.test.ts tests/unit/renderer/model-profiles.test.ts tests/unit/settings/model-profile-service.test.ts
rg -n "settings:models:key:import|importApiKey|apiKeyProfileId|ModelApiKeyEntryService" src tests
npm run build
```

预期：Vitest 和构建通过；`rg` 只允许在版本 1 迁移 schema、迁移输入测试或历史文档中找到 `apiKeyProfileId`，在 `src` 当前 API/运行时中不得找到导入功能。

- [ ] **步骤 8：提交请求边界修改**

```powershell
git add src/shared/validation.ts src/shared/contracts.ts src/preload/api.ts src/main/settings/register-settings-handlers.ts src/main/main.ts src/main/settings/model-profile-service.ts src/renderer/src/stores/model-profiles.ts tests/unit/preload/api.test.ts tests/unit/settings/register-settings-handlers.test.ts tests/unit/settings/model-profile-service.test.ts tests/unit/renderer/model-profiles.test.ts
git add -u src/main/settings/model-api-key-entry-service.ts tests/unit/settings/model-api-key-entry-service.test.ts
git commit -m "feat: accept directly edited model keys"
```

### 任务 6：完成在线密钥编辑界面

**文件：**
- 修改：`src/renderer/src/components/settings/ModelProfileManager.vue`
- 修改：`tests/unit/renderer/model-profiles.test.ts`
- 修改：`tests/unit/renderer/v18-visual-contract.test.ts`
- 修改：`tests/e2e/settings.spec.ts`

- [ ] **步骤 1：编写失败的编辑器视觉和草稿测试**

在渲染测试中添加：

```ts
it('builds transient profile input without retaining the key in the draft', () => {
  const draft = createProfileDraft(profile({ hasApiKey: true }))
  expect(draft).not.toHaveProperty('apiKey')
  expect(profileDraftInput(draft, ' replacement-key ')).toMatchObject({ apiKey: 'replacement-key' })
  expect(profileDraftInput(draft, '')).not.toHaveProperty('apiKey')
})
```

在 `v18-visual-contract.test.ts` 对组件源码增加：

```ts
expect(profiles).toContain('v-model="apiKey"')
expect(profiles).toContain("showApiKey ? 'text' : 'password'")
expect(profiles).toContain('EyeOff')
expect(profiles).toContain('清除已保存密钥')
expect(profiles).toContain('已配置密钥，留空则保留')
expect(profiles).not.toContain('导入密钥')
expect(profiles).not.toContain('LLM 密钥引用')
expect(profiles).not.toContain('apiKeyProfileId')
```

- [ ] **步骤 2：运行聚焦测试并确认失败**

```powershell
npx vitest run tests/unit/renderer/model-profiles.test.ts tests/unit/renderer/v18-visual-contract.test.ts
```

预期：当前密码输入框只读，组件仍含导入按钮和引用下拉框。

- [ ] **步骤 3：建立组件局部密钥状态和请求签名**

在 `ModelProfileManager.vue` 中移除 `llmProfiles`、`importKey` 和引用加载，增加：

```ts
const form = reactive<ProfileDraft>(createProfileDraft(undefined, props.kind))
const apiKey = ref('')
const showApiKey = ref(false)
const apiKeyRevision = ref(0)
const currentProfile = computed(() => editingId.value
  ? profiles.value.find(profile => profile.id === editingId.value)
  : undefined)
const keyPlaceholder = computed(() => currentProfile.value?.hasApiKey
  ? '已配置密钥，留空则保留'
  : '可选，Ollama 通常无需填写')

function requestInput(): RendererModelProfileInput {
  return profileDraftInput(form, apiKey.value)
}

function requestSignature(): string {
  return JSON.stringify({ form, apiKeyRevision: apiKeyRevision.value })
}

function clearTransientKey(): void {
  apiKey.value = ''
  showApiKey.value = false
}

function setForm(input: ProfileDraft): void {
  const target = form as unknown as Record<string, unknown>
  for (const key of Object.keys(target)) delete target[key]
  Object.assign(form, input)
}

function reset(): void {
  editingId.value = null
  clearTransientKey()
  setForm(createProfileDraft(undefined, props.kind))
}

function edit(profile: RendererModelProfile): void {
  editingId.value = profile.id
  clearTransientKey()
  setForm(createProfileDraft(profile))
}
```

从组件原有声明中删除 `keyPlaceholder` ref 和旧的 `form`、`reset`、`setForm`、`edit` 实现；从 `model-profiles` 导入 `type ProfileDraft`。新的草稿可以携带编辑 ID，但类型上不能携带明文密钥。

- [ ] **步骤 4：改写保存、测试和清除行为**

```ts
async function save(): Promise<void> {
  busy.value = true
  message.value = ''
  try {
    await store.save(requestInput())
    message.value = '配置已保存'
    reset()
  } catch (error) {
    message.value = error instanceof Error ? error.message : '配置保存失败'
  } finally {
    clearTransientKey()
    busy.value = false
  }
}

async function test(): Promise<void> {
  busy.value = true
  message.value = ''
  const signature = requestSignature()
  const request = testGuard.begin(signature)
  try {
    const result = await store.test(requestInput())
    if (testGuard.isCurrent(request, requestSignature())) message.value = `连接成功：${result.model}`
  } catch (error) {
    if (testGuard.isCurrent(request, requestSignature())) {
      message.value = error instanceof Error ? error.message : '模型连接测试失败'
    }
  } finally {
    clearTransientKey()
    if (testGuard.isLatest(request)) busy.value = false
  }
}

async function clearSavedKey(): Promise<void> {
  const profile = currentProfile.value
  if (!profile?.hasApiKey || !window.confirm(`清除“${profile.name}”已保存的 API Key？`)) return
  busy.value = true
  message.value = ''
  try {
    const cleared = await store.clearApiKey(profile.id)
    edit(cleared)
    message.value = '密钥已清除'
  } catch (error) {
    message.value = error instanceof Error ? error.message : '密钥清除失败'
  } finally {
    clearTransientKey()
    busy.value = false
  }
}
```

- [ ] **步骤 5：替换密钥表单控件**

使用 Lucide `Eye`、`EyeOff` 和 `Trash2`：

```vue
<label class="api-key-field span-2">
  <span>API Key</span>
  <span class="api-key-input-row">
    <input
      v-model="apiKey"
      :type="showApiKey ? 'text' : 'password'"
      :placeholder="keyPlaceholder"
      autocomplete="new-password"
      maxlength="4096"
      :disabled="busy"
      aria-describedby="api-key-note"
      @input="apiKeyRevision += 1"
    >
    <button type="button" class="icon-button" :disabled="busy" :aria-label="showApiKey ? '隐藏 API Key' : '显示 API Key'" :title="showApiKey ? '隐藏 API Key' : '显示 API Key'" @click="showApiKey = !showApiKey">
      <EyeOff v-if="showApiKey" :size="15" aria-hidden="true" />
      <Eye v-else :size="15" aria-hidden="true" />
    </button>
    <button v-if="currentProfile?.hasApiKey" type="button" class="icon-button danger" :disabled="busy" aria-label="清除已保存密钥" title="清除已保存密钥" @click="clearSavedKey">
      <Trash2 :size="15" aria-hidden="true" />
    </button>
  </span>
</label>
<p id="api-key-note" class="key-note span-2">密钥仅在保存或测试时发送给主进程；已保存密钥不会回填。</p>
```

删除列表项中的“导入密钥”按钮和 VLM 的“LLM 密钥引用”下拉框。为 `.api-key-input-row` 和 `.icon-button` 定义稳定高度/宽度，确保最长中文提示在窄设置页换行而不遮挡其他控件。

- [ ] **步骤 6：更新设置 E2E 的基础可见性断言**

把旧导入提示断言替换为：

```ts
const apiKeyInput = page.getByLabel('API Key', { exact: true })
await expect(apiKeyInput).toBeEditable()
await expect(apiKeyInput).toHaveAttribute('type', 'password')
await page.getByRole('button', { name: '显示 API Key', exact: true }).click()
await expect(apiKeyInput).toHaveAttribute('type', 'text')
await page.getByRole('button', { name: '隐藏 API Key', exact: true }).click()
await expect(apiKeyInput).toHaveAttribute('type', 'password')
await expect(page.getByText('密钥仅在保存或测试时发送给主进程；已保存密钥不会回填。', { exact: true })).toBeVisible()
await expect(page.getByRole('button', { name: '导入密钥' })).toHaveCount(0)
await panels.nth(2).click()
await expect(page.getByLabel('API Key', { exact: true })).toBeEditable()
await expect(page.getByText('LLM 密钥引用', { exact: true })).toHaveCount(0)
```

- [ ] **步骤 7：运行 UI 测试和构建**

```powershell
npx vitest run tests/unit/renderer/model-profiles.test.ts tests/unit/renderer/v18-visual-contract.test.ts tests/unit/renderer/settings-panels.test.ts
npx playwright test tests/e2e/settings.spec.ts --grep "opens real settings"
npm run build
```

预期：密钥输入可编辑，导入和引用控件不存在，设置页在现有响应式断点下无溢出。

- [ ] **步骤 8：提交设置界面修改**

```powershell
git add src/renderer/src/components/settings/ModelProfileManager.vue tests/unit/renderer/model-profiles.test.ts tests/unit/renderer/v18-visual-contract.test.ts tests/e2e/settings.spec.ts
git commit -m "feat: edit model API keys in settings"
```

### 任务 7：用真实 Electron 流程验证密钥生命周期和窗口布局

**文件：**
- 修改：`tests/e2e/settings.spec.ts`
- 修改：`tests/e2e/workbench.spec.ts`
- 检查：`src/main/model/chat-completions-client.ts`
- 检查：`src/main/model/model-provider-router.ts`

- [ ] **步骤 1：在设置 E2E 中建立本地受密钥保护的 OpenAI 兼容服务**

在 `tests/e2e/settings.spec.ts` 顶部补齐 Node 导入：

```ts
import { once } from 'node:events'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
```

增加以下完整测试辅助器：

```ts
function closeServer(server: { close(callback: (error?: Error) => void): void }): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
  })
}

async function startKeyedModelServer(): Promise<{
  server: HttpServer
  port: number
  authorizations: readonly string[]
  requests: number
}> {
  const authorizations: string[] = []
  let requests = 0
  const server = createHttpServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.statusCode = 404
      response.end()
      return
    }
    requests += 1
    authorizations.push(request.headers.authorization ?? '')
    request.resume()
    request.on('end', () => {
      response.statusCode = request.headers.authorization ? 200 : 401
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ id: 'test', choices: [{ message: { content: 'ok' } }] }))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    server,
    port: (server.address() as AddressInfo).port,
    authorizations,
    get requests() { return requests },
  }
}
```

- [ ] **步骤 2：编写完整在线密钥 E2E**

新增一条真实设置界面流程，按以下顺序执行：

```ts
test('edits, tests, replaces, and clears a protected model API key without echoing it', async () => {
  const fakeModel = await startKeyedModelServer()
  const userDataDir = await mkdtemp(join(tmpdir(), 'terminal-agent-key-editor-e2e-'))
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined
  try {
    app = await electron.launch({ args: [`--user-data-dir=${userDataDir}`, join(process.cwd(), 'out/main/main.js')] })
    const page = await app.firstWindow()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '大语言模型配置', exact: true }).click()
    await page.getByLabel('连接名称').fill('E2E Keyed Model')
    await page.getByLabel('接口类型').selectOption('openai')
    await page.getByLabel('模型').fill('keyed-e2e')
    await page.getByLabel('接口地址').fill(`http://127.0.0.1:${fakeModel.port}/v1/chat/completions`)

    const key = page.getByLabel('API Key', { exact: true })
    await key.fill('transient-key')
    await page.getByRole('button', { name: '测试连接', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('连接成功：keyed-e2e')
    await expect(key).toHaveValue('')
    expect(fakeModel.authorizations.at(-1)).toBe('Bearer transient-key')
    await expect(page.locator('.profile-item')).toHaveCount(0)

    await key.fill('saved-key')
    await page.getByRole('button', { name: '保存大语言模型配置', exact: true }).click()
    const profile = page.locator('.profile-item').filter({ hasText: 'E2E Keyed Model' })
    await expect(profile).toContainText('已配置密钥')
    await profile.locator('.profile-select').click()
    await expect(key).toHaveValue('')
    await expect(key).toHaveAttribute('placeholder', '已配置密钥，留空则保留')
    await expect(page.locator('body')).not.toContainText('saved-key')
    await page.getByRole('button', { name: '测试连接', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('连接成功：keyed-e2e')
    expect(fakeModel.authorizations.at(-1)).toBe('Bearer saved-key')

    await key.fill('replacement-key')
    await page.getByRole('button', { name: '保存大语言模型配置', exact: true }).click()
    await profile.locator('.profile-select').click()
    await page.getByRole('button', { name: '测试连接', exact: true }).click()
    expect(fakeModel.authorizations.at(-1)).toBe('Bearer replacement-key')

    page.once('dialog', dialog => dialog.accept())
    await page.getByRole('button', { name: '清除已保存密钥', exact: true }).click()
    await expect(profile).toContainText('未配置密钥')
    await expect(profile).toContainText('未激活')
    const requestsAfterClear = fakeModel.requests
    await page.getByRole('button', { name: '测试连接', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('API key')
    expect(fakeModel.requests).toBe(requestsAfterClear)
  } finally {
    await app?.close()
    await closeServer(fakeModel.server)
    await rm(userDataDir, { recursive: true, force: true })
  }
})
```

上述断言分别证明：临时测试不会创建配置，保存后空输入会使用受保护密钥，替换后旧密钥不再使用，清除后非 Ollama 配置在发出 HTTP 请求前即被拒绝。

- [ ] **步骤 3：增加双主题和窄窗口截图/几何验证**

在现有工作台和设置 E2E 中分别设置 `1440x900`、`1024x768`，保存珍珠白/石墨黑截图到 `testInfo.outputPath(...)`。每个尺寸断言：

```ts
const geometry = await page.evaluate(() => {
  const header = document.querySelector('.settings-top, .app-header') as HTMLElement
  const rightmostContent = header.matches('.settings-top')
    ? document.querySelector('.settings-top h1') as HTMLElement
    : document.querySelector('.app-header-actions') as HTMLElement
  const headerBox = header.getBoundingClientRect()
  const contentBox = rightmostContent.getBoundingClientRect()
  const baseRightPadding = header.matches('.settings-top') ? 16 : 14
  const controlsInset = Number.parseFloat(getComputedStyle(header).paddingRight) - baseRightPadding
  return {
    controlsInset,
    contentClear: contentBox.right <= window.innerWidth - controlsInset + 0.5,
    headerHeight: headerBox.height,
    noOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  }
})
expect(geometry.controlsInset).toBeGreaterThanOrEqual(138)
expect(geometry.contentClear).toBe(true)
expect(geometry.noOverflow).toBe(true)
```

- [ ] **步骤 4：运行真实 Electron E2E**

```powershell
npm run build
npx playwright test tests/e2e/settings.spec.ts
npx playwright test tests/e2e/workbench.spec.ts --grep "layout preferences|streams fake global AI chat"
```

预期：在线密钥完整生命周期通过；现有 AI 工作区流式、重试和持久化行为不回归；截图和几何断言无重叠或裁切。

- [ ] **步骤 5：提交 E2E 证据**

```powershell
git add tests/e2e/settings.spec.ts tests/e2e/workbench.spec.ts
git commit -m "test: verify online model key lifecycle"
```

### 任务 8：更新 `1.0.8` 发布信息并执行完整验证

**文件：**
- 修改：`package.json`
- 修改：`package-lock.json`
- 修改：`README.md`
- 修改：`README-en.md`
- 修改：`RELEASE_NOTES.md`
- 修改：`tests/unit/windows/app-branding.test.ts`

- [ ] **步骤 1：先把版本契约改为失败状态**

将 `app-branding.test.ts` 改为：

```ts
expect(packageJson.version).toBe('1.0.8')
```

运行：

```powershell
npx vitest run tests/unit/windows/app-branding.test.ts
```

预期：失败，因为当前版本仍为 `1.0.7`。

- [ ] **步骤 2：升级包版本**

```powershell
npm version 1.0.8 --no-git-tag-version
```

预期：`package.json`、`package-lock.json` 根版本均为 `1.0.8`，不创建 Git 标签。

- [ ] **步骤 3：更新中英文 README 和发布说明**

README 中文步骤改为“在模型连接表单中输入 API Key，选择测试连接，然后保存并激活模型”；英文使用对应直接输入说明。只更新 README 当前下载说明、当前版本标题和当前版本资产表中的文件名为 `1.0.8`，保留 `RELEASE_NOTES.md` 内已有 `1.0.7` 及更早历史记录。

在 `RELEASE_NOTES.md` 顶部新增：

```markdown
# Terminal-Agent v1.0.8

Release date: 2026-08-23

## CETA follow-up refinements

- Merges the native Windows controls into the application header while retaining minimize, maximize/restore, close, snapping, and accessibility behavior.
- Replaces file-based model-key import with direct, non-echoing API Key editing backed by Windows protected storage.
- Removes LLM key references and migrates existing VLM references to profile-owned protected credentials.

## Windows release assets

- Includes `Terminal-Agent-Setup-1.0.8.exe`, the standalone `putty.exe` bridge, and `Terminal-Agent-Uninstall-Cleanup-1.0.8.zip`.

---
```

- [ ] **步骤 4：运行完整自动化验证矩阵**

每个命令独立运行并记录准确测试数量：

```powershell
npm test
npm run lint
npm run build
npm run test:e2e
npm run test:integration
```

预期：全部退出 0。任何失败都必须先使用 `superpowers:systematic-debugging` 确定根因，修复后重新运行失败命令和可能受影响的后续命令。

- [ ] **步骤 5：执行敏感信息和移除功能审计**

```powershell
rg -n "settings:models:key:import|importApiKey|导入密钥|LLM 密钥引用" src tests README.md README-en.md
rg -n "apiKeyProfileId" src tests
git diff --check
```

预期：第一条搜索无结果；第二条只允许在版本 1 迁移 schema/输入测试中出现；`git diff --check` 无输出。

- [ ] **步骤 6：提交发布元数据**

```powershell
git add package.json package-lock.json README.md README-en.md RELEASE_NOTES.md tests/unit/windows/app-branding.test.ts
git commit -m "release: prepare Terminal-Agent 1.0.8"
```

### 任务 9：视觉验收、安装包构建和打包后冒烟测试

**产物：**
- 生成：`release/Terminal-Agent-Setup-1.0.8.exe`
- 生成：`release/Terminal-Agent-Setup-1.0.8.exe.blockmap`
- 生成：`release/Terminal-Agent-Uninstall-Cleanup-1.0.8.zip`
- 生成：`release/latest.yml`
- 生成：`release/putty.exe`

- [ ] **步骤 1：检查 Playwright 截图**

逐张检查任务 7 生成的珍珠白/石墨黑、`1440x900`/`1024x768` 工作台和设置截图，要求：

- 仅有一组 `TA + Terminal-Agent` 品牌；
- 设置、返回工作台、当前聊天文字均未进入右上角窗口按钮区域；
- API Key 输入、显示/隐藏和清除按钮不重叠、不裁切；
- 页面无水平溢出，文本不遮挡相邻控件。

- [ ] **步骤 2：运行 Windows 打包**

```powershell
npm run make:win
```

预期：命令退出 0，并生成安装包、blockmap、独立桥接程序和卸载清理压缩包。

- [ ] **步骤 3：检查发布产物和校验值**

```powershell
Get-Item release/Terminal-Agent-Setup-1.0.8.exe,release/Terminal-Agent-Setup-1.0.8.exe.blockmap,release/Terminal-Agent-Uninstall-Cleanup-1.0.8.zip,release/putty.exe | Select-Object FullName,Length,LastWriteTime
Get-FileHash release/Terminal-Agent-Setup-1.0.8.exe -Algorithm SHA256
```

预期：所有文件非空；记录安装包绝对路径、字节数、生成时间和 SHA-256。

- [ ] **步骤 4：冒烟测试打包后的窗口和原生按钮**

使用临时用户数据目录启动：

```powershell
release\win-unpacked\Terminal-Agent-runtime.exe --user-data-dir="$env:TEMP\terminal-agent-1.0.8-smoke"
```

通过 Windows 屏幕截图检查真实窗口，而不仅是 WebContents：顶部独立标题栏不再出现，右上角原生最小化、最大化/还原和关闭按钮可见。依次实际点击最小化、还原、最大化/还原；最后从应用内进入设置并返回工作台，再正常关闭程序。

- [ ] **步骤 5：执行最终完成审计**

```powershell
git status --short --branch
git log --oneline origin/main..HEAD
git diff --stat origin/main...HEAD
```

预期：分支为 `codex/ceta-current-polish`；除被 `.gitignore` 排除的发布产物和测试截图外工作区干净；提交历史包含设计、窗口层、迁移、在线密钥界面、E2E 和 `1.0.8` 发布提交。

逐项对照中文设计文档的九条验收标准，只有在源码、测试输出、真实窗口截图和安装包证据均完整时，才能宣布完成。
