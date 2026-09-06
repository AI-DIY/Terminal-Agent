import { describe, expect, it } from 'vitest'
import { BUILT_IN_SKILLS, builtInSkillInstructions, normalizeBuiltInSkillIds } from '../../../src/shared/built-in-skills'

describe('built-in AI skills', () => {
  it('keeps the product skill catalog explicit and deterministic', () => {
    expect(BUILT_IN_SKILLS.map(skill => skill.id)).toEqual([
      'teleagent-operations',
      'codex-development',
      'ssh-troubleshooting',
    ])
    expect(BUILT_IN_SKILLS.map(skill => skill.name)).toEqual(['系统告警分析', '系统日报周报月报分析', '系统知识库检索'])
    expect(BUILT_IN_SKILLS.every(skill => !skill.defaultEnabled)).toBe(true)
    expect(BUILT_IN_SKILLS.every(skill => skill.demoOnly)).toBe(true)
  })

  it('drops unknown and duplicate ids and keeps demo entries out of model instructions', () => {
    expect(normalizeBuiltInSkillIds(['ssh-troubleshooting', 'unknown', 'ssh-troubleshooting'])).toEqual(['ssh-troubleshooting'])
    expect(normalizeBuiltInSkillIds(['security-review'])).toEqual(['security-review'])
    expect(builtInSkillInstructions(['ssh-troubleshooting', 'security-review'])).toEqual([])
  })
})
