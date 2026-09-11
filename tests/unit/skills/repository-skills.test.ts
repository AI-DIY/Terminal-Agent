import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SkillService } from '../../../src/main/skills/skill-service'

// The shipped catalogue lives next to the application root; packaged builds
// copy it beside the executable.  Discovery, loading and auxiliary-file reads
// are exercised against the repository copy so a missing or renamed Skill is
// caught before packaging.
const skillsDirectory = fileURLToPath(new URL('../../../.skills', import.meta.url))
// `query-system-inspection` is distributed with the local and packaged
// catalogue but is deliberately not tracked in this repository, so a clean
// clone legitimately has no copy to exercise.
const hasQuerySystemInspection = existsSync(join(skillsDirectory, 'query-system-inspection', 'SKILL.md'))

describe('repository standard Skills', () => {
  it.skipIf(!hasQuerySystemInspection)('ships a loadable query-system-inspection Skill', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'terminal-agent-repo-skills-'))
    try {
      const service = new SkillService({ skillsDirectory, statePath: join(stateDirectory, 'skills-state.json') })
      const catalog = await service.initialize()

      const skill = catalog.skills.find(item => item.id === 'query-system-inspection')
      expect(skill).toMatchObject({ id: 'query-system-inspection', name: 'query-system-inspection', enabled: true })
      expect(skill?.description).toContain('工号')
      expect(catalog.diagnostics.filter(item => item.directory === 'query-system-inspection')).toEqual([])

      const document = await service.load({ id: 'query-system-inspection' })
      expect(document.content).toContain('查询流程')
      expect(document.content).toContain('references/api.md')

      const script = await service.readFile({ id: 'query-system-inspection', path: 'scripts/query-system.js' })
      expect(script.content).toContain('systemList')

      // The documented entry point must really run in the Skill directory.
      const result = await service.runCommand({
        id: 'query-system-inspection',
        invocationId: randomUUID(),
        executable: process.execPath,
        args: ['scripts/query-system.js'],
      })
      expect(result.timedOut).toBe(false)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('用法')
    } finally {
      await rm(stateDirectory, { recursive: true, force: true })
    }
  })
})
