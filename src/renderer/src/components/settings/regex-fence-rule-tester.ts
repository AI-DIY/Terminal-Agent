import { validateRegexFenceRules as validateEngineRules, type RegexFenceRule } from '../../../../main/agent/regex-fence-service'

export type RegexFenceValidation = { valid: boolean; error: string }

export function validateRegexFenceRules(rules: RegexFenceRule[]): RegexFenceValidation {
  for (const rule of rules) {
    try {
      validateEngineRules([rule])
    } catch {
      return { valid: false, error: `规则“${rule.name}”中的正则表达式无效。` }
    }
  }
  return { valid: true, error: '' }
}

export function testRegexFenceRules(rules: RegexFenceRule[], command: string): string {
  try {
    const safeRules = validateEngineRules(rules)
    const matched = safeRules.find(rule => rule.enabled && new RegExp(rule.pattern, 'iu').test(command))
    return matched ? `命中即拦截：${matched.name}` : '未命中'
  } catch {
    return '规则无效或不安全，无法测试匹配。'
  }
}
