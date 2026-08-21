import { app, safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export interface SecretStore {
  load(key: string): Promise<string | null>
  save(key: string, value: string): Promise<void>
  remove(key: string): Promise<void>
}

type EncryptedValues = Record<string, string>

export class ElectronSecretStore implements SecretStore {
  private readonly filePath: string
  private mutationTail: Promise<void> = Promise.resolve()

  constructor(filePath = join(app.getPath('userData'), 'secrets.json')) {
    this.filePath = filePath
  }

  async load(key: string): Promise<string | null> {
    return this.enqueue(async () => {
      const values = await this.readValues()
      const value = values[key]
      return value ? safeStorage.decryptString(Buffer.from(value, 'base64')) : null
    })
  }

  async save(key: string, value: string): Promise<void> {
    return this.enqueue(async () => {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('OS-protected storage is unavailable for the API key')
      }

      const values = await this.readValues()
      values[key] = safeStorage.encryptString(value).toString('base64')
      await this.writeValues(values)
    })
  }

  async remove(key: string): Promise<void> {
    return this.enqueue(async () => {
      const values = await this.readValues()
      if (!(key in values)) return
      delete values[key]
      await this.writeValues(values)
    })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation)
    this.mutationTail = result.then(() => undefined, () => undefined)
    return result
  }

  private async writeValues(values: EncryptedValues): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`
    await writeFile(temporaryPath, JSON.stringify(values), 'utf8')
    await rename(temporaryPath, this.filePath)
  }

  private async readValues(): Promise<EncryptedValues> {
    try {
      return JSON.parse(await readFile(this.filePath, 'utf8')) as EncryptedValues
    } catch (error: unknown) {
      if (isMissingFile(error)) {
        return {}
      }
      throw error
    }
  }
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
