import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { defaultRegexFenceRules, type RegexFenceRule, validateRegexFenceRules } from '../agent/regex-fence-service'

export class FileRegexRuleRepository {
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(private readonly path: string) {}

  async load(): Promise<RegexFenceRule[]> {
    try {
      return validateRegexFenceRules(JSON.parse(await readFile(this.path, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return cloneRules(defaultRegexFenceRules)
      throw error
    }
  }

  async save(rules: RegexFenceRule[]): Promise<void> {
    const projected = validateRegexFenceRules(rules)
    const write = this.writeQueue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true })
      const temporaryPath = `${this.path}.${randomUUID()}.tmp`
      await writeFile(temporaryPath, JSON.stringify(projected), 'utf8')
      await rename(temporaryPath, this.path)
    })
    this.writeQueue = write.catch(() => undefined)
    return write
  }
}

function cloneRules(rules: RegexFenceRule[]): RegexFenceRule[] {
  return rules.map(rule => ({ ...rule }))
}
