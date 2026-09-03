# Terminal-Agent v2.1.1

Release date: 2026-09-03

## AI 工作区微调

- 切换已保存会话时保留原始会话 ID 与“会话 N”名称；再次离开该会话只会更新同一条已保存记录，不再生成递增名称的副本。
- 移除 AI 输入区底部的在线 SSH 数量提示，保留 SSH 上下文选择、连接和 AI 协作能力。

## SSH 历史微调

- 历史 SSH 条目按主机名合并为单一入口，历史标题不再显示连接时间。
- 点击主机入口继续使用原有的 Shell 历史弹窗，查看该主机每次连接的时间、终端快照与重连操作。

## Windows 发布包

- `Terminal-Agent-Setup-2.1.1.exe`
- `putty.exe`
- `quick-install.cmd`
- `quick-start.pdf`

---

# Terminal-Agent v2.1.0

Release date: 2026-09-03

## AI 工作区与会话

- AI 工作区新增“新建会话”和“切换会话”：有聊天内容时会先按“会话 + 递增序号”备份当前会话；切换历史会话前也会自动备份当前内容，避免消息、任务步骤与会话顺序丢失。
- 没有聊天内容时不能新建空会话；恢复历史会话后可继续在同一 AI 工作区中对话。
- “选择主机追加上下文”默认不再自动勾选，只有用户明确选择的在线 SSH 连接才会提供给 AI。

## SSH 工作台与历史

- 没有在线 SSH 连接、但仍有历史连接时，主区域默认复用“新建 SSH 连接”界面，而不再显示历史终端窗口。
- 历史 SSH 连接以主机名为主要标题，以连接时间区分同名记录；历史区域进一步收紧高度与字号，并优化历史记录打开时的响应体验。

## 顶部栏

- 将“当前任务”恢复到顶部栏左侧起始位置；欢迎语移至右侧功能区前、紧邻“技能”按钮左侧，并与按钮组保持更清晰的间距层次。

## Windows 发布包

- `Terminal-Agent-Setup-2.1.0.exe`
- `putty.exe`
- `quick-install.cmd`
- `quick-start.pdf`

---

# Terminal-Agent v2.0.9

Release date: 2026-09-02

## AI 工作区与偏好

- SSH 上下文追加行数不再存在人为上限，并会保存在本地；重新启动应用后保留用户的设置。
- AI 工作区可按当前任务选择哪些在线 SSH 追加上下文：默认每个主机选择主连接，重复连接可明确选择 `#2`、`#3` 等替代连接。
- 移除独立的“AI 工作区·历史”分区，统一保留原有 AI 工作区；新增可设置的欢迎语和独立“技能”入口。启用的内置技能会在后续 AI 对话与上下文压缩中实际生效，且不会绕过安全围栏或人工确认。

## SSH 工作台与历史

- 暂时移除 SSH 工作区中的文件传输入口，避免在终端工作时误离开当前 SSH 连接。
- 历史 SSH 不再采用多选筛选；展示样式与在线 SSH 标签保持一致。只要仍有在线连接，历史项只会打开历史弹窗且不会占用终端主体；全部连接关闭后才显示只读历史主体。
- 历史 SSH 标签与下方只读历史卡片均支持拖拽排序，并为每个任务在本地保持相同的顺序。

## Windows 发布包

- `Terminal-Agent-Setup-2.0.9.exe`
- `putty.exe`
- `quick-install.cmd`
- `quick-start.pdf`

---

# Terminal-Agent v2.0.8

Release date: 2026-09-02

## SSH 工作台、AI 聊天与文件传输

- 压缩 AI 工作区上下文区域；消息发送后自动跟随到底部，用户手动上滑时暂停跟随，回到底部后恢复。
- SSH 标题栏和聊天滚动条改为悬浮显示；选中的 SSH 标题和卡片使用红色边框与浅黄色背景，并保持稳定尺寸。
- 文件传输面板归属对应 SSH 卡片，支持远程目录浏览、路径面包屑、文件/目录右键菜单、上传/下载和可滚动进度日志。
- 修复 SFTP 通道建立、传输超时和 Electron IPC 应答问题；传输面板在紧凑行高和窄窗口下仍保持日志区域可见。

## Windows 发布包

- `Terminal-Agent-Setup-2.0.8.exe`
- `putty.exe`
- `quick-install.cmd`
- `quick-start.pdf`

---

# Terminal-Agent v2.0.7

Release date: 2026-09-02

## SSH 工作台与文件传输

- 移除单个 SSH 窗口的操作菜单和冗余的“当前展示数量”提示；多 SSH 终端保持同时渲染，并在窄窗口或单列布局下支持滚动查看。
- 统一在线与历史 SSH 的主机目标映射；重复连接到同一主机时使用稳定的 `#1`、`#2` 序号，避免任务历史和 AI 计划串台。
- 为每个 SSH 会话增加独立 SFTP 文件传输面板，支持通过原生文件选择器上传、下载、进度反馈和安全路径校验，不中断终端会话。

## AI 工作区与升级

- 改进在线 Shell 上下文、执行计划目标标签和任务状态展示，计划确认后的结果不会额外打断对话。
- 修正 SSH 初始输出竞态、会话重连和 Electron 更新请求的网络会话使用；保留输入快捷键、布局和外观设置的持久化行为。

## Windows 发布包

- `Terminal-Agent-Setup-2.0.7.exe`
- `putty.exe`
- `quick-install.cmd`
- `quick-start.pdf`

---

# Terminal-Agent v2.0.6

Release date: 2026-09-01

## SSH 工作台与历史视图

- 在线 SSH 与历史 SSH 共享布局、卡片尺寸和字体大小设置；网格支持横向滚动，避免多窗口时纵向滚动挤压终端内容。
- 连接标题会优先使用已观测到的远端主机名；共享堡垒机或中继地址下的主机序号不再错误混用。
- 未选中但仍有在线 SSH 的任务会在任务历史区显示浅色在线状态和“正在工作”提示。
- 历史主机在同一任务存在在线 SSH 时统一进入“Shell 历史”查看；纯历史任务保持只读回放和主机筛选。

## 连接入口与升级

- 嵌入式首页默认采用“堡垒机主机唤起”，保留主机地址输入，并隐藏不适用于该入口的 CMDB 选项；对话框模式仍可使用 CMDB。
- 新增“堡垒机浏览器 MCP 配置”模拟界面，仅用于展示配置流程，不会连接外部服务或发起真实连接。
- 左上角显示当前版本；Node Inspector 右侧新增升级入口，支持从固定 GitHub 仓库检查、下载、摘要校验和安装 Windows x64 更新。

## Windows 发布包

- `Terminal-Agent-Setup-2.0.6.exe`
- `putty.exe`
- `quick-start.pdf`

---

# Terminal-Agent v2.0.5

Release date: 2026-08-31

## 安装与 AccessClient 快速开始

- 重写中文 README，并新增带截图的 AccessClient 安装、原始 `putty.exe` 备份、桥接程序替换和堡垒机会话配置指引。
- Release 随附独立的 `quick-start.pdf`，将图文说明嵌入 PDF，下载后无需依赖仓库中的图片路径。

## 工作台微调

- “设置 → 外观”和 Shell 工作区的“布局”菜单新增持久化字体大小设置；保留原有 `13px` 为默认最大值，并可缩小至 `12px` 或 `11px`。
- Shell 单行高度新增并默认使用“占满（100%）”；移除单个 Shell 的最大化/还原按钮，多个连接继续按布局同时展示。
- Shell 历史优先以已观测的真实主机名归档和筛选，避免 AccessClient 堡垒机或中转地址导致同一主机被拆分。
- AI 输入框改为裸 `Enter` 发送，`Shift+Enter`、`Ctrl+Enter`、`Alt+Enter` 和 `Meta+Enter` 保持换行；输入法组合态不会误发。
- 恢复可展开的上下文详情入口，并将“正在思考”等运行状态紧贴在触发该轮的用户问题下方。

## Windows 发布包

- `Terminal-Agent-Setup-2.0.5.exe`
- `putty.exe`
- `quick-start.pdf`

---

# Terminal-Agent v2.0.4

Release date: 2026-08-30

## 在线 Shell 上下文修复

- 修复连接地址为 IP、Raw 或堡垒机转发地址且尚未观测到远端 hostname 时，在线 Shell 被错误过滤、导致 AI 误报“没有在线主机”的问题。
- 对标题中严格识别的 `user@hostname` 使用安全主机目标；无法确认时使用不含连接地址和会话 ID 的匿名 Shell 目标，并在执行计划确认阶段映射回原在线会话。
- 当前任务上下文优先于历史助手回复，避免旧的“无在线 Shell”错误消息覆盖实时连接状态。
- 保持自动注入上下文中的连接 IP、网络接口地址和 Shell 输出地址脱敏。

## Windows 发布包

- `Terminal-Agent-Setup-2.0.4.exe`
- `putty.exe`
- `Terminal-Agent-Uninstall-Cleanup-2.0.4.zip`
- `latest.yml` 与匹配的 `.blockmap`

---

# Terminal-Agent v2.0.3

Release date: 2026-08-30

## 开源 TA 修改意见补充修复

- 修复历史任务区收起、AI 工作区展开且多个 Shell 采用双行布局时，Shell 底部输入行被遮挡的问题。
- 修复终端右键粘贴后 xterm 焦点和光标丢失的问题，粘贴后可直接继续输入。
- AI 自动注入上下文会移除堡垒机连接 IP、网络接口地址以及标题、审计和重试文本中的 IP 字面量。
- 以规范化真实 hostname 作为主机实体标识；同一 hostname 的不同大小写和重复连接不会被模型误识别为不同主机。
- 增加模型上下文投影、主机目标匹配和窄窗口终端布局的回归测试。

## Windows 发布包

- `Terminal-Agent-Setup-2.0.3.exe`
- `putty.exe`
- `Terminal-Agent-Uninstall-Cleanup-2.0.3.zip`
- `latest.yml` 与匹配的 `.blockmap`

---

# Terminal-Agent v2.0.2

Release date: 2026-08-29

## 开源 TA 修改意见修复

- 计划确认执行后不再向聊天窗口追加额外执行结果消息，避免干扰后续 AI 交互。
- 修复计划执行阶段复用请求幂等键导致的 `Chat request idempotency conflict`，执行完成后可继续进行 AI 对话。
- Shell 标题栏和 AI 计划目标使用可读连接标题及稳定序号；在线 Shell 上下文携带最近 200 行输出，关闭连接不会传递。
- 工作区和 AI 底部 Shell 数只统计当前在线连接。
- 连接建立后异步观测到真实主机名时，会同步更新任务关联，多个共享堡垒机中转地址的 Shell 可稳定区分。
- 重新生成 Windows x64 NSIS 安装包及配套桥接、卸载清理和自动更新元数据。

## Windows 发布包

- `Terminal-Agent-Setup-2.0.2.exe`
- `putty.exe`
- `Terminal-Agent-Uninstall-Cleanup-2.0.2.zip`
- `latest.yml` 与匹配的 `.blockmap`

---

# Terminal-Agent v2.0.0

Release date: 2026-08-27

## AI workspace plan approval

- The AI workspace now accepts text-only new messages. Existing persisted image messages remain readable, but the workbench exposes no new image-upload control.
- AI replies use a validated structured JSON contract. Human-readable replies, execution plans, and execution audits render separately; model JSON does not stream into the conversation.
- Every plan requires one explicit `确认并执行 N 步` group confirmation. The v2 workbench exposes no autonomous-driving, upgrade, single-command confirmation, or re-run path.
- Same-host terminal labels and AI context now use canonical hostnames with stable ordinals. A plan target remains the raw hostname and binds to the first still-online task-associated Shell in stored association order.
- Terminal right-click operations now include copy, paste, select all, and clear selection while retaining the existing terminal keyboard input behavior.

## AccessClient and Windows release

- AccessClient temporary profiles preserve declared UTF-8/CP936/GBK/GB2312/GB18030 decoding. Missing or unknown declarations try strict UTF-8 and then GB18030, independent of the Windows UTF-8 locale setting.
- `npm run make:win` produces `Terminal-Agent-Setup-2.0.0.exe`, its matching blockmap and `latest.yml`, the standalone `putty.exe` bridge, and `Terminal-Agent-Uninstall-Cleanup-2.0.0.zip`.

---

# Terminal-Agent v1.0.13

Release date: 2026-08-27

## 安装版依赖修复

- 修复 Windows 安装版启动时缺少 `@langchain/core/singletons` 的问题：将 LangGraph 的非可选 peer 依赖 `@langchain/core` 显式纳入生产依赖。
- 打包完成后自动检查 `app.asar` 中的全部直接生产依赖，以及 LangChain 的 `singletons` 运行时入口；任何缺失都会阻止发布集成校验继续执行。
- 新安装包为 `Terminal-Agent-Setup-1.0.13.exe`，并随附匹配的 `putty.exe`、自动更新元数据和卸载清理 ZIP。

---

# Terminal-Agent v1.0.11

Release date: 2026-08-25

## AccessClient and model-profile refinements

- Decodes Access Client temporary-profile titles using the declared `LineCodePage`, including `CP936`, GBK, GB2312, and GB18030, so titles such as `AI中台_10.54.98.34` display correctly.
- Positions the content of both LLM and VLM connection rows at the actual left edge of their cards, rather than retaining inherited centered button content.

## Windows release assets after packaging

- A Windows package made with `npm run make:win`, or a published release, will generate `Terminal-Agent-Setup-1.0.11.exe`, the standalone `putty.exe` bridge, and `Terminal-Agent-Uninstall-Cleanup-1.0.11.zip`.

---

# Terminal-Agent v1.0.10

Release date: 2026-08-25

## Single-feedback UI refinements

- Makes the normal task-history list fill the remaining sidebar height, so a short list does not become scrollable when its action menu opens; long task histories retain their existing low-distraction scrollbar and scrolling behavior.
- Vertically centers the `Shell history replay` title and host/record summary when every SSH session in the task is closed, without changing the workbench layout or history controls.
- Retains explicit left alignment for both LLM and VLM connection rows and adds a real Electron geometry check for their aligned text.

## Windows release assets after packaging

- A Windows package made with `npm run make:win`, or a published release, will generate `Terminal-Agent-Setup-1.0.10.exe`, the standalone `putty.exe` bridge, and `Terminal-Agent-Uninstall-Cleanup-1.0.10.zip`.

---

# Terminal-Agent v1.0.9

Release date: 2026-08-24

## Open-source TA refinements

- Adds `DevTools` for detached renderer-process Chrome DevTools and `Node Inspector` for a dedicated Electron window that automatically attaches to the current Node.js main process. The windows are reused when already open, reopen after closing, and require neither external Chrome nor `chrome://inspect`.
- Changes the model-chain boundary to pass task messages, authorized host facts, manually approved command audit context, and model responses through unchanged. Local credential storage, temporary bridge-password exclusion, Shell-history protections, host-memory authorization, infrastructure-error normalization, regex fences, and exact one-command confirmation remain in place.
- Adds task title state and pin state: system titles use Shanghai time, the first persisted user message or Shell association starts the task, custom titles remain intact, and the task menu supports rename, pin/unpin, and delete. Version-1 task data intentionally reports an incompatibility error instead of being migrated.
- Fixes startup when retained version-1 task data is present: the main window now opens and presents that incompatibility error instead of leaving only background processes. The legacy task file is neither migrated nor modified.
- Fixes a shutdown error in the main process by avoiding access to an already-destroyed renderer `webContents` during the `BrowserWindow` `closed` event.
- Explicitly left-aligns model-profile rows and reduces task-history scrollbar distraction while retaining layout stability.

## Scope boundaries

- This release does not add a log viewer, task-log persistence, or new business logging.
- This release does not add grouped command approval; candidate execution remains a single exact-command confirmation flow.
- This release does not migrate old version-1 task data.

## Windows release assets after packaging

- A Windows package made with `npm run make:win`, or a published release, will generate `Terminal-Agent-Setup-1.0.9.exe`, the standalone `putty.exe` bridge, and `Terminal-Agent-Uninstall-Cleanup-1.0.9.zip`.

---

# Terminal-Agent v1.0.8

Release date: 2026-08-23

## CETA follow-up refinements

- Removes the standalone top title strip with Electron's hidden title bar while retaining the native Windows minimize, maximize/restore, and close controls.
- Replaces file-based model-key input with direct API Key editing in the model connection form. A key can be tested before the configuration is saved and activated; protected storage retains it without returning the saved value to the UI.
- Removes LLM key references. Existing VLM references are migrated to protected credentials owned by the corresponding VLM profile.

## Windows release assets after packaging

- A Windows package made with `npm run make:win`, or a published release, will generate `Terminal-Agent-Setup-1.0.8.exe`, the standalone `putty.exe` bridge, and `Terminal-Agent-Uninstall-Cleanup-1.0.8.zip`.

---

# Terminal-Agent v1.0.7

Release date: 2026-08-22

## CETA interface refinements

- Removes Electron's redundant native application menu while retaining the standard Windows title bar and window controls, and lets the workbench fill the complete client area.
- Uses the same stripe-free `TA` mark for the executable, installer, taskbar, window, and in-app branding.
- Names the side regions `任务历史区` and `AI工作区`, improves the task-history scrollbar, and keeps narrow-window controls contained and keyboard accessible.
- Makes historical-only Shell content explicit with `Shell 历史回放`, host and record counts, and a clear read-only notice.
- Raises Shell row-height presets to Compact (48%), Standard (64%), and Relaxed (80%), with semantic migration of existing layouts.

## Host memory and AI verification

- Displays the complete ordered list of fixed read-only host-information commands in Settings, including the current enabled or disabled scope state for every command.
- Executes those commands only after `我已知道` and a required Linux platform check, keeps `hostname` first, and stores filtered structured facts by the observed hostname.
- Verifies the model connection API and `AI工作区` against the same local HTTP provider configuration, including streaming, temporary failure, retry, persistence, cancellation, and supersession coverage.

## Windows release assets

- Includes `Terminal-Agent-Setup-1.0.7.exe`, a newly compiled standalone `putty.exe` bridge, and `Terminal-Agent-Uninstall-Cleanup-1.0.7.zip`.

---

# Terminal-Agent v1.0.6

Release date: 2026-08-22

## V18 workbench visual parity

- Rebuilds the production workbench around the approved V18 desktop frame with a compact top bar, Chat Sessions sidebar, unified Shell host bar, responsive terminal grid, and dedicated AI Chat panel.
- Restyles the real four-mode SSH launcher, connected terminals, historical Shell playback, streaming AI conversation, panel resizing, collapse rails, and Pearl/Graphite themes without introducing prototype sample data.
- Uses Lucide icons and consistent semantic colors, focus treatment, typography, spacing, scrollbars, and compact controls across the renderer.

## Settings visual parity and retained behavior

- Rebuilds all six real settings routes with the V18 navigation, model-routing cards, split model-profile editor, safety-fence table and tester, host-memory controls, and full workbench theme previews.
- Retains real SSH, chat, AI model, history, host-memory, persistence, protected-key, safety-fence, cancellation, retry, and autonomous-upgrade confirmation behavior.
- Adds responsive coverage for 1440x900, 1024x768, and 900x700 layouts, including page-overflow, terminal mounting, and settings-table checks.

## Windows release assets

- Includes `Terminal-Agent-Setup-1.0.6.exe`, a newly compiled standalone `putty.exe` bridge, and `Terminal-Agent-Uninstall-Cleanup-1.0.6.zip`.

---

# Terminal-Agent v1.0.5

Release date: 2026-08-21

## Workbench and Shell history refinement

- Rebrands the application and workbench mark as `TA`, and renames the side regions to Task History and AI Workspace with explicit directional restore controls.
- Unifies Appearance and Shell workspace layout preferences. Row height is now a shared Compact (34%), Standard (48%), or Relaxed (64%) percentage, with automatic migration from v1.0.4 pixel settings.
- Improves Shell title and connection-area hierarchy in Pearl and Graphite themes, adds compact historical Shell connections, multi-host filtering, shared historical layouts, and a host context-menu reconnect action.
- Keeps closed Shell history isolated by normalized hostname and waits for final history persistence before application shutdown.

## Host memory and AI workspace

- Refines Local Host Memory status, scope controls, and dual-theme rendering while retaining per-host review, edit, and clear actions.
- The **I understand** consent action runs only the fixed read-only Linux observation commands, then stores structured facts by hostname.
- Moves the autonomous upgrade action into the AI Workspace and removes saved-session and upgrade actions from the Shell toolbar.
- Retains tested Ollama, OpenAI-compatible, and llama.cpp connection profiles plus durable streaming chat, retry, cancellation, and model connection tests.

## Windows release assets

- Includes `Terminal-Agent-Setup-1.0.5.exe`, a newly compiled standalone `putty.exe` bridge, and `Terminal-Agent-Uninstall-Cleanup-1.0.5.zip`.

---

# Terminal-Agent v1.0.4

Release date: 2026-08-21

## Unified SSH workbench and enterprise bastion entry

- Adds the unified workbench for direct password SSH, direct private-key SSH, bastion CMDB launch, and named bastion-host launch.
- Adds durable work-task chat, associated Shell workspaces, local Shell history playback, configurable workbench layout, and consented local host memory.
- Keeps Assess/Access Client-compatible `putty.exe` as a single-file bridge: temporary bastion SSH/Raw profiles open in the installed Terminal-Agent workbench without being saved as normal session profiles.

## AI task assistance and execution safeguards

- Adds task-oriented global AI chat and AI model profile/routing settings for Ollama, OpenAI-compatible, and llama.cpp endpoints.
- Uses Copilot mode by default: AI proposes a command and a human must confirm the exact candidate before it is sent to the current Shell.
- Includes configurable default safety fences for process termination, interactive editors, file removal, service changes, host power operations, and disk partitioning or formatting.
- Keeps autonomous execution behind an explicit, current-session-only confirmation. It is intended only for verified low-risk maintenance or test work.
- Redacts sensitive material from AI flows, bridge diagnostics, and approved-command context; model keys are stored through OS-protected storage.

## Windows uninstall-entry cleanup

- Includes `Terminal-Agent-Uninstall-Cleanup-1.0.4.zip` for cleaning Terminal-Agent entries left in the Windows installed-apps list.
- After extracting the ZIP, users can double-click `清理 Terminal-Agent 卸载残留.cmd`; it requests administrator permission, lists every matching entry, and requires an explicit `Y` before changing the registry.
- Each matching uninstall entry is exported to a `.reg` backup before deletion. The tool does not uninstall Terminal-Agent, remove application files or user data, or remove `HKCU\Software\Terminal-Agent\InstallPath`.

---

# Terminal-Agent v1.0.2

Release date: 2026-08-11

## Bastion warm-launch fix

- The standalone `putty.exe` now places its private bridge metadata after Electron's argument boundary, so a bastion jump remains correlated when Terminal-Agent is already open.
- Runtime metadata validation rejects shifted Chromium option names instead of creating a stray file named `--terminal-agent-bridge-id`.
- AccessClient temporary profiles that omit `Protocol` now follow the `-load tmp:...` SSH meaning used by the real client; explicit `raw` profiles remain supported and explicit unknown protocols remain invalid.
- A packaged warm-launch regression test opens a real SSH fixture through an existing Terminal-Agent primary instance and verifies that the bridge and runtime share one launch ID without logging credentials or temporary-profile paths.

## Upgrade instructions

1. Install `Terminal-Agent-Setup-1.0.2.exe`.
2. Replace the AccessClient-mapped executable with the included v1.0.2 `putty.exe`.
3. After a jump, inspect `putty-bridge.log` beside that mapped `putty.exe`. The legacy `accessclient-launch.log` is not used by this bridge and may remain empty.

Both the runtime and mapped bridge must be updated; keeping the v1.0.1 mapped `putty.exe` preserves the old warm-launch argument order.

---

# Terminal-Agent v1.0.1

Release date: 2026-08-10

## Bastion bridge diagnostics

- Every start through the released `putty.exe` writes a correlated, redacted JSON-line trace to `putty-bridge.log` beside the mapped bridge. The trace includes runtime lookup, process start, temporary-profile validation, transport opening, session opening, and a safe failure category.
- Passwords, tokens, passphrases, private-key content, and temporary-profile paths are redacted from the trace and from the in-app error message.
- Terminal-Agent now distinguishes unsupported launch arguments, unreadable or invalid temporary profiles, transport failures, and terminal-open failures instead of showing only one generic AccessClient error.
- A second bastion launch while Terminal-Agent is already open is routed through the same protected launch controller and trace path.

## Runtime recovery

- The bridge treats a missing or stale `HKCU\Software\Terminal-Agent\InstallPath` value as invalid and then checks a co-located runtime plus standard Windows installation locations.
- The bridge never rewrites the registry or deletes installation files. If the runtime itself was deleted, reinstall using the included Windows installer.

## Download assets

- `Terminal-Agent-Setup-1.0.1.exe`: Windows installer that restores the Terminal-Agent runtime and its normal registry association.
- `putty.exe`: single-file bridge to map in Assess/Access Client after Terminal-Agent has been installed.
