import { describe, expect, it } from 'vitest'
import { testRegexFenceRules, validateRegexFenceRules } from '../../../src/renderer/src/components/settings/regex-fence-rule-tester'

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

  it('rejects invalid enabled rules before save', () => {
    expect(validateRegexFenceRules([
      { id: 'broken', name: '\u574f\u89c4\u5219', pattern: '[', enabled: true },
    ])).toEqual({ valid: false, error: '\u89c4\u5219\u201c\u574f\u89c4\u5219\u201d\u4e2d\u7684\u6b63\u5219\u8868\u8fbe\u5f0f\u65e0\u6548\u3002' })
    expect(validateRegexFenceRules([
      { id: 'disabled', name: '\u505c\u7528\u89c4\u5219', pattern: '[', enabled: false },
    ])).toEqual({ valid: false, error: '\u89c4\u5219\u201c\u505c\u7528\u89c4\u5219\u201d\u4e2d\u7684\u6b63\u5219\u8868\u8fbe\u5f0f\u65e0\u6548\u3002' })
  })
})
