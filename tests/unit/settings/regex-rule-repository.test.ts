import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileRegexRuleRepository } from '../../../src/main/settings/regex-rule-repository'

describe('FileRegexRuleRepository', () => {
  it('stores only validated regex fence fields', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-rules-'))
    const path = join(directory, 'rules.json')
    try {
      const repository = new FileRegexRuleRepository(path)
      await repository.save([{ id: 'kill', name: '终止进程', pattern: 'kill\\b', enabled: true }])

      expect(await repository.load()).toEqual([{ id: 'kill', name: '终止进程', pattern: 'kill\\b', enabled: true }])
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual([{ id: 'kill', name: '终止进程', pattern: 'kill\\b', enabled: true }])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects invalid regular expressions before persisting them', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-rules-'))
    try {
      const repository = new FileRegexRuleRepository(join(directory, 'rules.json'))
      await expect(repository.save([{ id: 'bad', name: '错误', pattern: '(', enabled: true }])).rejects.toThrow('Invalid safety fence regex')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
