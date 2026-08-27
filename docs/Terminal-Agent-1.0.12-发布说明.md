# Terminal-Agent 1.0.12 发布说明

## 发布内容

本版本包含 AI 工作区图文对话、Shell 整组计划预览与审批、整组顺序执行、执行审计消息，以及 Assess/Access Client 堡垒机跳转兼容能力。

Windows 发布包应包含以下文件：

- `Terminal-Agent-Setup-1.0.12.exe`：Windows x64 安装包。
- `putty.exe`：提供给 Assess/Access Client 或堡垒机映射的单文件桥接程序。
- `Terminal-Agent-Uninstall-Cleanup-1.0.12.zip`：仅清理“已安装的应用”中的旧卸载条目，不会卸载程序或删除用户数据。
- `Terminal-Agent-Setup-1.0.12.exe.blockmap` 和 `latest.yml`：用于 Electron 自动更新。

## 安装 Terminal-Agent

1. 在 Windows x64 计算机上运行 `Terminal-Agent-Setup-1.0.12.exe`。
2. 按安装向导选择安装目录并完成安装。安装程序需要写入当前用户的 Terminal-Agent 运行时登记信息，便于桥接程序定位运行时。
3. 安装完成后手动启动一次 Terminal-Agent，确认主窗口能够打开，然后再配置堡垒机客户端。
4. 若此前安装过旧版本，直接运行新安装包即可覆盖升级；不要把新旧版本的 `resources` 或运行时目录混合复制。

## 替换 Assess/Access Client 中的 putty.exe

`putty.exe` 是 Terminal-Agent 的桥接入口，不是完整 PuTTY 客户端。替换时只需要替换映射目录中的这一个文件：

1. 关闭 Assess/Access Client 当前打开的堡垒机终端。
2. 备份旧的 `putty.exe`，然后将发布包中的 `putty.exe` 复制到 Assess/Access Client 配置的 PuTTY 可执行文件目录。
3. 在客户端设置中确认 PuTTY 可执行文件路径仍指向刚替换的文件。
4. 不要将 `Terminal-Agent-runtime.exe`、`resources`、整个 `win-unpacked` 目录或安装目录复制到映射目录；桥接程序会从当前用户登记的安装路径寻找运行时。
5. 如果映射目录不可写，桥接日志会回退写入 `%LOCALAPPDATA%\\Terminal-Agent\\putty-bridge.log`。

每次升级 Terminal-Agent 时，建议同时更新已映射的 `putty.exe`。旧桥接程序可能使用旧的暖启动参数顺序，导致 Terminal-Agent 已经运行时堡垒机跳转失败。

## 堡垒机实际跳转

### SSH 临时配置跳转

Assess/Access Client 通常以如下形式调用桥接程序：

```text
putty.exe -load "tmp:C:\\path\\to\\session.conf" [-pw "临时密码"]
```

桥接程序会读取临时配置，将连接请求转交给已经安装的 Terminal-Agent。临时配置、临时密码和一次性堡垒机凭据只用于本次连接，不会写入“已保存会话”。连接建立后，终端会出现在现有工作区九宫格中。

### Raw 或本地端口跳转

需要 Raw 传输时，客户端可以使用：

```text
putty.exe -raw -P <本地端口>
```

工作台会将堡垒机配置中的标题作为会话名称，不会把本地跳板地址误显示为最终目标主机名。

### 验证跳转是否成功

1. 确认 Terminal-Agent 已安装并至少启动过一次。
2. 从堡垒机客户端发起一次测试连接。
3. 确认 Terminal-Agent 已打开或复用同一个工作区，并出现新的临时终端。
4. 确认该临时连接没有出现在“已保存会话”列表中。
5. 如连接失败，查看 `putty.exe` 同级目录的 `putty-bridge.log`；日志会记录运行时查找、参数分类、进程启动和安全失败类别，不会记录密码、令牌、私钥或临时配置文件路径。

## AI 工作区使用边界

AI 可以根据文字和图片上下文生成候选命令或 Shell 整组计划。执行前应检查目标主机、命令顺序、参数和影响范围，并在计划审批面板中逐项确认。整组执行会按计划顺序执行，任何失败都会停止后续步骤并生成执行审计消息。

生产环境建议保持辅助驾驶模式，继续遵守堡垒机授权、变更单、双人复核和回滚流程。不要把密码、令牌、私钥或其他敏感凭据直接放入聊天图片、提示词或计划描述中。

## 升级与回滚

- 升级前保留旧版安装包和旧版 `putty.exe` 备份。
- 若堡垒机跳转异常，先恢复旧 `putty.exe` 验证是否为桥接版本问题，再检查 `putty-bridge.log`。
- 回滚应用版本时，应将安装运行时和 Assess/Access Client 映射的桥接程序一起回滚，避免两者参数协议不一致。

