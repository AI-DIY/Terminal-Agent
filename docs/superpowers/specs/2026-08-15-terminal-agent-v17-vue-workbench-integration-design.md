# Terminal-Agent V17 Vue Workbench Integration Design

> 文档状态：已完成用户设计确认，待用户审阅书面规格后编写实施计划
>
> 设计基线：`.superpowers/brainstorm/ui-20260811185554/content/simplified-core-workbench-v17-ux-visual-polish.html`
>
> 日期：2026-08-15
>
> 目标：以现有 Vue/Electron 产品功能为不可破坏的基线，将已定版的 V17 原型融合为真实工作台界面；原型负责视觉与布局，现有实现继续负责业务、数据和安全边界。

## 1. 目标、范围与不变量

本轮采用“Vue 工作台壳层 + 现有功能组件”的增量融合方案，而不是把独立 HTML 原型及其 JavaScript 直接移植到产品中。

交付内容：

- 建立与 V17 原型一致的顶栏、左侧栏、中间 Shell 工作区、右侧 AI 工作区和设置页视觉层级；
- 将现有真实会话、终端、Agent、连接对话框、会话簿、模式升级、堡垒机唤起和设置功能放入新的工作台壳层；
- 引入受控的 UI 布局状态：左右面板收起、分隔条宽度和浅色/深色主题；Shell 聚焦模式不属于本轮交付，避免在没有真实产品状态契约的情况下增加新的工作流语义；
- 在桌面宽屏与 1024px 窄桌面宽度下保持无页面级横向溢出、状态可读、操作可发现。

以下现有功能为本轮不可破坏的不变量，必须保留其现有 IPC、数据校验和安全边界：

1. 新建 SSH 连接，含密码认证、私钥认证和私钥文件选择；
2. 已保存会话的新增、打开、编辑和删除；
3. 既有 SSH 会话同步、打开、关闭、模式更新和 AccessClient 唤起；
4. xterm 的实时输出、键盘输入、窗口尺寸同步和会话间缓冲区隔离；
5. 多终端可见面板、活动会话切换与会话标签；
6. AI 分析启动、流式输出、错误、候选命令、人工确认、自动发送和安全围栏拦截；
7. 全自动驾驶升级确认；
8. 大模型连接设置和安全围栏规则设置；
9. AccessClient 启动错误的安全展示，且不泄露临时路径、密码或其他凭据；
10. 从工作台唤起堡垒机目标：空状态首次唤起、已有 Shell 时再次唤起、CMDB 选择和手动精确输入；
11. 在设置页与工作台之间切换时保持已有终端实例挂载。

## 2. 原型融合边界

V17 原型提供视觉和布局基线，但其中的静态示例主机、聊天记录、Shell 输出、主机记忆和演示交互不属于产品数据。

本轮将原型区域映射为真实功能承载位：

| V17 原型区域 | 产品中的真实承载 | 数据来源 |
| --- | --- | --- |
| 顶栏 | 当前工作台摘要、连接/会话簿入口、模式状态、设置入口 | `WorkbenchView` 的会话状态和现有事件 |
| 左侧栏 | 当前真实 SSH 会话列表、会话选择/关闭、连接入口 | `sessions` 与 `activeSessionId` |
| 中间 Shell 区 | 真实 xterm 面板网格、标签、活动态与尺寸调整 | `visibleSessionIds`、`TerminalPane` |
| 右侧 AI 区 | 真实 AI 分析、候选命令、人工确认和运行状态 | `AgentPanel` 与 Agent IPC |
| Shell 空状态与主机工具栏 | “唤起堡垒机”首次入口、已有 Shell 时的“唤起主机”浮层；同时保留“新建 SSH 连接”入口 | `BastionLaunchPanel`、AccessClient 唤起 API、现有连接 API |
| 各类弹窗 | 新建 SSH 连接、已保存会话、全自动驾驶升级 | 现有弹窗状态与处理函数 |
| 设置页 | 模型连接和安全围栏规则 | 现有 Settings API 与组件 |

聊天历史回放、Shell 历史回放、主机记忆、聊天上下文压缩和原型中的示例历史数据，当前没有与之对应的产品数据契约。本轮不伪造这类数据、不显示可误导用户的演示记录，也不将其视为已交付功能。

堡垒机唤起属于本轮必须落地的真实入口，不与历史回放等后续扩展混在一起。它必须使用真实的 CMDB/堡垒机解析或桥接来源；如果当前环境没有可用的 CMDB/桥接来源，实施阶段只能先建立经过类型校验的主进程端口和明确的不可用状态，不能把原型中的示例系统和主机当成生产数据。

## 3. 架构与组件边界

### 3.1 工作台协调器保持不变

`src/renderer/src/views/WorkbenchView.vue` 继续是会话和工作台业务协调器：

- 初始化、同步和维护 `sessions`；
- 维护 `activeSessionId`、`visibleSessionIds`、连接错误、弹窗状态和保存会话列表；
- 订阅既有 session、AccessClient 和 Agent 事件；
- 调用现有 `window.terminalAgent` API；
- 处理打开、关闭、保存、编辑、自动驾驶升级和设置导航。

它不承担 V17 的低层视觉样式，也不重新实现 xterm 或 Agent 状态。

### 3.2 新的工作台壳层

新增 `WorkbenchShell.vue` 作为纯呈现和布局组件。它渲染 V17 的顶栏和三栏网格，使用具名 slots 承载：

- `toolbar`：当前工作台摘要和操作入口；
- `sidebar`：真实 SSH 会话导航；
- `shell`：主机会话标签和终端面板；
- `agent`：现有 AI 面板；
- `overlays`：由 `WorkbenchView` 控制的弹窗。

新增 `WorkbenchSessionSidebar.vue` 承载左侧真实 SSH 会话列表；新增 `BastionLaunchPanel.vue` 承载空状态首次唤起和已有 Shell 后的再次唤起浮层；保留 `SessionTabs.vue` 作为中间 Shell 区的唯一会话标签组件，只重构其视觉和布局，不再创建第二套标签状态。

壳层只拥有布局状态并向上发出 UI 意图，例如选择会话、请求关闭会话、打开连接、显示已保存会话、显示设置、收起/展开面板和调整分隔条。它不得调用 SSH、Agent、设置或 AccessClient IPC，也不得保留第二份 session、Agent 或表单状态。

`BastionLaunchPanel.vue` 只负责入口模式、CMDB 系统/主机选择、手动目标校验、重复目标提示和可访问的状态展示；它通过 `WorkbenchView` 发出 `launch-bastion` 事件，不直接调用 IPC。

### 3.3 现有业务组件保持责任单一

- `TerminalPane.vue` 继续管理 xterm 生命周期、session buffer 回放、终端输入、数据监听和 `sessions.resize`；
- `AgentPanel.vue` 继续管理 `createAgentPanelStore()`、流式事件、候选命令和错误；
- `SessionTabs.vue` 继续以真实 `SessionView` 派生标签，并作为中间 Shell 区唯一的会话标签组件；
- `ConnectionDialog.vue`、`SavedSessionsDialog.vue`、`ModeIndicator.vue` 和 `CommandCandidate.vue` 保留现有事件和业务语义，只接收 V17 视觉 token；
- `SettingsView.vue` 继续承载模型连接和安全围栏规则组件，改为 V17 设置页布局。

### 3.4 堡垒机唤起接线

现有 `accessClient` preload API 目前只有错误快照和错误订阅，不能支持工作台主动唤起。实施阶段需要新增一个受控的、类型化的 `accessClient.launch` 能力，而不是把原始命令行参数从 renderer 传入主进程。

为支持 CMDB 两级选择，`accessClient` 还需要提供只读目录能力：`listBastionSystems()` 返回安全的系统显示信息，`listBastionHosts(systemId)` 返回指定系统下安全的主机显示信息（主机 ID、显示名、地址和环境，不含凭据）。目录数据和发起唤起都由同一个主进程 `BastionTargetResolver` 端口校验。

请求与结果模型为：

```ts
type BastionLaunchRequest =
  | { kind: 'cmdb'; systemId: string; hostId: string }
  | { kind: 'manual'; target: string }

type BastionLaunchResult =
  | { kind: 'opened'; sessionId: string }
  | { kind: 'focused'; sessionId: string }
```

主进程新增 `BastionTargetResolver` 端口，负责：

1. 校验 `systemId`、`hostId` 或完整手动目标；
2. 从真实 CMDB/堡垒机桥接来源解析出受信任的 AccessClient 会话参数；
3. 复用现有 `AccessClientService`/`SessionService` 打开 SSH 或 Raw 会话；
4. 保持临时密码只在内存中流转，不写入会话簿、renderer 状态或日志；
5. 对已打开的精确目标返回已有 session ID 或可聚焦结果，禁止重复连接。

renderer 只得到安全的结果，例如 `{ kind: 'opened'; sessionId: string }`、`{ kind: 'focused'; sessionId: string }` 或已分类的失败；不能得到原始临时配置、密码、桥接命令或文件路径。若 CMDB/桥接来源不可用，主进程返回明确的不可用/配置错误，UI 在唤起面板内显示可读错误，同时沿用顶栏的 AccessClient 错误告警。

### 3.5 主题和布局样式

新增以 CSS 自定义属性为中心的工作台视觉层。根工作台根据主题设置语义 token，例如画布、表面、次级表面、文本、弱文本、边框、悬停、选中、焦点、成功、警告和错误颜色。

组件不得继续各自硬编码相互冲突的深色调色板；需要替换为语义 token。`TerminalPane` 接收只读主题输入，在主题变化时更新 xterm 颜色选项，而不是卸载或重建终端。

布局状态为独立的 renderer UI 状态模块，只包含：

- 左侧栏是否收起；
- 右侧栏是否收起；
- 两条分隔条的宽度；
- 浅色或深色主题。

Shell 聚焦模式不在本轮布局状态中实现，后续若要加入，必须单独定义它对终端可见性、AI 面板、键盘焦点和返回路径的影响。

桌面宽屏使用接近原型的 `230px / 5px / minmax(0, 1fr) / 5px / 400px` 列结构；窄桌面使用不小于 `210px / 4px / minmax(320px, 1fr) / 4px / 340px` 的约束，并通过 `minmax`、`clamp` 和容器内滚动保证 1024px 视口不产生页面级横向溢出。

该状态不写入 session store 或 Agent store；除主题偏好等本地呈现偏好外，不引入业务持久化。

## 4. 数据流与交互接线

数据流保持单向：

```text
window.terminalAgent / 已有事件
              ↓
WorkbenchView + 现有 stores
              ↓ props
WorkbenchShell（布局和视觉状态）
              ↓
TerminalPane / AgentPanel / Dialogs / Settings
              ↑ emits
WorkbenchView 的既有处理函数
```

具体规则：

1. `sessions`、`activeSessionId` 和 `visibleSessionIds` 是会话 UI 的唯一来源。左侧栏、顶栏摘要、Shell 标签与终端网格都从这三个状态派生。
2. 选择或关闭会话仍调用 `WorkbenchView` 的 `select` 和 `close`。新壳层只发出事件，不直接修改 session store。
3. `TerminalPane` 继续按 session ID 订阅输出并向原有 API 写入输入。布局变化只改变它的容器尺寸，触发已有 resize 语义。
4. `AgentPanel` 继续以活动 session 为输入，并以 `key="activeSession.id"` 隔离不同会话的流式状态；壳层不缓存 AI 输出。
5. 连接、已保存会话、自动驾驶确认和设置导航继续由 `WorkbenchView` 和 `App.vue` 的既有状态驱动。
6. `App.vue` 中设置页必须继续使用 `v-show` 而非 `v-if` 切换。这样返回工作台时现有 `TerminalPane` 和 xterm 实例保持挂载。
7. 面板收起使用 CSS 布局或 `v-show`，而不是销毁终端和 AI 业务组件；恢复面板时会话、buffer、Agent 流和输入状态必须仍然存在。
8. 分隔条拖动使用 Pointer Events、指针捕获和明确的最小/最大边界。中间 Shell 区始终保留可操作的最小宽度；窄桌面视口由 CSS Grid 和断点收缩侧栏宽度，不产生页面级横向滚动。

### 4.1 新建 SSH 与堡垒机唤起并列

两条入口必须在视觉和语义上明确区分，不能把堡垒机唤起伪装成另一个手动 SSH 表单：

1. **空状态**：主工作区同时提供“唤起堡垒机”和“新建 SSH 连接”两个入口。前者打开 `BastionLaunchPanel` 的首次唤起布局，后者打开现有 `ConnectionDialog`；点击其中一个不会删除或替换另一个入口。
2. **已有 Shell**：Shell 工具栏提供“唤起主机”按钮，点击后打开不改变画布高度的紧凑浮层；顶栏的“新建 SSH 连接”仍打开现有手动连接对话框。
3. **CMDB 模式**：默认进入“CMDB 选择”，系统未选择前禁用目标主机；系统与主机列表来自受信任的 CMDB/桥接端口，并过滤已经打开的精确目标。
4. **手动模式**：只接受完整 IP 或完整主机名，不做模糊搜索。输入已经打开的目标时只聚焦现有 session，不创建重复终端。
5. **成功路径**：`WorkbenchView` 调用 `accessClient.launch`。返回 `opened` 时等待现有 `sessions.onOpened`/快照路径接入新 session；返回 `focused` 时调用现有 `select` 选中目标 session。renderer 不自行构造 session 对象。
6. **关闭路径**：浮层支持取消按钮、关闭图标、外部点击和 Escape；提交成功后自动关闭。打开浮层时关闭布局菜单，打开布局菜单时关闭浮层，避免两个层叠入口互相遮挡。
7. **失败路径**：字段错误显示在唤起面板内并通过 `aria-live` 通知；主进程分类错误同时进入现有 `connectionError` 告警，但不重复展示敏感细节。
8. **外部唤起兼容**：现有命令行 `@saved`、`-load`、`-raw` 和第二实例 AccessClient 流程继续保留；无论入口来自命令行还是工作台，最终都通过相同的 session opened/closed/updated 事件进入 `WorkbenchView`。

## 5. 错误、安全与可访问性

### 5.1 错误归属

- SSH、会话和 AccessClient 错误仍由 `WorkbenchView` 报告为安全的顶栏告警；
- AI 流式错误仍由 `AgentPanel` 显示；
- 连接和设置表单校验错误仍保留在各自组件内；
- 视觉壳层不得吞掉、改写或暴露未经清洗的 IPC 错误；
- 分隔条拖动造成的重复尺寸变化在 renderer 端合并到动画帧，并跳过未改变的 cols/rows，避免产生高频无效 resize IPC。

### 5.2 安全边界

本轮不改变现有 preload API 的安全模型、主进程 IPC 校验、凭据存储方式、会话认证、Agent 确认或安全围栏契约；但为了支持“从工作台主动唤起堡垒机”，会以新增的、严格校验的 `accessClient.launch` 作为兼容性扩展。视觉改造和新增唤起流程不得将密码、私钥路径、临时配置路径、原始命令行参数或桥接日志路径放入界面、日志或测试快照。

### 5.3 可访问性

- 所有按钮保留可见名称及中文 `aria-label`；
- 分隔条使用 `role="separator"`、方向和当前值，并支持键盘方向键调整；
- 焦点态独立于选中态和悬停态，在浅色/深色主题下均清晰可见；
- 对长主机名、会话标题、命令和错误文本使用安全截断或换行，不能挤压操作控件；
- 对话框继续使用 `role="dialog"`、`aria-modal` 和可访问标题，打开后将焦点置入对话框，关闭后恢复到触发入口；
- 收起面板后必须留下可达、可聚焦的展开入口。
- “唤起堡垒机”与“新建 SSH 连接”必须是两个可区分的入口；唤起面板中的 CMDB/手动 tab、系统选择、主机选择和错误提示都必须有对应的标签与 `aria-live` 状态。

## 6. 测试与验收

### 6.1 回归测试

现有 unit、integration 和 e2e 测试必须保持通过，尤其是：

- 两个真实 SSH 会话的输出与 buffer 隔离；
- 在设置页和工作台之间切换时既有 xterm 实例不被卸载；
- AccessClient Raw 会话、初始终端尺寸和第二实例唤起；
- AccessClient 启动错误不泄露临时凭据；
- 工作台空状态同时提供“唤起堡垒机”和“新建 SSH 连接”，两者不会互相替换；
- 已有 Shell 时“唤起主机”入口以不压缩 Shell 画布的浮层呈现，默认 CMDB，可切换手动输入；
- CMDB 目标选择在系统未选中时禁用主机控件，并排除已经打开的精确目标；
- 手动输入只接受完整 IP 或完整主机名，已打开目标只聚焦现有 session；
- `accessClient.launch` 的失败只展示分类后的安全错误，不泄露临时密码、配置路径或原始桥接参数；
- Agent store 对过期流事件的隔离；
- session buffer 边界、会话标签优先级和安全围栏规则。

### 6.2 新增单元测试

新增测试覆盖：

- 工作台布局状态的收起/展开、宽度最小/最大边界与重置；
- 分隔条键盘和指针调整的受控状态；
- 浅色/深色主题切换状态；
- 壳层事件不直接改变 session store；
- 收起面板不改变 `sessions`、`activeSessionId` 或 `visibleSessionIds`；
- 终端 resize 的帧内合并和相同尺寸去重。

### 6.3 端到端测试

在保留现有真实 SSH 场景的基础上，补充检查：

- 新壳层内两个 SSH 会话仍显示为独立终端，输入和输出互不串扰；
- 会话选择、关闭、新建 SSH 连接、唤起堡垒机、已保存会话和设置入口仍可访问；
- 空状态的 CMDB/手动唤起和已连接状态的紧凑浮层均能走真实主进程接线；
- 左右面板收起再展开不关闭 SSH，不清空 buffer，不丢失 Agent 状态；
- 候选命令确认和全自动驾驶升级入口仍可操作；
- 深浅主题切换不清空终端输出或重建会话；
- 连接失败和 AccessClient 失败仍展示安全的错误信息。

### 6.4 浏览器视觉验收

在 1440×900 与 1024×768 视口执行人工和自动化检查：

1. 无页面级横向滚动、重叠或被遮挡的关键控件；
2. 顶栏、左右栏、Shell 网格、AI 区和弹窗层级清晰；
3. 长标题、命令、时间和错误文本可读且不覆盖相邻控件；
4. 浅色与深色主题使用一致的语义层级；
5. 收起、展开、拖动分隔条和键盘焦点均可发现；
6. 实时终端、AI 状态和设置表单在窄桌面下仍可操作。

## 7. 非目标与后续扩展

本轮不实现新的聊天历史存储、Shell 历史存储、主机记忆持久化、历史执行回放或聊天上下文压缩。这些能力不得以静态原型数据代替。堡垒机唤起不属于非目标，它是本轮必须接入的真实入口；如果真实 CMDB/桥接来源尚未提供，必须在实施计划中将其列为明确的外部依赖和阻断条件，而不是用示例数据代替。以后每项新增能力都需要独立设计其数据来源、权限模型、保存周期、删除行为、安全处理和测试策略，再接入本工作台壳层预留的区域。

## 8. 完成定义

仅当以下条件全部成立时，本轮才可声明完成：

1. V17 定版原型的工作台视觉结构已在 Vue/Electron 产品中落地；
2. 本文列出的现有功能不变量均保持可用；
3. 所有既有与新增测试通过，构建、类型检查和 lint 通过；
4. 1440×900 和 1024×768 的视觉验收通过；
5. 未把原型静态数据、凭据或未经验证的新增业务能力混入产品；
6. 实施变更和验证结果被清晰记录，便于后续增量添加原型中的新能力。
