#requires -Version 5.1
<##
.SYNOPSIS
Backs up and removes Windows uninstall registry entries whose DisplayName contains Terminal-Agent.

.DESCRIPTION
Checks the standard current-user and local-machine uninstall locations in both
64-bit and 32-bit registry views. Normal execution requires an explicit Y
confirmation, then backs up every matching entry before deleting it. Use -WhatIf
for a read-only preview.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'None')]
param(
    [switch]$NoPause
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Complete-Run {
    param(
        [Parameter(Mandatory)]
        [int]$ExitCode
    )

    if (-not $NoPause -and $Host.Name -eq 'ConsoleHost') {
        Write-Host ''
        [void](Read-Host '按 Enter 关闭此窗口')
    }

    exit $ExitCode
}

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not $WhatIfPreference -and -not (Test-IsAdministrator)) {
    Write-Host '此工具需要管理员权限，正在请求 Windows 授权...' -ForegroundColor Cyan
    $elevatedArguments = '-NoProfile -ExecutionPolicy Bypass -File "{0}"{1}' -f $PSCommandPath, ($(if ($NoPause) { ' -NoPause' } else { '' }))
    try {
        $elevatedProcess = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -Verb RunAs -ArgumentList $elevatedArguments -Wait -PassThru
        exit $elevatedProcess.ExitCode
    }
    catch {
        Write-Warning '未获得管理员权限，未修改任何注册表项。'
        Complete-Run -ExitCode 2
    }
}

$targetText = 'Terminal-Agent'
$uninstallSubPath = 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'
$backupRoot = $null
$hadFailure = $false
$counts = [ordered]@{
    Matched  = 0
    Removed  = 0
    Previewed = 0
    Failed   = 0
}

$registryTargets = @(
    [pscustomobject]@{
        Hive = [Microsoft.Win32.RegistryHive]::CurrentUser
        Prefix = 'HKEY_CURRENT_USER'
    }
    [pscustomobject]@{
        Hive = [Microsoft.Win32.RegistryHive]::LocalMachine
        Prefix = 'HKEY_LOCAL_MACHINE'
    }
)

$registryViews = if ([Environment]::Is64BitOperatingSystem) {
    @(
        [pscustomobject]@{
            Value = [Microsoft.Win32.RegistryView]::Registry64
            Label = '64-bit'
        }
        [pscustomobject]@{
            Value = [Microsoft.Win32.RegistryView]::Registry32
            Label = '32-bit'
        }
    )
}
else {
    @(
        [pscustomobject]@{
            Value = [Microsoft.Win32.RegistryView]::Registry32
            Label = '32-bit'
        }
    )
}

$matches = New-Object System.Collections.Generic.List[object]
$seenEntries = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)

function Get-RegistryExportTool {
    param(
        [Parameter(Mandatory)]
        [Microsoft.Win32.RegistryView]$View
    )

    if ($View -eq [Microsoft.Win32.RegistryView]::Registry64) {
        if (-not [Environment]::Is64BitOperatingSystem) {
            throw '32 位 Windows 不存在 64 位注册表视图。'
        }

        if (-not [Environment]::Is64BitProcess) {
            # Sysnative bypasses Windows file-system redirection from a 32-bit host process.
            return Join-Path $env:WINDIR 'Sysnative\reg.exe'
        }

        return Join-Path $env:WINDIR 'System32\reg.exe'
    }

    if ([Environment]::Is64BitOperatingSystem) {
        return Join-Path $env:WINDIR 'SysWOW64\reg.exe'
    }

    return Join-Path $env:WINDIR 'System32\reg.exe'
}

function Get-BackupFileName {
    param(
        [Parameter(Mandatory)]
        [pscustomobject]$Match
    )

    $safeName = ($Match.SubKeyName -replace '[\\/:*?"<>|]', '_')
    if ($safeName.Length -gt 80) {
        $safeName = $safeName.Substring(0, 80)
    }

    $hashInput = '{0}|{1}|{2}' -f $Match.Prefix, $Match.ViewLabel, $Match.NativeRegistryPath
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hashBytes = $hasher.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($hashInput))
        $hash = ([System.BitConverter]::ToString($hashBytes)).Replace('-', '').Substring(0, 16).ToLowerInvariant()
    }
    finally {
        $hasher.Dispose()
    }

    return '{0}-{1}-{2}-{3}.reg' -f $Match.Prefix, $Match.ViewLabel, $safeName, $hash
}

foreach ($registryTarget in $registryTargets) {
    foreach ($registryView in $registryViews) {
        $baseKey = $null
        $uninstallKey = $null

        try {
            $baseKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey($registryTarget.Hive, $registryView.Value)
            $uninstallKey = $baseKey.OpenSubKey($uninstallSubPath, $false)
            if ($null -eq $uninstallKey) {
                continue
            }

            foreach ($subKeyName in $uninstallKey.GetSubKeyNames()) {
                $subKey = $null
                $nativeRegistryPath = '{0}\{1}\{2}' -f $registryTarget.Prefix, $uninstallSubPath, $subKeyName
                try {
                    $subKey = $uninstallKey.OpenSubKey($subKeyName, $false)
                    if ($null -eq $subKey) {
                        continue
                    }

                    $displayName = $subKey.GetValue(
                        'DisplayName',
                        $null,
                        [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
                    )

                    if ($null -eq $displayName) {
                        continue
                    }

                    $displayNameText = [string]$displayName
                    if ($displayNameText.IndexOf($targetText, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
                        continue
                    }

                    # HKCU can expose the same physical uninstall key through both registry views.
                    # HKLM views remain distinct because they may hold separate 32-bit and 64-bit entries.
                    $entryIdentity = if ($registryTarget.Hive -eq [Microsoft.Win32.RegistryHive]::CurrentUser) {
                        '{0}|{1}' -f $registryTarget.Hive, $nativeRegistryPath
                    }
                    else {
                        '{0}|{1}|{2}' -f $registryTarget.Hive, $registryView.Label, $nativeRegistryPath
                    }
                    if (-not $seenEntries.Add($entryIdentity)) {
                        continue
                    }

                    $matches.Add([pscustomobject]@{
                        Hive = $registryTarget.Hive
                        Prefix = $registryTarget.Prefix
                        View = $registryView.Value
                        ViewLabel = $registryView.Label
                        SubKeyName = $subKeyName
                        DisplayName = $displayNameText
                        NativeRegistryPath = $nativeRegistryPath
                    })
                }
                catch {
                    $hadFailure = $true
                    $counts.Failed++
                    Write-Warning ("无法读取卸载注册表项 {0}：{1}" -f $nativeRegistryPath, $_.Exception.Message)
                }
                finally {
                    if ($null -ne $subKey) {
                        $subKey.Dispose()
                    }
                }
            }
        }
        catch {
            $hadFailure = $true
            $counts.Failed++
            Write-Warning ("无法读取 {0} 注册表视图中的卸载项：{1}" -f $registryView.Label, $_.Exception.Message)
        }
        finally {
            if ($null -ne $uninstallKey) {
                $uninstallKey.Dispose()
            }
            if ($null -ne $baseKey) {
                $baseKey.Dispose()
            }
        }
    }
}

if ($matches.Count -eq 0) {
    Write-Host "未找到 DisplayName 包含 '$targetText' 的标准卸载注册表项。" -ForegroundColor Yellow
    Complete-Run -ExitCode 0
}

Write-Host "找到 $($matches.Count) 个匹配的卸载注册表项：" -ForegroundColor Cyan
foreach ($match in $matches) {
    Write-Host ("  [{0}] {1}" -f $match.ViewLabel, $match.DisplayName)
    Write-Host ("           {0}" -f $match.NativeRegistryPath)
}

if (-not $WhatIfPreference) {
    Write-Host ''
    Write-Warning '此操作只会删除 Windows 已安装应用中的卸载入口，不会卸载程序或删除配置。'
    Write-Warning '所有列出的 Terminal-Agent 卸载入口都会被删除，包括当前有效安装的入口。'
    $confirmation = Read-Host '输入 Y 并按 Enter 继续，其他任意输入都会取消'
    if ($confirmation -cne 'Y') {
        Write-Host '已取消，未修改任何注册表项。' -ForegroundColor Yellow
        Complete-Run -ExitCode 2
    }
}

foreach ($match in $matches) {
    $counts.Matched++

    # The built-in reg.exe export command creates a recoverable backup before deletion.
    if (-not $PSCmdlet.ShouldProcess(
        $match.NativeRegistryPath,
        "备份并删除匹配的卸载注册表项（$($match.DisplayName)）"
    )) {
        $counts.Previewed++
        continue
    }

    try {
        if ($null -eq $backupRoot) {
            $backupRoot = Join-Path $PSScriptRoot (
                'Terminal-Agent-registry-backup-{0}-{1}' -f (Get-Date -Format 'yyyyMMdd-HHmmssfff'), [guid]::NewGuid().ToString('N').Substring(0, 8)
            )
            New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
        }

        $backupFile = Join-Path $backupRoot (Get-BackupFileName -Match $match)
        if (Test-Path -LiteralPath $backupFile) {
            throw "备份文件已存在；为保护原备份，已保留注册表项：$backupFile"
        }

        $regExe = Get-RegistryExportTool -View $match.View

        if (-not (Test-Path -LiteralPath $regExe -PathType Leaf)) {
            throw "找不到用于备份 $($match.ViewLabel) 注册表视图的 reg.exe：$regExe"
        }

        & $regExe export $match.NativeRegistryPath $backupFile /y | Out-Null
        $backupItem = Get-Item -LiteralPath $backupFile -ErrorAction SilentlyContinue
        if ($LASTEXITCODE -ne 0 -or $null -eq $backupItem -or -not ($backupItem.Length -gt 0)) {
            throw "注册表备份未创建；已保留原项：$($match.NativeRegistryPath)"
        }

        $writeBaseKey = $null
        $writeUninstallKey = $null
        try {
            $writeBaseKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey($match.Hive, $match.View)
            $writeUninstallKey = $writeBaseKey.OpenSubKey($uninstallSubPath, $true)
            if ($null -eq $writeUninstallKey) {
                throw "无法以写入方式打开卸载注册表路径：$($match.NativeRegistryPath)"
            }

            $writeUninstallKey.DeleteSubKeyTree($match.SubKeyName, $false)
        }
        finally {
            if ($null -ne $writeUninstallKey) {
                $writeUninstallKey.Dispose()
            }
            if ($null -ne $writeBaseKey) {
                $writeBaseKey.Dispose()
            }
        }

        $counts.Removed++
        Write-Host ("已删除：{0}" -f $match.NativeRegistryPath) -ForegroundColor Green
    }
    catch {
        $hadFailure = $true
        $counts.Failed++
        Write-Warning ("未能删除 {0}：{1}" -f $match.NativeRegistryPath, $_.Exception.Message)
    }
}

Write-Host ''
Write-Host ("完成。匹配：{0}；已删除：{1}；预演：{2}；失败：{3}" -f `
    $counts.Matched, $counts.Removed, $counts.Previewed, $counts.Failed)

if ($null -ne $backupRoot) {
    Write-Host ("注册表备份位置：{0}" -f $backupRoot) -ForegroundColor Cyan
}

if ($hadFailure) {
    Write-Warning '部分项目未能处理。若失败项位于 HKEY_LOCAL_MACHINE，请以管理员身份运行 PowerShell 后重试。'
    Complete-Run -ExitCode 1
}

Complete-Run -ExitCode 0
