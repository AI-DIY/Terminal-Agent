import { AtomicJsonStore } from '../persistence/atomic-json-store'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import {
  skillCatalogSchema,
  skillCommandRequestSchema,
  skillDescriptionSchema,
  skillDiagnosticSchema,
  skillDocumentSchema,
  skillFileSchema,
  skillFileReadRequestSchema,
  skillIdSchema,
  skillLoadRequestSchema,
  skillSetEnabledRequestSchema,
  skillSummarySchema,
  type SkillCatalog,
  type SkillDiagnostic,
  type SkillDocument,
  type SkillFile,
  type SkillId,
} from '../../shared/skill-contracts'
import { SkillCommandExecutor } from './skill-command-executor'
import type { SkillCommandRequest, SkillCommandResult } from '../../shared/skill-contracts'

const skillStateSchema = z.record(skillIdSchema, z.boolean())
type SkillState = z.infer<typeof skillStateSchema>

const DEFAULT_MAX_SKILL_BYTES = 2_000_000

export type SkillFileSystem = {
  readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>
  readFile(path: string, encoding: 'utf8'): Promise<string>
  realpath(path: string): Promise<string>
  stat(path: string): Promise<{ isDirectory(): boolean }>
}

const defaultFileSystem: SkillFileSystem = {
  readdir: (path, options) => readdir(path, options),
  readFile: (path, encoding) => readFile(path, encoding),
  realpath: path => realpath(path),
  stat: path => stat(path),
}

export type SkillServiceOptions = {
  /** Absolute directory containing one subdirectory per Skill. */
  skillsDirectory: string
  /** User-scoped state file (normally userData/skills-state.json). */
  statePath: string
  fileSystem?: Partial<SkillFileSystem>
  maxSkillBytes?: number
  commandExecutor?: SkillCommandExecutor
}

export type SkillDirectoryResolutionOptions = {
  isPackaged: boolean
  /** Electron's stable app root in development (normally app.getAppPath()). */
  appPath?: string
  /** Absolute executable path in packaged builds. */
  executablePath?: string
  /** Last-resort development root; never used for packaged builds. */
  cwd?: string
}

/** Resolve the external Skill directory without depending on startup cwd. */
export function resolveSkillsDirectory(options: SkillDirectoryResolutionOptions): string {
  if (options.isPackaged) {
    const executablePath = options.executablePath?.trim()
    if (!executablePath || !isAbsolute(executablePath)) throw new Error('Packaged Skill directory requires an absolute executable path')
    return join(dirname(executablePath), '.skills')
  }
  const appPath = options.appPath?.trim()
  if (appPath && isAbsolute(appPath)) return join(appPath, '.skills')
  const cwd = options.cwd?.trim() || process.cwd()
  return join(cwd, '.skills')
}

type DiscoveredSkill = {
  id: SkillId
  name: SkillId
  description: string
  directory: string
  relativeDirectory: string
  content: string
}

/**
 * Discovers standard `.skills/<name>/SKILL.md` directories and owns the
 * renderer-facing enabled state.  The scanner is intentionally best-effort:
 * one malformed directory is represented as a diagnostic while healthy
 * Skills remain available.
 */
export class SkillService {
  private readonly fileSystem: SkillFileSystem
  private readonly maxSkillBytes: number
  private readonly stateStore: AtomicJsonStore<SkillState>
  private readonly commandExecutor: SkillCommandExecutor
  private readonly discovered = new Map<SkillId, DiscoveredSkill>()
  private diagnostics: SkillDiagnostic[] = []
  private state: SkillState = {}
  private initialized = false
  private refreshing: Promise<SkillCatalog> | undefined
  private readonly listeners = new Set<(catalog: SkillCatalog) => void>()

  constructor(options: SkillServiceOptions)
  constructor(skillsDirectory: string, statePath: string, options?: Omit<SkillServiceOptions, 'skillsDirectory' | 'statePath'>)
  constructor(
    optionsOrDirectory: SkillServiceOptions | string,
    statePath?: string,
    overrides: Omit<SkillServiceOptions, 'skillsDirectory' | 'statePath'> = {},
  ) {
    const options: SkillServiceOptions = typeof optionsOrDirectory === 'string'
      ? { skillsDirectory: optionsOrDirectory, statePath: statePath!, ...overrides }
      : optionsOrDirectory
    if (!options.skillsDirectory || !isAbsolute(options.skillsDirectory)) {
      throw new Error('skillsDirectory must be an absolute path')
    }
    if (!options.statePath || !isAbsolute(options.statePath)) {
      throw new Error('statePath must be an absolute path')
    }
    this.fileSystem = { ...defaultFileSystem, ...options.fileSystem }
    this.maxSkillBytes = Math.max(1, Math.floor(options.maxSkillBytes ?? DEFAULT_MAX_SKILL_BYTES))
    this.stateStore = new AtomicJsonStore(options.statePath, skillStateSchema, () => ({}), { backupCorrupt: false })
    this.stateStorePath = options.statePath
    this.skillsDirectory = resolve(options.skillsDirectory)
    this.commandExecutor = options.commandExecutor ?? new SkillCommandExecutor(skillId => {
      const skill = this.discovered.get(skillId)
      if (!skill) throw new Error(`Skill not found: ${skillId}`)
      return skill.directory
    })
  }

  readonly skillsDirectory: string

  /** Scan once at startup or explicitly refresh the page. */
  async initialize(): Promise<SkillCatalog> {
    return this.refresh()
  }

  async refresh(): Promise<SkillCatalog> {
    if (this.refreshing) return this.refreshing
    this.refreshing = this.scan().finally(() => { this.refreshing = undefined })
    return this.refreshing
  }

  async list(): Promise<SkillCatalog> {
    if (!this.initialized) return this.refresh()
    return this.snapshot()
  }

  async setEnabled(input: { id: string; enabled: boolean }): Promise<SkillCatalog> {
    const request = skillSetEnabledRequestSchema.parse(input)
    if (!this.initialized) await this.refresh()
    if (!this.discovered.has(request.id)) throw new Error(`Skill not found: ${request.id}`)
    const previous = this.state[request.id]
    try {
      this.state = await this.stateStore.update(current => ({ ...current, [request.id]: request.enabled }))
    } catch (error) {
      // Keep the in-memory projection unchanged so a renderer can restore its
      // switch after an atomic write failure.
      if (previous === undefined) delete this.state[request.id]
      else this.state[request.id] = previous
      throw error
    }
    const catalog = this.snapshot()
    this.emit(catalog)
    return catalog
  }

  async load(input: { id: string }): Promise<SkillDocument> {
    const request = skillLoadRequestSchema.parse(input)
    if (!this.initialized) await this.refresh()
    const skill = this.discovered.get(request.id)
    if (!skill) throw new Error(`Skill not found: ${request.id}`)
    if (!this.isEnabled(skill.id)) throw new Error(`Skill is disabled: ${skill.id}`)
    return skillDocumentSchema.parse({ id: skill.id, name: skill.name, description: skill.description, content: skill.content })
  }

  async readFile(input: { id: string; path: string }): Promise<SkillFile> {
    const request = skillFileReadRequestSchema.parse(input)
    if (!this.initialized) await this.refresh()
    const skill = this.discovered.get(request.id)
    if (!skill) throw new Error(`Skill not found: ${request.id}`)
    if (!this.isEnabled(skill.id)) throw new Error(`Skill is disabled: ${skill.id}`)
    const safePath = normalizeRelativePath(request.path)
    const target = await this.resolveContainedPath(skill.directory, safePath)
    const content = await this.fileSystem.readFile(target, 'utf8')
    if (Buffer.byteLength(content, 'utf8') > this.maxSkillBytes) throw new Error('Skill file is too large')
    return skillFileSchema.parse({ id: skill.id, path: safePath, content })
  }

  async runCommand(input: SkillCommandRequest, signal?: AbortSignal): Promise<SkillCommandResult> {
    if (!this.initialized) await this.refresh()
    const parsed = skillCommandRequestSchema.parse(input)
    if (!this.discovered.has(parsed.id)) throw new Error(`Skill not found: ${parsed.id}`)
    if (!this.isEnabled(parsed.id)) throw new Error(`Skill is disabled: ${parsed.id}`)
    return this.commandExecutor.run(parsed, signal)
  }

  cancelCommand(invocationId: string): boolean {
    return this.commandExecutor.cancel(invocationId)
  }

  cancelAllCommands(): void {
    this.commandExecutor.cancelAll()
  }

  getEnabledIds(): SkillId[] {
    return [...this.discovered.values()].filter(skill => this.isEnabled(skill.id)).map(skill => skill.id)
  }

  isEnabled(id: string): boolean {
    return this.state[id] ?? true
  }

  onChanged(listener: (catalog: SkillCatalog) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getDiagnostics(): SkillDiagnostic[] {
    return this.diagnostics.map(item => ({ ...item }))
  }

  /** Return a full document for trusted main-process model/tool calls. */
  getLoadedDocument(id: string): SkillDocument | undefined {
    const parsed = skillIdSchema.safeParse(id)
    if (!parsed.success) return undefined
    const skill = this.discovered.get(parsed.data)
    return skill ? { id: skill.id, name: skill.name, description: skill.description, content: skill.content } : undefined
  }

  private async scan(): Promise<SkillCatalog> {
    const diagnostics: SkillDiagnostic[] = []
    const candidates: DiscoveredSkill[] = []
    let directories: Dirent[]
    try {
      directories = await this.fileSystem.readdir(this.skillsDirectory, { withFileTypes: true })
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code
      if (code !== 'ENOENT') diagnostics.push(diagnostic('.', 'unreadable-directory', publicError(error, 'Unable to scan Skills directory')))
      // A missing `.skills` directory is a valid empty state.  Do not create
      // it during startup; users can copy a Skill and press Refresh.
      this.discovered.clear()
      this.diagnostics = diagnostics
      await this.loadState(diagnostics)
      this.initialized = true
      const catalog = this.snapshot()
      this.emit(catalog)
      return catalog
    }

    // Sort for deterministic UI order and deterministic duplicate handling.
    directories = directories.filter(entry => entry.isDirectory()).sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of directories) {
      const directoryName = entry.name
      const directory = resolve(this.skillsDirectory, directoryName)
      const skillPath = resolve(directory, 'SKILL.md')
      let content: string
      try {
        content = await this.fileSystem.readFile(skillPath, 'utf8')
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code
        diagnostics.push(diagnostic(directoryName, code === 'ENOENT' ? 'missing-skill-file' : 'unreadable-skill-file', publicError(error, code === 'ENOENT' ? 'SKILL.md is missing' : 'SKILL.md cannot be read')))
        continue
      }
      if (Buffer.byteLength(content, 'utf8') > this.maxSkillBytes) {
        diagnostics.push(diagnostic(directoryName, 'unreadable-skill-file', `SKILL.md exceeds the ${this.maxSkillBytes}-byte limit`))
        continue
      }
      const parsed = parseSkillDocument(content)
      if (!parsed.ok) {
        diagnostics.push(diagnostic(directoryName, parsed.code, parsed.message))
        continue
      }
      if (parsed.name !== directoryName) {
        diagnostics.push(diagnostic(directoryName, 'name-mismatch', `Skill name "${parsed.name}" must match directory "${directoryName}"`))
        continue
      }
      candidates.push({
        id: parsed.name,
        name: parsed.name,
        description: parsed.description,
        directory,
        relativeDirectory: directoryName,
        content,
      })
    }

    const byName = new Map<string, DiscoveredSkill[]>()
    for (const candidate of candidates) {
      const key = candidate.id.toLowerCase()
      const same = byName.get(key) ?? []
      same.push(candidate)
      byName.set(key, same)
    }
    this.discovered.clear()
    for (const [key, same] of byName) {
      if (same.length > 1) {
        for (const candidate of same) diagnostics.push(diagnostic(candidate.relativeDirectory, 'duplicate-name', `Duplicate Skill name "${candidate.id}"`))
        continue
      }
      // Preserve the canonical casing from the file while lookup remains
      // strict; standard IDs are normally lower-case and case-safe.
      void key
      this.discovered.set(same[0]!.id, same[0]!)
    }
    await this.loadState(diagnostics)
    this.diagnostics = diagnostics
    this.initialized = true
    const catalog = this.snapshot()
    this.emit(catalog)
    return catalog
  }

  private async loadState(diagnostics: SkillDiagnostic[]): Promise<void> {
    try {
      this.state = await this.stateStore.load()
    } catch (error) {
      // A malformed state file must not prevent ordinary chat or a fresh scan.
      this.state = {}
      diagnostics.push(diagnostic(basename(dirname(this.stateStorePath)), 'state-unavailable', publicError(error, 'Skill enabled state could not be loaded')))
    }
  }

  private stateStorePath: string

  private snapshot(): SkillCatalog {
    return skillCatalogSchema.parse({
      skills: [...this.discovered.values()].map(skill => skillSummarySchema.parse({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        enabled: this.isEnabled(skill.id),
      })),
      diagnostics: this.diagnostics,
    })
  }

  private emit(catalog: SkillCatalog): void {
    for (const listener of this.listeners) {
      try { listener(catalog) } catch { /* Renderer notification is best-effort. */ }
    }
  }

  private async resolveContainedPath(directory: string, relativePath: string): Promise<string> {
    const candidate = resolve(directory, relativePath)
    const base = await this.fileSystem.realpath(directory)
    const resolvedCandidate = await this.fileSystem.realpath(candidate)
    const prefix = base.endsWith(sep) ? base : `${base}${sep}`
    if (resolvedCandidate !== base && !resolvedCandidate.startsWith(prefix)) throw new Error('Skill file path escapes its directory')
    return resolvedCandidate
  }
}

function parseSkillDocument(content: string):
  | { ok: true; name: SkillId; description: string }
  | { ok: false; code: SkillDiagnostic['code']; message: string } {
  const normalized = content.replace(/^\uFEFF/, '')
  const match = normalized.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|\s*$)/)
  if (!match) return { ok: false, code: 'invalid-frontmatter', message: 'SKILL.md must begin with YAML frontmatter delimited by ---' }
  let metadata: unknown
  try { metadata = parseYaml(match[1] ?? '') } catch (error) {
    return { ok: false, code: 'invalid-frontmatter', message: publicError(error, 'YAML frontmatter is invalid') }
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return { ok: false, code: 'invalid-frontmatter', message: 'YAML frontmatter must be an object' }
  const record = metadata as Record<string, unknown>
  const nameResult = skillIdSchema.safeParse(record.name)
  if (!nameResult.success) return { ok: false, code: 'invalid-name', message: 'Frontmatter name must be a path-safe Skill id' }
  const descriptionResult = skillDescriptionSchema.safeParse(record.description)
  if (!descriptionResult.success) return { ok: false, code: 'invalid-frontmatter', message: 'Frontmatter description must be non-empty text' }
  return { ok: true, name: nameResult.data, description: descriptionResult.data }
}

function normalizeRelativePath(value: string): string {
  const candidate = value.trim().replaceAll('\\', '/')
  if (!candidate || candidate.startsWith('/') || isAbsolute(candidate) || candidate.split('/').some(part => part === '..' || part === '')) {
    throw new Error('Skill file path must be relative to the Skill directory')
  }
  return relative('.', candidate).replaceAll('\\', '/') || candidate
}

function diagnostic(directory: string, code: SkillDiagnostic['code'], message: string): SkillDiagnostic {
  return skillDiagnosticSchema.parse({ directory: directory.slice(0, 256), code, message: message.slice(0, 2_000) })
}

function publicError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message.trim() : ''
  return message || fallback
}
