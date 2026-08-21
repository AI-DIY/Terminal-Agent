# Terminal-Agent V18 统一 SSH 连接工作台实施计划

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** 将已确认的 V18 原型融合到 Vue/Electron 工作台，在不破坏现有真实 SSH、私钥、会话簿、AccessClient、终端、Agent 和设置功能的前提下提供四方式“新建 SSH 连接”入口。

**Architecture:** WorkbenchView.vue 保持为会话与 IPC 的唯一协调器；新的工作台壳层和统一连接器只接收 props、发出 UI 意图。密码和私钥仍走既有 sessions:connect 契约；堡垒机两种方式经严格校验的主进程 BastionLaunchService 和 BastionTargetResolver 端口工作，默认 resolver 明确报告 provider 未配置，绝不使用原型示例数据。

**Tech Stack:** Vue 3、TypeScript、Electron、Zod、Vitest、Playwright、xterm、ssh2。

---

## 实施前约束

- 产品基线是 .superpowers/brainstorm/ui-20260811185554/content/simplified-core-workbench-v18-unified-ssh-connection.html；不得改写该已确认原型。
- 不修改或删除已有未跟踪的 V12–V17 文档和 tmp/ 内容。
- 不在 main 分支实施。经用户同意后使用 codex/v18-unified-ssh 隔离工作区。
- 尚无真实 CMDB/堡垒机目录 provider。第一阶段的堡垒机 UI 与安全 IPC 必须完整，但返回“未配置堡垒机目录来源”；密码和私钥连接继续是真实可用功能。
- 若用户提供 provider 契约，第二阶段只实现 BastionTargetResolver 适配器，不改变 renderer、preload 或 IPC 名称。

### Task 1: 建立隔离基线并锁定现有行为

Files:
- Modify: none before baseline verification
- Test: tests/unit/shared/contracts.test.ts
- Test: tests/unit/ipc/register-handlers.test.ts
- Test: tests/e2e/workbench.spec.ts

- [ ] Step 1: 创建隔离工作区

运行：

~~~powershell
git worktree add .worktrees/v18-unified-ssh -b codex/v18-unified-ssh
~~~

预期：创建 D:/project/github/Terminal-Agent/.worktrees/v18-unified-ssh，分支为 codex/v18-unified-ssh。随后所有命令均在该目录执行。

- [ ] Step 2: 运行未修改代码的基线验证

~~~powershell
npm test
npm run lint
npm run build
~~~

预期：三个命令退出码均为 0。若任何命令在未修改代码时失败，停止实现并报告具体失败。

- [ ] Step 3: 记录现有 V18 原型哈希

~~~powershell
Get-FileHash .superpowers/brainstorm/ui-20260811185554/content/simplified-core-workbench-v18-unified-ssh-connection.html -Algorithm SHA256
~~~

预期：后续实现不修改该文件；最终再次执行并比较哈希。

- [ ] Step 4: 仅在 Git 检查要求时提交忽略规则

只有 .worktrees/ 未被忽略时，才在根 .gitignore 加入该目录，执行：

~~~powershell
git add .gitignore
git commit -m "chore: ignore local worktrees"
~~~

预期：不提交任何产品代码、文档草稿或用户已有未跟踪文件。

### Task 2: 定义堡垒机共享契约和纯连接入口状态

Files:
- Modify: src/shared/contracts.ts
- Create: src/renderer/src/components/connections/connection-entry-state.ts
- Create: tests/unit/shared/bastion-contracts.test.ts
- Create: tests/unit/renderer/connection-entry-state.test.ts

- [ ] Step 1: 写入共享契约的失败测试

在 tests/unit/shared/bastion-contracts.test.ts 覆盖：

~~~ts
it('accepts a CMDB system and host identifier without credentials', () => {
  expect(bastionLaunchRequestSchema.parse({ kind: 'cmdb', systemId: 'orders', hostId: 'host-42' }))
    .toEqual({ kind: 'cmdb', systemId: 'orders', hostId: 'host-42' })
})
it('accepts only a complete bastion host target', () => {
  expect(bastionLaunchRequestSchema.parse({ kind: 'host', target: 'web-01.example.internal' }))
    .toEqual({ kind: 'host', target: 'web-01.example.internal' })
  expect(() => bastionLaunchRequestSchema.parse({ kind: 'host', target: 'web' })).toThrow()
})
it('rejects credentials, temporary paths, and unknown renderer fields', () => {
  expect(() => bastionLaunchRequestSchema.parse({
    kind: 'cmdb', systemId: 'orders', hostId: 'host-42',
    password: 'secret', temporaryProfilePath: 'C:\\temp\\jump',
  })).toThrow()
})
~~~

在 tests/unit/renderer/connection-entry-state.test.ts 覆盖 mode 切换清空密码、密码短语、私钥 reference，以及完整 IPv4/主机名校验。

- [ ] Step 2: 运行测试确认正确 RED

~~~powershell
npx vitest run tests/unit/shared/bastion-contracts.test.ts tests/unit/renderer/connection-entry-state.test.ts
~~~

预期：仅因新 schema/helper 不存在而失败，不得是测试语法或导入路径错误。

- [ ] Step 3: 实现共享契约

在 src/shared/contracts.ts 增加：

~~~ts
export type BastionSystemSummary = { id: string; name: string }
export type BastionHostSummary = {
  id: string; systemId: string; name: string; address: string; environment?: string
}
export type BastionLaunchRequest =
  | { kind: 'cmdb'; systemId: string; hostId: string }
  | { kind: 'host'; target: string }
export type BastionLaunchResult =
  | { kind: 'opened'; sessionId: string }
  | { kind: 'focused'; sessionId: string }
export type BastionCatalogSnapshot =
  | { available: true; systems: BastionSystemSummary[] }
  | { available: false; systems: []; message: string }

export const bastionLaunchRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('cmdb'),
    systemId: z.string().trim().min(1).max(128),
    hostId: z.string().trim().min(1).max(128),
  }).strict(),
  z.object({
    kind: z.literal('host'),
    target: z.string().trim().min(3).max(255).refine(isCompleteBastionTarget),
  }).strict(),
])
~~~

在 src/shared/contracts.ts 同时实现并导出 isCompleteBastionTarget；它只允许完整 IPv4 或完整的点分主机名，不能接受模糊前缀。renderer 的 connection-entry-state.ts 只复用这个纯函数，不让 shared 层反向依赖 renderer。

- [ ] Step 4: 实现纯入口状态函数

创建 src/renderer/src/components/connections/connection-entry-state.ts，导出：

~~~ts
export type SshConnectionMode = 'cmdb' | 'bastionHost' | 'password' | 'privateKey'
export type ConnectionEntryState = {
  mode: SshConnectionMode
  host: string
  port: number
  username: string
  password: string
  passphrase: string
  keyReference: string | null
}
export function nextConnectionEntryState(state: ConnectionEntryState, mode: SshConnectionMode): ConnectionEntryState
export function isCompleteBastionTarget(value: string): boolean
~~~

实现必须在 mode 切换时保留 host/port/username，但清空 password/passphrase/keyReference。

- [ ] Step 5: 运行 GREEN 并提交

~~~powershell
npx vitest run tests/unit/shared/bastion-contracts.test.ts tests/unit/renderer/connection-entry-state.test.ts
git add src/shared/contracts.ts src/renderer/src/components/connections/connection-entry-state.ts tests/unit/shared/bastion-contracts.test.ts tests/unit/renderer/connection-entry-state.test.ts
git commit -m "feat: define unified SSH entry contracts"
~~~

### Task 3: 实现主进程堡垒机端口与不可用 provider

Files:
- Create: src/main/access-client/bastion-target-resolver.ts
- Create: src/main/access-client/bastion-launch-service.ts
- Create: tests/unit/access-client/bastion-launch-service.test.ts
- Modify: src/main/access-client/session-opener.ts

- [ ] Step 1: 写入失败测试

测试 BastionLaunchService 的三条行为：未配置 provider 返回安全的 catalog 状态；CMDB/host launch 不泄露 resolver 原因；同一目标第二次 launch 返回 focused 且 opener 只调用一次。

~~~ts
const openSsh = vi.fn().mockResolvedValue({ id: 's-1' })
const resolver = {
  listSystems: vi.fn().mockResolvedValue([{ id: 'orders', name: '订单中心' }]),
  listHosts: vi.fn().mockResolvedValue([{ id: 'host-42', systemId: 'orders', name: 'web-01', address: '10.0.0.8' }]),
  resolve: vi.fn().mockResolvedValue({
    protocol: 'ssh', host: '10.0.0.8', port: 22, username: 'ops',
    title: 'web-01', columns: 80, rows: 24,
  }),
}
const service = new BastionLaunchService(resolver, { openSsh, openRaw: vi.fn() })
await expect(service.launch({ kind: 'cmdb', systemId: 'orders', hostId: 'host-42' }))
  .resolves.toEqual({ kind: 'opened', sessionId: 's-1' })
await expect(service.launch({ kind: 'cmdb', systemId: 'orders', hostId: 'host-42' }))
  .resolves.toEqual({ kind: 'focused', sessionId: 's-1' })
expect(openSsh).toHaveBeenCalledOnce()
~~~

- [ ] Step 2: 运行 RED

~~~powershell
npx vitest run tests/unit/access-client/bastion-launch-service.test.ts
~~~

预期：因 service/resolver 尚不存在而失败。

- [ ] Step 3: 定义仅主进程可见的 resolver

创建 src/main/access-client/bastion-target-resolver.ts：

~~~ts
export type BastionResolvedConnection =
  | { protocol: 'ssh'; host: string; port: number; username: string; password?: string; title: string; columns: number; rows: number }
  | { protocol: 'raw'; host: string; port: number; title: string; columns: number; rows: number }

export type BastionTargetResolver = {
  listSystems(): Promise<BastionSystemSummary[]>
  listHosts(systemId: string): Promise<BastionHostSummary[]>
  resolve(request: BastionLaunchRequest): Promise<BastionResolvedConnection>
}
export class BastionProviderUnavailableError extends Error {
  constructor() { super('未配置堡垒机目录来源。') }
}
export class UnavailableBastionTargetResolver implements BastionTargetResolver {
  async listSystems() { throw new BastionProviderUnavailableError() }
  async listHosts(_systemId: string) { throw new BastionProviderUnavailableError() }
  async resolve(_request: BastionLaunchRequest) { throw new BastionProviderUnavailableError() }
}
~~~

BastionResolvedConnection 只在主进程存在，不能出现在 preload 类型或 renderer payload。

- [ ] Step 4: 实现 launch service

创建 src/main/access-client/bastion-launch-service.ts。实现：

1. catalog() 捕获 provider unavailable 并返回 { available: false, systems: [], message: '未配置堡垒机目录来源。' }；
2. hosts(systemId) 返回 resolver 的安全摘要；
3. launch(request) 用 cmdb:<systemId>:<hostId> 或 host:<normalizedTarget> 去重；
4. 已有目标返回 focused，新目标调用现有 openSsh/openRaw；
5. 提供 closeSession(sessionId) 清理运行期 map；
6. 所有其他异常转成不含密码、路径和内部错误的安全异常。

- [ ] Step 5: 保持 AccessClient opener 兼容

在 src/main/access-client/session-opener.ts 只增加返回类型导出：

~~~ts
export type AccessClientSessionOpenerPort = ReturnType<typeof createAccessClientSessionOpener>
~~~

不得改变 SessionService.connectAccessSsh、connectRaw 或现有命令行 AccessClient 流程。

- [ ] Step 6: 运行 GREEN 并提交

~~~powershell
npx vitest run tests/unit/access-client/bastion-launch-service.test.ts tests/unit/access-client/access-client-service.test.ts tests/unit/ssh/session-service.test.ts
git add src/main/access-client/bastion-target-resolver.ts src/main/access-client/bastion-launch-service.ts src/main/access-client/session-opener.ts tests/unit/access-client/bastion-launch-service.test.ts
git commit -m "feat: add safe bastion launch service"
~~~

### Task 4: 通过命名 preload 与 IPC 暴露堡垒机能力

Files:
- Create: src/main/access-client/register-bastion-launch-handlers.ts
- Modify: src/main/main.ts
- Modify: src/preload/api.ts
- Create: tests/unit/access-client/register-bastion-launch-handlers.test.ts
- Modify: tests/unit/shared/contracts.test.ts

- [ ] Step 1: 写 trusted sender 和 schema RED 测试

测试 untrusted renderer 在 validation 和 service 调用之前被拒绝；trusted renderer 只能把解析后的 BastionLaunchRequest 传给 service。

- [ ] Step 2: 运行 RED

~~~powershell
npx vitest run tests/unit/access-client/register-bastion-launch-handlers.test.ts
~~~

预期：因 handler 尚不存在而失败。

- [ ] Step 3: 实现专用 IPC 注册器

新增三个命名 channel：

~~~text
access-client:bastion:catalog
access-client:bastion:hosts
access-client:bastion:launch
~~~

每个 handler 先验证 event.sender，再执行 Zod parse，最后调用 service。dispose 时删除三个 handler。

- [ ] Step 4: 扩展 preload API

在 src/preload/api.ts 的 accessClient 下加入：

~~~ts
catalog: () => ipcRenderer.invoke('access-client:bastion:catalog') as Promise<BastionCatalogSnapshot>,
hosts: (systemId: string) => ipcRenderer.invoke('access-client:bastion:hosts', systemId) as Promise<BastionHostSummary[]>,
launch: (request: BastionLaunchRequest) => ipcRenderer.invoke('access-client:bastion:launch', request) as Promise<BastionLaunchResult>,
~~~

同步扩展 TerminalAgentApi 类型和 preload contract 测试。API 不暴露 ipcRenderer、原始 argv、临时路径、password 或 key material。

- [ ] Step 5: 在 main 注入并清理

在 src/main/main.ts 注入 BastionLaunchService(new UnavailableBastionTargetResolver(), createAccessClientSessionOpener(sessions))，注册/注销 handler；现有 accessClientLaunches、错误 snapshot、第二实例和命令行流程保持不变。现有 sessions.onClosed 额外调用 bastionLaunches.closeSession(event.sessionId)。

- [ ] Step 6: 运行 GREEN 并提交

~~~powershell
npx vitest run tests/unit/access-client/register-bastion-launch-handlers.test.ts tests/unit/shared/contracts.test.ts tests/unit/access-client/register-launch-error-handlers.test.ts
git add src/main/access-client/register-bastion-launch-handlers.ts src/main/main.ts src/preload/api.ts tests/unit/access-client/register-bastion-launch-handlers.test.ts tests/unit/shared/contracts.test.ts
git commit -m "feat: expose typed bastion launch IPC"
~~~

### Task 5: 抽取可复用的密码与私钥直连表单

Files:
- Create: src/renderer/src/components/connections/DirectSshForm.vue
- Create: src/renderer/src/components/connections/direct-ssh-form-state.ts
- Modify: src/renderer/src/components/ConnectionDialog.vue
- Create: tests/unit/renderer/direct-ssh-form.test.ts

- [ ] Step 1: 写直连 helper RED 测试

覆盖：

~~~ts
expect(toDirectConnectionRequest({
  mode: 'password', host: 'server-a', port: 22, username: 'ops', password: 'secret',
})).toEqual({
  host: 'server-a', port: 22, username: 'ops',
  auth: { kind: 'password', password: 'secret' },
})
expect(toDirectConnectionRequest({
  mode: 'privateKey', host: 'server-a', port: 22, username: 'ops',
  keyReference: null, passphrase: '',
})).toEqual({ error: '请选择私钥文件。' })
~~~

- [ ] Step 2: 运行 RED

~~~powershell
npx vitest run tests/unit/renderer/direct-ssh-form.test.ts
~~~

预期：因 helper 不存在而失败。

- [ ] Step 3: 实现 helper 和组件

direct-ssh-form-state.ts 导出 toDirectConnectionRequest()，只负责 host/port/username、密码和 key reference 的校验与 request 构造。DirectSshForm.vue 从现有 ConnectionDialog.vue 迁移真实主机、端口、用户名、密码、私钥选择、密码短语、保存会话和编辑保留凭据逻辑。

selectPrivateKey() 仍只接收 { id, fileName, filePath }，不读取文件内容。

- [ ] Step 4: 保持 ConnectionDialog.vue 兼容

保留 ConnectionDialogRequest、editingProfile prop、connect/saveProfile emits。包装器根据 profile 的 authKind 选择 DirectSshForm，保证 SavedSessionsDialog.vue 编辑路径不变。

- [ ] Step 5: 运行 GREEN 并提交

~~~powershell
npx vitest run tests/unit/renderer/direct-ssh-form.test.ts tests/unit/renderer/direct-session-profile-form.test.ts tests/unit/ipc/register-handlers.test.ts
git add src/renderer/src/components/connections src/renderer/src/components/ConnectionDialog.vue tests/unit/renderer/direct-ssh-form.test.ts
git commit -m "refactor: reuse direct SSH forms by connection mode"
~~~

### Task 6: 实现四方式统一连接器和两处承载位

Files:
- Create: src/renderer/src/components/connections/BastionCmdbForm.vue
- Create: src/renderer/src/components/connections/BastionHostForm.vue
- Create: src/renderer/src/components/connections/SshConnectionLauncher.vue
- Create: tests/unit/renderer/bastion-cmdb-form.test.ts
- Create: tests/unit/renderer/bastion-host-form.test.ts

- [ ] Step 1: 写 CMDB/精确目标 RED 测试

断言 availableHosts() 过滤已打开目标：

~~~ts
expect(availableHosts([
  { id: 'web-01', systemId: 'orders', name: 'web-01', address: '10.0.0.8' },
  { id: 'web-02', systemId: 'orders', name: 'web-02', address: '10.0.0.9' },
], 'orders', new Set(['web-01']))).toEqual([
  { id: 'web-02', systemId: 'orders', name: 'web-02', address: '10.0.0.9' },
])
~~~

断言 bastionHostRequest('web') 返回 { error: '请输入完整 IP 或完整主机名。' }，完整目标返回 { kind: 'host', target }。

- [ ] Step 2: 运行 RED

~~~powershell
npx vitest run tests/unit/renderer/bastion-cmdb-form.test.ts tests/unit/renderer/bastion-host-form.test.ts
~~~

预期：因 pure helper/表单不存在而失败。

- [ ] Step 3: 实现两个纯堡垒机表单

BastionCmdbForm.vue 接收父组件传入的 catalog、hosts、loading 和 error props，不直接访问 IPC；不可用状态显示安全 message；系统未选择时禁用主机 select；系统变化 emit system-change，由 WorkbenchView 加载 hosts；只显示父组件传入的过滤后主机；提交 emit { kind: 'cmdb', systemId, hostId }。

BastionHostForm.vue 使用 isCompleteBastionTarget()，只接受完整主机名或 IPv4，错误使用 role="alert"。

- [ ] Step 4: 实现 SshConnectionLauncher.vue

使用四个固定可访问名称：

~~~ts
const modes = [
  { id: 'cmdb', label: '堡垒机 CMDB 唤起' },
  { id: 'bastionHost', label: '堡垒机主机唤起' },
  { id: 'password', label: '主机用户名 + 密码连接' },
  { id: 'privateKey', label: '主机私钥连接' },
] as const
~~~

组件通过 emits 输出直连 request、堡垒机 request、system-change、save profile、close，不直接访问 IPC。每次只渲染一个 panel；mode 切换清空敏感字段。支持 dialog/embedded 两种外观。WorkbenchView 负责调用 accessClient.catalog/hosts/launch，并把安全结果通过 props 传回。

- [ ] Step 5: 运行 GREEN 并提交

~~~powershell
npx vitest run tests/unit/renderer/bastion-cmdb-form.test.ts tests/unit/renderer/bastion-host-form.test.ts tests/unit/renderer/connection-entry-state.test.ts
git add src/renderer/src/components/connections tests/unit/renderer/bastion-cmdb-form.test.ts tests/unit/renderer/bastion-host-form.test.ts
git commit -m "feat: add unified four-mode SSH launcher"
~~~

### Task 7: 落地 V18 工作台壳层并集成真实业务状态

Files:
- Create: src/renderer/src/components/workbench/WorkbenchShell.vue
- Create: src/renderer/src/components/workbench/WorkbenchSessionSidebar.vue
- Create: src/renderer/src/stores/workbench-layout.ts
- Modify: src/renderer/src/views/WorkbenchView.vue
- Modify: src/renderer/src/components/SessionTabs.vue
- Modify: src/renderer/src/components/TerminalPane.vue
- Modify: src/renderer/src/components/AgentPanel.vue
- Modify: src/renderer/src/views/SettingsView.vue
- Create: tests/unit/renderer/workbench-layout.test.ts

- [ ] Step 1: 写布局 store RED 测试

覆盖 clampSidebarWidth(80, 210, 420) 等于 210、clampSidebarWidth(480, 210, 420) 等于 420、左右栏 toggle，以及收起不改变 sessions/active/visible 的事实。

- [ ] Step 2: 运行 RED

~~~powershell
npx vitest run tests/unit/renderer/workbench-layout.test.ts
~~~

预期：因 layout store 尚不存在而失败。

- [ ] Step 3: 实现布局 store 与 shell

workbench-layout.ts 只包含左右栏收起、两条宽度、主题。最小/最大范围：左侧 210–360，右侧 340–520。WorkbenchShell.vue 使用 CSS Grid：

~~~css
grid-template-columns: var(--left-width) 5px minmax(320px, 1fr) 5px var(--right-width);
~~~

收起时保留可聚焦展开按钮；Shell、Agent 和 Terminal slot 使用 CSS/v-show，不用 v-if 销毁子树。

- [ ] Step 4: 以真实会话替代静态左栏

WorkbenchSessionSidebar.vue 只遍历 SessionView[]，显示 title ?? observedHostname ?? hostname，并 emit select/close。SessionTabs.vue 继续是中间 Shell 的唯一标签；TerminalPane.vue 的 data-testid、xterm 生命周期和 resize 语义不变。

- [ ] Step 5: 在 WorkbenchView.vue 接入统一连接器

1. 无会话时在 shell slot 渲染内嵌 SshConnectionLauncher；
2. 有会话时工具栏按钮打开绝对定位浮层，不压缩终端网格；
3. 密码/私钥 emit 继续调用既有 connect(request)；
4. CMDB/主机 emit 调用 accessClient.launch；
5. focused 调用既有 select(sessionId)，opened 等待 sessions opened 事件；
6. 成功、Escape、关闭按钮和外部点击关闭浮层；
7. SavedSessions、升级确认、top-level error 继续由 View 控制。

- [ ] Step 6: 应用 V18 视觉 token，不改变业务契约

确认 App.vue 继续使用 v-show 保持 xterm 挂载。将相关组件硬编码色彩替换为 --canvas、--surface、--surface-raised、--text、--muted、--border、--accent、--danger 等语义变量。不得修改 Agent 请求、session IPC、xterm 输入输出、设置持久化或 session store API。

- [ ] Step 7: 运行 renderer 回归并提交

~~~powershell
npx vitest run tests/unit/renderer/workbench-layout.test.ts tests/unit/renderer/sessions.test.ts tests/unit/renderer/visible-panes.test.ts tests/unit/renderer/agent-panel.test.ts tests/unit/renderer/close-session.test.ts
git add src/renderer/src/components/workbench src/renderer/src/stores/workbench-layout.ts src/renderer/src/views/WorkbenchView.vue src/renderer/src/components/SessionTabs.vue src/renderer/src/components/TerminalPane.vue src/renderer/src/components/AgentPanel.vue src/renderer/src/views/SettingsView.vue tests/unit/renderer/workbench-layout.test.ts
git commit -m "feat: apply V18 workbench shell"
~~~

### Task 8: 补齐真实 Electron 端到端回归

Files:
- Modify: tests/e2e/workbench.spec.ts

- [ ] Step 1: 添加空状态四方式和密码连接测试

启动现有本地 SSH fixture，确认四个 tab 的准确名称，切换到“主机用户名 + 密码连接”，填写 host/port/user/password，并确认出现一个真实 terminal pane。

- [ ] Step 2: 添加已有 Shell 浮层测试

建立一个本地 SSH 会话，点击工具栏“新建 SSH 连接”，确认 dialog/浮层可见、默认 CMDB、不可用 provider message 可读、可切换密码 tab，并确认打开前后 terminal pane DOM 仍连接。

- [ ] Step 3: 添加私钥模式回归

在 renderer 端到端检查私钥 tab、私钥文件按钮、可选密码短语和字段校验；主进程的 key reference 取用与 key material 不回传由既有 tests/unit/ipc/register-handlers.test.ts、tests/unit/ssh/private-key-loader.test.ts 和新增 direct form unit test 覆盖。当前 Electron 原生文件选择器不在 Playwright 页面中伪造真实文件路径，不为此引入测试专用生产分支。

- [ ] Step 4: 添加安全错误回归

保留现有 AccessClient invalid startup 测试，并增加断言：四方式 connector 的错误文本不包含 password、private key path、temporary profile path 或 raw argv。

- [ ] Step 5: 运行新增测试确认 RED，再实现后 GREEN

实现前运行：

~~~powershell
npm run build
npx playwright test tests/e2e/workbench.spec.ts
~~~

预期：新增 selector/浮层断言失败而旧测试保持可诊断。完成 Task 6–7 后再次运行同一命令，预期整个文件通过。

- [ ] Step 6: 提交端到端覆盖

~~~powershell
git add tests/e2e/workbench.spec.ts
git commit -m "test: cover V18 unified SSH workbench"
~~~

### Task 9: 全量质量门、视觉验收和代码评审

Files:
- Modify: only source/test files required to correct discovered regressions

- [ ] Step 1: 运行全量质量门

~~~powershell
npm test
npm run test:integration
npm run lint
npm run build
npm run test:e2e
~~~

预期：全部退出码为 0；失败必须先补充可复现测试，再修实现。

- [ ] Step 2: 检查 1440×900

确认顶栏、真实会话左栏、中间 Shell、右侧 AI 和设置入口层级清楚；空状态和浮层的四个 tab 完整可读；密码/私钥字段无重叠；长主机名、错误、Agent 内容不遮挡操作控件。

- [ ] Step 3: 检查 1024×768 与键盘

确认无页面级横向滚动；侧栏收起后仍有展开按钮；tab 方向键、Escape、关闭后焦点恢复均可操作；设置往返后原 xterm DOM 仍挂载。

- [ ] Step 4: 复核原型未被修改和敏感数据未泄露

~~~powershell
Get-FileHash .superpowers/brainstorm/ui-20260811185554/content/simplified-core-workbench-v18-unified-ssh-connection.html -Algorithm SHA256
git status --short
git diff --check
~~~

预期：V18 哈希与 Task 1 相同；没有密码、私钥内容、临时路径、原始 argv；不触碰用户已有未跟踪文档和 tmp/。

- [ ] Step 5: 进行代码评审并决定分支收尾方式

使用 superpowers:requesting-code-review 审查行为回归、安全边界、测试覆盖和视觉溢出。评审通过后再使用 superpowers:finishing-a-development-branch，由用户选择合并、PR 或保留分支。

## 真实 CMDB provider 的后续小任务

用户提供 provider 的调用方式、认证边界、字段映射、错误码和测试 fixture 后，新增一个独立任务实现 BastionTargetResolver 适配器。适配器必须证明：目录不向 renderer 泄露凭据、精确主机去重、临时堡垒机会话不进入会话簿、错误不泄露临时路径或密码。
