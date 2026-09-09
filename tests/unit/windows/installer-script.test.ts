import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { createDefaultSsoConfiguration, ssoDocumentSchema } from '../../../src/shared/sso-contracts'

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
    expect(install).toContain('.terminal-agent')
    expect(install).toContain('.terminal-agent\\user-config')
    expect(install).toContain('.ta\\user-config')
    expect(install).toMatch(/IfFileExists\s+"\$1\\user-config\.yml"\s+done_config[\s\S]*IfFileExists\s+"\$4"\s+done_config[\s\S]*IfFileExists\s+"\$5"\s+done_config[\s\S]*CreateDirectory\s+"\$1"/)
    expect(install).toContain('user-config.yml')
    expect(install).toContain('CreateDirectory')
    expect(install).toMatch(/GetTempFileName\s+\$2\s+"\$1"/)
    expect(install).toMatch(/FileOpen\s+\$3\s+"\$2"\s+w/)
    expect(install).toMatch(/MoveFileEx\(t\s+r2,\s*t\s+"\$1\\user-config\.yml",\s*i\s+0\)/)
    expect(install).not.toMatch(/FileOpen[^\r\n]*user-config[^\r\n]*\sw/)

    const payload = [...install.matchAll(/FileWrite\s+\$3\s+'([^']*)'/g)]
      .map(match => match[1].replace(/\$\\r\$\\n/g, '\n'))
      .join('')
    expect(payload).toContain('# 用户配置文件格式版本，请勿手动修改。')
    expect(payload).toContain('# 是否启用单点登录。')
    expect(payload).toContain('# 平台地址匹配方式：exact、prefix 或 regex。')
    expect(payload).toContain('# 用户信息响应中姓名的字段路径。')
    const document = ssoDocumentSchema.parse(parse(payload))
    expect(document).toEqual({ version: 1, sso: createDefaultSsoConfiguration() })

    expect(uninstall).not.toContain('user-config')
    expect(uninstall).not.toContain('.ta')
  })

  it('creates an install-directory diagnostics folder writable by ordinary users', async () => {
    const script = await readFile(join(process.cwd(), 'scripts', 'windows', 'terminal-agent-installer.nsh'), 'utf8')
    const installStart = script.indexOf('!macro customInstall')
    const installEnd = script.indexOf('!macroend', installStart) + '!macroend'.length
    const install = script.slice(installStart, installEnd)

    expect(install).toMatch(/CreateDirectory\s+"\$INSTDIR\\logs"[\s\S]*ExecWait\s+'"\$SYSDIR\\icacls\.exe"\s+"\$INSTDIR\\logs"\s+\/grant:r\s+\*S-1-5-32-545:\(OI\)\(CI\)M\s+\/T\s+\/C'\s+\$0/)
  })
})
