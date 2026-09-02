/**
 * Product-owned AI skills. These are static, reviewable instructions rather
 * than user-authored prompt text, so enabling a skill cannot inject arbitrary
 * instructions into an AI request.
 */
export const BUILT_IN_SKILLS = [
  {
    id: 'teleagent-operations',
    name: 'TeleAgent 运维协作',
    source: 'TeleAgent 内置技能',
    description: '把多主机巡检、状态汇总和执行前确认整理成可复用的运维流程。',
    detail: '适合跨主机查看服务状态、日志和资源使用情况。',
    defaultEnabled: true,
    instruction: '采用运维协作方式：先归纳各在线主机的观察结果和差异；涉及执行时按主机拆分步骤，并清楚说明每一步的目的和影响范围。',
  },
  {
    id: 'codex-development',
    name: 'Codex 开发助手',
    source: 'Codex 内置技能',
    description: '辅助阅读代码、拆解任务、生成补丁并在执行前展示变更计划。',
    detail: '适合代码审查、故障定位和小范围工程修改。',
    defaultEnabled: true,
    instruction: '采用开发协作方式：先区分已确认事实、待验证假设和建议操作；对于代码或配置变更，先给出可审查的计划，避免把推测表述为事实。',
  },
  {
    id: 'ssh-troubleshooting',
    name: 'SSH 故障排查',
    source: 'Terminal-Agent 内置技能',
    description: '根据终端输出梳理连接、权限、进程和网络问题的排查路径。',
    detail: '会优先引用当前选中的 SSH 上下文，不读取未选择的主机。',
    defaultEnabled: true,
    instruction: '采用 SSH 故障排查方式：按连接、认证、权限、进程与网络的顺序提出最小风险的验证步骤；只根据当前任务明确提供的 Shell 上下文下结论。',
  },
  {
    id: 'security-review',
    name: '安全审查',
    source: 'Terminal-Agent 内置技能',
    description: '在执行高风险命令前提示影响范围、回滚方式和常见安全隐患。',
    detail: '默认关闭；启用后仍需手动确认计划，技能不会绕过安全围栏。',
    defaultEnabled: false,
    instruction: '对可能修改、删除、重启、暴露凭据或扩大网络访问的步骤，明确提示影响范围、前置确认和可行的回滚方式；这不会绕过任何既有安全围栏或人工确认。',
  },
] as const

export type BuiltInSkill = (typeof BUILT_IN_SKILLS)[number]
export type BuiltInSkillId = BuiltInSkill['id']

const skillsById = new Map<string, BuiltInSkill>(BUILT_IN_SKILLS.map(skill => [skill.id, skill]))

/** Ignore unknown/repeated ids at the trust boundary. */
export function normalizeBuiltInSkillIds(ids: readonly string[] | undefined): BuiltInSkillId[] {
  if (!ids) return []
  const normalized: BuiltInSkillId[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id) || !skillsById.has(id)) continue
    seen.add(id)
    normalized.push(id as BuiltInSkillId)
  }
  return normalized
}

export function builtInSkillInstructions(ids: readonly string[] | undefined): string[] {
  return normalizeBuiltInSkillIds(ids).flatMap(id => {
    const skill = skillsById.get(id)
    return skill ? [skill.instruction] : []
  })
}
