import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export type AtomicFileWriterFileSystem = {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>
  writeFile(path: string, data: string): Promise<void>
  rename(source: string, destination: string): Promise<void>
  rm(path: string, options: { force: true }): Promise<void>
}

export type AtomicFileWriterOptions = {
  fileSystem?: Partial<AtomicFileWriterFileSystem>
  createId?: () => string
}

const defaultFileSystem: AtomicFileWriterFileSystem = {
  mkdir: (path, options) => mkdir(path, options),
  writeFile: (path, data) => writeFile(path, data, 'utf8'),
  rename: (source, destination) => rename(source, destination),
  rm: (path, options) => rm(path, options),
}

export function createAtomicFileWriter(options: AtomicFileWriterOptions = {}): (path: string, value: unknown) => Promise<void> {
  const fileSystem = { ...defaultFileSystem, ...options.fileSystem }
  const createId = options.createId ?? randomUUID
  return async (path, value) => {
    await fileSystem.mkdir(dirname(path), { recursive: true })
    const temporaryPath = `${path}.${createId()}.tmp`
    try {
      await fileSystem.writeFile(temporaryPath, JSON.stringify(value))
      await fileSystem.rename(temporaryPath, path)
    } catch (error) {
      await fileSystem.rm(temporaryPath, { force: true }).catch(() => undefined)
      throw error
    }
  }
}
