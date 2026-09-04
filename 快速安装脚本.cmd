@echo off
setlocal EnableExtensions DisableDelayedExpansion
rem Chinese-named entry point shipped in the standalone quick-install ZIP.
rem Keep the implementation in quick-install.cmd so the repository and older
rem releases continue to support their original entry point.
set "TA_IMPLEMENTATION=%~dp0quick-install.cmd"
if not exist "%TA_IMPLEMENTATION%" (
  echo [错误] 找不到同目录的 quick-install.cmd 实现文件。
  exit /b 1
)
call "%TA_IMPLEMENTATION%" %*
exit /b %ERRORLEVEL%
