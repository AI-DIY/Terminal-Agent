#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$Version = $env:npm_package_version
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Version)) {
    throw 'A cleanup release version is required.'
}

$repositoryRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$sourceDirectory = Join-Path $repositoryRoot 'uninstall-terminal-agent'
$releaseDirectory = Join-Path $repositoryRoot 'release'
$archivePath = Join-Path $releaseDirectory "Terminal-Agent-Uninstall-Cleanup-$Version.zip"
$stagingDirectory = Join-Path ([IO.Path]::GetTempPath()) ("terminal-agent-uninstall-cleanup-$Version-" + [guid]::NewGuid().ToString('N'))
$files = @(
    'Clear-Terminal-Agent-UninstallEntries.ps1',
    '清理 Terminal-Agent 卸载残留.cmd',
    '使用说明.txt'
)

try {
    New-Item -ItemType Directory -Path $stagingDirectory -Force | Out-Null
    foreach ($file in $files) {
        $sourcePath = Join-Path $sourceDirectory $file
        if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
            throw "Missing cleanup release file: $sourcePath"
        }
        Copy-Item -LiteralPath $sourcePath -Destination (Join-Path $stagingDirectory $file)
    }

    New-Item -ItemType Directory -Path $releaseDirectory -Force | Out-Null
    Compress-Archive -Path (Join-Path $stagingDirectory '*') -DestinationPath $archivePath -Force
    if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) {
        throw "Cleanup archive was not created: $archivePath"
    }

    Write-Host $archivePath
}
finally {
    if (Test-Path -LiteralPath $stagingDirectory) {
        Remove-Item -LiteralPath $stagingDirectory -Recurse -Force
    }
}
