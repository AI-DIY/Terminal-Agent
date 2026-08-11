# 堡垒机暖启动参数错位修复设计

## 背景

从 AccessClient 映射的 `putty.exe` 启动 Terminal-Agent 时，若 Terminal-Agent 尚未运行，临时 SSH 会话可以进入；若 Terminal-Agent 已经打开，Electron 的第二实例参数回调会把桥接私有元数据的值错位。现场日志因此把 `--terminal-agent-bridge-id` 当成日志路径，把 `--allow-file-access-from-files` 当成 `launchId`，最终读取不到临时会话配置并显示 `temporary-profile-invalid`。

现场保留下来的真实临时配置证明还有一个独立的兼容性问题：AccessClient 写入 `HostName`、`PortNumber`、`UserName`、终端尺寸、`LineCodePage` 和 `mode=direct`，但不写 `Protocol`。`-load tmp:...` 在 PuTTY/AccessClient 中本身表示 SSH 临时会话，当前读取器却把缺少 `Protocol=ssh` 的配置误判为无效。

## 目标与非目标

目标：

1. 让首次启动和已有窗口的第二实例启动都保留桥接日志路径、跳转标识和原始 AccessClient 参数。
2. 错位或缺失的私有元数据不得被当作文件路径，避免在运行时目录创建名为选项的错误日志文件。
3. 兼容 AccessClient 实际生成的无 `Protocol` SSH 临时配置，同时继续拒绝明确写入的未知协议。
4. 用自动化测试覆盖真实的暖启动路径，并重新生成可部署的 Windows 产物。

非目标：

- 不改变 AccessClient 支持的 `@saved-session`、`-load` 或 `-raw -P` 业务语义。
- 不把密码、临时配置路径或私钥材料写入诊断日志。
- 不引入 IPC 服务或注册表协议来替代现有便携式桥接器。

## 设计

### 参数边界

Windows 原生桥接器把 Terminal-Agent 私有参数和 AccessClient 原始参数整体放到 Electron 命令行的 `--` 分隔符之后：

```text
Terminal-Agent-runtime.exe -- --terminal-agent-bridge-log <log-path> --terminal-agent-bridge-id <launch-id> <access-client-args>
```

Electron/Chromium 不会把分隔符后的值当作自身开关解析；首次启动的 `process.argv` 与已有窗口的 `second-instance` `argv` 都能保留同一组数据。现有 `tryOpenFromArgv` 会在任意位置寻找 AccessClient 调用起点，因此无需改变业务参数解析。

### 元数据防御性校验

运行时提取桥接元数据时，要求每个选项后都有非空、且不是以 `-` 开头的值。桥接器生成的 Windows 日志路径是盘符或 UNC 路径，跳转标识是数字和短横线组合，因此选项形状的值一定表示 Electron 参数错位。无效元数据按“没有诊断上下文”处理，不创建伪造路径。

### AccessClient 临时配置兼容

临时配置读取器继续优先使用显式 `Protocol`。当该字段缺失或只包含空白时，按 `-load tmp:...` 的既有调用语义默认使用 SSH；显式 `Protocol=raw` 仍走 Raw 兼容路径，显式未知值仍返回 `temporary-profile-invalid`。`mode`、`websid` 和 `NoRemoteWinTitle` 等 AccessClient 附加字段继续忽略，不进入持久配置或日志。

### 诊断与错误处理

正确启动时桥接器日志和运行时日志继续共享同一个 `launchId`，并继续沿用现有密码脱敏。元数据无效时业务错误仍按现有分类显示，但不会把参数名作为日志文件路径展示或写入。

## 测试策略

1. 单元测试：验证分隔符后的元数据提取；验证 `--terminal-agent-bridge-id`、`--allow-file-access-from-files` 等选项形状值被拒绝。
2. 单元测试：用脱敏后的真实 AccessClient 字段形状验证缺少 `Protocol` 时得到 SSH 会话，并验证显式未知协议仍被拒绝。
3. 集成测试：确保有一个 Terminal-Agent 主实例，再通过打包的 `putty.exe` 发起临时 SSH 跳转；等待真实 SSH fixture shell，断言桥接与运行时日志共享 launch ID，并确认没有产生以选项命名的伪造日志文件。测试若发现用户已经打开 Terminal-Agent，复用该主实例且绝不终止它；否则启动并清理测试自己的主实例。
4. 回归验证：相关单元测试、完整单元测试、重新构建后的 Windows 打包集成测试、构建和 lint 必须全部执行并记录退出状态。

## 交付

补丁版本升至 `1.0.2`，更新发布说明，重新生成 `release/win-unpacked/putty.exe` 与 Windows 安装包。只映射新版 `putty.exe` 到 AccessClient；运行时仍由安装包提供。
