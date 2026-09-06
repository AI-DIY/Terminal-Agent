import { z } from 'zod'

/**
 * Product-owned AI skills shown in the Skills view.
 *
 * The v3.2.6 entries are deliberately catalogue-only. They describe the
 * planned operations-platform capabilities but are not wired to a data source
 * yet, so enabling one must not alter an AI request.
 */
export const BUILT_IN_SKILLS = [
  {
    id: 'teleagent-operations',
    name: '系统告警分析',
    source: 'Terminal-Agent 演示技能',
    description: '汇总系统告警并识别异常模式，帮助快速定位需要优先处理的问题。',
    detail: '适合分析告警级别、发生时间和关联主机。',
    defaultEnabled: false,
    demoOnly: true,
    instruction: '采用系统告警分析方式：按严重程度、时间和影响范围归纳告警，区分已确认事实与待验证假设，并优先指出需要人工确认的异常。',
  },
  {
    id: 'codex-development',
    name: '系统日报周报月报分析',
    source: 'Terminal-Agent 演示技能',
    description: '分析系统日报、周报和月报，提炼运行趋势、重复问题和待跟进事项。',
    detail: '适合对比不同周期的运行数据和工作记录。',
    defaultEnabled: false,
    demoOnly: true,
    instruction: '采用系统日报周报月报分析方式：按报告周期整理关键指标、变化趋势和重复问题，明确数据来源与统计范围，并将待跟进事项单独列出。',
  },
  {
    id: 'ssh-troubleshooting',
    name: '系统知识库检索',
    source: 'Terminal-Agent 演示技能',
    description: '从系统知识库中检索相关资料，为故障分析和日常运维提供参考依据。',
    detail: '适合按关键词、主机和问题现象查找知识条目。',
    defaultEnabled: false,
    demoOnly: true,
    instruction: '采用系统知识库检索方式：根据关键词、主机和问题现象查找相关条目，标注资料来源和适用范围，并区分知识库建议与当前 Shell 已验证的事实。',
  },
] as const

/** IDs accepted at trust boundaries for backwards-compatible old requests. */
export const LEGACY_BUILT_IN_SKILL_IDS = ['security-review'] as const
export const BUILT_IN_SKILL_IDS = [
  ...BUILT_IN_SKILLS.map(skill => skill.id),
  ...LEGACY_BUILT_IN_SKILL_IDS,
] as const

export type BuiltInSkill = (typeof BUILT_IN_SKILLS)[number]
export type VisibleBuiltInSkillId = BuiltInSkill['id']
export type BuiltInSkillId = (typeof BUILT_IN_SKILL_IDS)[number]

export const builtInSkillIdSchema = z.enum(BUILT_IN_SKILL_IDS)

const knownSkillIds = new Set<string>(BUILT_IN_SKILL_IDS)
const skillsById = new Map<string, BuiltInSkill>(BUILT_IN_SKILLS.map(skill => [skill.id, skill]))

/** Ignore unknown/repeated ids at the trust boundary. */
export function normalizeBuiltInSkillIds(ids: readonly string[] | undefined): BuiltInSkillId[] {
  if (!ids) return []
  const normalized: BuiltInSkillId[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id) || !knownSkillIds.has(id)) continue
    seen.add(id)
    normalized.push(id as BuiltInSkillId)
  }
  return normalized
}

export function builtInSkillInstructions(ids: readonly string[] | undefined): string[] {
  // v3.2.6 skills are presentation-only until their platform integrations
  // are implemented. Legacy IDs are accepted above but intentionally have
  // no effect either.
  return normalizeBuiltInSkillIds(ids).flatMap(id => {
    const skill = skillsById.get(id)
    return skill && !skill.demoOnly ? [skill.instruction] : []
  })
}
