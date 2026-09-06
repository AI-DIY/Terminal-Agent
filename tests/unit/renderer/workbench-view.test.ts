import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../../../src/renderer/src/views/WorkbenchView.vue', import.meta.url), 'utf8')

describe('WorkbenchView SSO identity and skill gate', () => {
  it('formats authenticated identity before falling back to the local display name', () => {
    const derivation = source.slice(source.indexOf('const welcomeName ='), source.indexOf('const workbenchReady ='))
    const shellBinding = source.slice(source.indexOf('<WorkbenchShell'), source.indexOf('>\n    <template #app-actions>'))
    expect(source).toContain("import { getSsoStore } from '../stores/sso'")
    expect(source).toContain('const sso = getSsoStore()')
    expect(derivation).toContain("identity.name + '（' + identity.employeeId + '）'")
    expect(derivation).toContain("userPreferences.state.displayName || '朋友'")
    expect(shellBinding).toContain(':welcome-name="welcomeName"')
  })

  it('fails closed for header skill navigation while preserving the normal action', () => {
    const handler = source.slice(source.indexOf('function openSkills'), source.indexOf('// Internal AI conversations'))
    const button = source.slice(source.indexOf('<button type="button" class="header-button"'), source.indexOf('</button>', source.indexOf('<button type="button" class="header-button"')))
    const panelBinding = source.slice(source.indexOf('<GlobalChatPanel'), source.indexOf('/>', source.indexOf('<GlobalChatPanel')))
    expect(button).toContain(':disabled="!skillsAvailable"')
    expect(button).toContain('未登录状态不能使用技能')
    expect(button).toContain('@click="openSkills"')
    expect(handler).toContain("if (skillsAvailable.value) emit('showSkills', chatStore.state.selectedId)")
    expect(panelBinding).toContain(':skills-available="skillsAvailable"')
  })

  it('keeps SSH connection creation in the SSH workspace only', () => {
    const panel = source.slice(source.indexOf('<GlobalChatPanel'), source.indexOf('/>', source.indexOf('<GlobalChatPanel')))
    expect(panel).not.toContain('new-connection')
    expect(panel).not.toContain('新建 SSH 连接')
  })
})
