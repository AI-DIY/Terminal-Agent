import { constants } from 'node:fs'
import { access, readFile, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const cleanupDirectory = join(process.cwd(), 'uninstall-terminal-agent')
const launcherPath = join(cleanupDirectory, '清理 Terminal-Agent 卸载残留.cmd')
const scriptPath = join(cleanupDirectory, 'Clear-Terminal-Agent-UninstallEntries.ps1')
const packagerPath = join(process.cwd(), 'scripts', 'windows', 'package-uninstall-cleanup.ps1')
const execFileAsync = promisify(execFile)

async function runPowerShell(args: string[]) {
  return execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], {
    windowsHide: true
  })
}

describe('Terminal-Agent uninstall cleanup tool', () => {
  it('provides a double-click launcher that locates the script relatively and keeps its result visible', async () => {
    await expect(access(launcherPath, constants.F_OK)).resolves.toBeUndefined()
    const launcher = await readFile(launcherPath, 'utf8')

    expect(launcher).toContain('%~dp0Clear-Terminal-Agent-UninstallEntries.ps1')
    expect(launcher).toMatch(/-ExecutionPolicy\s+Bypass/i)
    expect(launcher).toMatch(/pause/i)
    expect(launcher).not.toMatch(/[A-Z]:\\Users\\/i)
  })

  it('requires an explicit Y confirmation, supports a no-pause preview, and verifies registry backups before deletion', async () => {
    const script = await readFile(scriptPath, 'utf8')

    expect(script).toContain('[switch]$NoPause')
    expect(script).toMatch(/Read-Host.+Y/i)
    expect(script).toContain('Start-Process')
    expect(script).toContain('-File "{0}"{1}')
    expect(script).not.toContain('-File \\"{0}\\"{1}')
    expect(script).toMatch(/Get-Item[\s\S]+Length.+-gt\s+0/i)
    expect(script.indexOf('& $regExe export')).toBeLessThan(script.indexOf('DeleteSubKeyTree'))
    expect(script).not.toMatch(/Delete(?:RegValue|Value).+InstallPath/i)
  })

  it('uses UTF-8 with a BOM so Windows PowerShell 5.1 reads Chinese text consistently', async () => {
    for (const path of [scriptPath, packagerPath, join(cleanupDirectory, '使用说明.txt')]) {
      const bytes = await readFile(path)
      expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    }
  })

  it('runs a read-only preview and creates a ZIP containing the three cleanup files', async () => {
    const version = `test-${process.pid}-${Date.now()}`
    const archivePath = join(process.cwd(), 'release', `Terminal-Agent-Uninstall-Cleanup-${version}.zip`)

    await expect(runPowerShell(['-File', scriptPath, '-WhatIf', '-NoPause'])).resolves.toBeDefined()

    try {
      await runPowerShell(['-File', packagerPath, '-Version', version])
      const { stdout } = await runPowerShell([
        '-Command',
        `Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip = [System.IO.Compression.ZipFile]::OpenRead('${archivePath.replace(/'/g, "''")}'); try { $zip.Entries | ForEach-Object FullName | ConvertTo-Json -Compress } finally { $zip.Dispose() }`
      ])

      expect((JSON.parse(stdout) as string[]).sort()).toEqual([
        'Clear-Terminal-Agent-UninstallEntries.ps1',
        '清理 Terminal-Agent 卸载残留.cmd',
        '使用说明.txt'
      ].sort())
    }
    finally {
      await rm(archivePath, { force: true })
    }
  })

  it('packages only the user-facing cleanup files into a versioned release zip', async () => {
    await expect(access(packagerPath, constants.F_OK)).resolves.toBeUndefined()
    const packager = await readFile(packagerPath, 'utf8')
    const packageJson = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }

    expect(packager).toContain('Clear-Terminal-Agent-UninstallEntries.ps1')
    expect(packager).toContain('清理 Terminal-Agent 卸载残留.cmd')
    expect(packager).toContain('使用说明.txt')
    expect(packager).toContain('Terminal-Agent-Uninstall-Cleanup-')
    expect(packager).toContain('$env:npm_package_version')
    expect(packageJson.scripts['make:uninstall-cleanup']).not.toContain('$npm_package_version')
    expect(packageJson.scripts['make:uninstall-cleanup']).not.toContain('$env:npm_package_version')
  })
})
