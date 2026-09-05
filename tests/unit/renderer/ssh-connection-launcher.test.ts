import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const launcher = readFileSync(new URL('../../../src/renderer/src/components/connections/SshConnectionLauncher.vue', import.meta.url), 'utf8')
const workbench = readFileSync(new URL('../../../src/renderer/src/views/WorkbenchView.vue', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

describe('unified SSH connection launcher', () => {
  it('exposes only the direct password and private-key modes', () => {
    expect(launcher).toContain("id: 'password'")
    expect(launcher).toContain("id: 'privateKey'")
    expect(launcher).not.toContain("id: 'bastionHost'")
    expect(launcher).not.toContain('BastionHostForm')
    expect(launcher).not.toContain('堡垒机主机地址')
    expect(launcher).not.toContain('唤起终端')
    expect(launcher).toContain('【配置须知】')
    expect(launcher).toContain('【使用须知】')
    expect(launcher).toContain('06-select-global-putty.png')
    expect(launcher).toContain('07-launch-bastion.png')
    expect(launcher).toContain(':src="sessionConfigImage"')
    expect(launcher).toContain(':src="bastionUsageImage"')
  })

  it('uses a two-column desktop tab strip and the same component for embedded and dialog entry points', () => {
    expect(launcher).toContain('.mode-tabs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));')
    expect(workbench).toContain('<SshConnectionLauncher\n              appearance="embedded"')
    expect(workbench).toContain('<SshConnectionLauncher\n          appearance="dialog"')
  })
})
