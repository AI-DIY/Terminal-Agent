# Terminal-Agent 2.0.3 发布说明

## 发布内容

本版本针对开源 TA 修改意见补充修复终端布局、右键粘贴焦点和 AI 主机上下文边界，同时保留现有 SSH、堡垒机、任务审批、Shell 历史与本地主机记忆能力。

## 关键修复

- 历史任务区收起、AI 工作区展开且 Shell 采用双行布局时，终端底部输入行保持可见。
- 终端右键粘贴后自动恢复 xterm 焦点和光标，可直接继续键入命令。
- 发给 AI 的应用自动注入上下文移除连接 IP、网络接口地址，以及标题、审计和重试文本中的地址字面量。
- 真实 hostname 统一小写、去尾部 DNS 点号并去重，同一主机的多个连接被模型视为同一主机实体。

## Windows 发布包

- `Terminal-Agent-Setup-2.0.3.exe`：Windows x64 NSIS 安装包。
- `putty.exe`：提供给 Assess/Access Client 或堡垒机映射的单文件桥接程序。
- `Terminal-Agent-Uninstall-Cleanup-2.0.3.zip`：仅清理遗留卸载条目，不会卸载程序或删除用户数据。
- `Terminal-Agent-Setup-2.0.3.exe.blockmap` 和 `latest.yml`：用于 Electron 自动更新。

## 验证建议

安装后在 900×700 窗口中收起历史任务区、保持 AI 工作区展开并切换 Shell 双行布局；确认每个终端的底部输入行可见。随后在终端内右键粘贴，直接键入命令验证焦点恢复。最后在 AI 工作区检查上下文中使用真实 hostname 且不显示堡垒机连接 IP。
