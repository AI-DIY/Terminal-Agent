# Terminal-Agent V18 原型完整功能对齐实施计划

> **执行代理必读：** 实施本计划时，必须使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans，逐任务执行。所有执行步骤使用复选框跟踪。

**目标：** 实现已确认 V18 HTML 原型中的全部真实用户功能，同时保留现有 SSH、AccessClient、Agent、安全机制和安装包行为。

**架构：** 在主进程增加带版本的聊天工作区、Shell 历史、模型配置、工作台偏好和主机记忆仓库与服务；只通过严格类型化的 preload IPC 暴露给 renderer；用职责单一的 Vue 组件替换左侧会话、右侧 Agent 和设置页的占位实现。SSH 会话、执行网关、正则围栏、主机观察、V18 连接入口和密钥仓库全部复用现有实现，不再创建第二套逻辑。

**技术栈：** Electron 43、Vue 3 Composition API、TypeScript 6、Zod 4、xterm 6、ssh2、Vitest、Playwright Electron、electron-builder/NSIS。

**设计规格：** docs/superpowers/specs/2026-08-16-terminal-agent-v18-full-prototype-parity-design.md

**产品基准：** .superpowers/brainstorm/ui-20260811185554/content/simplified-core-workbench-v18-unified-ssh-connection.html

---

## 文件职责总览

新增主进程持久化与业务模块：

- src/main/persistence/atomic-json-store.ts：带版本、结构校验、串行写入和原子替换的 JSON 存储基础。
- src/main/chat/chat-contracts.ts：仅供主进程使用的聊天实体与端口。
- src/main/chat/chat-repository.ts：持久化聊天、消息和 Shell 关联。
- src/main/chat/chat-service.ts：聊天创建、更新、标题、驾驶模式和 Shell 关联规则。
- src/main/chat/chat-runtime.ts：模型流式响应、运行关联、上下文组装和压缩。
- src/main/chat/token-estimator.ts：确定性的上下文用量估算。
- src/main/chat/register-chat-handlers.ts：可信聊天 IPC 和 renderer 事件。
- src/main/shell-history/shell-history-repository.ts：有上限的终端历史持久化。
- src/main/shell-history/shell-history-service.ts：会话生命周期、历史预览和重连描述。
- src/main/shell-history/register-shell-history-handlers.ts：可信 Shell 历史 IPC。
- src/main/settings/model-profile-repository.ts：不含密钥的 LLM/VLM 配置和模型路由。
- src/main/settings/model-profile-service.ts：模型配置增删改查、密钥处理、测试、激活和迁移。
- src/main/settings/workbench-preferences-service.ts：外观、布局和主机记忆选项。
- src/main/settings/register-workbench-settings-handlers.ts：类型化工作台设置 IPC。
- src/main/agent/multi-session-plan-service.ts：多目标命令决策、执行和审计。

新增 renderer 模块：

- src/renderer/src/stores/chat-workspaces.ts：当前聊天、实时/历史切换和过期事件拒绝。
- src/renderer/src/stores/layout-preferences.ts：持久化左右面板与 Shell 布局。
- src/renderer/src/components/workbench/ShellCanvas.vue：V18 Shell 工具栏、标签、网格和操作。
- src/renderer/src/components/workbench/ShellHistoryDialog.vue：历史列表、预览和重连。
- src/renderer/src/components/chat/GlobalChatPanel.vue：V18 右侧全局 AI。
- src/renderer/src/components/chat/CommandPlanCard.vue：多主机命令编辑、批准、拒绝和结果。
- src/renderer/src/components/settings/ModelRoutingSettings.vue：原型中的模型选择。
- src/renderer/src/components/settings/ModelProfileManager.vue：LLM/VLM 共用配置管理器。
- src/renderer/src/components/settings/HostMemorySettings.vue：主机记忆告知、选项和增删改查。
- src/renderer/src/components/settings/AppearanceSettings.vue：主题和布局偏好。

需要协调修改的现有文件：

- src/shared/contracts.ts、src/shared/validation.ts：严格 renderer DTO 与 Zod schema。
- src/preload/api.ts：冻结并暴露类型化 API。
- src/main/main.ts：构造服务、执行迁移、注册 handler 和销毁资源。
- src/main/ssh/session-service.ts：安全重连元数据和生命周期订阅。
- src/main/facts/host-facts-repository.ts、src/main/facts/host-facts-service.ts：列表、更新、删除和版本迁移。
- src/main/agent/agent-model-runtime.ts：适配多主机命令计划格式。
- src/main/agent/execution-gateway.ts：继续作为安全围栏唯一执行入口。
- src/renderer/src/views/WorkbenchView.vue：只负责页面组合和跨模块协调。
- src/renderer/src/views/SettingsView.vue：原型中的六个设置面板。
- src/renderer/src/components/workbench/WorkbenchShell.vue：分隔条、折叠栏和插槽。
- src/renderer/src/components/workbench/WorkbenchSessionSidebar.vue：真实聊天会话。
- src/renderer/src/App.vue、src/renderer/src/main.ts：偏好预加载并保持工作台挂载。
- tests/e2e/workbench.spec.ts：完整原型验收，同时保留现有用例。

---

### 任务 1：固定 V18 功能验收清单和现有基线

**文件：**

- 新建：tests/fixtures/v18-prototype-actions.json
- 新建：tests/unit/renderer/v18-prototype-coverage.test.ts
- 新建：src/renderer/src/prototype-actions.ts
- 修改：tests/e2e/workbench.spec.ts

- [ ] **步骤 1：写入原型操作清单**

把每个稳定操作记录为结构化需求：设置入口、新建/选择聊天、左右折叠、布局、主机操作、Shell 历史、四种 SSH、驾驶模式、上下文压缩、发送消息、命令编辑/批准/拒绝、六个设置面板、模型配置操作、主机记忆和主题。

~~~json
{
  "source": "simplified-core-workbench-v18-unified-ssh-connection.html",
  "areas": {
    "chatSessions": ["create", "select-live", "select-history", "restore-live"],
    "shellCanvas": ["layout", "focus", "close", "maximize", "duplicate", "reconnect", "history"],
    "globalChat": ["send", "stream", "retry", "compress", "copilot", "autonomous", "edit-plan", "approve", "reject"],
    "settings": ["routing", "llm-profiles", "vlm-profiles", "fence", "memory", "appearance"],
    "ssh": ["cmdb", "bastion-host", "password", "private-key"]
  }
}
~~~

- [ ] **步骤 2：先写会失败的完整覆盖测试**

~~~ts
import { readFileSync } from 'node:fs'
import { implementedPrototypeActions } from '../../../src/renderer/src/prototype-actions'

it('为 V18 中每个已确认操作提供生产实现', () => {
  const inventory = JSON.parse(readFileSync(
    new URL('../../fixtures/v18-prototype-actions.json', import.meta.url),
    'utf8',
  )) as { areas: Record<string, string[]> }
  const required = Object.values(inventory.areas).flat().sort()
  expect([...implementedPrototypeActions].sort()).toEqual(required)
})
~~~

- [ ] **步骤 3：运行测试并确认红灯**

运行：npx vitest run tests/unit/renderer/v18-prototype-coverage.test.ts

预期：因为 prototype-actions.ts 尚不存在而失败。

- [ ] **步骤 4：建立类型化实施清单**

只登记当前已经真实支持的四种 SSH 操作。后续任务必须在功能测试通过后才追加相应操作名，不能为了让验收测试变绿而提前登记。

~~~ts
export const implementedPrototypeActions = [
  'cmdb', 'bastion-host', 'password', 'private-key',
] as const
~~~

- [ ] **步骤 5：运行现有完整基线**

运行：npm test && npm run test:integration && npm run lint && npm run build && npm run test:e2e

预期：全部现有测试通过。完整覆盖测试暂时使用 .skip，并注明在任务 15 启用。

- [ ] **步骤 6：提交**

~~~powershell
git add tests/fixtures/v18-prototype-actions.json tests/unit/renderer/v18-prototype-coverage.test.ts src/renderer/src/prototype-actions.ts tests/e2e/workbench.spec.ts
git commit -m "test: inventory complete V18 prototype behavior"
~~~

### 任务 2：增加安全的带版本 JSON 持久化基础

**文件：**

- 新建：src/main/persistence/atomic-json-store.ts
- 新建：tests/unit/persistence/atomic-json-store.test.ts

- [ ] **步骤 1：先写持久化基础的失败测试**

覆盖：文件不存在时返回默认值、严格 schema 校验、并发写入顺序、临时文件原子替换、损坏文件备份、解析失败后不覆盖原文件。

~~~ts
const schema = z.object({
  version: z.literal(1),
  values: z.array(z.string()),
}).strict()
const store = new AtomicJsonStore(path, schema, () => ({ version: 1, values: [] }))
await Promise.all([
  store.update(value => ({ ...value, values: [...value.values, 'a'] })),
  store.update(value => ({ ...value, values: [...value.values, 'b'] })),
])
expect((await store.load()).values).toEqual(['a', 'b'])
~~~

- [ ] **步骤 2：运行并确认红灯**

运行：npx vitest run tests/unit/persistence/atomic-json-store.test.ts

预期：AtomicJsonStore 缺失导致失败。

- [ ] **步骤 3：实现最小持久化基础**

~~~ts
export class AtomicJsonStore<T> {
  private queue = Promise.resolve()

  constructor(
    private path: string,
    private schema: z.ZodType<T>,
    private empty: () => T,
  ) {}

  load(): Promise<T> {
    return this.readValidated()
  }

  update(change: (current: T) => T | Promise<T>): Promise<T> {
    const write = this.queue.then(async () => {
      const next = this.schema.parse(await change(await this.readValidated()))
      await writeAtomically(this.path, next)
      return structuredClone(next)
    })
    this.queue = write.then(() => undefined, () => undefined)
    return write
  }
}
~~~

readValidated 和 writeAtomically 使用 mkdir、UUID 临时文件、UTF-8 JSON 和 rename。读取到损坏数据时先生成带时间的 .corrupt 备份，再向上报告错误。

- [ ] **步骤 4：运行并确认绿灯**

运行：npx vitest run tests/unit/persistence/atomic-json-store.test.ts

预期：全部通过，测试目录没有遗留临时文件。

- [ ] **步骤 5：提交**

~~~powershell
git add src/main/persistence/atomic-json-store.ts tests/unit/persistence/atomic-json-store.test.ts
git commit -m "feat: add safe versioned JSON persistence"
~~~

### 任务 3：实现持久化聊天工作区和类型化 IPC

**文件：**

- 新建：src/main/chat/chat-contracts.ts
- 新建：src/main/chat/chat-repository.ts
- 新建：src/main/chat/chat-service.ts
- 新建：src/main/chat/register-chat-handlers.ts
- 新建：tests/unit/chat/chat-repository.test.ts
- 新建：tests/unit/chat/chat-service.test.ts
- 新建：tests/unit/chat/register-chat-handlers.test.ts
- 修改：src/shared/contracts.ts
- 修改：src/preload/api.ts
- 修改：src/main/main.ts
- 修改：tests/unit/shared/contracts.test.ts
- 修改：tests/unit/preload/api.test.ts

- [ ] **步骤 1：先写契约和服务失败测试**

覆盖严格输入校验、时间后备标题、列表排序、聊天级驾驶模式、Shell 关联数量、消息只追加、删除聊天不关闭会话、拒绝不可信 IPC。

~~~ts
const chat = await service.create({ requestId, now })
expect(chat.title).toBe('新建聊天 2026-08-16 16:00:00')
expect(chat.mode).toBe('copilot')
~~~

- [ ] **步骤 2：运行并确认红灯**

运行：npx vitest run tests/unit/chat tests/unit/shared/contracts.test.ts tests/unit/preload/api.test.ts

预期：聊天 schema 和 API 尚不存在而失败。

- [ ] **步骤 3：增加严格共享 DTO**

定义 ChatSummary、ChatWorkspace、ChatMessageRecord、ChatShellAssociation、ChatCreateRequest、ChatSetModeRequest 及严格 Zod schema。Renderer DTO 只能包含显示身份和历史 ID，不能包含凭据或主进程重连描述。

~~~ts
export type ChatSummary = {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  shellCount: number
  mode: SessionMode
  live: boolean
}

export type ChatMessageRecord = {
  id: string
  chatId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: string
  state: 'complete' | 'streaming' | 'error'
}
~~~

- [ ] **步骤 4：实现仓库和服务**

使用 AtomicJsonStore 保存 { version: 1, chats, messages, associations }。提供 list、get、create、appendMessage、updateTitle、setMode、associateShell、closeAssociation、remove。所有写操作在持久化文档中按 requestId 去重。

- [ ] **步骤 5：实现可信 IPC 和 preload API**

~~~ts
chats: {
  list(): Promise<ChatSummary[]>
  create(request: ChatCreateRequest): Promise<ChatWorkspace>
  get(chatId: string): Promise<ChatWorkspace>
  setMode(request: ChatSetModeRequest): Promise<ChatWorkspace>
  remove(request: { chatId: string; requestId: string }): Promise<void>
  onChanged(listener: (event: ChatChangedEvent) => void): () => void
}
~~~

每个 channel 都先严格 parse，再验证 event.sender === trustedSender。销毁时必须移除全部 handler 和事件监听。

- [ ] **步骤 6：接入 main.ts 并确认绿灯**

运行：npx vitest run tests/unit/chat tests/unit/shared/contracts.test.ts tests/unit/preload/api.test.ts tests/unit/ipc/register-handlers.test.ts

预期：全部通过。

- [ ] **步骤 7：提交**

~~~powershell
git add src/main/chat src/shared/contracts.ts src/preload/api.ts src/main/main.ts tests/unit/chat tests/unit/shared/contracts.test.ts tests/unit/preload/api.test.ts
git commit -m "feat: persist chat workspaces"
~~~

### 任务 4：把左侧占位会话列表替换成真实聊天

**文件：**

- 新建：src/renderer/src/stores/chat-workspaces.ts
- 新建：tests/unit/renderer/chat-workspaces.test.ts
- 修改：src/renderer/src/components/workbench/WorkbenchSessionSidebar.vue
- 修改：src/renderer/src/views/WorkbenchView.vue
- 修改：src/renderer/src/components/workbench/WorkbenchShell.vue
- 修改：tests/e2e/workbench.spec.ts

- [ ] **步骤 1：先写 store 和组件失败测试**

覆盖日期分组、新建、选择、删除、拒绝过期事件、恢复实时工作区快照、当前标题和真实 Shell 数量。

~~~ts
const store = createChatWorkspacesStore(api)
await store.load()
await store.select('history-a')
expect(store.state.selected?.id).toBe('history-a')
store.apply({ revision: 1, chat: newerChat })
store.apply({ revision: 0, chat: staleChat })
expect(store.state.selected?.title).toBe(newerChat.title)
~~~

- [ ] **步骤 2：运行并确认红灯**

运行：npx vitest run tests/unit/renderer/chat-workspaces.test.ts

预期：store 缺失导致失败。

- [ ] **步骤 3：实现 store 和侧栏输入/事件**

WorkbenchSessionSidebar.vue 接收分组后的 ChatSummary、当前 ID、加载状态和错误，发出 create、select、remove。现有 SSH 会话行移动到中间 Shell 标签；左侧只显示聊天，与 V18 一致。

- [ ] **步骤 4：在 WorkbenchView.vue 协调聊天切换**

实时终端始终保持挂载。为每个聊天保存可见会话 ID 和活动 ID。历史聊天把历史关联交给 ShellCanvas，并让 GlobalChatPanel 进入只读回放。返回实时聊天时恢复原来的活动终端和布局。

- [ ] **步骤 5：完成端到端红绿循环**

新增用例：新建聊天、连接一个本地 SSH、重新加载 renderer 后仍显示同一聊天标题和“1 个 Shell”。

运行：npx playwright test tests/e2e/workbench.spec.ts --grep "persists chat navigation"

预期：实现后通过。

- [ ] **步骤 6：更新操作清单并提交**

测试通过后才登记 create、select-live、select-history、restore-live。

~~~powershell
git add src/renderer/src/stores/chat-workspaces.ts src/renderer/src/components/workbench/WorkbenchSessionSidebar.vue src/renderer/src/views/WorkbenchView.vue src/renderer/src/components/workbench/WorkbenchShell.vue src/renderer/src/prototype-actions.ts tests/unit/renderer/chat-workspaces.test.ts tests/e2e/workbench.spec.ts
git commit -m "feat: add durable chat navigation"
~~~

### 任务 5：持久化布局并实现完整 Shell 画布控制

**文件：**

- 新建：src/main/settings/workbench-preferences-service.ts
- 新建：src/main/settings/register-workbench-settings-handlers.ts
- 新建：src/renderer/src/stores/layout-preferences.ts
- 新建：src/renderer/src/components/workbench/ShellCanvas.vue
- 新建：tests/unit/settings/workbench-preferences-service.test.ts
- 新建：tests/unit/renderer/layout-preferences.test.ts
- 修改：src/shared/contracts.ts
- 修改：src/preload/api.ts
- 修改：src/main/main.ts
- 修改：src/renderer/src/components/workbench/WorkbenchShell.vue
- 修改：src/renderer/src/views/WorkbenchView.vue
- 修改：tests/e2e/workbench.spec.ts

- [ ] **步骤 1：先写布局校验失败测试**

~~~ts
expect(workbenchPreferencesSchema.parse({
  theme: 'pearl',
  leftWidth: 222,
  rightWidth: 390,
  leftCollapsed: false,
  rightCollapsed: false,
  visibleCount: 3,
  columns: 3,
  rowHeight: 330,
})).toMatchObject({ visibleCount: 3, columns: 3 })
expect(() => workbenchPreferencesSchema.parse({ leftWidth: 9000 })).toThrow()
~~~

同时覆盖 1-4 个可见面板、1-4 列、260/330/410 行高、最大化/恢复、隐藏终端仍挂载、键盘调整分隔条边界。

- [ ] **步骤 2：运行并确认红灯**

运行：npx vitest run tests/unit/settings/workbench-preferences-service.test.ts tests/unit/renderer/layout-preferences.test.ts

预期：schema 和服务缺失导致失败。

- [ ] **步骤 3：实现偏好服务与类型化 API**

通过 AtomicJsonStore 保存 { version: 1, appearance, layout, routing, memory }。saveLayout 只合并校验通过的布局字段，并返回主进程归一化后的权威值。

- [ ] **步骤 4：实现 ShellCanvas.vue**

把工具栏、SessionTabs、终端网格、展示数量、列数、行高、最大化/恢复、关闭和“新建 SSH 连接”入口移入组件。TerminalPane 始终按 session ID 保持稳定 key；仅隐藏时不能重新挂载。

- [ ] **步骤 5：实现分隔条和折叠栏**

WorkbenchShell.vue 使用 pointer capture 和方向键调整，提供 role="separator"、aria-valuenow 和固定最小/最大值；延迟保存宽度。恢复 V18 的左右展开按钮。

- [ ] **步骤 6：运行聚焦测试与 E2E**

运行：npx vitest run tests/unit/settings/workbench-preferences-service.test.ts tests/unit/renderer/layout-preferences.test.ts tests/unit/renderer/visible-panes.test.ts

运行：npx playwright test tests/e2e/workbench.spec.ts --grep "layout|collapse|maximize"

预期：全部通过，布局变化后原终端仍在线。

- [ ] **步骤 7：更新操作清单并提交**

测试通过后登记 layout、focus、close、maximize。

~~~powershell
git add src/main/settings/workbench-preferences-service.ts src/main/settings/register-workbench-settings-handlers.ts src/shared/contracts.ts src/preload/api.ts src/main/main.ts src/renderer/src/stores/layout-preferences.ts src/renderer/src/components/workbench/ShellCanvas.vue src/renderer/src/components/workbench/WorkbenchShell.vue src/renderer/src/views/WorkbenchView.vue src/renderer/src/prototype-actions.ts tests/unit/settings/workbench-preferences-service.test.ts tests/unit/renderer/layout-preferences.test.ts tests/e2e/workbench.spec.ts
git commit -m "feat: implement persisted Shell canvas layout"
~~~

### 任务 6：采集有上限的 Shell 历史并提供安全预览

**文件：**

- 新建：src/main/shell-history/shell-history-contracts.ts
- 新建：src/main/shell-history/shell-history-repository.ts
- 新建：src/main/shell-history/shell-history-service.ts
- 新建：src/main/shell-history/register-shell-history-handlers.ts
- 新建：tests/unit/shell-history/shell-history-repository.test.ts
- 新建：tests/unit/shell-history/shell-history-service.test.ts
- 新建：tests/unit/shell-history/register-shell-history-handlers.test.ts
- 修改：src/main/ssh/session-service.ts
- 修改：src/shared/contracts.ts
- 修改：src/preload/api.ts
- 修改：src/main/main.ts

- [ ] **步骤 1：先写保留上限和脱敏失败测试**

覆盖输出块顺序、单记录 256 KiB 截断、每主机最多 50 条、密码和 Token 不落盘、聊天关联、关闭时间和 renderer 安全 DTO。

~~~ts
service.attach({
  sessionId: 's1',
  chatId: 'c1',
  hostname: 'web-01',
  startedAt,
})
service.append({
  sessionId: 's1',
  data: 'ready\r\npassword=secret\r\n',
})
await service.close({ sessionId: 's1', endedAt })
expect((await service.list({ chatId: 'c1' }))[0].preview).not.toContain('secret')
~~~

- [ ] **步骤 2：运行并确认红灯**

运行：npx vitest run tests/unit/shell-history

预期：历史服务缺失导致失败。

- [ ] **步骤 3：实现仓库和服务**

实时输出块只在主进程内存采集；写入前调用 redactSensitiveText；使用 { version: 1, records } 的 AtomicJsonStore。Renderer DTO 只暴露标题、时间、状态、预览和 reconnectable 布尔值，不暴露真实重连描述。

- [ ] **步骤 4：接入会话生命周期**

在 main.ts 订阅 sessions.onOpened、onData、onClosed；有聊天关联后再附加 chatId。历史落盘不能阻塞终端数据事件。持久化失败只发送安全历史错误，不能关闭 SSH。

- [ ] **步骤 5：增加类型化历史 IPC**

~~~ts
shellHistory: {
  list(request: {
    chatId?: string
    hostname?: string
  }): Promise<ShellHistorySummary[]>
  get(historyId: string): Promise<ShellHistoryDetail>
  onChanged(listener: (event: ShellHistoryChangedEvent) => void): () => void
}
~~~

- [ ] **步骤 6：确认绿灯并提交**

运行：npx vitest run tests/unit/shell-history tests/unit/ssh/session-service.test.ts tests/unit/preload/api.test.ts

~~~powershell
git add src/main/shell-history src/main/ssh/session-service.ts src/shared/contracts.ts src/preload/api.ts src/main/main.ts tests/unit/shell-history tests/unit/ssh/session-service.test.ts tests/unit/preload/api.test.ts
git commit -m "feat: persist safe Shell history"
~~~

### 任务 7：实现 Shell 历史回放、复制通道和重新连接

**文件：**

- 新建：src/renderer/src/components/workbench/ShellHistoryDialog.vue
- 新建：src/renderer/src/stores/shell-history.ts
- 新建：tests/unit/renderer/shell-history.test.ts
- 修改：src/main/shell-history/shell-history-service.ts
- 修改：src/main/shell-history/register-shell-history-handlers.ts
- 修改：src/main/ssh/direct-session-repository.ts
- 修改：src/shared/contracts.ts
- 修改：src/preload/api.ts
- 修改：src/renderer/src/components/workbench/ShellCanvas.vue
- 修改：src/renderer/src/views/WorkbenchView.vue
- 修改：tests/e2e/workbench.spec.ts

- [ ] **步骤 1：先写重连资格和 renderer 失败测试**

验证：直连或 AccessClient 重连描述始终只在主进程；复制通道建立第二个真实会话；只有描述仍有效时才允许重连；历史终端只读；聊天切换后可恢复实时终端。

- [ ] **步骤 2：运行并确认红灯**

运行：npx vitest run tests/unit/renderer/shell-history.test.ts tests/unit/shell-history/shell-history-service.test.ts

预期：复制和重连 API 缺失导致失败。

- [ ] **步骤 3：实现主进程不透明重连引用**

持久化层只保存不透明引用。主进程根据引用查询直连会话仓库或 AccessClient 安全描述。duplicate(sessionId) 和 reconnect(historyId) 返回新的权威 ConnectedSession；不接受 renderer 提供凭据或启动命令。

- [ ] **步骤 4：实现历史对话框和主机右键菜单**

保持 V18 左侧列表、右侧预览结构。打开后聚焦第一条记录，锁定焦点，支持 Escape 和点击遮罩关闭，关闭后焦点返回触发按钮。右键菜单包含复制、重连和历史，并正确禁用不可用操作。

- [ ] **步骤 5：实现聊天级历史回放协调**

选择历史聊天后，根据关联关系为每台主机显示最新只读历史。重连时切换到实时聊天，建立真实新会话，关联到所选聊天并写入重连审计。

- [ ] **步骤 6：验证 E2E 并更新操作清单**

运行：npx playwright test tests/e2e/workbench.spec.ts --grep "history|duplicate|reconnect"

测试通过后登记 duplicate、reconnect、history。

- [ ] **步骤 7：提交**

~~~powershell
git add src/renderer/src/components/workbench/ShellHistoryDialog.vue src/renderer/src/stores/shell-history.ts src/main/shell-history src/main/ssh/direct-session-repository.ts src/shared/contracts.ts src/preload/api.ts src/renderer/src/components/workbench/ShellCanvas.vue src/renderer/src/views/WorkbenchView.vue src/renderer/src/prototype-actions.ts tests/unit/renderer/shell-history.test.ts tests/unit/shell-history tests/e2e/workbench.spec.ts
git commit -m "feat: add Shell history playback and reconnect"
~~~

### 任务 8：增加多个 LLM/VLM 配置和模型路由

**文件：**

- 新建：src/main/settings/model-profile-repository.ts
- 新建：src/main/settings/model-profile-service.ts
- 新建：src/main/model/model-provider-router.ts
- 新建：tests/unit/settings/model-profile-repository.test.ts
- 新建：tests/unit/settings/model-profile-service.test.ts
- 新建：tests/unit/model/model-provider-router.test.ts
- 修改：src/shared/contracts.ts
- 修改：src/shared/validation.ts
- 修改：src/main/settings/register-settings-handlers.ts
- 修改：src/main/settings/model-settings-service.ts
- 修改：src/main/model/chat-completions-client.ts
- 修改：src/preload/api.ts
- 修改：src/main/main.ts

- [ ] **步骤 1：先写迁移、增删改查、密钥和路由失败测试**

覆盖旧单模型配置迁移、LLM/VLM 独立列表、新配置默认未激活、每类最多一个激活项、删除激活项规则、API Key 保留、renderer DTO 不含密钥、OpenAI/Ollama/llama.cpp 请求适配、组合模式和纯视觉模式。

~~~ts
await service.save({
  ...profile,
  kind: 'llm',
  apiKey: 'secret',
})
expect(await service.list('llm')).toEqual([
  expect.objectContaining({ hasApiKey: true }),
])
expect(JSON.stringify(await repository.load())).not.toContain('secret')
~~~

- [ ] **步骤 2：运行并确认红灯**

运行：npx vitest run tests/unit/settings/model-profile* tests/unit/model/model-provider-router.test.ts

预期：多配置服务缺失导致失败。

- [ ] **步骤 3：实现版本化配置仓库和迁移**

只保存非敏感字段、activeLlmId、activeVlmId 和 routing。密钥键使用 model-profile.<id>.apiKey。旧受保护密钥只迁移一次，并记录迁移版本。

- [ ] **步骤 4：实现服务和供应商路由**

~~~ts
export type ModelProfileKind = 'llm' | 'vlm'
export type ModelRouting = 'combined' | 'vision-only'
export type ModelProvider = 'openai' | 'ollama' | 'llama-cpp'
~~~

供应商适配器统一为现有流式客户端接口。Ollama 解析 JSONL 流；OpenAI 与 llama.cpp 使用兼容 SSE 的 chat completions。安全错误必须脱敏全部已配置密钥。

- [ ] **步骤 5：替换设置 IPC 并保留兼容入口**

暴露 list、get、save、test、activate、delete、setRouting。在全局聊天完成迁移前保留 getModel、saveModel、testModel 兼容包装。

- [ ] **步骤 6：运行聚焦与旧测试**

运行：npx vitest run tests/unit/settings tests/unit/model tests/unit/agent/agent-model-runtime.test.ts tests/unit/preload/api.test.ts

预期：全部通过。

- [ ] **步骤 7：提交**

~~~powershell
git add src/main/settings/model-profile-repository.ts src/main/settings/model-profile-service.ts src/main/model/model-provider-router.ts src/shared/contracts.ts src/shared/validation.ts src/main/settings/register-settings-handlers.ts src/main/settings/model-settings-service.ts src/main/model/chat-completions-client.ts src/preload/api.ts src/main/main.ts tests/unit/settings tests/unit/model tests/unit/agent/agent-model-runtime.test.ts tests/unit/preload/api.test.ts
git commit -m "feat: manage routed LLM and VLM profiles"
~~~

### 任务 9：实现原型中的六个设置面板

**文件：**

- 新建：src/renderer/src/components/settings/ModelRoutingSettings.vue
- 新建：src/renderer/src/components/settings/ModelProfileManager.vue
- 新建：src/renderer/src/components/settings/AppearanceSettings.vue
- 新建：src/renderer/src/stores/model-profiles.ts
- 新建：tests/unit/renderer/model-profiles.test.ts
- 修改：src/renderer/src/views/SettingsView.vue
- 修改：src/renderer/src/components/settings/RegexFenceRules.vue
- 修改：src/renderer/src/components/workbench/WorkbenchShell.vue
- 修改：src/renderer/src/main.ts
- 修改：tests/e2e/workbench.spec.ts

- [ ] **步骤 1：先写 renderer store 失败测试**

覆盖新建、编辑、取消、保存、测试、激活、删除、忽略过期异步测试响应、API Key 占位语义、LLM/VLM 独立选择、路由保存、主题首次绘制以及无效正则禁止保存。

- [ ] **步骤 2：运行并确认红灯**

运行：npx vitest run tests/unit/renderer/model-profiles.test.ts tests/unit/renderer/regex-fence-rule-tester.test.ts

预期：模型配置 store 缺失导致失败。

- [ ] **步骤 3：实现模型路由和共用配置管理器**

ModelProfileManager.vue 通过 kind、字段标题和限制标题复用。布局与 V18 的列表/编辑区一致。不能把 API Key 回填到输入框；使用 hasApiKey 加空密码框，空值表示保留现有密钥。

- [ ] **步骤 4：完成安全围栏和外观面板**

安全围栏增加保存状态、无效正则提示、新增、删除、启用和确定性测试器。外观面板通过任务 5 的服务持久化主题和布局；main.ts 在 renderer 绘制前应用主题类。

- [ ] **步骤 5：替换 SettingsView.vue 导航**

按原型顺序显示六个按钮：模型选择、大语言模型配置、视觉语言模型配置、安全围栏、本地主机记忆、外观。主机记忆先显示真实加载占位，在任务 10 完成。

- [ ] **步骤 6：运行设置 E2E**

运行：npx playwright test tests/e2e/workbench.spec.ts --grep "settings|model profile|theme|fence"

预期：已完成面板全部可交互；进入设置再返回时终端元素身份不变。

- [ ] **步骤 7：更新操作清单并提交**

测试通过后登记 routing、llm-profiles、vlm-profiles、fence、appearance。

~~~powershell
git add src/renderer/src/components/settings src/renderer/src/stores/model-profiles.ts src/renderer/src/views/SettingsView.vue src/renderer/src/components/workbench/WorkbenchShell.vue src/renderer/src/main.ts src/renderer/src/prototype-actions.ts tests/unit/renderer/model-profiles.test.ts tests/unit/renderer/regex-fence-rule-tester.test.ts tests/e2e/workbench.spec.ts
git commit -m "feat: implement V18 model fence and appearance settings"
~~~

### 任务 10：完成本地主机记忆告知、选项和增删改查

**文件：**

- 新建：src/renderer/src/components/settings/HostMemorySettings.vue
- 新建：src/renderer/src/components/workbench/HostMemoryConsentDialog.vue
- 新建：src/main/settings/host-memory-settings-service.ts
- 新建：src/main/settings/register-host-memory-handlers.ts
- 新建：tests/unit/settings/host-memory-settings-service.test.ts
- 新建：tests/unit/facts/host-facts-migration.test.ts
- 新建：tests/unit/renderer/host-memory-settings.test.ts
- 修改：src/main/facts/host-facts-repository.ts
- 修改：src/main/facts/host-facts-service.ts
- 修改：src/main/observation/register-session-observation.ts
- 修改：src/shared/contracts.ts
- 修改：src/preload/api.ts
- 修改：src/main/main.ts
- 修改：src/renderer/src/views/SettingsView.vue
- 修改：src/renderer/src/views/WorkbenchView.vue
- 修改：tests/e2e/workbench.spec.ts

- [ ] **步骤 1：先写迁移和采集策略失败测试**

覆盖旧事实迁移、全局启用、四类范围、每主机告知状态、关闭后不持久化、renderer 安全列表/详情、编辑、清除、仅 IP 的待观察身份以及拒绝敏感字段。

- [ ] **步骤 2：运行并确认红灯**

运行：npx vitest run tests/unit/settings/host-memory-settings-service.test.ts tests/unit/facts tests/unit/renderer/host-memory-settings.test.ts

预期：列表、更新、删除和采集策略 API 缺失导致失败。

- [ ] **步骤 3：扩展主机事实仓库和服务**

增加 list、update、remove；返回克隆 DTO 并串行写入。把旧主机名键值对象迁移为 { version: 2, records }。保存前检测并拒绝敏感键和值。

- [ ] **步骤 4：实现选项与告知门禁**

registerSessionObservation 在采集前查询主机记忆服务：功能是否启用、允许哪些范围、该主机是否已确认告知。未确认时先发 renderer 告知事件；acknowledge(hostIdentity) 成功后才执行只读观察。

- [ ] **步骤 5：实现 V18 主机记忆界面**

实现总开关、四个复选框、真实主机列表、详情展开、编辑、取消、保存和清除，以及首次连接告知对话框。清除前显示确认；对话框锁定并恢复焦点。

- [ ] **步骤 6：运行聚焦测试和 E2E**

运行：npx vitest run tests/unit/settings/host-memory-settings-service.test.ts tests/unit/facts tests/unit/observation tests/unit/renderer/host-memory-settings.test.ts

运行：npx playwright test tests/e2e/workbench.spec.ts --grep "host memory|memory disclosure"

- [ ] **步骤 7：更新操作清单并提交**

测试通过后登记 memory。

~~~powershell
git add src/renderer/src/components/settings/HostMemorySettings.vue src/renderer/src/components/workbench/HostMemoryConsentDialog.vue src/main/settings/host-memory-settings-service.ts src/main/settings/register-host-memory-handlers.ts src/main/facts src/main/observation/register-session-observation.ts src/shared/contracts.ts src/preload/api.ts src/main/main.ts src/renderer/src/views/SettingsView.vue src/renderer/src/views/WorkbenchView.vue src/renderer/src/prototype-actions.ts tests/unit/settings/host-memory-settings-service.test.ts tests/unit/facts tests/unit/observation tests/unit/renderer/host-memory-settings.test.ts tests/e2e/workbench.spec.ts
git commit -m "feat: implement local host memory controls"
~~~

### 任务 11：实现真实的全局 AI 流式聊天

**文件：**

- 新建：src/main/chat/chat-context-builder.ts
- 新建：src/main/chat/chat-runtime.ts
- 新建：src/main/chat/token-estimator.ts
- 新建：src/renderer/src/components/chat/GlobalChatPanel.vue
- 新建：src/renderer/src/stores/global-chat.ts
- 新建：tests/unit/chat/chat-context-builder.test.ts
- 新建：tests/unit/chat/chat-runtime.test.ts
- 新建：tests/unit/chat/token-estimator.test.ts
- 新建：tests/unit/renderer/global-chat.test.ts
- 修改：src/main/chat/register-chat-handlers.ts
- 修改：src/shared/contracts.ts
- 修改：src/preload/api.ts
- 修改：src/main/main.ts
- 修改：src/renderer/src/views/WorkbenchView.vue
- 修改：tests/e2e/workbench.spec.ts

- [ ] **步骤 1：先写上下文、运行时和 store 失败测试**

覆盖脱敏多 Shell 上下文、最近消息窗口、带 chatId/runId 的流式增量、流式期间切换聊天、明确取消、超时、重试、中文输入法安全 Ctrl+Enter、重启后消息恢复和纯文本安全显示。

~~~ts
const first = runtime.send(
  { chatId: 'c1', runId: 'r1', content: '检查两台主机' },
  publish,
)
await runtime.send(
  { chatId: 'c1', runId: 'r2', content: '重新检查' },
  publish,
)
expect(firstSignal.aborted).toBe(true)
expect(events.every(event => event.chatId === 'c1')).toBe(true)
await first
~~~

- [ ] **步骤 2：运行并确认红灯**

运行：npx vitest run tests/unit/chat tests/unit/renderer/global-chat.test.ts

预期：聊天运行时和右侧面板缺失导致失败。

- [ ] **步骤 3：实现确定性 Token 估算和上下文构建**

分别估算中文字符和非中文文本，使用激活模型上限。上下文只包含脱敏消息、关联会话显示元数据、用户允许的主机事实和近期执行审计；默认不把原始终端历史发送给模型。

- [ ] **步骤 4：实现聊天运行时和 IPC**

先持久化用户消息，再调用模型。同一聊天同一时间只有一个活动 run；新的 send 取消旧 run。事件 chat:delta、chat:completed、chat:error 都携带 chatId、runId、messageId。错误以可重试状态持久化，不删除用户消息。

- [ ] **步骤 5：实现 GlobalChatPanel.vue 和 store**

匹配 V18 头部、消息流、输入区、折叠栏、加载/错误/重试和历史只读模式。流式文本使用 aria-live="polite"；每个聊天分别保存输入草稿。

- [ ] **步骤 6：工作台不再直接渲染旧 AgentPanel**

保留旧服务和兼容测试，但右侧插槽改为 GlobalChatPanel。活动 Shell 只是聊天上下文信号之一，切换 Shell 不能重置聊天。

- [ ] **步骤 7：运行集成与 E2E**

运行：npx vitest run tests/unit/chat tests/unit/renderer/global-chat.test.ts tests/unit/agent

运行：npx playwright test tests/e2e/workbench.spec.ts --grep "AI chat|stream|retry|history chat"

- [ ] **步骤 8：更新操作清单并提交**

测试通过后登记 send、stream、retry。

~~~powershell
git add src/main/chat src/renderer/src/components/chat/GlobalChatPanel.vue src/renderer/src/stores/global-chat.ts src/shared/contracts.ts src/preload/api.ts src/main/main.ts src/renderer/src/views/WorkbenchView.vue src/renderer/src/prototype-actions.ts tests/unit/chat tests/unit/renderer/global-chat.test.ts tests/e2e/workbench.spec.ts
git commit -m "feat: add durable global AI chat"
~~~

### 任务 12：增加真实上下文用量与无损压缩

**文件：**

- 新建：src/main/chat/chat-compression-service.ts
- 新建：tests/unit/chat/chat-compression-service.test.ts
- 修改：src/main/chat/chat-runtime.ts
- 修改：src/main/chat/chat-repository.ts
- 修改：src/main/chat/register-chat-handlers.ts
- 修改：src/shared/contracts.ts
- 修改：src/preload/api.ts
- 修改：src/renderer/src/components/chat/GlobalChatPanel.vue
- 修改：src/renderer/src/stores/global-chat.ts
- 修改：tests/e2e/workbench.spec.ts

- [ ] **步骤 1：先写上下文压缩失败测试**

覆盖真实 used/total、手动压缩、90% 自动触发、保留近期消息、审计不可变、最后时间/类型、requestId 幂等、失败回滚和摘要不泄露敏感信息。

- [ ] **步骤 2：运行并确认红灯**

运行：npx vitest run tests/unit/chat/chat-compression-service.test.ts tests/unit/chat/chat-runtime.test.ts tests/unit/renderer/global-chat.test.ts

预期：压缩服务和 API 缺失导致失败。

- [ ] **步骤 3：实现压缩事务**

从符合条件的旧消息构建摘要请求，校验并脱敏模型响应，最后原子追加摘要并标记已压缩消息 ID。模型调用或写入失败时不得留下部分变化。

~~~ts
export type ContextUsage = {
  used: number
  total: number
  percent: number
  compressedAt: string | null
  compressionType: 'manual' | 'automatic' | null
}
~~~

- [ ] **步骤 4：接入手动与自动压缩**

按钮调用 chats.compress({ chatId, requestId, trigger: 'manual' })。chat-runtime 在发送前估算用量，必要时调用同一服务的 automatic 路径；尝试一次压缩后仍超限才返回大小错误。

- [ ] **步骤 5：渲染 V18 上下文区域**

显示本地化 Token 数值、百分比、进度、接近上限状态、最近时间/类型、加载和可重试错误。压缩进行中禁用重复操作。

- [ ] **步骤 6：验证并提交**

运行：npx vitest run tests/unit/chat tests/unit/renderer/global-chat.test.ts

运行：npx playwright test tests/e2e/workbench.spec.ts --grep "context|compress"

测试通过后登记 compress。

~~~powershell
git add src/main/chat src/shared/contracts.ts src/preload/api.ts src/renderer/src/components/chat/GlobalChatPanel.vue src/renderer/src/stores/global-chat.ts src/renderer/src/prototype-actions.ts tests/unit/chat tests/unit/renderer/global-chat.test.ts tests/e2e/workbench.spec.ts
git commit -m "feat: add AI context usage and compression"
~~~

### 任务 13：实现多主机命令计划和辅助驾驶审批

**文件：**

- 新建：src/main/agent/multi-session-plan-service.ts
- 新建：src/renderer/src/components/chat/CommandPlanCard.vue
- 新建：src/renderer/src/stores/command-plans.ts
- 新建：tests/unit/agent/multi-session-plan-service.test.ts
- 新建：tests/unit/renderer/command-plans.test.ts
- 修改：src/main/agent/agent-model-runtime.ts
- 修改：src/main/chat/chat-runtime.ts
- 修改：src/main/chat/chat-repository.ts
- 修改：src/main/chat/register-chat-handlers.ts
- 修改：src/shared/contracts.ts
- 修改：src/preload/api.ts
- 修改：src/main/main.ts
- 修改：src/renderer/src/components/chat/GlobalChatPanel.vue
- 修改：tests/e2e/workbench.spec.ts

- [ ] **步骤 1：先写计划 schema、服务和 store 失败测试**

覆盖零/多个候选命令、目标必须属于聊天、编辑不能更换目标、空命令被拒绝、逐目标确认/围栏/执行、部分结果、批准/拒绝幂等、重复点击安全、审计持久化和过期更新。

~~~ts
const result = await service.approve({
  chatId,
  planId,
  requestId,
  commands: [
    { candidateId: 'a', command: 'systemctl status api' },
    { candidateId: 'b', command: 'rm -rf /' },
  ],
})
expect(result.targets.map(item => item.state)).toEqual([
  'sent',
  'intercepted',
])
~~~

- [ ] **步骤 2：运行并确认红灯**

运行：npx vitest run tests/unit/agent/multi-session-plan-service.test.ts tests/unit/renderer/command-plans.test.ts

预期：多会话命令计划服务缺失导致失败。

- [ ] **步骤 3：扩展模型输出 schema**

把单个 nullable candidate 改为 candidates 数组，每项包含 sessionId、command、explanation，最大数量不超过聊天关联的实时会话数。主进程把模型目标别名解析为权威 session ID，拒绝未知或未关联目标。

- [ ] **步骤 4：通过现有安全服务实现计划执行**

每条候选命令都调用现有候选确认和 ExecutionGateway。同一计划的决定串行执行；先持久化状态再发送事件。重复 requestId 或已经结束的计划直接返回已保存结果。

- [ ] **步骤 5：实现 CommandPlanCard.vue**

匹配 V18 的目标列表和卡片状态。每台主机显示命令、编辑/取消/保存、内联错误和最终 sent/intercepted/failed 状态。提交期间立即禁用批准/拒绝；决定后不再显示操作。

- [ ] **步骤 6：运行聚焦、集成和 E2E**

运行：npx vitest run tests/unit/agent tests/unit/chat tests/unit/renderer/command-plans.test.ts

运行：npx playwright test tests/e2e/workbench.spec.ts --grep "command plan|approve|reject|edit command"

- [ ] **步骤 7：更新操作清单并提交**

测试通过后登记 edit-plan、approve、reject。

~~~powershell
git add src/main/agent/multi-session-plan-service.ts src/main/agent/agent-model-runtime.ts src/main/chat src/shared/contracts.ts src/preload/api.ts src/main/main.ts src/renderer/src/components/chat src/renderer/src/stores/command-plans.ts src/renderer/src/prototype-actions.ts tests/unit/agent tests/unit/chat tests/unit/renderer/command-plans.test.ts tests/e2e/workbench.spec.ts
git commit -m "feat: add multi-host command approval"
~~~

### 任务 14：把驾驶模式改为聊天级并完成全自动执行

**文件：**

- 新建：tests/unit/chat/chat-driving-mode.test.ts
- 修改：src/main/chat/chat-service.ts
- 修改：src/main/chat/chat-runtime.ts
- 修改：src/main/agent/multi-session-plan-service.ts
- 修改：src/main/agent/session-mode-controller.ts
- 修改：src/renderer/src/components/chat/GlobalChatPanel.vue
- 修改：src/renderer/src/stores/global-chat.ts
- 修改：src/renderer/src/views/WorkbenchView.vue
- 修改：tests/e2e/workbench.spec.ts

- [ ] **步骤 1：先写聊天驾驶模式失败测试**

覆盖新聊天默认辅助驾驶、明确确认全自动、每聊天独立持久化、切换/关闭 Shell 不重置、新聊天不继承全自动、安全围栏仍拦截，以及全自动部分结果不显示审批操作。

- [ ] **步骤 2：运行并确认红灯**

运行：npx vitest run tests/unit/chat/chat-driving-mode.test.ts tests/unit/agent/multi-session-plan-service.test.ts

预期：当前模式仍归属单个 session，测试失败。

- [ ] **步骤 3：把全局编排模式迁移到聊天服务**

保留现有 session mode API 兼容旧逻辑，但全局聊天读取 ChatWorkspace.mode。setMode('autonomous') 必须携带由 V18 确认对话框生成的一次性确认 requestId，renderer 不能伪造已确认状态。

- [ ] **步骤 4：实现全自动计划执行**

全自动聊天解析出计划后，通过同一 MultiSessionPlanService 走内部自动决定路径。隐藏编辑和批准操作，但每条命令仍执行围栏并持久化结果。

- [ ] **步骤 5：验证 UI 并更新操作清单**

运行：npx playwright test tests/e2e/workbench.spec.ts --grep "copilot|autonomous"

测试通过后登记 copilot、autonomous。

- [ ] **步骤 6：提交**

~~~powershell
git add src/main/chat src/main/agent/multi-session-plan-service.ts src/main/agent/session-mode-controller.ts src/renderer/src/components/chat/GlobalChatPanel.vue src/renderer/src/stores/global-chat.ts src/renderer/src/views/WorkbenchView.vue src/renderer/src/prototype-actions.ts tests/unit/chat/chat-driving-mode.test.ts tests/unit/agent/multi-session-plan-service.test.ts tests/e2e/workbench.spec.ts
git commit -m "feat: add chat-scoped autonomous driving"
~~~

### 任务 15：闭合完整原型验收矩阵并生成 Windows 交付物

**文件：**

- 修改：src/renderer/src/prototype-actions.ts
- 修改：tests/unit/renderer/v18-prototype-coverage.test.ts
- 修改：tests/e2e/workbench.spec.ts
- 新建：tests/e2e/v18-visual-parity.spec.ts
- 新建：docs/testing/v18-full-prototype-acceptance.md
- 修改：RELEASE_NOTES.md

- [ ] **步骤 1：启用完整覆盖测试并确认红灯**

移除 v18-prototype-coverage.test.ts 的 .skip。

运行：npx vitest run tests/unit/renderer/v18-prototype-coverage.test.ts

预期：若仍有缺口，测试准确列出缺失操作。只能在对应行为测试通过后补登记，不能直接追加名字。

- [ ] **步骤 2：增加最终端到端验收**

覆盖一个完整真实流程：新建聊天、连接两个 SSH 测试服务、修改布局、发送全局聊天、批准多主机计划、关闭/回放/重连 Shell、访问六个设置面板、返回后终端仍挂载、重启后状态仍恢复。

- [ ] **步骤 3：增加视觉和几何检查**

在 1440x900 和 1024x768 下，对空状态、有会话、折叠栏、历史、审批和六个设置面板分别生成珍珠白/石墨黑截图。

~~~ts
expect(await page.evaluate(() => (
  document.documentElement.scrollWidth
  <= document.documentElement.clientWidth
))).toBe(true)

for (const selector of criticalSelectors) {
  const box = await page.locator(selector).boundingBox()
  expect(box?.width).toBeGreaterThan(0)
  expect(box?.height).toBeGreaterThan(0)
}
~~~

同时检查终端画布像素非空，以及面板折叠/设置往返过程中终端 DOM 没有断开。

- [ ] **步骤 4：编写操作到测试的验收映射**

docs/testing/v18-full-prototype-acceptance.md 列出每个清单操作、真实行为、自动化测试文件/用例名，以及堡垒机提供方不可用时的人工检查。没有证据的功能不能标记完成。

- [ ] **步骤 5：执行全新完整验证**

严格按以下顺序运行：

~~~powershell
npm test
npm run test:integration
npm run lint
npm run build
npm run test:e2e
npm run make:win
~~~

预期：单元、集成、E2E 零失败，lint、类型和构建零错误；生成 release/Terminal-Agent-Setup-1.0.3.exe、build/launcher/putty.exe 和 release/win-unpacked/putty.exe；两个 putty.exe 的 SHA-256 一致。

- [ ] **步骤 6：验证产物和原型完整性**

确认安装包、运行时和桥接程序存在；计算两个桥接程序哈希；确认已批准 V18 原型 SHA-256 未变化。把准确大小、哈希和生成时间写入验收文档。

- [ ] **步骤 7：请求最终代码审查**

使用 superpowers:requesting-code-review 审查从 4c52448 到最终 HEAD 的完整差异。每个严重或重要问题都先增加会失败的回归测试，再修复并重新执行全套验证。

- [ ] **步骤 8：提交**

~~~powershell
git add src/renderer/src/prototype-actions.ts tests/unit/renderer/v18-prototype-coverage.test.ts tests/e2e/workbench.spec.ts tests/e2e/v18-visual-parity.spec.ts docs/testing/v18-full-prototype-acceptance.md RELEASE_NOTES.md
git commit -m "test: verify complete V18 prototype parity"
~~~

---

## 执行纪律

1. 只在 D:\project\github\Terminal-Agent\.worktrees\v18-unified-ssh 的 codex/v18-unified-ssh 分支工作，不在 main 上实施。
2. 每项新功能或修复严格执行红灯、绿灯、重构；修改生产代码前必须保留目标测试按预期失败的证据。
3. 因为契约和仓库相互依赖，15 个任务必须顺序执行；不能让多个实现代理并行修改同一工作区。
4. 每个任务结束时运行聚焦测试、git diff --check、敏感信息差异检查，只提交该任务相关文件。
5. 不能用原型示例数据替代真实堡垒机提供方不可用状态。
6. API Key、SSH 密码、私钥、AccessClient 临时路径、原始环境变量值和未脱敏终端内容，不得进入 renderer DTO、持久化、快照、日志、测试数据或提交。
7. 每个检查点都必须保持现有 SSH、AccessClient 和桥接程序测试通过；出现回归时先使用 superpowers:systematic-debugging 查明根因。
8. 任务 15 的全新完整验证和验收映射全部通过前，不得声明 V18 已完整实现。
