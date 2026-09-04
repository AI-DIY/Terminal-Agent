import { BUILT_IN_SKILLS, normalizeBuiltInSkillIds, type BuiltInSkillId } from '../../../shared/built-in-skills'

export type SkillPreferenceState = Readonly<Record<BuiltInSkillId, boolean>>

export type BuiltInSkillControl = {
  id: BuiltInSkillId
  enabled: boolean
  disabled: boolean
}

export type BuiltInSkillControls = {
  enabledCount: number
  controls: BuiltInSkillControl[]
}

/** Derive visible skill controls from the renderer's authenticated capability. */
export function resolveBuiltInSkillControls(
  skillsAvailable: boolean,
  preferences: SkillPreferenceState,
): BuiltInSkillControls {
  const controls = BUILT_IN_SKILLS.map(skill => ({
    id: skill.id,
    enabled: skillsAvailable && preferences[skill.id] === true,
    disabled: !skillsAvailable,
  }))
  return {
    enabledCount: skillsAvailable ? controls.filter(control => control.enabled).length : 0,
    controls,
  }
}

/** Apply a toggle only when the renderer has an authenticated skill capability. */
export function toggleBuiltInSkill(
  skillsAvailable: boolean,
  id: BuiltInSkillId,
  preferences: SkillPreferenceState,
  setSkillEnabled: (id: BuiltInSkillId, enabled: boolean) => void,
): boolean {
  if (!skillsAvailable) return false
  setSkillEnabled(id, !preferences[id])
  return true
}

/** Project local preferences at the chat request boundary. */
export function projectChatSkillIds(
  skillsAvailable: boolean,
  enabledSkillIds: readonly string[],
): BuiltInSkillId[] {
  return skillsAvailable ? normalizeBuiltInSkillIds(enabledSkillIds) : []
}

/** Run either send or compact through the same renderer-side skill gate. */
export function runChatActionWithSkillGate<T>(
  skillsAvailable: boolean,
  enabledSkillIds: readonly string[],
  action: (skillIds: BuiltInSkillId[]) => Promise<T>,
): Promise<T> {
  return action(projectChatSkillIds(skillsAvailable, enabledSkillIds))
}
