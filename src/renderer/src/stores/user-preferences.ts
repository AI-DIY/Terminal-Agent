import { reactive } from 'vue'
import { BUILT_IN_SKILLS, type BuiltInSkillId } from '../../../shared/built-in-skills'

/**
 * Renderer-only preferences which are safe to keep in localStorage.
 *
 * These values deliberately do not contain credentials or connection details.
 * Keeping them in one small store lets the workbench and the Skills view stay
 * in sync while both views remain mounted by App.vue.
 */
export const DISPLAY_NAME_STORAGE_KEY = 'terminal-agent.display-name'
export const SKILLS_STORAGE_KEY = 'terminal-agent.skills'
export const DISPLAY_NAME_MAX_LENGTH = 40

export { type BuiltInSkillId } from '../../../shared/built-in-skills'

export const BUILT_IN_SKILL_DEFAULTS = Object.freeze(Object.fromEntries(
  BUILT_IN_SKILLS.map(skill => [skill.id, skill.defaultEnabled]),
) as Record<BuiltInSkillId, boolean>)

export type UserPreferencesState = {
  displayName: string
  skills: Record<BuiltInSkillId, boolean>
}

function readDisplayName(): string {
  try {
    const value = globalThis.localStorage?.getItem(DISPLAY_NAME_STORAGE_KEY)
    return normalizeDisplayName(value ?? '')
  } catch {
    return ''
  }
}

function readSkills(): Record<BuiltInSkillId, boolean> {
  const defaults = { ...BUILT_IN_SKILL_DEFAULTS } as Record<BuiltInSkillId, boolean>
  try {
    const raw = globalThis.localStorage?.getItem(SKILLS_STORAGE_KEY)
    if (!raw) return defaults
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return defaults
    for (const id of Object.keys(defaults) as BuiltInSkillId[]) {
      const value = (parsed as Record<string, unknown>)[id]
      if (typeof value === 'boolean') defaults[id] = value
    }
  } catch {
    // A blocked or malformed localStorage entry should never prevent startup.
  }
  return defaults
}

export function normalizeDisplayName(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.trim().replace(/\s+/g, ' ').slice(0, DISPLAY_NAME_MAX_LENGTH)
}

function persistDisplayName(value: string): void {
  try {
    if (value) globalThis.localStorage?.setItem(DISPLAY_NAME_STORAGE_KEY, value)
    else globalThis.localStorage?.removeItem(DISPLAY_NAME_STORAGE_KEY)
  } catch {
    // localStorage is an optional convenience; keep the in-memory value.
  }
}

function persistSkills(value: Record<BuiltInSkillId, boolean>): void {
  try { globalThis.localStorage?.setItem(SKILLS_STORAGE_KEY, JSON.stringify(value)) } catch {
    // localStorage is an optional convenience; keep the in-memory value.
  }
}

const state = reactive<UserPreferencesState>({
  displayName: readDisplayName(),
  skills: readSkills(),
})

function setDisplayName(value: string): void {
  const normalized = normalizeDisplayName(value)
  state.displayName = normalized
  persistDisplayName(normalized)
}

function setSkillEnabled(id: BuiltInSkillId, enabled: boolean): void {
  state.skills[id] = enabled
  persistSkills(state.skills)
}

function enabledSkillIds(): BuiltInSkillId[] {
  return BUILT_IN_SKILLS
    .filter(skill => state.skills[skill.id])
    .map(skill => skill.id)
}

export function getUserPreferencesStore(): {
  state: UserPreferencesState
  setDisplayName: (value: string) => void
  setSkillEnabled: (id: BuiltInSkillId, enabled: boolean) => void
  enabledSkillIds: () => BuiltInSkillId[]
} {
  return { state, setDisplayName, setSkillEnabled, enabledSkillIds }
}
