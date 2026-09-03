# Terminal-Agent v3.0.0 单点登录与身份感知设计

**状态：** 已由用户于 2026-09-03 批准，待实施计划评审。

## 目标

为 Terminal-Agent 增加默认启用的单点登录（SSO）门控。应用在首次运行或 SSO 配置不完整时进入单点登录设置；配置完整后先打开用户配置的登录页，等待用户登录并进入平台页，**被动捕获**平台页面自然发起的用户信息接口响应，从响应 JSON 中读取姓名和工号，将已验证身份保存在应用运行期的全局状态中，最后显示工作台并在顶部欢迎语中使用该身份。

本版本的发布版本为 `3.0.0`，开发分支为 `codex/v3.0.0`，最终验证完成后在发布提交上创建 Git tag `v3.0.0`。

## 已确认的产品约束

1. 单点登录门控默认启用。
2. 单点登录配置文件必须位于用户目录的 `.ta/user-config`，并在 Windows 安装完成时创建默认文件；应用启动还必须提供一次初始化兜底。
3. 缺少必填 SSO 配置时，应用不能进入工作台，必须直接显示“设置 → 单点登录”。
4. 关闭登录门控后可以进入工作台，但处于未登录状态，内置技能不可使用；设置页和技能入口必须给出明确提示。
5. 用户登录后，平台页本身会自然加载用户信息接口。Terminal-Agent 只能监听、匹配和读取该响应，不能再次主动请求、重放、修改或拼接用户信息接口请求。
6. 平台 URL 与用户信息接口 URL 都必须同时支持精确匹配与正则匹配。
7. 姓名、工号配置必须支持多层级 Object Path 与 JSONPath 风格路径，例如 `data.em[0].name` 和 `$.data.em[0].name`。
8. 成功登录后，顶部欢迎语必须包含获取到的姓名；本设计同时显示工号以便确认当前身份。

## 范围与非目标

### 本版本范围

- 版本化的 `.ta/user-config` 配置存储、Windows 安装器默认文件和启动兜底初始化。
- 设置页单点登录面板、应用启动门控和本地登录状态页。
- 受控认证窗口、平台导航监听、CDP 网络响应被动捕获、JSON 路径提取和运行期身份状态。
- 工作台欢迎语、技能入口和聊天技能上下文的登录状态约束。
- 单元、预加载 API、主进程生命周期、安装脚本和 Electron 端到端测试。
- `3.0.0` 版本、发布说明和最终 Git tag。

### 非目标

- 不实现账号密码表单、注册、找回密码、OAuth token 交换或自有身份服务。
- 不保存用户信息接口原始响应、Cookie、Access Token、Refresh Token 或密码。
- 不在用户信息接口不可捕获时退化为 DOM 抓取、localStorage 抓取、重复 `fetch` 或其他主动请求。
- 不改变现有 SSH、模型 API Key、主机记忆和聊天数据的存储位置或格式。
- 不允许未认证用户通过直接 IPC 参数绕过“技能不可用”的限制。

## 术语

| 术语 | 含义 |
| --- | --- |
| 登录页 | 由 `loginPageUrl` 配置的远程页面，用户在这里完成企业既有的登录流程。 |
| 平台页 | 登录成功后远程窗口导航到的页面；匹配 `platformUrlMatcher` 后才允许完成身份认证。 |
| 用户信息响应 | 平台页正常加载时自然产生、URL 匹配 `userInfoUrlMatcher` 的 HTTP 响应。 |
| 认证窗口 | 单独创建、使用内存会话的 Electron `BrowserWindow`，专门承载登录页和平台页。 |
| 本地登录状态页 | Terminal-Agent 本地 Vue 页面，显示正在登录、错误、重试和进入设置的状态；不承载企业登录 HTML。 |

## 配置存储

### 路径与创建规则

- Windows 路径：`%USERPROFILE%\\.ta\\user-config`。
- 其他平台路径：`<app.getPath('home')>/.ta/user-config`。
- 文件名固定为 `user-config`，不附加 `.json` 扩展名。
- Windows NSIS 安装器仅在文件不存在时创建默认文件，绝不覆盖升级或用户编辑后的文件。
- `SsoConfigService.ensureInitialized()` 在每次应用启动时运行；它只在文件缺失时创建默认文件，作为开发、便携启动、损坏安装流程或人工删除文件后的兜底。
- 配置使用现有 `AtomicJsonStore`，因此读取时受 Zod schema 校验、写入原子化、并发更新串行化，格式损坏时保存 `.corrupt` 诊断副本而不是静默覆盖。

### 文件格式

```json
{
  "version": 1,
  "sso": {
    "enabled": true,
    "loginPageUrl": "",
    "platformUrlMatcher": {
      "mode": "exact",
      "value": ""
    },
    "userInfoUrlMatcher": {
      "mode": "exact",
      "value": ""
    },
    "employeeIdField": "",
    "nameField": ""
  }
}
```

`enabled: true` 是默认值。空 URL、空 matcher 值和空字段路径允许作为未完成草稿持久化，但这样的配置不是“完整配置”，不能启动认证窗口或进入工作台。

### 配置模型与校验

```ts
type SsoUrlMatcher = {
  mode: 'exact' | 'regex'
  value: string
}

type SsoConfiguration = {
  enabled: boolean
  loginPageUrl: string
  platformUrlMatcher: SsoUrlMatcher
  userInfoUrlMatcher: SsoUrlMatcher
  employeeIdField: string
  nameField: string
}
```

- `loginPageUrl`：完整配置时必须为 HTTP 或 HTTPS URL。
- 两个 matcher：`mode: 'exact'` 时，完整配置必须为 HTTP 或 HTTPS URL；`mode: 'regex'` 时，完整配置必须是可编译的 JavaScript 正则表达式源文本。
- 正则没有配置 flags，避免 `g` / `y` 等状态性 flags 使多次网络事件匹配不稳定。
- 所有文本在保存时 trim；URL 和路径长度受有限上限保护，不能保存空白字符串伪装的配置。
- 设置页会即时显示单项格式错误；“保存并继续”只在 `enabled` 为 `true` 且配置完整时可用。“保存草稿”始终可用。

### URL 匹配语义

平台导航 URL 和网络响应 URL 使用**同一个 matcher 实现**，因此两者的精确和正则语义一致。

1. 先解析 HTTP/HTTPS URL，删除 fragment（fragment 不会随网络请求发送，也不应参与匹配）。
2. `exact` 模式比较规范化的 `protocol + host + pathname`，忽略 query 参数。这样动态登录参数、一次性 code 或跟踪参数不会让固定平台/API 地址失配，也不会被写入错误或日志。
3. `regex` 模式匹配规范化后的完整 URL（保留 query，删除 fragment）。需要匹配动态 query 时由管理员显式编写正则。
4. URL 或正则永远不记录到包含 Cookie、授权头、响应体或 token 的日志中。

例如，动态平台回调可使用：

```text
^https://platform\\.example\\.com/(?:home|index)(?:\\?.*)?$
```

动态用户信息接口可使用：

```text
^https://platform\\.example\\.com/api/v\\d+/userinfo(?:\\?.*)?$
```

## 字段路径解析

`employeeIdField` 与 `nameField` 各自解析到一个单一的 JSON 标量值。支持的安全只读路径形式为：

| 写法 | 示例 |
| --- | --- |
| Object Path | `data.em[0].name` |
| Object Path | `data.user.employeeId` |
| JSONPath 风格根路径 | `$.data.em[0].name` |
| JSONPath 风格带引号键 | `$['data']['em'][0]['employeeId']` |

解析器支持命名属性、带引号的属性键和非负数组索引；拒绝通配符、递归下降、过滤器、脚本表达式和会产生多个候选值的 JSONPath 特性。认证需要一个明确身份，不应通过多值表达式猜测目标。路径还会拒绝 `__proto__`、`prototype`、`constructor` 等危险属性名。

路径结果必须为非空字符串或有限数字；数字会转换为字符串后存储。路径不存在、数组索引越界、值为对象/数组/null/空字符串或两条路径任一失败，均不能完成认证。

## 主进程架构

### 新增职责边界

| 单元 | 责任 |
| --- | --- |
| `SsoConfigService` | 读取、保存、初始化和判定 `.ta/user-config` 是否完整。 |
| URL matcher / field-path resolver | 无副作用地验证 matcher、匹配 URL、解析单一身份字段。 |
| `SsoResponseCapture` | 对一个认证窗口附着 CDP 网络监听，等待已完成的匹配用户信息响应并返回已提取身份。 |
| `SsoAuthenticationService` | 管理认证窗口、认证状态机、超时、取消、清理及向渲染进程发布安全的状态快照。 |
| SSO IPC handlers | 仅向可信主渲染进程暴露配置 CRUD、认证状态读取、重试和状态事件；不暴露 CDP、Cookie、request ID、原始 URL 参数或原始响应。 |
| Renderer SSO store | 保存响应式的安全状态快照，供根页面门控、欢迎语和技能可用性共用。 |

### 认证窗口

认证窗口独立于工作台主窗口创建，并在加载 `loginPageUrl` 前完成监听安装。它使用独立的非持久 Electron session partition：登录页和平台页在本次应用运行中仍可共享必要 Cookie，但应用退出后会丢弃该 session。

认证窗口的 Web 偏好至少与主窗口同等严格：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`。不会向远程登录页面注入通用 preload API，也不会关闭 Chromium 的 web security。认证窗口关闭、调试器 detach、超时或显式重试都会进入明确的失败/可重试状态。

主窗口停留在本地 `LoginView`，显示“正在打开登录页”“等待平台加载用户信息”“登录窗口已关闭”或可读错误。完成认证后关闭认证窗口，主窗口在原有本地 renderer 中切换到工作台，无需把主窗口导航到远程站点再重新加载本地应用。

### 被动响应捕获流程

认证窗口加载前，`SsoResponseCapture` 执行：

1. 对认证窗口的 `webContents.debugger` 附着 Chrome DevTools Protocol，启用 `Network` 域。
2. 监听浏览器导航事件，并使用 `platformUrlMatcher` 记录“已经到达平台页”。
3. 监听 `Network.responseReceived`；只对 HTTP 成功响应、可读取主体的请求保存 `requestId`，并仅在 URL 匹配 `userInfoUrlMatcher` 时继续。
4. 等待同一个 `requestId` 的 `Network.loadingFinished`。不能在 `responseReceived` 时立即读取主体，因为响应可能尚未传输完成。
5. 调用 `Network.getResponseBody`，按 `base64Encoded` 标志解码，限制可解析的响应大小，解析 JSON，并使用两条字段路径构造 `{ employeeId, name }`。
6. 认证仅在“已匹配平台导航”和“已从一条自然产生的响应中解析出有效身份”同时满足时成功；二者到达顺序不限。
7. 成功后只保留已验证的姓名、工号和状态；删除网络监听、禁用 Network 域、detach 调试器并关闭认证窗口。

该流程没有任何 `fetch`、`session.fetch`、`net.request`、请求重放、接口 URL 拼接或 DOM/localStorage 回退。平台页面自然发出的请求仍由 Chromium 正常处理；Terminal-Agent 只在响应结束后读取其结果。

如果某条匹配响应 JSON 不正确或字段路径无法解析，捕获器记录安全的、面向用户的失败原因并继续等待同一认证窗口中的下一条匹配响应，直到成功、窗口关闭、调试器断开或认证超时。认证超时为 60 秒，从平台 URL 首次匹配开始计时。

### 清理与异常安全

每个认证会话拥有唯一、幂等的 cleanup 函数，覆盖成功、失败、超时、认证窗口关闭、主窗口关闭、CDP detach 和用户点击重试。cleanup 必须：

1. 移除导航、CDP message 和 window closed 监听器；
2. 在仍附着时尝试 `Network.disable`；
3. 在仍附着时 detach；
4. 清除 timeout；
5. 关闭未销毁的认证窗口；
6. 丢弃 request ID、响应正文和临时 JSON；
7. 仅向仍存活的主渲染进程发布安全状态。

CDP 响应主体不可用、attach/command 失败或窗口提前关闭是认证失败，不触发任何主动请求回退。

## 状态机与全局身份

```ts
type SsoAuthState =
  | 'configuration-required'
  | 'login-required'
  | 'authenticating'
  | 'authenticated'
  | 'login-disabled'
  | 'error'

type SsoIdentity = {
  employeeId: string
  name: string
}
```

状态转换规则：

| 当前条件 / 动作 | 目标状态 | 结果 |
| --- | --- | --- |
| `enabled === true` 且配置不完整 | `configuration-required` | 根组件强制显示单点登录设置页。 |
| `enabled === false` | `login-disabled` | 清除身份，显示工作台，禁用技能。 |
| 完整配置启动或保存后 | `login-required` → `authenticating` | `LoginView` 自动打开认证窗口。 |
| 平台匹配且身份解析成功 | `authenticated` | 保存内存身份、关闭认证窗口、显示工作台。 |
| 关闭窗口、超时、CDP 或解析失败 | `error` | 保留错误类别，LoginView 提供重试和进入设置。 |
| 用户点击重试 | `login-required` → `authenticating` | 清理旧会话后开启全新的认证窗口。 |
| 保存新 SSO 配置或关闭门控 | 对应首行规则 | 立即清除旧身份和旧认证窗口。 |

主进程和 renderer 都持有同一安全身份快照：`state`、可显示的错误文案和可选 `{ employeeId, name }`。身份只保留在应用进程内存中，重启应用后不恢复。Cookie 仅存在认证窗口的内存 session，不写入 `user-config`。

## Renderer 体验

### 根页面门控

`App.vue` 从 SSO store 决定唯一活动页面：

- `configuration-required`：显示 `SettingsView`，并强制选择“单点登录”标签；返回工作台操作不改变门控。
- `login-required`、`authenticating`、`error`：显示新的 `LoginView`。
- `authenticated`、`login-disabled`：显示原有 `WorkbenchView`；设置和技能页面仍通过既有壳层切换。

`LoginView` 不承载远程登录 DOM；它展示认证进度、重试、打开设置以及认证窗口已关闭后的可恢复操作。远程登录由认证窗口承载，避免跨域 iframe 限制和对远程网页放宽 renderer 安全设置。

### 单点登录设置页

设置导航新增“单点登录”标签。面板字段为：

1. `启用单点登录门控` 开关；
2. `登录页 URL`；
3. `平台 URL 匹配方式`（精确 URL / 正则匹配）；
4. `平台 URL / 正则`；
5. `用户信息接口 URL 匹配方式`（精确 URL / 正则匹配）；
6. `用户信息接口 URL / 正则`；
7. `工号字段路径`；
8. `姓名字段路径`。

面板同时展示 Object Path 和 JSONPath 示例。关闭门控时，开关下面始终显示：

> 关闭登录门控后，应用将以未登录状态运行，内置技能不可使用。

保存行为固定如下：

- 保存草稿：持久化所有有效格式字段，但仍留在设置页。
- 配置完整且门控开启时点击“保存并继续”：保存配置后转到 `LoginView` 并自动打开登录窗口。
- 门控关闭时点击“保存并进入工作台”：保存后进入工作台；不允许隐式恢复旧身份。

### 技能约束

`skillsAvailable` 只在 `SsoAuthState === 'authenticated'` 时为真。关闭门控不是“可信任模式”，因此 `login-disabled` 同样不能使用技能。

约束必须同时存在于 renderer 和主进程：

- 工作台顶部“技能”按钮禁用，`title` 和可访问名称说明“未登录状态不能使用技能”。
- `SkillsView` 在不可用状态显示限制说明，禁用技能编辑开关；根组件不允许通过普通导航打开可交互的技能管理页。
- `GlobalChatPanel` 在不可用状态传递空 `skillIds`。
- 主进程聊天 IPC 在身份未认证时丢弃或拒绝请求中的 `skillIds`，避免通过 renderer 参数伪造绕过。

普通聊天、SSH 和其他本地工作台能力仍然可在关闭登录门控后的未登录状态使用。

### 欢迎语

认证成功时，工作台顶部显示：

```text
欢迎回来，<姓名>（<工号>）
```

SSO 身份优先级高于现有 renderer `localStorage` 中的手工显示姓名。关闭门控时保留现有手工显示姓名作为工作台的回退称呼；它不能用于解锁技能。

## IPC 与安全边界

预加载层新增窄接口，而不是把认证窗口或 CDP 暴露给 renderer：

```ts
terminalAgent.sso = {
  getConfig(): Promise<SsoConfiguration>,
  saveConfig(input: SsoConfiguration): Promise<SsoConfiguration>,
  getState(): Promise<SsoAuthSnapshot>,
  retry(): Promise<void>,
  onState(listener: (state: SsoAuthSnapshot) => void): () => void,
}
```

所有主进程 handler 与现有设置 handler 一样验证 `event.sender === mainWindow.webContents`，对输入使用共享 Zod schema，并在主窗口关闭时移除。返回 renderer 的状态禁止包含：Cookie、authorization header、网络 request ID、原始接口响应、完整 HTTP headers、远程页面 DOM 或调试协议错误细节。

## Windows 安装与运行时初始化

NSIS 安装器新增以下语义：

1. 解析当前用户 profile 目录；
2. 创建 `<profile>\\.ta`（若不存在）；
3. 仅在 `<profile>\\.ta\\user-config` 不存在时写入本设计的默认 JSON；
4. 不触碰其它 `.ta` 文件和不属于 Terminal-Agent 的用户数据；
5. 卸载流程不删除 `.ta/user-config`，与现有“保留用户数据”约定一致。

应用启动时在创建主窗口之前调用 `ensureInitialized()`。安装器和运行时写出的默认 JSON 必须字节上可被同一 Zod schema 接受。

## 测试策略与验收标准

### 单元测试

- `SsoConfigService`：默认文件路径、缺失文件创建、默认门控开启、原子更新、旧文件保留、空草稿与完整配置判定。
- matcher：平台与用户信息 matcher 的 exact/regex 一致性、query 忽略规则、fragment 删除、非法 HTTP scheme、非法正则与动态 URL。
- path resolver：`data.em[0].name`、`$.data.em[0].name`、引号属性、工号与姓名独立提取、空/多值/对象/危险属性拒绝。
- `SsoResponseCapture`：attach 后再加载页面、`Network.enable`、只监听匹配 URL、必须等待 `Network.loadingFinished`、base64 解码、响应大小限制、重复事件、无响应主体、JSON 错误、字段错误、timeout、window closed、debugger detach 和幂等 cleanup。
- `SsoAuthenticationService`：状态转换、平台导航和身份响应任意顺序、重试、新配置清除旧身份、禁用门控、可信 renderer IPC。
- preload：冻结的 `sso` namespace、输入 schema、事件订阅移除。
- renderer：配置不足强制设置、关闭门控进入工作台、技能不可用、认证成功欢迎语优先使用 SSO 姓名和工号。
- 主进程聊天 guard：未认证请求绝不将内置技能 ID 交给聊天运行时。
- 安装脚本：默认文件只创建一次、使用用户 profile 的 `.ta/user-config` 路径、不删除该文件。

### Electron 端到端测试

启动本地 HTTP 服务器模拟：登录页 → 平台页 → 平台页脚本自然 `fetch('/userinfo')`。测试必须验证：

1. 新用户数据目录、默认启用门控时主窗口先显示单点登录设置页；
2. 保存完整配置后打开认证窗口并加载登录页；
3. 平台页脚本自然发出的用户信息请求被捕获；
4. 测试服务器的用户信息端点只收到平台页面的那一次自然请求，不存在 Terminal-Agent 发起的第二次请求；
5. 返回本地工作台，欢迎语显示服务端返回的姓名与工号；
6. 关闭门控后可进入工作台，但技能按钮、技能页和聊天技能上下文均不可用；
7. 平台/用户信息 URL 各自的 regex matcher 能完成同一流程。

### 完成门槛

实施完成前必须有新鲜证据证明：目标单元测试、完整 `npm test`、`npm run lint`、`npm run build`、相关 Electron E2E 测试均通过；版本文件、发布说明和 Windows 安装器测试均指向 `3.0.0`；最终 tag `v3.0.0` 指向经过上述验证的发布提交。
