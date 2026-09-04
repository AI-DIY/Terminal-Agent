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
    const countBlock = source.slice(source.indexOf('const enabledCount ='), source.indexOf('function saveDisplayName'))
    const inputBlock = source.slice(source.indexOf('<input type="checkbox"'), source.indexOf('</label>', source.indexOf('<input type="checkbox"')))
    const cardBlock = source.slice(source.indexOf('<article v-for="skill in SKILLS"'), source.indexOf('</article>', source.indexOf('<article v-for="skill in SKILLS"')))
    expect(countBlock).toContain('sso.skillsAvailable.value ?')
    expect(countBlock).toContain(': 0)')
    expect(inputBlock).toContain(':disabled="!sso.skillsAvailable"')
    expect(cardBlock).toContain('sso.skillsAvailable && preferences.state.skills[skill.id]')
    expect(cardBlock).toContain("sso.skillsAvailable && preferences.state.skills[skill.id] ? '已启用' : '已停用'")
  })

  it('guards direct toggle calls before mutating local preferences', () => {
    const toggleBlock = source.slice(source.indexOf('function toggleSkill'), source.indexOf('function closeSkills'))
    const guard = toggleBlock.indexOf('if (!sso.skillsAvailable.value) return')
    const mutation = toggleBlock.indexOf('preferences.setSkillEnabled')
    expect(guard).toBeGreaterThan(-1)
    expect(mutation).toBeGreaterThan(guard)
    expect(toggleBlock).toContain('preferences.setSkillEnabled(skill.id, !preferences.state.skills[skill.id])')
  })

  it('keeps local skill choices visible when authenticated', () => {
    expect(source).toContain('preferences.state.skills[skill.id]')
    expect(source).toContain('preferences.setSkillEnabled(skill.id')
  })
})
