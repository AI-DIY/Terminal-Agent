import { validateRegexFenceRules, type RegexFenceRule } from '../../../../main/agent/regex-fence-service'

export function testRegexFenceRules(rules: RegexFenceRule[], command: string): string {
  try {
    const safeRules = validateRegexFenceRules(rules)
    const matched = safeRules.find(rule => rule.enabled && new RegExp(rule.pattern, 'iu').test(command))
    return matched ? `命中即拦截：${matched.name}` : '未命中'
  } catch {
    return '规则无效或不安全，无法测试匹配。'
  }
}
