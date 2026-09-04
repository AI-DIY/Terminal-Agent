import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../../../src/renderer/src/views/WorkbenchView.vue', import.meta.url), 'utf8')

describe('WorkbenchView SSO identity and skill gate', () => {
  it('formats authenticated identity before falling back to the local display name', () => {
    expect(source).toContain("import { getSsoStore } from '../stores/sso'")
    expect(source).toContain('const sso = getSsoStore()')
    expect(source).toContain("identity.name + '（' + identity.employeeId + '）'")
    expect(source).toContain("userPreferences.state.displayName || '朋友'")
    expect(source).toContain(':welcome-name="welcomeName"')
  })

  it('fails closed for header skill navigation while preserving the normal action', () => {
    expect(source).toContain(':disabled="!skillsAvailable"')
    expect(source).toContain('未登录状态不能使用技能')
    expect(source).toContain("if (skillsAvailable.value) emit('showSkills')")
    expect(source).toContain(':skills-available="skillsAvailable"')
  })
})
