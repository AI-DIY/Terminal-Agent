export type RegexFenceRule = {
  id: string
  name: string
  pattern: string
  enabled: boolean
}

export type RegexFenceMatch = Pick<RegexFenceRule, 'id' | 'name'>

export const defaultRegexFenceRules: RegexFenceRule[] = [
  { id: 'kill-process', name: '终止进程', pattern: '\\b(?:kill|killall|pkill)\\b', enabled: true },
  { id: 'terminal-editor', name: '交互式编辑器', pattern: '\\b(?:vi|vim|nvim)\\b', enabled: true },
  { id: 'remove-files', name: '删除文件', pattern: '\\brm(?:\\s|$)', enabled: true },
  { id: 'service-change', name: '服务状态变更', pattern: '\\bsystemctl\\s+(?:stop|restart|reload|disable|mask)\\b', enabled: true },
  { id: 'host-power', name: '主机关机或重启', pattern: '\\b(?:shutdown|reboot|poweroff|halt)\\b', enabled: true },
  { id: 'disk-format', name: '磁盘分区或格式化', pattern: '\\b(?:mkfs|fdisk|parted)\\b', enabled: true },
]

export class RegexFenceService {
  private readonly rules: RegexFenceRule[]

  constructor(rules: RegexFenceRule[]) {
    this.rules = validateRegexFenceRules(rules)
  }

  match(command: string): RegexFenceMatch | null {
    for (const rule of this.rules) {
      if (rule.enabled && new RegExp(rule.pattern, 'iu').test(command)) {
        return { id: rule.id, name: rule.name }
      }
    }
    return null
  }
}

export function validateRegexFenceRules(value: unknown): RegexFenceRule[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('Invalid safety fence rules')
  const ids = new Set<string>()
  return value.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Invalid safety fence rules')
    const rule = entry as Record<string, unknown>
    const id = requiredText(rule.id, 128)
    const name = requiredText(rule.name, 128)
    const pattern = requiredText(rule.pattern, 2_048)
    if (typeof rule.enabled !== 'boolean' || ids.has(id)) throw new Error('Invalid safety fence rules')
    assertSafeRegexPattern(pattern)
    try {
      new RegExp(pattern, 'iu')
    } catch {
      throw new Error('Invalid safety fence regex')
    }
    ids.add(id)
    return { id, name, pattern, enabled: rule.enabled }
  })
}

function assertSafeRegexPattern(pattern: string): void {
  if (/\\[1-9]|\\k<[^>]+>/.test(pattern)) {
    throw new Error('Unsafe safety fence regex')
  }
  let unboundedQuantifiers = 0

  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]
    if (character === '\\') {
      index += 1
      continue
    }
    if (character === '[') {
      index = skipCharacterClass(pattern, index)
      continue
    }
    if (character === '(' && pattern[index + 1] === '?') {
      if (pattern[index + 2] !== ':') throw new Error('Unsafe safety fence regex')
      index += 2
      continue
    }
    if (character === '*' || character === '+') {
      unboundedQuantifiers += 1
      if (unboundedQuantifiers > 1 || !isSimpleQuantifierTarget(pattern[index - 1])) {
        throw new Error('Unsafe safety fence regex')
      }
      continue
    }
    // User rules are intentionally limited to a non-repeating subset with one simple repetition.
    if (character === '?' || character === '{') throw new Error('Unsafe safety fence regex')
  }
}

function isSimpleQuantifierTarget(character: string | undefined): boolean {
  return Boolean(character && !'()|^$*+?{}'.includes(character))
}

function skipCharacterClass(pattern: string, index: number): number {
  for (let cursor = index + 1; cursor < pattern.length; cursor += 1) {
    if (pattern[cursor] === '\\') {
      cursor += 1
      continue
    }
    if (pattern[cursor] === ']') return cursor
  }
  return pattern.length
}

function requiredText(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum) {
    throw new Error('Invalid safety fence rules')
  }
  return value.trim()
}
