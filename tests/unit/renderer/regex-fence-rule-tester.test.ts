import { describe, expect, it } from 'vitest'
import { testRegexFenceRules } from '../../../src/renderer/src/components/settings/regex-fence-rule-tester'

describe('regex fence rule tester', () => {
  it('reports an invalid or unsafe user pattern instead of throwing in the settings page', () => {
    expect(testRegexFenceRules([
      { id: 'unsafe', name: '不安全规则', pattern: '^(a+)+$', enabled: true },
    ], 'aaaaaaaaaaaaaaaa')).toBe('规则无效或不安全，无法测试匹配。')
  })

  it('reports the matched enabled rule for a safe local pattern', () => {
    expect(testRegexFenceRules([
      { id: 'kill', name: '终止进程', pattern: '\\bkill\\b', enabled: true },
    ], 'kill -9 1234')).toBe('命中即拦截：终止进程')
  })
})
