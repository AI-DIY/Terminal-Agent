import { defaultRegexFenceRules, RegexFenceService, type RegexFenceMatch, type RegexFenceRule, validateRegexFenceRules } from '../agent/regex-fence-service'

type RegexRuleRepository = {
  load(): Promise<RegexFenceRule[]>
  save(rules: RegexFenceRule[]): Promise<void>
}

export class RegexRuleSettingsService {
  private rules = cloneRules(defaultRegexFenceRules)

  constructor(private readonly repository: RegexRuleRepository) {}

  async load(): Promise<RegexFenceRule[]> {
    this.rules = validateRegexFenceRules(await this.repository.load())
    return this.list()
  }

  async save(rules: RegexFenceRule[]): Promise<void> {
    const validated = validateRegexFenceRules(rules)
    await this.repository.save(validated)
    this.rules = validated
  }

  list(): RegexFenceRule[] {
    return cloneRules(this.rules)
  }

  match(command: string): RegexFenceMatch | null {
    return new RegexFenceService(this.rules).match(command)
  }
}

function cloneRules(rules: RegexFenceRule[]): RegexFenceRule[] {
  return rules.map(rule => ({ ...rule }))
}
