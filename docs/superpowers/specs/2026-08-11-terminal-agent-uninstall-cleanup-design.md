# Terminal-Agent Windows 卸载残留清理工具设计

## 目标

把现有 `uninstall-terminal-agent/Clear-Terminal-Agent-UninstallEntries.ps1` 优化为普通 Windows 用户可以通过 Release 下载、完整解压并双击运行的卸载列表清理工具。工具只处理 Windows“已安装的应用”中的 Terminal-Agent 标准卸载注册表项，不卸载程序、不删除安装文件或用户配置，也不删除 `HKCU\Software\Terminal-Agent\InstallPath`。

用户已经确认：在显示完整风险说明并输入 `Y` 后，工具删除所有 `DisplayName` 不区分大小写地包含 `Terminal-Agent` 的标准卸载条目，包括仍可能对应有效安装的条目。

## 发布形态

Terminal-Agent 版本升级到 `1.0.3`，创建新的 `v1.0.3` 标签和 GitHub Release，不覆盖 v1.0.2。Release 包含三个资产：

```text
Terminal-Agent-Setup-1.0.3.exe
putty.exe
Terminal-Agent-Uninstall-Cleanup-1.0.3.zip
```

清理 ZIP 完整解压后包含：

```text
清理 Terminal-Agent 卸载残留.cmd
Clear-Terminal-Agent-UninstallEntries.ps1
使用说明.txt
```

安装包仍是正常安装或升级入口。清理 ZIP 只用于修复 Windows 卸载列表中的残留、重复或用户明确希望全部移除的 Terminal-Agent 卸载条目。

## 用户流程

1. 用户完整解压 `Terminal-Agent-Uninstall-Cleanup-1.0.3.zip`。
2. 用户双击 `清理 Terminal-Agent 卸载残留.cmd`。
3. 启动器从自身目录定位 PowerShell 脚本。若脚本不存在，提示用户完整解压 ZIP 并等待按键，不闪退。
4. 工具说明将修改的内容、不会修改的内容，以及当前有效安装的卸载入口也会被删除。
5. 工具自动申请管理员权限，以访问当前用户和本机范围的卸载注册表项。用户取消 UAC 时不做任何修改并显示取消结果。
6. 工具扫描并列出所有匹配条目的显示名称、注册表范围、32/64 位视图和完整注册表路径。
7. 未找到条目时显示结果并退出，不创建空备份目录。
8. 工具要求用户输入 `Y` 并回车。空输入或任何其他输入均视为取消。
9. 每个条目先导出为独立的 `.reg` 备份，验证备份存在且非空后再删除。
10. 工具显示匹配数、删除数、预览数、失败数和备份目录。成功删除至少一个条目后打开备份目录。
11. CMD 等待用户按键后关闭窗口，保证结果可读。

## 组件边界

### 双击启动器

`uninstall-terminal-agent/清理 Terminal-Agent 卸载残留.cmd` 只负责：

- 使用 `%~dp0` 定位同目录 PowerShell 脚本，不包含开发者机器的绝对路径；
- 检测 ZIP 是否完整解压；
- 以 `-NoProfile` 和当前进程级 `-ExecutionPolicy Bypass` 启动脚本；
- 等待 PowerShell 脚本及其提升后的子进程结束；
- 根据退出码显示适合普通用户的结束状态；
- 始终等待按键，避免窗口一闪而过。

注册表扫描、备份和删除逻辑不放进 CMD，避免批处理转义、编码和维护风险。

### PowerShell 核心

`uninstall-terminal-agent/Clear-Terminal-Agent-UninstallEntries.ps1` 负责：

- 管理员身份检查与自提升；
- 用户说明、风险确认和取消处理；
- 32/64 位注册表扫描与 HKCU 去重；
- `.reg` 备份文件名生成、导出和完整性检查；
- 删除前身份复核、注册表删除和逐项错误隔离；
- `-WhatIf` 预览；
- 汇总、备份目录打开和稳定退出码。

扫描、匹配、备份和删除实现为可独立调用的函数。脚本作为程序运行时使用标准 Windows 卸载路径；测试可以点入这些函数，并把注册表子路径限定到测试拥有的隔离键，而不接触用户真实卸载列表。

### 普通用户说明

`uninstall-terminal-agent/使用说明.txt` 使用中文说明：

- 适用场景；
- 必须完整解压 ZIP；
- 工具会删除所有匹配卸载入口，包括有效安装入口；
- 工具不会卸载或删除 Terminal-Agent 本体；
- 工具不会删除用户配置或 AccessClient 使用的 `InstallPath`；
- `.reg` 备份位置和双击恢复方式；
- 删除有效卸载入口后，如需正常卸载，应重新运行安装包修复安装后再卸载。

## 注册表范围和匹配规则

正式入口只扫描以下标准位置：

```text
HKEY_CURRENT_USER\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall
HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall
```

64 位 Windows 同时检查 `Registry64` 和 `Registry32`；32 位 Windows 只检查 `Registry32`。匹配条件是 `DisplayName` 不区分大小写地包含文本 `Terminal-Agent`。

HKCU 的两个注册表视图可能暴露同一物理条目，按原生注册表路径去重。HKLM 的 32 位和 64 位视图可以代表不同条目，保持独立。

工具不读取或执行 `UninstallString`，不根据安装路径删除任何文件，不遍历或清理其他 Terminal-Agent 注册表位置。

## 备份和删除安全性

备份根目录创建在完整解压后的工具目录下，名称包含毫秒时间戳和短随机标识：

```text
Terminal-Agent-registry-backup-YYYYMMDD-HHMMSSfff-xxxxxxxx
```

每个备份文件名包含注册表范围、位数、清理前子键名称和注册表身份短哈希。文件名会移除 Windows 禁止字符并限制长度，不覆盖已有文件。

每个条目遵循以下顺序：

1. 使用与目标视图一致的 `reg.exe` 导出完整原生注册表路径。
2. 检查命令退出码、备份文件存在且长度大于零。
3. 重新打开目标注册表项，重新读取 `DisplayName`。
4. 只有当前显示名称仍然匹配 `Terminal-Agent` 时才删除整个卸载子键。
5. 任一步骤失败时保留该条目、记录失败并继续处理其他匹配项。

工具提供逐项安全，不承诺多条目的全局事务回滚。已经成功备份并删除的条目不会因为后续条目失败而自动恢复；用户可按说明双击对应 `.reg` 文件恢复。

## 权限、取消和退出码

访问 HKLM 删除需要管理员权限。PowerShell 正式入口检查当前身份，在实际清理模式下通过 `Start-Process -Verb RunAs -Wait` 自提升一次；CMD 等待这个完整过程。提升后的脚本重新扫描，避免使用提权前可能已经过时的结果。`-WhatIf` 只读预览不触发提升。用户取消 UAC 时不修改注册表。

退出码定义如下：

- `0`：清理成功、未找到匹配项或 `-WhatIf` 预览成功；
- `1`：存在读取、备份或删除失败；
- `2`：用户取消确认或取消管理员授权；
- `3`：启动器缺少 PowerShell 脚本或无法启动 PowerShell。

CMD 将这些退出码翻译为普通用户可理解的中文提示，不隐藏 PowerShell 已输出的详细汇总。

## 测试策略

### 源码与启动器单元测试

Vitest 测试检查：

- CMD 使用相对脚本路径且没有开发者机器绝对路径；
- CMD 检测缺失脚本、传递执行策略、等待 PowerShell 完整执行并保留窗口；
- PowerShell 正式入口保持标准卸载路径和固定的 `Terminal-Agent` 匹配文本；
- 脚本明确不删除 `HKCU\Software\Terminal-Agent\InstallPath`；
- `-WhatIf` 不进入备份或删除分支；
- ZIP 打包脚本使用 `package.json` 中的版本生成资产名。

### Windows 注册表集成测试

Windows 专用测试在 `HKCU\Software\Terminal-Agent\Tests\UninstallCleanup\<随机 ID>` 下创建隔离注册表结构，点入 PowerShell 函数并传入测试子路径。测试覆盖：

- 匹配项被发现，非匹配项被保留；
- 用户确认后匹配项先备份再删除；
- `.reg` 文件存在且非空；
- 备份目录不可用时注册表项保持存在；
- `-WhatIf` 只报告预览；
- 测试无论成功或失败都会删除自己创建的注册表键和临时目录。

测试不能读取、导出、删除或重命名用户真实的标准卸载条目。

### ZIP 和发布验证

打包测试解压 `Terminal-Agent-Uninstall-Cleanup-1.0.3.zip` 到包含空格和中文的临时目录，确认三个文件齐全且 CMD 能找到同目录脚本。发布前运行：

```text
npm test
npm run lint
npm run build
npm run make:win
npm run test:integration -- tests/integration/release-launcher.test.ts
```

验证 `Terminal-Agent-Setup-1.0.3.exe`、`release/win-unpacked/putty.exe` 和清理 ZIP 存在，版本元数据为 1.0.3，现有堡垒机发布集成测试保持通过。

## 构建与 Release

增加可重复执行的清理工具打包脚本，从 `uninstall-terminal-agent` 复制明确列出的三个源文件到临时暂存目录，再压缩为：

```text
release/Terminal-Agent-Uninstall-Cleanup-1.0.3.zip
```

打包脚本不使用宽泛通配符，防止将备份目录、编辑器文件或本地测试文件放进 Release。`npm run make:win` 在 Windows 安装包成功构建后生成清理 ZIP。

`RELEASE_NOTES.md` 增加 v1.0.3 说明。GitHub Release 正文使用中文列出用途、风险、操作步骤、恢复方法，以及安装包、`putty.exe` 和清理 ZIP 的 SHA-256。发布流程创建并推送 `v1.0.3` 注释标签，上传三个资产，回读 Release 状态、资产大小和 GitHub 摘要后才报告完成。
