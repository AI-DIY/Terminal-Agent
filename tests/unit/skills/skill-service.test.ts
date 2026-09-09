import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SkillService, resolveSkillsDirectory } from '../../../src/main/skills/skill-service'

const temporaryDirectories: string[] = []
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function fixture(): Promise<{ root: string; skills: string; state: string }> {
  const root = await mkdtemp(join(tmpdir(), 'terminal-agent-skills-'))
  temporaryDirectories.push(root)
  const skills = join(root, '.skills')
  const state = join(root, 'userData', 'skills-state.json')
  await mkdir(skills, { recursive: true })
  return { root, skills, state }
}

function document(name: string, description = 'A test skill'): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nUse this skill.\n`
}

describe('dynamic Skill discovery and state', () => {
  it('discovers valid standard directories and keeps malformed entries as diagnostics', async () => {
    const paths = await fixture()
    await mkdir(join(paths.skills, 'valid-skill'))
    await writeFile(join(paths.skills, 'valid-skill', 'SKILL.md'), document('valid-skill'), 'utf8')
    await mkdir(join(paths.skills, 'missing-skill'))
    await mkdir(join(paths.skills, 'bad-skill'))
    await writeFile(join(paths.skills, 'bad-skill', 'SKILL.md'), '# no frontmatter', 'utf8')
    const service = new SkillService({ skillsDirectory: paths.skills, statePath: paths.state })

    const catalog = await service.initialize()
    expect(catalog.skills).toEqual([{ id: 'valid-skill', name: 'valid-skill', description: 'A test skill', enabled: true }])
    expect(catalog.diagnostics.map(item => item.code)).toEqual(['invalid-frontmatter', 'missing-skill-file'])
  })

  it('persists disable state across refresh and a new service instance', async () => {
    const paths = await fixture()
    await mkdir(join(paths.skills, 'persisted'))
    await writeFile(join(paths.skills, 'persisted', 'SKILL.md'), document('persisted'), 'utf8')
    const first = new SkillService({ skillsDirectory: paths.skills, statePath: paths.state })
    await first.initialize()
    await first.setEnabled({ id: 'persisted', enabled: false })
    const second = new SkillService({ skillsDirectory: paths.skills, statePath: paths.state })
    expect((await second.initialize()).skills[0]?.enabled).toBe(false)
    await writeFile(join(paths.skills, 'persisted', 'SKILL.md'), document('persisted', 'updated'), 'utf8')
    expect((await second.refresh()).skills[0]).toMatchObject({ id: 'persisted', description: 'updated', enabled: false })
  })

  it('reads only contained auxiliary files and rejects traversal', async () => {
    const paths = await fixture()
    const skillDir = join(paths.skills, 'reader')
    await mkdir(join(skillDir, 'references'), { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), document('reader'), 'utf8')
    await writeFile(join(skillDir, 'references', 'note.txt'), 'hello', 'utf8')
    const service = new SkillService({ skillsDirectory: paths.skills, statePath: paths.state })
    await service.initialize()
    expect((await service.readFile({ id: 'reader', path: 'references/note.txt' })).content).toBe('hello')
    await expect(service.readFile({ id: 'reader', path: '../reader/SKILL.md' })).rejects.toThrow(/relative|escapes/i)
  })

  it('resolves development and packaged directories independently of cwd', () => {
    expect(resolveSkillsDirectory({ isPackaged: false, appPath: 'C:\\app' })).toBe(join('C:\\app', '.skills'))
    expect(resolveSkillsDirectory({ isPackaged: true, executablePath: 'C:\\app\\Terminal-Agent.exe', cwd: 'C:\\elsewhere' })).toBe(join('C:\\app', '.skills'))
  })

  it('does not execute a disabled skill', async () => {
    const paths = await fixture()
    const skillDir = join(paths.skills, 'disabled')
    await mkdir(skillDir)
    await writeFile(join(skillDir, 'SKILL.md'), document('disabled'), 'utf8')
    const service = new SkillService({ skillsDirectory: paths.skills, statePath: paths.state })
    await service.initialize()
    await service.setEnabled({ id: 'disabled', enabled: false })
    await expect(service.runCommand({ id: 'disabled', invocationId: crypto.randomUUID(), command: 'node -e "console.log(1)"' })).rejects.toThrow(/disabled/i)
  })
})
