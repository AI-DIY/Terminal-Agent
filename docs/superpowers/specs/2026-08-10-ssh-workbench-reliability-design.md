# SSH 工作台可靠性设计

## 目标

修复设置返回、Assess Client/堡垒机启动、模型连通性、主机名标签和 SSH 会话保存五个相互关联的体验问题。所有终端（手动直连和 Assess Client 启动）必须在同一个工作台中显示，并可同时按九宫格查看。

## 设计边界

- `putty.exe` 是交给 Assess Client 映射的唯一轻量入口；安装目录中的 Electron 运行时不需要复制到 Assess Client 目录。
- 手动 SSH 直连与 Assess Client/堡垒机临时启动严格分开：前者可保存，后者绝不写入会话簿或保存本次密码。
- 保存的密码和私钥口令必须通过 Electron `safeStorage`（Windows 下为系统级加密）保护；私钥内容永不落盘，只保存选中的路径。
- 顶部会话标签优先展示远端实际主机名。Raw 堡垒机跳转无法查询远端时，展示临时配置提供的标题，而非本地跳板 IP。
- 模型设置保存与模型可用是两个动作；用户能用当前输入值测试标准 OpenAI Chat Completions 连通性，并得到脱敏、可行动的诊断。

## 架构

### 1. 工作台保活与九宫格

`App.vue` 同时挂载工作台与设置页，以 `v-show` 切换可见性，避免离开设置时卸载 `WorkbenchView`。这样保留连接对话框输入、已打开会话、当前标签和 `visibleSessionIds`。Assess Client 的单实例第二次启动继续通过 `sessions:opened` 加入相同 store，现有最多九格的选择逻辑不改变。

### 2. 便携 `putty.exe` 与安装运行时

Windows 启动器编译产物更名为 `putty.exe`。运行时启动时把其已安装目录登记到当前用户注册表 `HKCU\\Software\\Terminal-Agent\\InstallPath`；安装版启动路径也会更新此值。启动器先从该值定位 `Terminal-Agent-runtime.exe`，校验文件存在后原样转发命令行参数。仅在开发或同目录发布包中运行时，才以同目录运行时作为回退。两处都不可用时显示明确信息框，指引用户安装或重新打开安装版。这样 Assess Client 目录只保留 `putty.exe`。

### 3. 会话元数据与顶部标签

会话摘要增加可选 `displayHostname`。直连 SSH 初始显示用户输入；只读观察先执行 `hostname` 并立即更新该字段，再采集其余事实。标签渲染优先级是 `observedHostname`、堡垒机临时配置的 `title`、初始连接地址。Raw 传输以本地端口连接，但将其 `title` 作为显示名，故不会把 `127.0.0.1`/跳板 IP 当成目标机名。

### 4. 直连会话簿

新增 `DirectSessionRepository`，在用户数据目录维护仅含非敏感元数据的 JSON：稳定 ID、显示名称、主机、端口、用户名、认证种类与私钥路径。每个密码或私钥口令独立存入 `ElectronSecretStore`，键由稳定会话 ID 派生。仓储提供 `list`、`save`、`load`、`remove`。删除同时删除对应密钥；更新认证方式时删除不再适用的密钥。

`ConnectionDialog` 增加“保存到会话簿”和显示名称，保存后仍立即连接。`SavedSessionsDialog` 以 XShell 式列表提供连接、编辑、删除和新建；点击已保存的私钥会话时主进程从保存路径重新读取私钥，因此不依赖已过期的临时 key reference。此 IPC 只服务手动直连。

`AccessSessionResolver` 不再对 `tmp:` 临时配置调用 `save`。已有的 Assess Client 协议解析和原样参数转发保持不变，但临时跳转只在内存中解析与打开。

### 5. Chat Completions 连通性与故障信息

`ChatCompletionsClient` 增加非流式 `verify`：用与用户当前输入相同的 endpoint、model 和 API Key 发出最小标准 Chat Completions 请求，不附加 JSON Schema 扩展。它把网络、超时、HTTP 状态和安全响应摘要转为 `ModelConnectionError`，并通过敏感信息脱敏器防止回显密钥。

设置 IPC 接受未保存的设置输入并调用 `verify`。界面有“测试连接”按钮，独立展示测试中、成功和失败状态。实际 Agent 调用也不再强制发送 `response_format: json_schema`；系统提示要求纯 JSON，主进程继续执行严格 schema 校验。运行错误向面板传递分类后的原因（例如 HTTP 401、TLS/网络、超时、返回不是有效 JSON），而不是统一的“暂时不可用”。

## 数据流

```text
Assess Client -> putty.exe -> 注册表中的 Terminal-Agent-runtime.exe -> 单实例主进程 -> 同一 Workbench 九宫格
手动 SSH -> 会话簿(元数据 + 系统加密密钥) -> 主进程 SSH -> Workbench 九宫格
堡垒机 tmp -> 内存解析 -> 本地 Raw/SSH -> Workbench 九宫格（不写会话簿）
模型测试 -> 标准 Chat Completions -> 脱敏诊断 -> 设置页
```

## 验收标准

1. 设置返回不丢失已打开会话、当前九宫格、连接表单输入或会话簿状态。
2. Release 根目录产出 `putty.exe`，单独复制后可从登记的安装路径启动运行时并转发 Access Client 参数；无安装路径时给出可理解的错误。
3. 未支持 JSON Schema 的 OpenAI-compatible Chat Completions 服务可完成标准测试和 Agent 请求；保存前即可看到成功或可行动、脱敏的失败原因。
4. 直连到 IP 后顶部变更为远端 `hostname`；堡垒机 Raw 会话显示配置标题而不是本地跳板 IP。
5. 手动密码与私钥会话可保存、重开、编辑和删除；密码/口令不出现在 JSON；`tmp:` 堡垒机配置及其密码不进入会话簿。
6. 手动直连和堡垒机启动均在单个页面的既有最多九格工作区显示。
