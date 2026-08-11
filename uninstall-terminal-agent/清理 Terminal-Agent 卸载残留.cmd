@echo off
setlocal EnableExtensions

set "SCRIPT=%~dp0Clear-Terminal-Agent-UninstallEntries.ps1"
if not exist "%SCRIPT%" (
  echo Package is incomplete. Please extract the complete ZIP before running this tool.
  pause
  exit /b 3
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%"
exit /b %ERRORLEVEL%
