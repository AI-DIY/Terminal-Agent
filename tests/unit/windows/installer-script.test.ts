import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Terminal-Agent NSIS bridge registration lifecycle', () => {
  it('removes only this installation InstallPath during uninstall and leaves a non-empty registry key intact', async () => {
    const script = await readFile(join(process.cwd(), 'scripts', 'windows', 'terminal-agent-installer.nsh'), 'utf8')

    expect(script).toMatch(/!macro customInstall[\s\S]*WriteRegStr HKCU "Software\\Terminal-Agent" "InstallPath" "\$INSTDIR"[\s\S]*!macroend/)
    expect(script).toMatch(/!macro customUnInstall[\s\S]*ReadRegStr \$0 HKCU "Software\\Terminal-Agent" "InstallPath"[\s\S]*StrCmp \$0 "\$INSTDIR"[\s\S]*DeleteRegValue HKCU "Software\\Terminal-Agent" "InstallPath"[\s\S]*DeleteRegKey \/ifempty HKCU "Software\\Terminal-Agent"[\s\S]*!macroend/)
  })

  it('initializes user-config in the current profile without deleting it on uninstall', async () => {
    const script = await readFile(join(process.cwd(), 'scripts', 'windows', 'terminal-agent-installer.nsh'), 'utf8')
    const installStart = script.indexOf('!macro customInstall')
    const installEnd = script.indexOf('!macroend', installStart) + '!macroend'.length
    const uninstallStart = script.indexOf('!macro customUnInstall')
    const uninstallEnd = script.indexOf('!macroend', uninstallStart) + '!macroend'.length
    const install = script.slice(installStart, installEnd)
    const uninstall = script.slice(uninstallStart, uninstallEnd)

    expect(install).toContain('ReadEnvStr')
    expect(install).toContain('"USERPROFILE"')
    expect(install).toContain('.ta')
    expect(install).toContain('user-config')
    expect(install).toContain('CreateDirectory')
    expect(install).toContain('IfFileExists')
    expect(install).toMatch(/IfFileExists[^\r\n]*user-config/)
    expect(install).toMatch(/FileOpen[^\r\n]*user-config[^\r\n]*\sw/)
    expect(install).toContain('"version":1')
    expect(install).toContain('"enabled":true')
    expect(install).toContain('"platformUrlMatcher"')
    expect(install).toContain('"userInfoUrlMatcher"')
    expect(install.indexOf('IfFileExists')).toBeLessThan(install.indexOf('FileOpen'))

    expect(uninstall).not.toContain('user-config')
    expect(uninstall).not.toContain('.ta')
  })
})
