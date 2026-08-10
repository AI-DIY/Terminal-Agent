import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Terminal-Agent NSIS bridge registration lifecycle', () => {
  it('removes only this installation InstallPath during uninstall and leaves a non-empty registry key intact', async () => {
    const script = await readFile(join(process.cwd(), 'scripts', 'windows', 'terminal-agent-installer.nsh'), 'utf8')

    expect(script).toMatch(/!macro customInstall[\s\S]*WriteRegStr HKCU "Software\\Terminal-Agent" "InstallPath" "\$INSTDIR"[\s\S]*!macroend/)
    expect(script).toMatch(/!macro customUnInstall[\s\S]*ReadRegStr \$0 HKCU "Software\\Terminal-Agent" "InstallPath"[\s\S]*StrCmp \$0 "\$INSTDIR"[\s\S]*DeleteRegValue HKCU "Software\\Terminal-Agent" "InstallPath"[\s\S]*DeleteRegKey \/ifempty HKCU "Software\\Terminal-Agent"[\s\S]*!macroend/)
  })
})
