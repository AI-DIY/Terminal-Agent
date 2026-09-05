import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const launcher = readFileSync(new URL('../../../src/renderer/src/components/connections/SshConnectionLauncher.vue', import.meta.url), 'utf8')
const workbench = readFileSync(new URL('../../../src/renderer/src/views/WorkbenchView.vue', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

describe('unified SSH connection launcher', () => {
  it('exposes the direct and bastion-jump modes, defaulting to bastion guidance', () => {
    expect(launcher).toContain("id: 'password'")
    expect(launcher).toContain("id: 'privateKey'")
    expect(launcher).toContain("id: 'bastionHost'")
    expect(launcher).toContain("label: '堡垒机跳转连接'")
    expect(launcher).toContain("const initialMode = props.editingProfile?.authKind ?? 'bastionHost'")
    expect(launcher).toContain('BastionHostForm')
    expect(launcher).toContain('bastionLaunch: [request: BastionLaunchRequest]')
    expect(launcher).toContain('@launch="launchBastion"')
    expect(launcher).toContain('<template v-if="mode === \'bastionHost\'">')
    expect(launcher).toContain('【配置须知】')
    expect(launcher).toContain('【使用须知】')
    expect(launcher).toContain('06-select-global-putty.png')
    expect(launcher).toContain('07-launch-bastion.png')
    expect(launcher).toContain(':src="sessionConfigImage"')
    expect(launcher).toContain(':src="bastionUsageImage"')

    const bastionPanel = launcher.indexOf('<template v-if="mode === \'bastionHost\'">')
    const notices = launcher.indexOf('<section class="connection-notices"')
    const bastionPanelEnd = launcher.indexOf('</template>', notices)
    expect(notices).toBeGreaterThan(bastionPanel)
    expect(bastionPanelEnd).toBeGreaterThan(notices)
  })

  it('uses a responsive tab strip and the same component for embedded and dialog entry points', () => {
    expect(launcher).toContain('.mode-tabs { display: flex; flex-wrap: wrap;')
    expect(launcher).toContain('.mode-tabs button { flex: 1 1 140px;')
    expect(launcher).toContain('@media (max-width: 520px) { .mode-tabs button { flex-basis: 100%; }')
    expect(workbench).toContain('<SshConnectionLauncher\n              appearance="embedded"')
    expect(workbench).toContain('<SshConnectionLauncher\n          appearance="dialog"')
  })
})
