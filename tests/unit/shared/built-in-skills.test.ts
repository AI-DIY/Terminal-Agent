import { describe, expect, it } from 'vitest'
import { BUILT_IN_SKILLS, builtInSkillInstructions, normalizeBuiltInSkillIds } from '../../../src/shared/built-in-skills'

describe('built-in AI skills', () => {
  it('keeps the product skill catalog explicit and deterministic', () => {
    expect(BUILT_IN_SKILLS.map(skill => skill.id)).toEqual([
      'teleagent-operations',
      'codex-development',
      'ssh-troubleshooting',
      'security-review',
    ])
    expect(BUILT_IN_SKILLS.filter(skill => skill.defaultEnabled).map(skill => skill.id)).toEqual([
      'teleagent-operations',
      'codex-development',
      'ssh-troubleshooting',
    ])
  })

  it('drops unknown and duplicate ids before instructions reach the model', () => {
    expect(normalizeBuiltInSkillIds(['security-review', 'unknown', 'security-review'])).toEqual(['security-review'])
    expect(builtInSkillInstructions(['security-review'])).toEqual([
      expect.stringContaining('影响范围'),
    ])
  })
})
