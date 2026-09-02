import { describe, expect, it } from 'vitest'
import { BUILT_IN_SKILL_DEFAULTS, DISPLAY_NAME_MAX_LENGTH, normalizeDisplayName } from '../../../src/renderer/src/stores/user-preferences'

describe('user preferences', () => {
  it('normalizes a display name before it is shown in the workbench greeting', () => {
    expect(normalizeDisplayName('  林\t小  明  ')).toBe('林 小 明')
    expect(normalizeDisplayName('   ')).toBe('')
    expect(normalizeDisplayName('x'.repeat(DISPLAY_NAME_MAX_LENGTH + 8))).toHaveLength(DISPLAY_NAME_MAX_LENGTH)
  })

  it('keeps a small, explicit built-in skill catalog default', () => {
    expect(BUILT_IN_SKILL_DEFAULTS).toMatchObject({
      'teleagent-operations': true,
      'codex-development': true,
      'ssh-troubleshooting': true,
      'security-review': false,
    })
  })
})
