import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { BUILT_IN_SKILLS, type BuiltInSkillId } from '../../../src/shared/built-in-skills'
import { resolveBuiltInSkillControls, toggleBuiltInSkill } from '../../../src/renderer/src/stores/skill-capability'

function enabledPreferences(): Record<BuiltInSkillId, boolean> {
  return Object.fromEntries(BUILT_IN_SKILLS.map(skill => [skill.id, true])) as Record<BuiltInSkillId, boolean>
}

describe('SkillsView SSO restrictions', () => {
  it('keeps the skills screen focused on selectable capabilities', () => {
    const view = readFileSync(new URL('../../../src/renderer/src/views/SkillsView.vue', import.meta.url), 'utf8')

    for (const removedText of ['欢迎语', '显示姓名', '预览', '本地保存', '演示', '开发中']) {
      expect(view).not.toContain(removedText)
    }
    expect(view).toContain('内置技能')
    expect(view).toContain('选择需要在 AI 工作区中使用的内置能力。')
    expect(view).toContain("skillControl(skill.id).enabled ? '已启用' : '未启用'")
  })

  it('exposes every built-in control as disabled with zero enabled skills while unavailable', () => {
    const controls = resolveBuiltInSkillControls(false, enabledPreferences())

    expect(controls.enabledCount).toBe(0)
    expect(controls.controls).toHaveLength(BUILT_IN_SKILLS.length)
    expect(controls.controls.map(control => control.id)).toEqual(BUILT_IN_SKILLS.map(skill => skill.id))
    expect(controls.controls.every(control => control.disabled)).toBe(true)
    expect(controls.controls.every(control => !control.enabled)).toBe(true)
  })

  it('does not mutate a locally enabled skill when an unavailable control is toggled', () => {
    const preferences = enabledPreferences()
    const update = vi.fn((id: BuiltInSkillId, enabled: boolean) => { preferences[id] = enabled })

    const changed = toggleBuiltInSkill(false, 'ssh-troubleshooting', preferences, update)

    expect(changed).toBe(false)
    expect(update).not.toHaveBeenCalled()
    expect(preferences['ssh-troubleshooting']).toBe(true)
  })

  it('keeps enabled controls interactive when the SSO capability is available', () => {
    const preferences = enabledPreferences()
    const update = vi.fn((id: BuiltInSkillId, enabled: boolean) => { preferences[id] = enabled })
    const controls = resolveBuiltInSkillControls(true, preferences)

    expect(controls.enabledCount).toBe(BUILT_IN_SKILLS.length)
    expect(controls.controls.every(control => !control.disabled && control.enabled)).toBe(true)
    expect(toggleBuiltInSkill(true, 'ssh-troubleshooting', preferences, update)).toBe(true)
    expect(update).toHaveBeenCalledWith('ssh-troubleshooting', false)
  })
})
