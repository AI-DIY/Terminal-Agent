import { link, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { TextDecoder } from 'node:util'
import { z } from 'zod'

const invalidDataMessage = 'AtomicJsonStore could not read valid JSON data'
const invalidIdMessage = 'AtomicJsonStore createId must return a UUID'
const nonUniqueIdMessage = 'AtomicJsonStore createId must return a unique UUID'
const uuidSchema = z.string().uuid()
const utf8Decoder = new TextDecoder('utf-8', { fatal: true })
const invalidDataErrors = new WeakSet<Error>()

export type AtomicJsonStoreFileSystem = {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>
  readFile(path: string): Promise<Buffer>
  /** Returns a handle that exclusively owns a newly created path or rejects with EEXIST. */
  openExclusive(path: string): Promise<AtomicJsonStoreFileHandle>
  /** Atomically creates destination as a hard link; rejects with EEXIST if it exists. */
  link(source: string, destination: string): Promise<void>
  rename(source: string, destination: string): Promise<void>
  rm(path: string, options: { force: true }): Promise<void>
}

export type AtomicJsonStoreFileHandle = {
  writeFile(data: string | Buffer, options: 'utf8'): Promise<void>
  close(): Promise<void>
}

export type AtomicJsonStoreOptions = {
  now?: () => Date
  createId?: () => string
  fileSystem?: AtomicJsonStoreFileSystem
  migrate?: (persisted: unknown) => { value: unknown; changed: boolean }
  /** Disables raw corrupt-source diagnostic copies for stores that may contain secrets. */
  backupCorrupt?: boolean
  /** @internal Used to force source-key collisions in deterministic tests. */
  corruptSourceKey?: (source: Buffer) => string
}

const defaultFileSystem: AtomicJsonStoreFileSystem = {
  mkdir: (path, options) => mkdir(path, options),
  readFile: (path) => readFile(path),
  openExclusive: async (path) => {
    const handle = await open(path, 'wx')
    return {
      writeFile: (data, options) => handle.writeFile(data, options),
      close: () => handle.close(),
    }
  },
  link: (source, destination) => link(source, destination),
  rename: (source, destination) => rename(source, destination),
  rm: (path, options) => rm(path, options),
}

type CorruptBackup = {
  source: Buffer
  operation: Promise<void>
}

type CorruptBackupCoordinator = {
  tail: Promise<void>
  operationsBySource: Map<string, CorruptBackup[]>
}

const corruptBackupCoordinators = new Map<string, CorruptBackupCoordinator>()

export class AtomicJsonStore<T> {
  private queue: Promise<void> = Promise.resolve()
  private corruptBackup: CorruptBackup | undefined
  private readonly now: () => Date
  private readonly createId: () => string
  private readonly fileSystem: AtomicJsonStoreFileSystem
  private readonly migrate: AtomicJsonStoreOptions['migrate']
  private readonly backupCorrupt: boolean
  private readonly corruptSourceKey: (source: Buffer) => string

  constructor(
    private readonly path: string,
    private readonly schema: z.ZodType<T>,
    private readonly empty: () => T,
    options: AtomicJsonStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date())
    this.createId = options.createId ?? randomUUID
    this.fileSystem = options.fileSystem ?? defaultFileSystem
    this.migrate = options.migrate
    this.backupCorrupt = options.backupCorrupt ?? true
    this.corruptSourceKey = options.corruptSourceKey ?? hashSource
  }

  load(): Promise<T> {
    const operation = this.queue.then(async () => {
      const current = await this.readCurrent()
      if (current.migrated) await this.writeAtomically(current.value)
      return structuredClone(current.value)
    })

    this.queue = operation.then(() => undefined, () => undefined)
    return operation
  }

  update(change: (current: T) => T | Promise<T>): Promise<T> {
    const operation = this.queue.then(async () => {
      const current = (await this.readCurrent()).value
      const next = this.schema.parse(await change(structuredClone(current)))

      await this.writeAtomically(next)
      return structuredClone(next)
    })

    this.queue = operation.then(() => undefined, () => undefined)
    return operation
  }

  /** Explicitly replace the document, used only by an authorized recovery flow. */
  replace(value: T): Promise<T> {
    const operation = this.queue.then(async () => {
      const next = this.schema.parse(value)
      await this.writeAtomically(next)
      this.corruptBackup = undefined
      return structuredClone(next)
    })

    this.queue = operation.then(() => undefined, () => undefined)
    return operation
  }

  /**
   * Create the target exactly once; a competing creator's document wins
   * unchanged.  An optional factory lets callers seed a newly-created file
   * from a legacy location while retaining the same exclusive publication
   * guarantees as the default empty document.
   */
  createIfMissing(initializer?: () => T | Promise<T>): Promise<T> {
    const operation = this.queue.then(async () => {
      try {
        const current = await this.readCurrent(true)
        return structuredClone(current.value)
      } catch (error) {
        if (!isNodeError(error) || error.code !== 'ENOENT') throw error
      }

      const empty = this.schema.parse(await (initializer ? initializer() : this.empty()))
      await this.fileSystem.mkdir(dirname(this.path), { recursive: true })
      const serialized = JSON.stringify(empty)
      const attemptedPaths = new Set<string>()

      while (true) {
        const temporaryPath = `${this.path}.init-${this.createSafeId()}`
        if (attemptedPaths.has(temporaryPath)) throw new Error(nonUniqueIdMessage)
        attemptedPaths.add(temporaryPath)

        try {
          await this.writeExclusively(temporaryPath, serialized)
        } catch (error) {
          if (isNodeError(error) && error.code === 'EEXIST') continue
          throw error
        }

        try {
          await this.fileSystem.link(temporaryPath, this.path)
        } catch (error) {
          await this.fileSystem.rm(temporaryPath, { force: true }).catch(() => undefined)
          if (!isNodeError(error) || error.code !== 'EEXIST') throw error

          try {
            const current = await this.readCurrent()
            return structuredClone(current.value)
          } catch (readError) {
            if (isNodeError(readError) && readError.code === 'ENOENT') continue
            throw readError
          }
        }

        await this.fileSystem.rm(temporaryPath, { force: true }).catch(() => undefined)
        this.corruptBackup = undefined
        return structuredClone(empty)
      }
    })

    this.queue = operation.then(() => undefined, () => undefined)
    return operation
  }

  private async readCurrent(requireExisting = false): Promise<{ value: T; migrated: boolean }> {
    let source: Buffer

    try {
      source = Buffer.from(await this.fileSystem.readFile(this.path))
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        if (requireExisting) throw error
        this.corruptBackup = undefined
        return { value: this.schema.parse(this.empty()), migrated: false }
      }
      throw error
    }

    let decoded: unknown

    try {
      decoded = JSON.parse(utf8Decoder.decode(source))
    } catch (error) {
      if (this.backupCorrupt) await this.backUpCorruptFileOnce(source)
      throw createInvalidDataError(error)
    }

    try {
      const migration = this.migrate?.(decoded)
      const data = this.schema.parse(migration?.value ?? decoded)
      this.corruptBackup = undefined
      return { value: data, migrated: migration?.changed ?? false }
    } catch (error) {
      if (!(error instanceof z.ZodError)) {
        throw error
      }

      if (this.backupCorrupt) await this.backUpCorruptFileOnce(source)
      throw createInvalidDataError(error)
    }
  }

  private async backUpCorruptFileOnce(source: Buffer): Promise<void> {
    if (this.corruptBackup?.source.equals(source)) {
      await this.corruptBackup.operation
      return
    }

    const backup: CorruptBackup = {
      source: Buffer.from(source),
      operation: coordinateCorruptBackup(
        this.path,
        source,
        this.corruptSourceKey,
        (snapshot) => this.backUpCorruptFile(snapshot),
      ),
    }
    this.corruptBackup = backup

    try {
      await backup.operation
    } catch (error) {
      if (this.corruptBackup === backup) {
        this.corruptBackup = undefined
      }
      throw error
    }
  }

  private async backUpCorruptFile(source: Buffer): Promise<void> {
    const sourceSnapshot = Buffer.from(source)
    const timestamp = this.now().toISOString().replace(/[.:]/g, '-')
    const backupStem = `${this.path}.${timestamp}`
    let backupPath = `${backupStem}.corrupt`
    const attemptedPaths = new Set<string>()

    while (true) {
      if (attemptedPaths.has(backupPath)) {
        throw new Error('AtomicJsonStore createId must return a unique UUID')
      }
      attemptedPaths.add(backupPath)

      const collision = await this.writeCorruptBackupExclusively(backupPath, sourceSnapshot)
      if (!collision) return

      backupPath = `${backupStem}-${this.createSafeId()}.corrupt`
    }
  }

  private async writeCorruptBackupExclusively(path: string, source: Buffer): Promise<boolean> {
    const sourceSnapshot = Buffer.from(source)

    while (true) {
      try {
        await this.writeExclusively(path, Buffer.from(sourceSnapshot))
        return false
      } catch (error) {
        if (!isNodeError(error) || error.code !== 'EEXIST') {
          throw error
        }
      }

      try {
        return !Buffer.from(await this.fileSystem.readFile(path)).equals(sourceSnapshot)
      } catch (error) {
        if (!isNodeError(error) || error.code !== 'ENOENT') {
          throw error
        }
      }
    }
  }

  private async writeAtomically(data: T): Promise<void> {
    const directory = dirname(this.path)
    const serialized = JSON.stringify(data)
    const attemptedPaths = new Set<string>()

    await this.fileSystem.mkdir(directory, { recursive: true })

    while (true) {
      const temporaryPath = `${this.path}.tmp-${this.createSafeId()}`
      if (attemptedPaths.has(temporaryPath)) {
        throw new Error(nonUniqueIdMessage)
      }
      attemptedPaths.add(temporaryPath)

      try {
        await this.writeExclusively(temporaryPath, serialized)
      } catch (error) {
        if (isNodeError(error) && error.code === 'EEXIST') {
          continue
        }
        throw error
      }

      try {
        await this.fileSystem.rename(temporaryPath, this.path)
        return
      } catch (error) {
        await this.fileSystem.rm(temporaryPath, { force: true }).catch(() => undefined)
        throw error
      }
    }
  }

  private async writeExclusively(path: string, data: string | Buffer): Promise<void> {
    const handle = await this.fileSystem.openExclusive(path)
    let failure: unknown

    try {
      await handle.writeFile(data, 'utf8')
    } catch (error) {
      failure = error
    }

    try {
      await handle.close()
    } catch (error) {
      failure ??= error
    }

    if (failure !== undefined) {
      await this.fileSystem.rm(path, { force: true }).catch(() => undefined)
      throw failure
    }
  }

  private createSafeId(): string {
    const id = this.createId()
    if (!uuidSchema.safeParse(id).success) {
      throw new Error(invalidIdMessage)
    }
    return id
  }
}

export function isAtomicJsonStoreInvalidDataError(error: unknown): boolean {
  return error instanceof Error && invalidDataErrors.has(error)
}

function createInvalidDataError(cause: unknown): Error {
  const error = new Error(invalidDataMessage, { cause })
  invalidDataErrors.add(error)
  return error
}

function coordinateCorruptBackup(
  path: string,
  source: Buffer,
  sourceKey: (source: Buffer) => string,
  backup: (source: Buffer) => Promise<void>,
): Promise<void> {
  const key = normalizeTargetPath(path)
  const sourceSnapshot = Buffer.from(source)
  const bucketKey = sourceKey(Buffer.from(sourceSnapshot))
  let coordinator = corruptBackupCoordinators.get(key)

  if (!coordinator) {
    coordinator = {
      tail: Promise.resolve(),
      operationsBySource: new Map(),
    }
    corruptBackupCoordinators.set(key, coordinator)
  }

  const bucket = coordinator.operationsBySource.get(bucketKey) ?? []
  const existing = bucket.find((candidate) => candidate.source.equals(sourceSnapshot))
  if (existing) return existing.operation

  const operation = coordinator.tail
    .catch(() => undefined)
    .then(() => backup(Buffer.from(sourceSnapshot)))
  const coordinatedBackup: CorruptBackup = {
    source: sourceSnapshot,
    operation,
  }
  coordinator.tail = operation
  bucket.push(coordinatedBackup)
  coordinator.operationsBySource.set(bucketKey, bucket)

  const cleanup = () => {
    const currentBucket = coordinator.operationsBySource.get(bucketKey)
    if (currentBucket) {
      const entryIndex = currentBucket.indexOf(coordinatedBackup)
      if (entryIndex >= 0) currentBucket.splice(entryIndex, 1)
      if (currentBucket.length === 0) coordinator.operationsBySource.delete(bucketKey)
    }
    if (
      coordinator.tail === operation
      && coordinator.operationsBySource.size === 0
      && corruptBackupCoordinators.get(key) === coordinator
    ) {
      corruptBackupCoordinators.delete(key)
    }
  }
  void operation.then(cleanup, cleanup)

  return operation
}

function hashSource(source: Buffer): string {
  return createHash('sha256').update(source).digest('hex')
}

function normalizeTargetPath(path: string): string {
  const normalized = resolve(path)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
