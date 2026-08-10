import { describe, expect, it } from 'vitest'
import { defaultRegexFenceRules, RegexFenceService, validateRegexFenceRules } from '../../../src/main/agent/regex-fence-service'

const rules = [
  { id: 'kill', name: '终止进程', pattern: '\\b(?:kill|killall|pkill)\\b', enabled: true },
  { id: 'editor', name: '交互式编辑器', pattern: '\\b(?:vi|vim|nvim)\\b', enabled: true },
]

describe('RegexFenceService', () => {
  it('returns the first matching enabled rule from the final command text', () => {
    expect(new RegexFenceService(rules).match('sudo kill -9 1234')).toEqual({ id: 'kill', name: '终止进程' })
  })

  it('does not match disabled rules', () => {
    expect(new RegexFenceService([{ ...rules[0], enabled: false }]).match('kill -9 1234')).toBeNull()
  })

  it.each([
    ['command substitution', 'echo "$(kill -9 1234)"', 'kill-process'],
    ['backtick substitution', 'echo `rm -rf /tmp/cache`', 'remove-files'],
    ['shell wrapper', "sh -c 'systemctl restart nginx'", 'service-change'],
    ['line break', 'printf ready\nsudo reboot', 'host-power'],
    ['interactive editor nested in a shell expression', 'result=$(vim /etc/nginx/nginx.conf)', 'terminal-editor'],
  ])('matches the default local rule for a dangerous command in %s', (_name, command, ruleId) => {
    expect(new RegexFenceService(defaultRegexFenceRules).match(command)).toMatchObject({ id: ruleId })
  })

  it('rejects user rules with nested unbounded quantifiers or backreferences before they can be stored', () => {
    const unsafe = (pattern: string) => [{ id: 'unsafe', name: '不安全规则', pattern, enabled: true }]

    expect(() => validateRegexFenceRules(unsafe('^(a+)+$'))).toThrow('Unsafe safety fence regex')
    expect(() => validateRegexFenceRules(unsafe('^((a+))+$'))).toThrow('Unsafe safety fence regex')
    expect(() => validateRegexFenceRules(unsafe('^(?:(?:a+))+$'))).toThrow('Unsafe safety fence regex')
    expect(() => validateRegexFenceRules(unsafe('^((a+)){2,}$'))).toThrow('Unsafe safety fence regex')
    expect(() => validateRegexFenceRules(unsafe('^a*a*a*a*a*a*a*a*a*a*a*a*$'))).toThrow('Unsafe safety fence regex')
    expect(() => validateRegexFenceRules(unsafe('(a)\\1+'))).toThrow('Unsafe safety fence regex')
  })
})
