import { app } from 'electron'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { PersistedModelSettings } from '../../shared/validation'

export interface SettingsRepository {
  load(): Promise<PersistedModelSettings | null>
  save(settings: PersistedModelSettings): Promise<void>
}

export class JsonSettingsRepository implements SettingsRepository {
  private readonly filePath: string

  constructor(filePath = join(app.getPath('userData'), 'settings.json')) {
    this.filePath = filePath
  }

  async load(): Promise<PersistedModelSettings | null> {
    try {
      return JSON.parse(await readFile(this.filePath, 'utf8')) as PersistedModelSettings
    } catch (error: unknown) {
      if (isMissingFile(error)) {
        return null
      }
      throw error
    }
  }

  async save(settings: PersistedModelSettings): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.tmp`
    await writeFile(temporaryPath, JSON.stringify(settings), 'utf8')
    await rename(temporaryPath, this.filePath)
  }
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
