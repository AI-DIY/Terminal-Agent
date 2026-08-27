# Terminal-Agent 2.0.0 发布说明

## 发布内容

本版本依据开源 TA 修改意见微调现有工作台，保留三栏布局、Shell/SSH/跳板机、任务历史、Shell 历史、保存会话和设置能力。AI 工作区改为文字优先的结构化计划流程：AI 先返回普通文字回复和可审阅计划，计划必须经过一次整组人工确认后才能按顺序写入 Shell。

本版本同时统一 hostname 标签和 AI 目标上下文、增加终端右键剪贴板操作，并修复 AccessClient 临时配置在非 UTF-8 Windows 区域设置下的中文标题解码。

## Windows 发布包

- `Terminal-Agent-Setup-2.0.0.exe`：Windows x64 NSIS 安装包。
- `putty.exe`：提供给 Assess/Access Client 或堡垒机映射的单文件桥接程序。
- `Terminal-Agent-Uninstall-Cleanup-2.0.0.zip`：仅清理“已安装的应用”中的旧卸载条目，不会卸载程序或删除用户数据。
- `Terminal-Agent-Setup-2.0.0.exe.blockmap` 和 `latest.yml`：用于 Electron 自动更新。

## 关键行为变化

- 当前版本的新 AI 消息仅支持文字输入；旧版已保存的多模态消息仍可读取，不会新建图片消息。
- AI 输出采用结构化 JSON。普通回复与计划卡片分开显示，计划中的说明不会写入 Shell。
- 所有计划都必须点击一次“确认并执行 N 步”完成整组人工确认；没有自动驾驶、单条审批或再次执行入口。
- 同一 hostname 存在多个连接时，执行绑定任务关联顺序中第一个仍在线的 Shell。终端标签和 AI 上下文使用 canonical hostname，并以 `#1`、`#2` 等稳定序号区分同主机连接；连接 title 仍保留为元数据。
- 终端右键菜单支持复制、粘贴、全选和取消选择，保留键盘输入和现有 Shell 操作。
- AccessClient 临时配置会优先使用声明的 `LineCodePage`；未声明或未知时先严格按 UTF-8 解码，失败后使用 GB18030，不依赖 Windows 系统 UTF-8 开关。

## 堡垒机跳转

`putty.exe` 是桥接入口，不是完整 PuTTY 客户端。替换 Assess/Access Client 映射时只需替换这一个文件，不要复制 `Terminal-Agent-runtime.exe`、`resources` 或整个 `win-unpacked` 目录。临时配置、临时密码和一次性凭据只用于本次连接，不写入保存会话。

## 安装与验证

1. 在 Windows x64 计算机上运行 `Terminal-Agent-Setup-2.0.0.exe`，完成安装并手动启动一次 Terminal-Agent。
2. 将发布包中的 `putty.exe` 映射到 Assess/Access Client 配置的 PuTTY 可执行文件位置。
3. 发起测试跳转，确认新临时终端出现在工作台当前任务中，且没有出现在保存会话列表。
4. 在 AI 工作区发送文字请求，检查计划目标为 hostname，确认计划后观察 Shell 和执行审计消息。
5. 在终端内右键，确认复制、粘贴、全选和取消选择菜单可用；在 900x700 窗口中确认命令输入区仍可见且页面无滚动条。

## 回滚

升级前保留旧版安装包和旧版 `putty.exe` 备份。回滚应用时应同时回滚安装运行时和 Assess/Access Client 映射的桥接程序，避免两者参数协议不一致。
