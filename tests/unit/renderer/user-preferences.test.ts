import { describe, expect, it, vi } from 'vitest'
import { BUILT_IN_SKILL_DEFAULTS, DISPLAY_NAME_MAX_LENGTH, normalizeDisplayName } from '../../../src/renderer/src/stores/user-preferences'

describe('user preferences', () => {
  it('normalizes a display name before it is shown in the workbench greeting', () => {
    expect(normalizeDisplayName('  林\t小  明  ')).toBe('林 小 明')
    expect(normalizeDisplayName('   ')).toBe('')
    expect(normalizeDisplayName('x'.repeat(DISPLAY_NAME_MAX_LENGTH + 8))).toHaveLength(DISPLAY_NAME_MAX_LENGTH)
  })

  it('keeps a small, explicit built-in skill catalog default', () => {
    expect(BUILT_IN_SKILL_DEFAULTS).toMatchObject({
      'teleagent-operations': false,
      'codex-development': false,
      'ssh-troubleshooting': false,
    })
  })

  it('migrates an old skill catalogue once, then preserves a demo toggle on reload', async () => {
    const values = new Map<string, string>([
      ['terminal-agent.skills', JSON.stringify({
        'teleagent-operations': true,
        'codex-development': true,
        'ssh-troubleshooting': true,
      })],
      ['terminal-agent.skills-version', '3.2.5'],
    ])
    const storage = {
      get length() { return values.size },
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      key: (index: number) => [...values.keys()][index] ?? null,
      removeItem: (key: string) => { values.delete(key) },
      setItem: (key: string, value: string) => { values.set(key, value) },
    } satisfies Storage
    vi.stubGlobal('localStorage', storage)
    try {
      vi.resetModules()
      const migrated = await import('../../../src/renderer/src/stores/user-preferences')
      const migratedStore = migrated.getUserPreferencesStore()
      expect(migratedStore.state.skills).toMatchObject({
        'teleagent-operations': false,
        'codex-development': false,
        'ssh-troubleshooting': false,
      })
      expect(values.get('terminal-agent.skills-version')).toBe('3.2.6')

      migratedStore.setSkillEnabled('teleagent-operations', true)
      vi.resetModules()
      const reloaded = await import('../../../src/renderer/src/stores/user-preferences')
      expect(reloaded.getUserPreferencesStore().state.skills['teleagent-operations']).toBe(true)
    } finally {
      vi.unstubAllGlobals()
      vi.resetModules()
    }
  })
})
