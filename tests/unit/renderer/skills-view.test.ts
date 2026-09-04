import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../../../src/renderer/src/views/SkillsView.vue', import.meta.url), 'utf8')

describe('SkillsView SSO restrictions', () => {
  it('uses the SSO capability gate and shows the unavailable warning', () => {
    expect(source).toContain("import { getSsoStore } from '../stores/sso'")
    expect(source).toContain('const sso = getSsoStore()')
    expect(source).toContain('未登录状态不能使用技能')
    expect(source).toContain('role="alert"')
  })

  it('disables every built-in switch and forces the unavailable count to zero', () => {
    expect(source).toContain('const enabledCount = computed(() => sso.skillsAvailable.value ?')
    expect(source).toContain(': 0)')
    expect(source).toContain(':disabled="!sso.skillsAvailable"')
  })

  it('guards direct toggle calls before mutating local preferences', () => {
    const guard = source.indexOf('if (!sso.skillsAvailable.value) return')
    const mutation = source.indexOf('preferences.setSkillEnabled', guard)
    expect(guard).toBeGreaterThan(-1)
    expect(mutation).toBeGreaterThan(guard)
  })

  it('keeps local skill choices visible when authenticated', () => {
    expect(source).toContain('preferences.state.skills[skill.id]')
    expect(source).toContain('preferences.setSkillEnabled(skill.id')
  })
})
