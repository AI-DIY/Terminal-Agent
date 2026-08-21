# Terminal-Agent V18 统一 SSH 连接工作台落地设计

> 状态：待用户评审
>
> 产品基线：`.superpowers/brainstorm/ui-20260811185554/content/simplified-core-workbench-v18-unified-ssh-connection.html`
>
> 实施原则：V18 只改变工作台呈现和连接入口组织，不删除、替换或伪造现有 Vue/Electron 产品能力。

## 1. 目标

将已确认的 V18 HTML 原型融合到现有 Terminal-Agent Vue/Electron 产品中，并将原型中的“新建 SSH 连接”统一入口接入真实功能。

统一入口包含四种连接方式：

1. 堡垒机 CMDB 唤起；
2. 堡垒机主机唤起；
3. 主机用户名 + 密码连接；
4. 主机私钥连接。

V18 是视觉、布局和交互基线。现有代码仍是业务行为、安全边界和数据来源基线。两者发生冲突时，不能为了匹配静态原型而削弱现有真实功能或安全校验。

## 2. 必须保留的现有能力

以下能力在改造前已经存在，实施后必须继续通过原有 IPC、主进程服务和测试：

1. 用户名密码 SSH 连接；
2. 私钥 SSH 连接、私钥文件选择和可选密码短语；
3. 直连会话保存、打开、编辑和删除；
4. AccessClient/Assess 兼容启动，包括 `@saved`、`-load`、`-raw` 和第二实例唤起；
5. 临时堡垒机密码只在内存中流转，不写入会话簿、renderer 状态或日志；
6. xterm 实时输出、键盘输入、窗口尺寸同步和会话缓冲区隔离；
7. 会话标签、多终端可见面板、活动会话选择和关闭；
8. AI 分析、流式输出、候选命令、人工确认、自动执行和安全围栏；
9. 辅助驾驶到全自动驾驶的显式升级确认；
10. 模型连接设置、安全围栏设置和设置页往返时终端保持挂载；
11. AccessClient 错误的安全展示，不泄露密码、临时配置路径或原始启动参数；
12. 主机只读观察和按观察主机名维护的本地事实。

不允许把现有 `ConnectionDialog.vue` 的密码、私钥、保存会话能力替换成仅供展示的表单，也不允许让新的工作台壳层直接访问 Electron IPC。

## 3. 当前实现与 V18 的差距

| 领域 | 当前实现 | V18 目标 | 设计结论 |
| --- | --- | --- | --- |
| 工作台结构 | `WorkbenchView.vue` 为顶部工具栏、Agent、终端网格 | 顶栏、左侧导航、中间 Shell、右侧 AI 三栏结构 | 新增纯呈现壳层，业务状态仍由 `WorkbenchView.vue` 持有 |
| 连接入口 | 顶部按钮打开密码/私钥对话框 | 空状态与已有 Shell 工具栏都使用四方式统一入口 | 复用同一个 `SshConnectionLauncher.vue`，根据承载位置切换面板/浮层外观 |
| 直连表单 | `ConnectionDialog.vue` 内同时处理密码、私钥和保存会话 | 密码与私钥成为两个明确的连接方式 | 抽取 `DirectSshForm.vue`，保留相同请求和保存语义 |
| 堡垒机外部唤起 | 只接受命令行/第二实例 AccessClient 启动 | renderer 可主动选择 CMDB 或精确主机唤起 | 新增严格类型化的主进程端口和命名 IPC，不向 renderer 暴露凭据或原始参数 |
| CMDB 数据 | 仓库中不存在真实提供方 | 系统到主机的两级选择 | 定义端口与不可用状态；未接入真实提供方前禁止使用原型示例数据 |
| 设置往返 | `App.vue` 使用 `v-show` 保持工作台挂载 | V18 设置视觉 | 保留 `v-show`，只调整样式和导航呈现 |
| 原型历史数据 | 产品没有聊天历史和 Shell 历史持久化契约 | V18 中存在演示历史 | 不伪造；本轮只保留真实会话、终端和 Agent 数据 |

## 4. 组件架构

### 4.1 `WorkbenchView.vue`

`src/renderer/src/views/WorkbenchView.vue` 继续作为唯一业务协调器，负责：

- 初始化和同步真实会话；
- 维护 `sessions`、`activeSessionId` 和 `visibleSessionIds`；
- 调用 `window.terminalAgent.sessions`、`accessClient` 和 `sessionModes`；
- 处理连接、保存会话、关闭会话、堡垒机唤起、错误和设置导航；
- 订阅 `sessions:onData/onOpened/onUpdated/onClosed` 和 AccessClient 错误；
- 将真实状态作为 props 传给纯呈现组件。

它不实现四个表单的视觉细节，也不持有第二套 session store。

### 4.2 `WorkbenchShell.vue`

新增 `src/renderer/src/components/workbench/WorkbenchShell.vue`，承载 V18 的顶栏和三栏布局，并提供具名 slots：

- `sidebar`：真实会话列表；
- `shell-toolbar`：Shell 标题、连接数量、统一入口和布局控制；
- `shell`：真实 `SessionTabs` 与 `TerminalPane` 网格；
- `agent`：现有 `AgentPanel`；
- `overlays`：连接器、会话簿和升级确认。

壳层只维护左右栏收起、分隔条宽度和主题等呈现状态。收起侧栏只能改变 CSS 布局，不能卸载终端、Agent 或改变会话集合。

### 4.3 `WorkbenchSessionSidebar.vue`

新增 `src/renderer/src/components/workbench/WorkbenchSessionSidebar.vue`，将当前真实 SSH 会话渲染为 V18 左侧导航。它接收：

```ts
type Props = {
  sessions: SessionView[]
  activeSessionId: string | null
}
```

并只发出 `select`、`close`、`create` 和 `open-saved` 意图。由于产品目前没有聊天历史数据契约，左侧栏不能显示 V18 原型中的静态聊天记录。

### 4.4 `SshConnectionLauncher.vue`

新增 `src/renderer/src/components/connections/SshConnectionLauncher.vue`，作为空状态和已有 Shell 后工具栏入口共用的统一连接组件。

组件 mode 固定为：

```ts
export type SshConnectionMode = 'cmdb' | 'bastionHost' | 'password' | 'privateKey'
```

组件职责：

- 渲染四种连接方式的可访问 tab；
- 切换时保留共享的主机地址、端口和用户名，不在密码与私钥模式之间复制敏感值；
- CMDB 模式显示系统和目标主机两级选择；
- 堡垒机主机模式只接受完整 IP 或完整主机名；
- 密码和私钥模式复用真实直连逻辑；
- 在组件内部显示字段错误和堡垒机目录不可用状态；
- 提交成功后发出 `connected` 并由父级关闭面板。

组件不调用 IPC。它通过 emits 输出经过表单层校验的意图：

```ts
type Emits = {
  directConnect: [request: ConnectionDialogRequest]
  bastionLaunch: [request: BastionLaunchRequest]
  saveProfile: [profile: SavedDirectSessionInput]
  close: []
}
```

### 4.5 `DirectSshForm.vue`

新增 `src/renderer/src/components/connections/DirectSshForm.vue`，从现有 `ConnectionDialog.vue` 搬迁真实直连表单逻辑。

它保留：

- 主机、端口和用户名校验；
- 密码认证；
- 私钥选择和密码短语；
- 保存到会话簿、会话名称和编辑保留凭据语义；
- 现有 `RendererSessionRequest` 与 `SavedDirectSessionInput` 数据结构。

密码与私钥模式由外部传入，表单不会再显示二级“认证方式”单选项。`ConnectionDialog.vue` 保留为编辑已保存会话的兼容包装器，避免破坏 `SavedSessionsDialog.vue` 的编辑路径。

### 4.6 堡垒机表单

新增：

- `BastionCmdbForm.vue`：系统到主机两级选择；
- `BastionHostForm.vue`：完整 IP/主机名精确唤起；
- `connection-entry-state.ts`：模式切换、完整目标校验和已经连接目标过滤的纯函数。

CMDB 系统未选中时必须禁用目标主机控件。主机列表必须排除当前已打开的相同 CMDB 目标。精确目标已经打开时只聚焦已有 session，不重复连接。

## 5. 主进程堡垒机边界

### 5.1 共享安全契约

在 `src/shared/contracts.ts` 新增：

```ts
export type BastionSystemSummary = { id: string; name: string }

export type BastionHostSummary = {
  id: string
  systemId: string
  name: string
  address: string
  environment?: string
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
```

所有 renderer 请求使用严格的 Zod schema。目标长度、ID 长度、空白、端口和未知字段都在进入服务前拒绝。

### 5.2 `BastionTargetResolver`

新增 `src/main/access-client/bastion-target-resolver.ts`：

```ts
export type BastionTargetResolver = {
  listSystems(): Promise<BastionSystemSummary[]>
  listHosts(systemId: string): Promise<BastionHostSummary[]>
  resolve(request: BastionLaunchRequest): Promise<BastionResolvedConnection>
}
```

`BastionResolvedConnection` 只在主进程内部存在，可包含建立 AccessClient SSH/Raw 会话所需的临时信息。它不能进入 preload 类型、renderer 事件、日志或错误文本。

### 5.3 `BastionLaunchService`

新增 `src/main/access-client/bastion-launch-service.ts`，负责：

1. 调用 resolver 获取安全目录或解析目标；
2. 使用现有 `AccessClientSessionOpener` 打开 SSH/Raw 会话；
3. 维护 `cmdb:<hostId>` 和 `host:<normalizedTarget>` 到 session ID 的运行期映射；
4. 已打开目标返回 `focused`，不创建重复 session；
5. 会话关闭时清理映射；
6. 将 provider 错误转换为分类后的中文安全错误。

renderer 不能传入命令行数组、临时文件路径、密码、私钥或本地转发参数。

### 5.4 当前外部依赖

仓库当前没有真实 CMDB/堡垒机目录 SDK、HTTP 契约或浏览器插件调用接口。因此本轮不能把 V18 示例中的“订单中心”“数据平台”“web-01”等写入产品。

实施时先提供 `UnavailableBastionTargetResolver`：

- `listSystems()` 返回明确的不可用状态；
- `listHosts()` 和 `resolve()` 返回分类错误；
- UI 仍完整展示四种方式，但堡垒机两种方式显示“未配置堡垒机目录来源”；
- 密码和私钥直连正常工作；
- 外部 AccessClient 命令行唤起继续正常工作。

接入真实 provider 时只替换 resolver，不修改 renderer、IPC 或会话服务。真实 provider 的地址、鉴权、字段映射和生命周期必须由用户或堡垒机系统契约提供，不能由实施者猜测。

## 6. Preload 与 IPC

`TerminalAgentApi.accessClient` 增加命名方法：

```ts
catalog(): Promise<BastionCatalogSnapshot>
hosts(systemId: string): Promise<BastionHostSummary[]>
launch(request: BastionLaunchRequest): Promise<BastionLaunchResult>
```

对应 IPC：

```text
access-client:bastion:catalog
access-client:bastion:hosts
access-client:bastion:launch
```

`registerAccessClientLaunchHandlers()` 继续负责现有错误快照和错误事件；新增 `registerBastionLaunchHandlers()` 负责主动唤起。每个 handler 都必须先验证 trusted sender，再执行 schema parse，然后调用服务。

## 7. 数据流

```text
用户切换四方式连接入口
          ↓
SshConnectionLauncher / 子表单
          ↓ emits
WorkbenchView
  ├─ password/privateKey → terminalAgent.sessions.connect
  └─ cmdb/bastionHost   → terminalAgent.accessClient.launch
                                   ↓ named IPC
                         BastionLaunchService
                                   ↓
                         BastionTargetResolver
                                   ↓
                    AccessClientSessionOpener / SessionService
                                   ↓ opened event
                              WorkbenchView
```

成功建立会话后仍以 `sessions:onOpened` 和 `sessions:list` 为真实来源。renderer 不自行构造 `ConnectedSession`。

## 8. 入口行为

### 8.1 无 Shell 空状态

- 中间区域直接显示 V18 的“新建 SSH 连接”大入口；
- 默认选中“堡垒机 CMDB 唤起”；
- 四种方式均可切换；
- 直连成功后进入真实 Shell 工作台；
- 堡垒机 provider 不可用时在表单内显示安全状态，不影响切换到直连。

### 8.2 已有 Shell

- Shell 工具栏保留“新建 SSH 连接”按钮；
- 点击后打开绝对定位浮层，不占用或压缩终端网格高度；
- 浮层同样包含四种方式；
- Escape、关闭按钮、外部点击和成功提交都会关闭浮层；
- 打开连接浮层时关闭布局菜单，打开布局菜单时关闭连接浮层。

### 8.3 已保存会话

“已保存会话”的列表、创建、编辑、删除和打开保持独立入口。统一连接器中的密码/私钥表单仍可选择“保存到会话簿”；堡垒机 CMDB 和堡垒机主机唤起永远不能保存到直连会话簿。

## 9. 错误与安全

- 直连字段错误显示在当前表单内；
- 堡垒机目录不可用、目标不存在和连接失败显示分类后的安全中文消息；
- 全局 `connectionError` 继续展示主进程安全错误；
- 密码、私钥内容、密码短语和临时配置路径不能进入 Vue reactive 调试记录、测试快照或日志；
- 切换连接方式不自动复制或回显密码、私钥引用和密码短语；
- 关闭连接器时清空敏感字段和一次性 key reference；
- renderer 只能持有 `KeyMaterialStore` 返回的短期 key reference，主进程取用后立即删除。

## 10. 可访问性与响应式约束

- 四种连接方式使用 `role="tablist"`、`role="tab"` 和对应 `tabpanel`；
- tab 支持方向键切换，焦点顺序与视觉顺序一致；
- 对话框使用 `role="dialog"`、`aria-modal` 和可访问标题；
- 错误区域使用 `role="alert"` 或 `aria-live="polite"`；
- 分隔条使用 `role="separator"`、键盘方向键和当前值；
- 1440×900 与 1024×768 不产生页面级横向滚动；
- 2×2 连接方式网格在窄宽度下变为单列或保持文字完整，不裁切最长标签；
- 终端卡片、工具栏和 AI 控件不能互相覆盖。

## 11. 测试策略

### 11.1 单元测试

- 四方式 mode、完整目标校验和切换时敏感字段清理；
- 现有密码/私钥请求与保存会话请求保持不变；
- Bastion schema 拒绝空 ID、部分主机名、未知字段和超长值；
- `BastionLaunchService` 的 opened、focused、关闭清理和安全错误；
- preload 只暴露命名 API；
- IPC trusted sender 与 schema 校验；
- 未配置 resolver 不泄露内部错误。

### 11.2 端到端测试

- 空状态存在四种连接方式；
- 密码连接真实本地 SSH fixture；
- 私钥模式可以选择 key reference 并提交；
- 已有 Shell 后打开的是不改变网格尺寸的浮层；
- CMDB provider 不可用状态可读，并可继续切到直连；
- 设置往返保持原终端 DOM 挂载；
- 两个终端的输入输出继续隔离；
- AccessClient 初始启动和第二实例唤起继续通过；
- 错误页面不出现密码和临时路径。

### 11.3 完成验证

```powershell
npm test
npm run test:integration
npm run lint
npm run build
npm run test:e2e
```

并在 Electron 窗口中检查 1440×900 和 1024×768 两个视口，覆盖空状态、已有 Shell、四方式切换、设置页和错误状态。

## 12. 非目标

本轮不实现或伪造：

- V18 原型中的静态聊天历史；
- Shell 历史持久化和回放；
- 新的聊天上下文压缩存储；
- 原型示例 CMDB 数据；
- 供应商未知的登录、令牌刷新或浏览器插件协议；
- 将堡垒机临时连接保存为直连会话；
- 绕过现有 Agent 确认和安全围栏。

这些能力以后必须基于真实数据契约单独设计。

## 13. 完成定义

只有同时满足以下条件才可声明 V18 落地完成：

1. V18 工作台结构和两处统一入口已进入真实 Vue/Electron 产品；
2. 四种连接方式均有真实交互，其中堡垒机两种方式在 provider 未配置时显示明确不可用状态；
3. 密码、私钥、会话簿、AccessClient、终端、Agent、设置和安全围栏原功能保持可用；
4. 不包含任何原型示例业务数据或敏感信息泄漏；
5. 单元、集成、端到端、lint、构建和视觉验收通过；
6. 接入真实 CMDB provider 所需的唯一剩余工作是实现 `BastionTargetResolver`，不需要再次改动 UI 或 IPC 契约。
