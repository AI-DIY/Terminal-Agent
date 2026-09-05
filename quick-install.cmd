@echo off
setlocal EnableExtensions DisableDelayedExpansion
title Terminal-Agent Quick Install

rem ============================================================================
rem Terminal-Agent quick installer (Windows)
rem
rem The release 快速安装手册.md describes the standalone ZIP flow.  This script automates
rem the four actions that have a stable machine interface:
rem   * read HKCR\accessclient\shell\open\command;
rem   * preserve AccessClient\putty.exe as putty.exe.bak;
rem   * copy the release putty.exe bridge into AccessClient; and
rem   * run Terminal-Agent-Setup-*.exe LAST and wait for completion.
rem
rem The AccessClient setting "全局 putty" is vendor UI state.  It is called out
rem after installation because changing an unknown vendor configuration file
rem would be unsafe.  The script can be placed in the repository root, in the
rem release directory, or beside the three release assets.
rem
rem Local assets are preferred.  If one is missing, the latest GitHub release
rem is downloaded over HTTPS.  Use /NoDownload on machines that must stay offline.
rem ============================================================================

set "TA_ELEVATED_BRIDGE=0"
if /I "%~1"=="--elevated-bridge" set "TA_ELEVATED_BRIDGE=1"
set "TA_NO_ELEVATION=0"
if /I "%QUICK_INSTALL_NO_ELEVATION%"=="1" set "TA_NO_ELEVATION=1"

for %%I in ("%~dp0.") do set "TA_SCRIPT_DIR=%%~fI"
pushd "%TA_SCRIPT_DIR%" >nul 2>&1
if errorlevel 1 (
  echo [错误] 无法进入脚本所在目录。
  exit /b 1
)

set "TA_ALLOW_DOWNLOAD=1"
set "TA_FORCE_DOWNLOAD=0"
set "TA_AUTO_LAUNCH=1"
set "TA_SILENT_INSTALL=0"
set "TA_OPEN_GUIDE=0"
set "TA_NO_PAUSE=0"
set "TA_INSTALLER="
set "TA_BRIDGE="
set "TA_ACCESS_DIR="
set "TA_RELEASE_DIR="
set "TA_REPOSITORY=AI-DIY/Terminal-Agent"
set "TA_INSTALLER_EXPLICIT=0"
set "TA_BRIDGE_EXPLICIT=0"
set "TA_ACCESS_DIR_EXPLICIT=0"
set "TA_INSTALL_STARTED=0"
set "TA_BACKUP_CREATED=0"
set "TA_BACKUP_EXISTS=0"
set "TA_TARGET_PUTTY="
set "TA_BACKUP_PUTTY="
set "TA_TEMP_PUTTY="
set "TA_RUNTIME="
set "TA_ERROR="
set "TA_USAGE_RC=0"
set "TA_DOWNLOAD_DIR="
set "TA_DOWNLOAD_CREATED=0"
set "TA_ENCODE_INPUT="
set "TA_ENCODE_OUTPUT="
set "TA_DECODE_INPUT="
set "TA_DECODE_OUTPUT="

rem The elevated child only backs up and maps putty.exe.  The installer always
rem runs in the original user process so HKCU/LocalAppData stay with that user.
if "%TA_ELEVATED_BRIDGE%"=="1" goto elevated_bridge_start

rem Parse options one at a time so paths containing spaces remain intact.
:parse_arguments
if "%~1"=="" goto arguments_done
if /I "%~1"=="/?" goto usage
if /I "%~1"=="/help" goto usage
if /I "%~1"=="--help" goto usage
if /I "%~1"=="/nodownload" (
  set "TA_ALLOW_DOWNLOAD=0"
  shift
  goto parse_arguments
)
if /I "%~1"=="--no-download" (
  set "TA_ALLOW_DOWNLOAD=0"
  shift
  goto parse_arguments
)
if /I "%~1"=="/download" (
  set "TA_FORCE_DOWNLOAD=1"
  shift
  goto parse_arguments
)
if /I "%~1"=="--download" (
  set "TA_FORCE_DOWNLOAD=1"
  shift
  goto parse_arguments
)
if /I "%~1"=="/nolaunch" (
  set "TA_AUTO_LAUNCH=0"
  shift
  goto parse_arguments
)
if /I "%~1"=="--no-launch" (
  set "TA_AUTO_LAUNCH=0"
  shift
  goto parse_arguments
)
if /I "%~1"=="/silent" (
  set "TA_SILENT_INSTALL=1"
  shift
  goto parse_arguments
)
if /I "%~1"=="--silent" (
  set "TA_SILENT_INSTALL=1"
  shift
  goto parse_arguments
)
if /I "%~1"=="/openguide" (
  set "TA_OPEN_GUIDE=1"
  shift
  goto parse_arguments
)
if /I "%~1"=="--open-guide" (
  set "TA_OPEN_GUIDE=1"
  shift
  goto parse_arguments
)
if /I "%~1"=="/nopause" (
  set "TA_NO_PAUSE=1"
  shift
  goto parse_arguments
)
if /I "%~1"=="--no-pause" (
  set "TA_NO_PAUSE=1"
  shift
  goto parse_arguments
)
if /I "%~1"=="/releasedir" goto parse_release_dir
if /I "%~1"=="--release-dir" goto parse_release_dir
if /I "%~1"=="/installer" goto parse_installer
if /I "%~1"=="--installer" goto parse_installer
if /I "%~1"=="/bridge" goto parse_bridge
if /I "%~1"=="--bridge" goto parse_bridge
if /I "%~1"=="/accessclientdir" goto parse_access_dir
if /I "%~1"=="--access-client-dir" goto parse_access_dir
if /I "%~1"=="/repo" goto parse_repository
if /I "%~1"=="--repo" goto parse_repository

echo [错误] 包含未知参数，请使用 /? 查看帮助。
goto usage_error

:parse_release_dir
if "%~2"=="" (
  echo [错误] /ReleaseDir 需要一个目录参数。
  goto usage_error
)
set "TA_RELEASE_DIR=%~2"
for %%I in ("%TA_RELEASE_DIR%") do set "TA_RELEASE_DIR=%%~fI"
shift
shift
goto parse_arguments

:parse_installer
if "%~2"=="" (
  echo [错误] /Installer 需要一个 .exe 路径。
  goto usage_error
)
set "TA_INSTALLER=%~2"
set "TA_INSTALLER_EXPLICIT=1"
for %%I in ("%TA_INSTALLER%") do set "TA_INSTALLER=%%~fI"
shift
shift
goto parse_arguments

:parse_bridge
if "%~2"=="" (
  echo [错误] /Bridge 需要一个 putty.exe 路径。
  goto usage_error
)
set "TA_BRIDGE=%~2"
set "TA_BRIDGE_EXPLICIT=1"
for %%I in ("%TA_BRIDGE%") do set "TA_BRIDGE=%%~fI"
shift
shift
goto parse_arguments

:parse_access_dir
if "%~2"=="" (
  echo [错误] /AccessClientDir 需要一个目录路径。
  goto usage_error
)
set "TA_ACCESS_DIR=%~2"
set "TA_ACCESS_DIR_EXPLICIT=1"
for %%I in ("%TA_ACCESS_DIR%") do set "TA_ACCESS_DIR=%%~fI"
shift
shift
goto parse_arguments

:parse_repository
if "%~2"=="" (
  echo [错误] /Repo 需要 owner/repository 参数。
  goto usage_error
)
set "TA_REPOSITORY=%~2"
shift
shift
goto parse_arguments

:arguments_done

if "%TA_FORCE_DOWNLOAD%"=="1" if "%TA_ALLOW_DOWNLOAD%"=="0" (
  echo [错误] /Download 与 /NoDownload 不能同时使用。
  goto usage_error
)

rem A script at the repository root uses .\release; a copied release script
rem uses its own directory.  /ReleaseDir always wins.
if not defined TA_RELEASE_DIR if exist "%TA_SCRIPT_DIR%\release\*" for %%I in ("%TA_SCRIPT_DIR%\release") do set "TA_RELEASE_DIR=%%~fI"
if not defined TA_RELEASE_DIR set "TA_RELEASE_DIR=%TA_SCRIPT_DIR%"
set "TA_REQUIRED_PATH=%TA_RELEASE_DIR%"
set "TA_REQUIRED_LABEL=Release"
call :require_directory
if errorlevel 1 goto failed

if exist "%TA_RELEASE_DIR%\快速安装手册.md" (
  echo [信息] 已找到 快速安装手册.md，将自动执行其中的文件/注册表步骤。
) else (
  echo [提示] 未找到 快速安装手册.md；继续执行同等的自动化流程。
)

rem Resolve and validate every release asset before touching AccessClient.
if "%TA_FORCE_DOWNLOAD%"=="1" (
  if "%TA_BRIDGE_EXPLICIT%"=="0" set "TA_BRIDGE="
  if "%TA_INSTALLER_EXPLICIT%"=="0" set "TA_INSTALLER="
)
if "%TA_FORCE_DOWNLOAD%"=="0" if not defined TA_BRIDGE call :find_local_bridge
if "%TA_FORCE_DOWNLOAD%"=="0" if not defined TA_INSTALLER call :find_local_installer
if not defined TA_BRIDGE if "%TA_ALLOW_DOWNLOAD%"=="1" call :download_bridge
if not defined TA_INSTALLER if "%TA_ALLOW_DOWNLOAD%"=="1" call :download_installer

if not defined TA_BRIDGE (
  set "TA_ERROR=[错误] 找不到 putty.exe 中继程序。请将其放在脚本/release 目录，或联网自动下载。"
  goto failed
)
set "TA_REQUIRED_PATH=%TA_BRIDGE%"
set "TA_REQUIRED_LABEL=putty.exe 中继程序"
call :require_file
if errorlevel 1 goto failed
for %%I in ("%TA_BRIDGE%") do set "TA_BRIDGE=%%~fI"

if not defined TA_INSTALLER (
  set "TA_ERROR=[错误] 找不到 Terminal-Agent-Setup-*.exe。请将安装包放在脚本/release 目录，或联网自动下载。"
  goto failed
)
set "TA_REQUIRED_PATH=%TA_INSTALLER%"
set "TA_REQUIRED_LABEL=Terminal-Agent 安装包"
call :require_file
if errorlevel 1 goto failed
for %%I in ("%TA_INSTALLER%") do set "TA_INSTALLER=%%~fI"

if "%TA_ACCESS_DIR_EXPLICIT%"=="1" goto access_dir_ready
call :find_accessclient_dir
if errorlevel 1 goto failed

:access_dir_ready
set "TA_REQUIRED_PATH=%TA_ACCESS_DIR%"
set "TA_REQUIRED_LABEL=AccessClient"
call :require_directory
if errorlevel 1 goto failed
set "TA_TARGET_PUTTY=%TA_ACCESS_DIR%\putty.exe"
set "TA_BACKUP_PUTTY=%TA_ACCESS_DIR%\putty.exe.bak"
set "TA_TEMP_PUTTY=%TA_ACCESS_DIR%\putty.exe.quick-install.tmp"

echo [步骤 1/3] 已定位 AccessClient 目录。
echo [步骤 2/3] 备份并复制 putty.exe 中继程序...
call :backup_and_copy_bridge
if errorlevel 1 goto failed

rem Do not move this block above the bridge operation: the installer is
rem intentionally the final automated step requested by the user.
echo.
echo [步骤 3/3] 现在启动 Terminal-Agent 安装包（最后一步）。
echo         安装向导完成后即可使用已映射的 AccessClient 桥接程序。
set "TA_INSTALL_STARTED=1"
if "%TA_SILENT_INSTALL%"=="1" (
  start "" /wait "%TA_INSTALLER%" /S
) else (
  start "" /wait "%TA_INSTALLER%"
)
set "TA_INSTALL_RC=%ERRORLEVEL%"
if not "%TA_INSTALL_RC%"=="0" if not "%TA_INSTALL_RC%"=="3010" (
  set "TA_ERROR=[错误] 安装程序退出码为 %TA_INSTALL_RC%；已保留 putty.exe.bak。"
  goto failed
)

call :locate_runtime
if errorlevel 1 goto failed
if "%TA_AUTO_LAUNCH%"=="1" call :launch_runtime

echo.
echo [完成] Terminal-Agent 已安装，putty.exe 中继程序已映射到 AccessClient。
echo.
echo 还需在 AccessClient 堡垒机界面手动完成快速安装手册中的配置步骤：
echo   在“会话配置”中选择“全局 putty”，然后按原流程唤起 SSH。
echo   这是厂商 UI 设置，脚本不会修改未知的 AccessClient 配置文件。
echo.
call :print_backup_path
if "%TA_OPEN_GUIDE%"=="1" if exist "%TA_RELEASE_DIR%\快速安装手册.md" start "" "%TA_RELEASE_DIR%\快速安装手册.md"
if "%TA_NO_PAUSE%"=="0" pause
call :cleanup_download
popd >nul 2>&1
exit /b 0

:find_local_bridge
if exist "%TA_RELEASE_DIR%\putty.exe" set "TA_BRIDGE=%TA_RELEASE_DIR%\putty.exe"
if not defined TA_BRIDGE if exist "%TA_RELEASE_DIR%\win-unpacked\putty.exe" set "TA_BRIDGE=%TA_RELEASE_DIR%\win-unpacked\putty.exe"
if not defined TA_BRIDGE if exist "%TA_SCRIPT_DIR%\putty.exe" set "TA_BRIDGE=%TA_SCRIPT_DIR%\putty.exe"
if not defined TA_BRIDGE if exist "%TA_SCRIPT_DIR%\build\launcher\putty.exe" set "TA_BRIDGE=%TA_SCRIPT_DIR%\build\launcher\putty.exe"
if defined TA_BRIDGE for %%I in ("%TA_BRIDGE%") do set "TA_BRIDGE=%%~fI"
exit /b 0

:find_local_installer
rem latest.yml is produced with the matching bridge by the Windows release
rem finalizer, so prefer its installer before considering stale files left in
rem a shared release directory.  Fall back to the highest numeric version for
rem an unpacked/development directory that does not have update metadata.
set "TA_SEARCH_DIR=%TA_RELEASE_DIR%"
call :select_latest_yml_installer
if defined TA_INSTALLER exit /b 0
call :select_local_installer
if defined TA_INSTALLER exit /b 0
set "TA_SEARCH_DIR=%TA_SCRIPT_DIR%"
call :select_latest_yml_installer
if defined TA_INSTALLER exit /b 0
call :select_local_installer
exit /b 0

:select_latest_yml_installer
set "TA_LATEST_INSTALLER_NAME="
set "TA_LATEST_YML=%TA_SEARCH_DIR%\latest.yml"
if not exist "%TA_LATEST_YML%" exit /b 0
rem Only accept a conventional release filename.  The candidate is joined to
rem TA_SEARCH_DIR, so metadata cannot redirect execution outside that folder.
for /f "delims=" %%F in ('powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$p=Join-Path $env:TA_SEARCH_DIR 'latest.yml'; if(Test-Path -LiteralPath $p){foreach($line in [IO.File]::ReadAllLines($p)){if($line -match '^path:\s*(Terminal-Agent-Setup-[0-9A-Za-z._-]+\.exe)\s*$'){[Console]::Write($Matches[1]); break}}}"') do if not defined TA_LATEST_INSTALLER_NAME set "TA_LATEST_INSTALLER_NAME=%%F"
if not defined TA_LATEST_INSTALLER_NAME exit /b 0
set "TA_LATEST_INSTALLER=%TA_SEARCH_DIR%\%TA_LATEST_INSTALLER_NAME%"
if exist "%TA_LATEST_INSTALLER%" set "TA_INSTALLER=%TA_LATEST_INSTALLER%"
if defined TA_INSTALLER for %%I in ("%TA_INSTALLER%") do set "TA_INSTALLER=%%~fI"
exit /b 0

:select_local_installer
rem The PowerShell helper prints only the ASCII filename, so a Unicode
rem directory name never crosses the CMD pipe.
for /f "delims=" %%F in ('powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$d=$env:TA_SEARCH_DIR; Get-ChildItem -LiteralPath $d -Filter 'Terminal-Agent-Setup-*.exe' -File -ErrorAction SilentlyContinue | ForEach-Object { $n=$_.BaseName; if($n -match '^Terminal-Agent-Setup-(\d+(?:\.\d+){2,3})(.*)$'){ try { [pscustomobject]@{Name=$_.Name; Version=[version]$Matches[1]; Stable=[string]::IsNullOrEmpty($Matches[2])} } catch {} } } | Sort-Object @{Expression='Version';Descending=$true},@{Expression='Stable';Descending=$true},Name | Select-Object -First 1 -ExpandProperty Name"') do if not defined TA_INSTALLER set "TA_INSTALLER=%TA_SEARCH_DIR%\%%F"
rem Keep a fallback for a locally renamed fixture or a non-semver package.
if not defined TA_INSTALLER for /f "delims=" %%F in ('dir /b /a:-d /o:-n "%TA_SEARCH_DIR%\Terminal-Agent-Setup-*.exe" 2^>nul') do if not defined TA_INSTALLER set "TA_INSTALLER=%TA_SEARCH_DIR%\%%F"
if defined TA_INSTALLER for %%I in ("%TA_INSTALLER%") do set "TA_INSTALLER=%%~fI"
exit /b 0

:download_bridge
call :ensure_download_dir
if errorlevel 1 exit /b 1
set "TA_DOWNLOAD_URL=https://github.com/%TA_REPOSITORY%/releases/latest/download/putty.exe"
set "TA_DOWNLOAD_OUT=%TA_DOWNLOAD_DIR%\putty.exe"
echo [信息] 本地未找到 putty.exe，正在从 GitHub 下载...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing -Headers @{'User-Agent'='Terminal-Agent-Quick-Install'} -Uri $env:TA_DOWNLOAD_URL -OutFile $env:TA_DOWNLOAD_OUT; if((Get-Item -LiteralPath $env:TA_DOWNLOAD_OUT).Length -le 0){throw 'Downloaded bridge is empty'}"
if errorlevel 1 (
  set "TA_ERROR=[错误] putty.exe 下载失败，请检查网络，或使用 /NoDownload 配合本地文件。"
  exit /b 1
)
set "TA_BRIDGE=%TA_DOWNLOAD_OUT%"
exit /b 0

:download_installer
call :ensure_download_dir
if errorlevel 1 exit /b 1
set "TA_API_URL=https://api.github.com/repos/%TA_REPOSITORY%/releases/latest"
set "TA_DOWNLOAD_OUT=%TA_DOWNLOAD_DIR%\Terminal-Agent-Setup-latest.exe"
echo [信息] 本地未找到安装包，正在查询 GitHub 最新 Release...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; $headers=@{'User-Agent'='Terminal-Agent-Quick-Install'}; $r=Invoke-RestMethod -UseBasicParsing -Headers $headers -Uri $env:TA_API_URL; $a=@($r.assets | Where-Object { $_.name -like 'Terminal-Agent-Setup-*.exe' } | Select-Object -First 1); if($a.Count -eq 0){throw 'Terminal-Agent installer asset was not found'}; Invoke-WebRequest -UseBasicParsing -Headers $headers -Uri $a[0].browser_download_url -OutFile $env:TA_DOWNLOAD_OUT; if((Get-Item -LiteralPath $env:TA_DOWNLOAD_OUT).Length -le 0){throw 'Downloaded installer is empty'}"
if errorlevel 1 (
  set "TA_ERROR=[错误] 无法下载 Terminal-Agent 安装包，请手动下载 Terminal-Agent-Setup-*.exe。"
  exit /b 1
)
set "TA_INSTALLER=%TA_DOWNLOAD_OUT%"
exit /b 0

:ensure_download_dir
if "%TA_DOWNLOAD_CREATED%"=="1" if defined TA_DOWNLOAD_DIR if exist "%TA_DOWNLOAD_DIR%\*" exit /b 0
set "TA_DOWNLOAD_DIR=%TEMP%\Terminal-Agent-QuickInstall-%RANDOM%%RANDOM%"
if not defined TEMP set "TA_DOWNLOAD_DIR=%SystemRoot%\Temp\Terminal-Agent-QuickInstall-%RANDOM%%RANDOM%"
md "%TA_DOWNLOAD_DIR%" >nul 2>&1
if not exist "%TA_DOWNLOAD_DIR%\*" (
  set "TA_ERROR=[错误] 无法创建临时下载目录：%TA_DOWNLOAD_DIR%"
  exit /b 1
)
set "TA_DOWNLOAD_CREATED=1"
exit /b 0

:cleanup_download
if "%TA_DOWNLOAD_CREATED%"=="1" if defined TA_DOWNLOAD_DIR if exist "%TA_DOWNLOAD_DIR%\*" rd /s /q "%TA_DOWNLOAD_DIR%" >nul 2>&1
exit /b 0

:find_accessclient_dir
set "TA_ACCESS_EXE="
rem This is the exact query printed in 快速安装手册.md.
reg query "HKCR\accessclient\shell\open\command" /ve >nul 2>&1
if errorlevel 1 (
  set "TA_ERROR=[错误] 未找到 HKCR\accessclient 注册信息。请先安装 AccessClient，或使用 /AccessClientDir 指定目录。"
  exit /b 1
)

rem PowerShell handles quoted paths with spaces, unquoted paths with arguments,
rem and environment-variable expansion.  UTF-8 console output is enabled for
rem non-ASCII paths.
for /f "tokens=2 delims=:" %%C in ('chcp') do set "TA_OLD_CODEPAGE=%%C"
chcp 65001 >nul 2>&1
for /f "delims=" %%P in ('powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $v=(Get-ItemProperty -LiteralPath 'Registry::HKEY_CLASSES_ROOT\accessclient\shell\open\command' -Name '(default)').'(default)'; $v=[Environment]::ExpandEnvironmentVariables([string]$v); $t=$v.Trim(); if($t.StartsWith([char]34)){ $e=$t.IndexOf([char]34,1); if($e -le 1){throw 'Invalid quoted AccessClient command'}; $t.Substring(1,$e-1) } else { ($t -split '\s+',2)[0] }"') do if not defined TA_ACCESS_EXE set "TA_ACCESS_EXE=%%P"
if defined TA_OLD_CODEPAGE chcp %TA_OLD_CODEPAGE% >nul 2>&1

if not defined TA_ACCESS_EXE (
  set "TA_ERROR=[错误] 无法解析 AccessClient 注册命令。请使用 /AccessClientDir 指定目录。"
  exit /b 1
)
if not exist "%TA_ACCESS_EXE%" (
  set "TA_ERROR=[错误] 注册表指向的 AccessClient 程序不存在：%TA_ACCESS_EXE%"
  exit /b 1
)
for %%I in ("%TA_ACCESS_EXE%") do set "TA_ACCESS_DIR=%%~dpI"
if "%TA_ACCESS_DIR:~-1%"=="\" set "TA_ACCESS_DIR=%TA_ACCESS_DIR:~0,-1%"
exit /b 0

:elevated_bridge_start
rem This mode is invoked only by the original process after it has located the
rem AccessClient directory.  Its four arguments are UTF-16 Base64 paths, so
rem the UAC command line never has to carry an unescaped user path.
if "%5"=="" goto elevated_bridge_invalid
set "TA_DECODE_INPUT=%2"
call :decode_value
if errorlevel 1 goto elevated_bridge_invalid
set "TA_BRIDGE=%TA_DECODE_OUTPUT%"
set "TA_DECODE_INPUT=%3"
call :decode_value
if errorlevel 1 goto elevated_bridge_invalid
set "TA_TARGET_PUTTY=%TA_DECODE_OUTPUT%"
set "TA_DECODE_INPUT=%4"
call :decode_value
if errorlevel 1 goto elevated_bridge_invalid
set "TA_BACKUP_PUTTY=%TA_DECODE_OUTPUT%"
set "TA_DECODE_INPUT=%5"
call :decode_value
if errorlevel 1 goto elevated_bridge_invalid
set "TA_TEMP_PUTTY=%TA_DECODE_OUTPUT%"

call :backup_and_copy_bridge_local
set "TA_ELEVATED_BRIDGE_RC=%ERRORLEVEL%"
if not "%TA_ELEVATED_BRIDGE_RC%"=="0" (
  if "%TA_BACKUP_CREATED%"=="1" call :restore_created_backup
  popd >nul 2>&1
  exit /b %TA_ELEVATED_BRIDGE_RC%
)
if "%TA_BACKUP_CREATED%"=="1" (
  popd >nul 2>&1
  exit /b 10
)
popd >nul 2>&1
exit /b 0

:elevated_bridge_invalid
popd >nul 2>&1
exit /b 1

:encode_bridge_arguments
set "TA_ENCODE_INPUT=%TA_BRIDGE%"
call :encode_value
if errorlevel 1 exit /b 1
set "TA_ELEVATED_BRIDGE_SOURCE=%TA_ENCODE_OUTPUT%"
set "TA_ENCODE_INPUT=%TA_TARGET_PUTTY%"
call :encode_value
if errorlevel 1 exit /b 1
set "TA_ELEVATED_BRIDGE_TARGET=%TA_ENCODE_OUTPUT%"
set "TA_ENCODE_INPUT=%TA_BACKUP_PUTTY%"
call :encode_value
if errorlevel 1 exit /b 1
set "TA_ELEVATED_BRIDGE_BACKUP=%TA_ENCODE_OUTPUT%"
set "TA_ENCODE_INPUT=%TA_TEMP_PUTTY%"
call :encode_value
if errorlevel 1 exit /b 1
set "TA_ELEVATED_BRIDGE_TEMP=%TA_ENCODE_OUTPUT%"
exit /b 0

:encode_value
set "TA_ENCODE_OUTPUT="
for /f "delims=" %%P in ('powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $v=[string]$env:TA_ENCODE_INPUT; if([string]::IsNullOrEmpty($v)){throw 'Value is empty'}; [Console]::Write(([Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($v))).TrimEnd('='))"') do if not defined TA_ENCODE_OUTPUT set "TA_ENCODE_OUTPUT=%%P"
if not defined TA_ENCODE_OUTPUT exit /b 1
exit /b 0

:decode_value
set "TA_DECODE_OUTPUT="
set "TA_DECODE_CODEPAGE="
for /f "tokens=2 delims=:" %%C in ('chcp') do set "TA_DECODE_CODEPAGE=%%C"
chcp 65001 >nul 2>&1
for /f "delims=" %%P in ('powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $e=$env:TA_DECODE_INPUT; switch($e.Length %% 4){0{}2{$e+='=='}3{$e+='='}default{throw 'Invalid Base64 value'}}; $v=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($e)); if([string]::IsNullOrEmpty($v)){throw 'Value is empty'}; [Console]::Write($v)"') do if not defined TA_DECODE_OUTPUT set "TA_DECODE_OUTPUT=%%P"
if defined TA_DECODE_CODEPAGE chcp %TA_DECODE_CODEPAGE% >nul 2>&1
if not defined TA_DECODE_OUTPUT exit /b 1
exit /b 0

:backup_and_copy_bridge
if /I "%TA_BRIDGE%"=="%TA_TARGET_PUTTY%" (
  set "TA_ERROR=[错误] 中继程序源文件不能是 AccessClient 目标文件。请指定 Release 中的 putty.exe。"
  exit /b 1
)

rem Keep setup.exe in this original user process.  Only the protected
rem AccessClient file operation below is elevated when Windows requires it.
if "%TA_NO_ELEVATION%"=="1" goto backup_and_copy_bridge_local
fltmc >nul 2>&1
if not errorlevel 1 goto backup_and_copy_bridge_local

echo [信息] 需要管理员权限来替换 AccessClient\putty.exe，正在请求 UAC 权限...
call :encode_bridge_arguments
if errorlevel 1 (
  set "TA_ERROR=[错误] 无法准备管理员权限所需的桥接文件参数。"
  exit /b 1
)
set "TA_ELEVATE_ARGS=/d /c call ^"%~f0^" --elevated-bridge %TA_ELEVATED_BRIDGE_SOURCE% %TA_ELEVATED_BRIDGE_TARGET% %TA_ELEVATED_BRIDGE_BACKUP% %TA_ELEVATED_BRIDGE_TEMP%"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; try { $p=Start-Process -FilePath $env:ComSpec -ArgumentList $env:TA_ELEVATE_ARGS -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode } catch { exit 1223 }"
set "TA_ELEVATE_RC=%ERRORLEVEL%"
if "%TA_ELEVATE_RC%"=="1223" (
  set "TA_ERROR=[错误] 已取消管理员权限请求，未替换 AccessClient 的 putty.exe。"
  exit /b 1
)
if "%TA_ELEVATE_RC%"=="10" (
  set "TA_BACKUP_CREATED=1"
  set "TA_BACKUP_EXISTS=1"
  echo [信息] 原 putty.exe 已备份为 putty.exe.bak。
  goto backup_and_copy_bridge_elevated_success
)
if not "%TA_ELEVATE_RC%"=="0" (
  set "TA_ERROR=[错误] 无法以管理员权限备份并替换 AccessClient 的 putty.exe。请关闭 AccessClient 后重试。"
  exit /b 1
)

:backup_and_copy_bridge_elevated_success
echo [完成] 已将 release putty.exe 映射到 AccessClient。
exit /b 0

:backup_and_copy_bridge_local
set "TA_CHECK_PATH=%TA_TARGET_PUTTY%"
call :path_is_directory
if not errorlevel 1 (
  set "TA_ERROR=[错误] 目标路径是目录而不是 putty.exe：%TA_TARGET_PUTTY%"
  exit /b 1
)
set "TA_CHECK_PATH=%TA_BACKUP_PUTTY%"
call :path_is_directory
if not errorlevel 1 (
  set "TA_ERROR=[错误] 备份路径是目录而不是 putty.exe.bak：%TA_BACKUP_PUTTY%"
  exit /b 1
)
set "TA_CHECK_PATH=%TA_TEMP_PUTTY%"
call :path_is_directory
if not errorlevel 1 (
  set "TA_ERROR=[错误] 临时路径是目录，无法继续：%TA_TEMP_PUTTY%"
  exit /b 1
)

rem Keep this deliberately linear.  In a parenthesised CMD block, percent
rem variables are expanded before the block runs, which can make a newly-set
rem TA_BACKUP_EXISTS look stale and can corrupt the following ELSE branch.
if exist "%TA_BACKUP_PUTTY%" set "TA_BACKUP_EXISTS=1"
if not exist "%TA_TARGET_PUTTY%" goto bridge_copy_payload
if "%TA_BACKUP_EXISTS%"=="1" goto bridge_copy_payload

fc /b "%TA_TARGET_PUTTY%" "%TA_BRIDGE%" >nul 2>&1
if not errorlevel 1 goto bridge_copy_payload

move /y "%TA_TARGET_PUTTY%" "%TA_BACKUP_PUTTY%" >nul 2>&1
if errorlevel 1 (
  set "TA_ERROR=[错误] 无法将原 putty.exe 备份为 putty.exe.bak。请关闭 AccessClient 后以管理员身份重试。"
  exit /b 1
)
set "TA_BACKUP_CREATED=1"
set "TA_BACKUP_EXISTS=1"
if "%TA_ELEVATED_BRIDGE%"=="0" echo [信息] 原 putty.exe 已备份为 putty.exe.bak。

:bridge_copy_payload

if exist "%TA_TEMP_PUTTY%" del /f /q "%TA_TEMP_PUTTY%" >nul 2>&1
copy /y /b "%TA_BRIDGE%" "%TA_TEMP_PUTTY%" >nul
if errorlevel 1 (
  set "TA_ERROR=[错误] 无法准备 putty.exe 临时副本。请检查权限和文件锁。"
  exit /b 1
)
move /y "%TA_TEMP_PUTTY%" "%TA_TARGET_PUTTY%" >nul 2>&1
if errorlevel 1 (
  del /f /q "%TA_TEMP_PUTTY%" >nul 2>&1
  set "TA_ERROR=[错误] 无法激活 putty.exe 中继程序。请关闭 AccessClient 后重试。"
  exit /b 1
)
fc /b "%TA_BRIDGE%" "%TA_TARGET_PUTTY%" >nul 2>&1
if errorlevel 1 (
  set "TA_ERROR=[错误] 中继程序复制校验失败：%TA_TARGET_PUTTY%"
  exit /b 1
)
if "%TA_ELEVATED_BRIDGE%"=="0" echo [完成] 已将 release putty.exe 映射到 AccessClient。
exit /b 0

:locate_runtime
set "TA_RUNTIME="
set "TA_INSTALL_PATH="
set "TA_RUNTIME_CODEPAGE="
for /f "tokens=2 delims=:" %%C in ('chcp') do set "TA_RUNTIME_CODEPAGE=%%C"
chcp 65001 >nul 2>&1
for /f "delims=" %%P in ('powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='SilentlyContinue'; $p=Get-ItemProperty -LiteralPath 'Registry::HKEY_CURRENT_USER\Software\Terminal-Agent' -Name InstallPath -ErrorAction SilentlyContinue; if($null -ne $p){$v=[Environment]::ExpandEnvironmentVariables([string]$p.InstallPath); if($v){$v.Trim()}}"') do if not defined TA_INSTALL_PATH set "TA_INSTALL_PATH=%%P"
if defined TA_RUNTIME_CODEPAGE chcp %TA_RUNTIME_CODEPAGE% >nul 2>&1
if defined TA_INSTALL_PATH (
  for %%I in ("%TA_INSTALL_PATH%") do set "TA_INSTALL_PATH=%%~fI"
  set "TA_RUNTIME=%TA_INSTALL_PATH%\Terminal-Agent-runtime.exe"
)
if defined TA_RUNTIME if exist "%TA_RUNTIME%" goto runtime_target_check
set "TA_RUNTIME="
if defined LOCALAPPDATA if exist "%LOCALAPPDATA%\Programs\Terminal-Agent\Terminal-Agent-runtime.exe" set "TA_RUNTIME=%LOCALAPPDATA%\Programs\Terminal-Agent\Terminal-Agent-runtime.exe"
if not defined TA_RUNTIME if defined ProgramFiles if exist "%ProgramFiles%\Terminal-Agent\Terminal-Agent-runtime.exe" set "TA_RUNTIME=%ProgramFiles%\Terminal-Agent\Terminal-Agent-runtime.exe"
if not defined TA_RUNTIME if defined ProgramW6432 if exist "%ProgramW6432%\Terminal-Agent\Terminal-Agent-runtime.exe" set "TA_RUNTIME=%ProgramW6432%\Terminal-Agent\Terminal-Agent-runtime.exe"
if not defined TA_RUNTIME (
  set "TA_ERROR=[错误] 安装程序已完成，但找不到 Terminal-Agent-runtime.exe。请检查安装路径后手动启动一次。"
  exit /b 1
)
:runtime_target_check
if not exist "%TA_TARGET_PUTTY%" (
  set "TA_ERROR=[错误] 安装后找不到 AccessClient 中的 putty.exe：%TA_TARGET_PUTTY%"
  exit /b 1
)
exit /b 0

:launch_runtime
if not defined TA_RUNTIME exit /b 0
echo [信息] 正在启动 Terminal-Agent...
start "" "%TA_RUNTIME%" >nul 2>&1
exit /b 0

:require_file
if not exist "%TA_REQUIRED_PATH%" (
  set "TA_ERROR=[错误] %TA_REQUIRED_LABEL% 不存在：%TA_REQUIRED_PATH%"
  exit /b 1
)
for %%I in ("%TA_REQUIRED_PATH%") do if %%~zI LEQ 0 (
  set "TA_ERROR=[错误] %TA_REQUIRED_LABEL% 是空文件：%TA_REQUIRED_PATH%"
  exit /b 1
)
exit /b 0

:require_directory
set "TA_CHECK_PATH=%TA_REQUIRED_PATH%"
call :path_is_directory
if errorlevel 1 (
  set "TA_ERROR=[错误] %TA_REQUIRED_LABEL% 目录不存在：%TA_REQUIRED_PATH%"
  exit /b 1
)
exit /b 0

:path_is_directory
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "if(Test-Path -LiteralPath $env:TA_CHECK_PATH -PathType Container){exit 0}else{exit 1}"
exit /b %ERRORLEVEL%

:print_backup_path
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "[Console]::WriteLine('原始程序备份：' + $env:TA_BACKUP_PUTTY)"
exit /b 0

:print_error
if not defined TA_ERROR exit /b 0
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "[Console]::WriteLine($env:TA_ERROR)"
if errorlevel 1 echo [错误] 自动安装失败。
exit /b 0

:failed
call :print_error
echo.
if "%TA_INSTALL_STARTED%"=="0" (
  if "%TA_BACKUP_CREATED%"=="1" call :restore_created_backup
  echo [失败] 自动安装未完成；Terminal-Agent 安装包尚未启动。
) else (
  echo [失败] 安装包已启动但未正常完成；已保留 AccessClient 的 putty.exe.bak。
)
if defined TA_BACKUP_PUTTY if exist "%TA_BACKUP_PUTTY%" call :print_backup_path
call :cleanup_download
if "%TA_NO_PAUSE%"=="0" pause
popd >nul 2>&1
exit /b 1

:restore_created_backup
if not defined TA_BACKUP_PUTTY exit /b 0
if not exist "%TA_BACKUP_PUTTY%" exit /b 0
if exist "%TA_TARGET_PUTTY%" del /f /q "%TA_TARGET_PUTTY%" >nul 2>&1
move /y "%TA_BACKUP_PUTTY%" "%TA_TARGET_PUTTY%" >nul 2>&1
if not errorlevel 1 if "%TA_ELEVATED_BRIDGE%"=="0" echo [信息] 已恢复本次运行前的 putty.exe。
exit /b 0

:usage_error
set "TA_USAGE_RC=1"
:usage
echo Terminal-Agent quick-install.cmd
echo.
echo 用法：quick-install.cmd [选项]
echo.
echo 默认从脚本所在目录或 release 目录寻找 快速安装手册.md、putty.exe 和安装包，
echo 自动查询 HKCR\accessclient、备份原 putty.exe、复制中继程序，最后启动安装向导。
echo.
echo 选项：
echo   /NoDownload                  仅使用本地资产，不访问 GitHub
echo   /Download                    忽略本地资产并重新下载最新版资产
echo   /NoLaunch                    安装完成后不自动启动 Terminal-Agent
echo   /Silent                      以 NSIS 静默参数 /S 启动安装包
echo   /OpenGuide                   成功后打开 快速安装手册.md
echo   /NoPause                     完成或失败后不暂停窗口
echo   /ReleaseDir ^<目录^>           指定 release 资产目录
echo   /Installer ^<文件^>            指定 Terminal-Agent-Setup-*.exe
echo   /Bridge ^<文件^>               指定 putty.exe 中继程序
echo   /AccessClientDir ^<目录^>      指定 AccessClient 目录，跳过注册表查询
echo   /Repo ^<owner/repo^>           指定 GitHub 仓库，默认 AI-DIY/Terminal-Agent
popd >nul 2>&1
exit /b %TA_USAGE_RC%
