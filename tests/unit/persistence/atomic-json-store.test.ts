import { link, mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  AtomicJsonStore,
  type AtomicJsonStoreFileSystem,
  type AtomicJsonStoreOptions,
} from '../../../src/main/persistence/atomic-json-store'

const stateSchema = z.object({
  count: z.number().int().nonnegative(),
  labels: z.array(z.string()),
}).strict()

type State = z.infer<typeof stateSchema>

const temporaryDirectories: string[] = []
const defaultId = '11111111-1111-4111-8111-111111111111'

function deferred<T = void>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void
  let rejectPromise!: (reason?: unknown) => void
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })

  return { promise, reject: rejectPromise, resolve: resolvePromise }
}

async function createStorePath(...parts: string[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'atomic-json-store-'))
  temporaryDirectories.push(directory)
  return join(directory, ...parts)
}

function createStore(
  path: string,
  empty: () => State = () => ({ count: 0, labels: [] }),
  options: AtomicJsonStoreOptions = {},
) {
  return new AtomicJsonStore(path, stateSchema, empty, {
    now: () => new Date('2026-08-16T12:34:56.789Z'),
    createId: () => defaultId,
    ...options,
  })
}

type InjectedFailure = 'writeFile' | 'rename'
type ExclusiveWrite = (
  path: string,
  data: string | Buffer,
  options: 'utf8',
  write: (override?: string | Buffer) => Promise<void>,
) => Promise<void>

function createInstrumentedFileSystem(failure?: InjectedFailure) {
  const events: string[] = []
  let pendingFailure = failure

  const fileSystem: AtomicJsonStoreFileSystem = {
    mkdir,
    readFile: (path) => readFile(path),
    async openExclusive(path) {
      events.push(`writeFile:${path}:utf8:wx`)
      const handle = await open(path, 'wx')
      return {
        async writeFile(data, options) {
          if (pendingFailure === 'writeFile') {
            pendingFailure = undefined
            throw new Error('injected writeFile failure')
          }

          await handle.writeFile(data, options)
        },
        close: () => handle.close(),
      }
    },
    async rename(source, destination) {
      events.push(`rename:${source}:${destination}`)

      if (pendingFailure === 'rename') {
        pendingFailure = undefined
        throw new Error('injected rename failure')
      }

      await rename(source, destination)
    },
    link: (source, destination) => link(source, destination),
    async rm(path, options) {
      events.push(`rm:${path}`)
      await rm(path, options)
    },
  }

  return { events, fileSystem }
}

function interceptExclusiveWrites(
  fileSystem: AtomicJsonStoreFileSystem,
  intercept: ExclusiveWrite,
): AtomicJsonStoreFileSystem {
  return {
    ...fileSystem,
    link: (source, destination) => fileSystem.link(source, destination),
    async openExclusive(path) {
      const handle = await fileSystem.openExclusive(path)
      return {
        writeFile: (data, options) => intercept(
          path,
          data,
          options,
          (override) => handle.writeFile(override ?? data, options),
        ),
        close: () => handle.close(),
      }
    },
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })))
})

describe('AtomicJsonStore', () => {
  it('returns an existing valid target without invoking any write-side adapter operation', async () => {
    const path = await createStorePath('state.json')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify({ count: 7, labels: ['managed'] }), 'utf8')
    const writes = {
      mkdir: 0,
      openExclusive: 0,
      link: 0,
      rename: 0,
      rm: 0,
    }
    const store = createStore(path, () => ({ count: 0, labels: [] }), {
      fileSystem: {
        readFile: file => readFile(file),
        mkdir: async () => { writes.mkdir++; throw new Error('mkdir must not be called') },
        openExclusive: async () => { writes.openExclusive++; throw new Error('openExclusive must not be called') },
        link: async () => { writes.link++; throw new Error('link must not be called') },
        rename: async () => { writes.rename++; throw new Error('rename must not be called') },
        rm: async () => { writes.rm++; throw new Error('rm must not be called') },
      },
    })

    await expect(store.createIfMissing()).resolves.toEqual({ count: 7, labels: ['managed'] })
    expect(writes).toEqual({ mkdir: 0, openExclusive: 0, link: 0, rename: 0, rm: 0 })
  })

  it('returns a fresh validated default when the file is missing', async () => {
    const path = await createStorePath('state.json')
    const defaultState = { count: 0, labels: [] as string[] }
    const store = createStore(path, () => defaultState)

    const first = await store.load()
    first.labels.push('caller mutation')
    const second = await store.load()

    expect(first).not.toBe(defaultState)
    expect(second).toEqual({ count: 0, labels: [] })
    expect(second).not.toBe(first)
  })

  it('strictly validates defaults and persisted data with the provided schema', async () => {
    const invalidDefaultPath = await createStorePath('invalid-default.json')
    const invalidDefaultStore = createStore(invalidDefaultPath, () => ({ count: -1, labels: [] }))

    await expect(invalidDefaultStore.load()).rejects.toBeInstanceOf(z.ZodError)

    const invalidPersistedPath = await createStorePath('invalid-persisted.json')
    await writeFile(invalidPersistedPath, JSON.stringify({ count: 1, labels: [], extra: true }))

    await expect(createStore(invalidPersistedPath).load()).rejects.toThrow('AtomicJsonStore could not read valid JSON data')
  })

  it('serializes concurrent updates without losing changes', async () => {
    const path = await createStorePath('state.json')
    const store = createStore(path)
    const firstStarted = deferred()
    const releaseFirst = deferred()

    const first = store.update(async (current) => {
      firstStarted.resolve()
      await releaseFirst.promise
      return { ...current, count: current.count + 1, labels: [...current.labels, 'first'] }
    })
    await firstStarted.promise
    const second = store.update((current) => ({
      ...current,
      count: current.count + 1,
      labels: [...current.labels, 'second'],
    }))
    const third = store.update((current) => ({
      ...current,
      count: current.count + 1,
      labels: [...current.labels, 'third'],
    }))
    releaseFirst.resolve()

    const results = await Promise.all([
      first,
      second,
      third,
    ])

    expect(results).toEqual([
      { count: 1, labels: ['first'] },
      { count: 2, labels: ['first', 'second'] },
      { count: 3, labels: ['first', 'second', 'third'] },
    ])
    await expect(store.load()).resolves.toEqual(results[2])
  })

  it('makes load wait behind a queued write', async () => {
    const path = await createStorePath('state.json')
    const { fileSystem: realFileSystem } = createInstrumentedFileSystem()
    const secondReadStarted = deferred()
    let readCount = 0
    const fileSystem: AtomicJsonStoreFileSystem = {
      ...realFileSystem,
      link: (source, destination) => link(source, destination),
      async readFile(file) {
        readCount += 1
        if (readCount === 2) secondReadStarted.resolve()
        return realFileSystem.readFile(file)
      },
    }
    const store = createStore(path, undefined, { fileSystem })
    const updateStarted = deferred()
    const updateGate = deferred()

    const update = store.update(async (current) => {
      updateStarted.resolve()
      await updateGate.promise
      return { ...current, count: 1 }
    })
    await updateStarted.promise
    expect(readCount).toBe(1)
    const load = store.load()
    const loadSchedulingCheckpoint = deferred()
    queueMicrotask(() => loadSchedulingCheckpoint.resolve())

    await loadSchedulingCheckpoint.promise
    expect(readCount).toBe(1)

    updateGate.resolve()
    await expect(update).resolves.toEqual({ count: 1, labels: [] })
    await secondReadStarted.promise
    await expect(load).resolves.toEqual({ count: 1, labels: [] })
    expect(readCount).toBe(2)
  })

  it('creates missing parent directories', async () => {
    const path = await createStorePath('nested', 'deeper', 'state.json')
    const store = createStore(path)

    await store.update(() => ({ count: 4, labels: ['saved'] }))

    await expect(readFile(path, 'utf8')).resolves.toBe(JSON.stringify({ count: 4, labels: ['saved'] }))
    expect(await readdir(dirname(path))).toEqual(['state.json'])
  })

  it('writes through a UUID-suffixed same-directory temporary file before renaming', async () => {
    const path = await createStorePath('state.json')
    const id = '123e4567-e89b-42d3-a456-426614174000'
    const temporaryPath = `${path}.tmp-${id}`
    const { events, fileSystem } = createInstrumentedFileSystem()
    const store = createStore(path, undefined, {
      createId: () => id,
      fileSystem,
    })

    await store.update(() => ({ count: 4, labels: ['saved'] }))

    expect(events).toEqual([
      `writeFile:${temporaryPath}:utf8:wx`,
      `rename:${temporaryPath}:${path}`,
    ])
    await expect(readFile(path, 'utf8')).resolves.toBe(JSON.stringify({ count: 4, labels: ['saved'] }))
    expect(await readdir(dirname(path))).toEqual(['state.json'])
  })

  it('preserves a pre-existing temporary file and retries with a fresh UUID', async () => {
    const path = await createStorePath('state.json')
    const firstId = '22222222-2222-4222-8222-222222222222'
    const secondId = '33333333-3333-4333-8333-333333333333'
    const firstTemporaryPath = `${path}.tmp-${firstId}`
    await writeFile(firstTemporaryPath, 'unrelated temporary data', 'utf8')
    const ids = [firstId, secondId]
    const store = createStore(path, undefined, {
      createId: () => ids.shift() ?? secondId,
    })

    await expect(store.update(() => ({ count: 4, labels: ['saved'] })))
      .resolves.toEqual({ count: 4, labels: ['saved'] })

    await expect(readFile(firstTemporaryPath, 'utf8')).resolves.toBe('unrelated temporary data')
    await expect(readFile(path, 'utf8')).resolves.toBe(JSON.stringify({ count: 4, labels: ['saved'] }))
  })

  it('rejects repeated temporary UUID collisions without deleting unrelated files', async () => {
    const path = await createStorePath('state.json')
    const id = '22222222-2222-4222-8222-222222222222'
    const temporaryPath = `${path}.tmp-${id}`
    await writeFile(temporaryPath, 'unrelated temporary data', 'utf8')
    const store = createStore(path, undefined, { createId: () => id })

    await expect(store.update(() => ({ count: 4, labels: ['saved'] })))
      .rejects.toThrow('AtomicJsonStore createId must return a unique UUID')

    await expect(readFile(temporaryPath, 'utf8')).resolves.toBe('unrelated temporary data')
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('cleans a partially written temporary file after an owned write failure', async () => {
    const path = await createStorePath('state.json')
    const original = JSON.stringify({ count: 1, labels: ['original'] })
    await writeFile(path, original, 'utf8')
    const partialWriteFailure = new Error('injected partial temporary write failure')
    const { fileSystem: realFileSystem } = createInstrumentedFileSystem()
    const fileSystem = interceptExclusiveWrites(realFileSystem, async (file, _data, _options, write) => {
      if (file.includes('.tmp-')) {
        await write(Buffer.from('{"count":'))
        throw partialWriteFailure
      }
      await write()
    })
    const store = createStore(path, undefined, { fileSystem })

    await expect(store.update((current) => ({ ...current, count: 2 })))
      .rejects.toBe(partialWriteFailure)

    await expect(readFile(path, 'utf8')).resolves.toBe(original)
    expect((await readdir(dirname(path))).some((name) => name.includes('.tmp-'))).toBe(false)
  })

  it('routes reads through the same file-system adapter as writes', async () => {
    const path = await createStorePath('state.json')
    await writeFile(path, JSON.stringify({ count: 1, labels: [] }), 'utf8')
    const readFailure = new Error('injected readFile failure')
    const { fileSystem } = createInstrumentedFileSystem()
    const store = createStore(path, undefined, {
      fileSystem: {
        ...fileSystem,
        readFile: async () => { throw readFailure },
      },
    })

    await expect(store.load()).rejects.toBe(readFailure)
  })

  it('rejects non-UUID createId values before constructing a temporary path', async () => {
    const path = await createStorePath('state.json')
    const store = createStore(path, undefined, { createId: () => 'not-a-uuid' })

    await expect(store.update(() => ({ count: 1, labels: [] })))
      .rejects.toThrow('AtomicJsonStore createId must return a UUID')
    expect(await readdir(dirname(path))).toEqual([])
  })

  it('rejects UUID-shaped values with invalid version or variant bits', async () => {
    const path = await createStorePath('state.json')
    const invalidVersion = '123e4567-e89b-02d3-a456-426614174000'
    const invalidVariant = '123e4567-e89b-42d3-7456-426614174000'

    await expect(createStore(path, undefined, { createId: () => invalidVersion })
      .update(() => ({ count: 1, labels: [] }))).rejects.toThrow(
        'AtomicJsonStore createId must return a UUID',
      )
    await expect(createStore(path, undefined, { createId: () => invalidVariant })
      .update(() => ({ count: 1, labels: [] }))).rejects.toThrow(
        'AtomicJsonStore createId must return a UUID',
      )
  })

  it('reuses one corrupt backup per bad content state and resets after content changes or recovery', async () => {
    const path = await createStorePath('state.json')
    const firstMalformed = '{ definitely not JSON'
    const secondMalformed = '{ still broken JSON'
    let nowCalls = 0
    await writeFile(path, firstMalformed)
    const store = createStore(path, undefined, {
      now: () => new Date(Date.UTC(2026, 7, 16, 12, 34, 56, 789) + nowCalls++ * 1_000),
    })

    const firstError = await store.load().catch((error: unknown) => error)
    const secondError = await store.load().catch((error: unknown) => error)
    await Promise.all(Array.from({ length: 3 }, () => (
      expect(store.load()).rejects.toThrow('AtomicJsonStore could not read valid JSON data')
    )))
    const firstBackups = (await readdir(dirname(path))).filter((name) => name.endsWith('.corrupt'))

    expect(firstError).toBeInstanceOf(Error)
    expect((firstError as Error).message).toBe('AtomicJsonStore could not read valid JSON data')
    expect((secondError as Error).message).toBe((firstError as Error).message)
    expect(firstBackups).toEqual(['state.json.2026-08-16T12-34-56-789Z.corrupt'])
    expect(nowCalls).toBe(1)
    await expect(readFile(join(dirname(path), firstBackups[0]), 'utf8')).resolves.toBe(firstMalformed)

    await writeFile(path, secondMalformed)
    await Promise.all([
      expect(store.load()).rejects.toThrow('AtomicJsonStore could not read valid JSON data'),
      expect(store.load()).rejects.toThrow('AtomicJsonStore could not read valid JSON data'),
    ])

    const changedBackups = (await readdir(dirname(path)))
      .filter((name) => name.endsWith('.corrupt'))
      .sort()
    expect(changedBackups).toEqual([
      'state.json.2026-08-16T12-34-56-789Z.corrupt',
      'state.json.2026-08-16T12-34-57-789Z.corrupt',
    ])
    expect(nowCalls).toBe(2)
    await expect(readFile(join(dirname(path), changedBackups[1]), 'utf8')).resolves.toBe(secondMalformed)

    await writeFile(path, JSON.stringify({ count: 7, labels: ['recovered'] }))
    await expect(store.load()).resolves.toEqual({ count: 7, labels: ['recovered'] })
    await writeFile(path, secondMalformed)
    await expect(store.load()).rejects.toThrow('AtomicJsonStore could not read valid JSON data')
    expect((await readdir(dirname(path))).filter((name) => name.endsWith('.corrupt'))).toHaveLength(3)
    expect(nowCalls).toBe(3)
  })

  it('preserves invalid UTF-8 bytes exactly in corrupt backups', async () => {
    const path = await createStorePath('state.json')
    const malformed = Buffer.from([0x7b, 0x20, 0x80])
    await writeFile(path, malformed)
    const store = createStore(path)

    await expect(store.load()).rejects.toThrow('AtomicJsonStore could not read valid JSON data')

    const backup = (await readdir(dirname(path))).find((name) => name.endsWith('.corrupt'))
    expect(backup).toBeDefined()
    await expect(readFile(join(dirname(path), backup!))).resolves.toEqual(malformed)
  })

  it('rejects invalid UTF-8 even when replacement decoding would produce schema-valid JSON', async () => {
    const path = await createStorePath('state.json')
    const malformed = Buffer.concat([
      Buffer.from('{"count":1,"labels":["'),
      Buffer.from([0x80]),
      Buffer.from('"]}'),
    ])
    expect(() => stateSchema.parse(JSON.parse(malformed.toString('utf8')))).not.toThrow()
    await writeFile(path, malformed)

    await expect(createStore(path).load())
      .rejects.toThrow('AtomicJsonStore could not read valid JSON data')

    const backup = (await readdir(dirname(path))).find((name) => name.endsWith('.corrupt'))
    expect(backup).toBeDefined()
    await expect(readFile(join(dirname(path), backup!))).resolves.toEqual(malformed)
    await expect(readFile(path)).resolves.toEqual(malformed)
  })

  it('cleans a partially written corrupt backup after an owned write failure', async () => {
    const path = await createStorePath('state.json')
    const malformed = '{ partial corrupt source'
    await writeFile(path, malformed, 'utf8')
    const partialWriteFailure = new Error('injected partial corrupt backup failure')
    const { fileSystem: realFileSystem } = createInstrumentedFileSystem()
    const fileSystem = interceptExclusiveWrites(realFileSystem, async (file, _data, _options, write) => {
      if (file.endsWith('.corrupt')) {
        await write(Buffer.from('partial backup'))
        throw partialWriteFailure
      }
      await write()
    })
    const store = createStore(path, undefined, { fileSystem })

    await expect(store.load()).rejects.toBe(partialWriteFailure)

    expect((await readdir(dirname(path))).some((name) => name.endsWith('.corrupt'))).toBe(false)
    await expect(readFile(path, 'utf8')).resolves.toBe(malformed)
  })

  it('backs up distinct invalid UTF-8 byte sequences that decode to the same text', async () => {
    const path = await createStorePath('state.json')
    const firstMalformed = Buffer.from([0x7b, 0x20, 0x80])
    const secondMalformed = Buffer.from([0x7b, 0x20, 0x81])
    expect(firstMalformed.toString('utf8')).toBe(secondMalformed.toString('utf8'))
    await writeFile(path, firstMalformed)
    const store = createStore(path, undefined, {
      createId: () => '44444444-4444-4444-8444-444444444444',
    })

    await expect(store.load()).rejects.toThrow('AtomicJsonStore could not read valid JSON data')
    await writeFile(path, secondMalformed)
    await expect(store.load()).rejects.toThrow('AtomicJsonStore could not read valid JSON data')

    const backupPaths = (await readdir(dirname(path)))
      .filter((name) => name.endsWith('.corrupt'))
      .map((name) => join(dirname(path), name))
    expect(backupPaths).toHaveLength(2)
    const contents = await Promise.all(backupPaths.map((backupPath) => readFile(backupPath)))
    expect(contents).toEqual(expect.arrayContaining([firstMalformed, secondMalformed]))
  })

  it('backs up the exact source that failed validation even if the target changes afterward', async () => {
    const path = await createStorePath('state.json')
    const rejectedSource = JSON.stringify({ count: 1, labels: ['rejected'] })
    const replacement = JSON.stringify({ count: 9, labels: ['replacement'] })
    await writeFile(path, rejectedSource, 'utf8')
    const rejectingSchema = z.object({
      count: z.number().int().nonnegative(),
      labels: z.array(z.string()),
    }).strict().superRefine((_value, context) => {
      writeFileSync(path, replacement, 'utf8')
      context.addIssue({ code: 'custom', message: 'reject after read' })
    })
    const store = new AtomicJsonStore(path, rejectingSchema, () => ({ count: 0, labels: [] }), {
      now: () => new Date('2026-08-16T12:34:56.789Z'),
      createId: () => defaultId,
    })

    await expect(store.load()).rejects.toThrow('AtomicJsonStore could not read valid JSON data')

    const backup = (await readdir(dirname(path))).find((name) => name.endsWith('.corrupt'))
    expect(backup).toBeDefined()
    await expect(readFile(join(dirname(path), backup!), 'utf8')).resolves.toBe(rejectedSource)
    await expect(readFile(path, 'utf8')).resolves.toBe(replacement)
  })

  it('snapshots adapter-owned buffers before schema refinement can mutate them', async () => {
    const path = await createStorePath('state.json')
    const rejectedSource = Buffer.from(JSON.stringify({ count: 1, labels: ['rejected'] }))
    const adapterBuffer = Buffer.from(rejectedSource)
    const { fileSystem: realFileSystem } = createInstrumentedFileSystem()
    const fileSystem: AtomicJsonStoreFileSystem = {
      ...realFileSystem,
      link: (source, destination) => link(source, destination),
      readFile: async () => adapterBuffer,
    }
    const rejectingSchema = stateSchema.superRefine((_value, context) => {
      adapterBuffer.fill(0x20)
      context.addIssue({ code: 'custom', message: 'reject after adapter mutation' })
    })
    const store = new AtomicJsonStore(path, rejectingSchema, () => ({ count: 0, labels: [] }), {
      now: () => new Date('2026-08-16T12:34:56.789Z'),
      createId: () => defaultId,
      fileSystem,
    })

    await expect(store.load()).rejects.toThrow('AtomicJsonStore could not read valid JSON data')

    const backup = (await readdir(dirname(path))).find((name) => name.endsWith('.corrupt'))
    expect(backup).toBeDefined()
    await expect(readFile(join(dirname(path), backup!))).resolves.toEqual(rejectedSource)
  })

  it('coordinates normalized paths across store instances and deduplicates an in-flight source backup', async () => {
    const path = await createStorePath('state.json')
    const aliasDirectory = join(dirname(path), 'alias')
    await mkdir(aliasDirectory)
    const aliasedPath = join(aliasDirectory, '..', 'state.json')
    const rejectedSource = JSON.stringify({ count: 3, labels: ['shared corrupt state'] })
    await writeFile(path, rejectedSource, 'utf8')
    const secondParseStarted = deferred()
    let parseCount = 0
    const rejectingSchema = z.object({
      count: z.number().int().nonnegative(),
      labels: z.array(z.string()),
    }).strict().superRefine((_value, context) => {
      parseCount += 1
      if (parseCount === 2) secondParseStarted.resolve()
      context.addIssue({ code: 'custom', message: 'force corrupt backup' })
    })
    const firstBackupStarted = deferred()
    const releaseFirstBackup = deferred()
    let backupAttempts = 0
    const { fileSystem: realFileSystem } = createInstrumentedFileSystem()
    const fileSystem = interceptExclusiveWrites(realFileSystem, async (file, _data, _options, write) => {
      if (file.endsWith('.corrupt')) {
        backupAttempts += 1
        if (backupAttempts === 1) {
          firstBackupStarted.resolve()
          await releaseFirstBackup.promise
        }
      }
      await write()
    })
    const options: AtomicJsonStoreOptions = {
      now: () => new Date('2026-08-16T12:34:56.789Z'),
      createId: () => defaultId,
      fileSystem,
    }
    const directStore = new AtomicJsonStore(path, rejectingSchema, () => ({ count: 0, labels: [] }), options)
    const aliasedStore = new AtomicJsonStore(
      aliasedPath,
      rejectingSchema,
      () => ({ count: 0, labels: [] }),
      options,
    )

    const directLoad = directStore.load()
    const firstProgress = await Promise.race([
      firstBackupStarted.promise.then(() => 'adapter' as const),
      directLoad.then(() => 'settled' as const, () => 'settled' as const),
    ])
    expect(firstProgress).toBe('adapter')

    const aliasedLoad = aliasedStore.load()
    await secondParseStarted.promise
    const attemptsWhileFirstIsBlocked = backupAttempts
    releaseFirstBackup.resolve()
    const results = await Promise.allSettled([directLoad, aliasedLoad])

    expect(attemptsWhileFirstIsBlocked).toBe(1)
    expect(backupAttempts).toBe(1)
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected'])
    const backups = (await readdir(dirname(path))).filter((name) => name.endsWith('.corrupt'))
    expect(backups).toHaveLength(1)
    await expect(readFile(join(dirname(path), backups[0]), 'utf8')).resolves.toBe(rejectedSource)
    expect(resolve(aliasedPath)).toBe(resolve(path))
  })

  it('keeps coordination identity stable when the adapter mutates a backup buffer', async () => {
    const path = await createStorePath('state.json')
    const rejectedSource = Buffer.from(JSON.stringify({ count: 3, labels: ['shared source'] }))
    const secondParseStarted = deferred()
    let parseCount = 0
    const rejectingSchema = stateSchema.superRefine((_value, context) => {
      parseCount += 1
      if (parseCount === 2) secondParseStarted.resolve()
      context.addIssue({ code: 'custom', message: 'force corrupt backup' })
    })
    const firstBackupStarted = deferred()
    const releaseFirstBackup = deferred()
    let backupAttempts = 0
    const { fileSystem: realFileSystem } = createInstrumentedFileSystem()
    const fileSystem = interceptExclusiveWrites({
      ...realFileSystem,
      readFile: async () => Buffer.from(rejectedSource),
    }, async (file, data, _options, write) => {
      if (file.endsWith('.corrupt')) {
        backupAttempts += 1
        if (backupAttempts === 1) {
          expect(Buffer.isBuffer(data)).toBe(true)
          ;(data as Buffer).fill(0x20)
          firstBackupStarted.resolve()
          await releaseFirstBackup.promise
          await write(rejectedSource)
          return
        }
      }
      await write()
    })
    const options: AtomicJsonStoreOptions = {
      now: () => new Date('2026-08-16T12:34:56.789Z'),
      createId: () => defaultId,
      fileSystem,
    }
    const firstStore = new AtomicJsonStore(path, rejectingSchema, () => ({ count: 0, labels: [] }), options)
    const secondStore = new AtomicJsonStore(path, rejectingSchema, () => ({ count: 0, labels: [] }), options)

    const firstLoad = firstStore.load()
    await firstBackupStarted.promise
    const secondLoad = secondStore.load()
    await secondParseStarted.promise
    releaseFirstBackup.resolve()
    const results = await Promise.allSettled([firstLoad, secondLoad])

    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected'])
    expect(backupAttempts).toBe(1)
    const backup = (await readdir(dirname(path))).find((name) => name.endsWith('.corrupt'))
    expect(backup).toBeDefined()
    await expect(readFile(join(dirname(path), backup!))).resolves.toEqual(rejectedSource)
  })

  it('serializes different corrupt sources for the same path across store instances', async () => {
    const path = await createStorePath('state.json')
    const firstMalformed = Buffer.from('{ first corrupt source')
    const secondMalformed = Buffer.from('{ second corrupt source')
    const firstBackupStarted = deferred()
    const secondSourceCoordinated = deferred()
    const secondBackupStarted = deferred()
    const releaseFirstBackup = deferred()
    let backupAttempts = 0
    let reads = 0
    const { fileSystem: realFileSystem } = createInstrumentedFileSystem()
    const fileSystem = interceptExclusiveWrites({
      ...realFileSystem,
      async readFile(file) {
        if (file === path) {
          reads += 1
          return Buffer.from(reads === 1 ? firstMalformed : secondMalformed)
        }
        return realFileSystem.readFile(file)
      },
    }, async (file, _data, _options, write) => {
      if (file.endsWith('.corrupt')) {
        backupAttempts += 1
        if (backupAttempts === 1) {
          firstBackupStarted.resolve()
          await releaseFirstBackup.promise
        } else {
          secondBackupStarted.resolve()
        }
      }
      await write()
    })
    const ids = [
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
    ]
    let sourceKeyCalls = 0
    const options = {
      now: () => new Date('2026-08-16T12:34:56.789Z'),
      createId: () => ids.shift() ?? defaultId,
      fileSystem,
      corruptSourceKey: () => {
        sourceKeyCalls += 1
        if (sourceKeyCalls === 2) secondSourceCoordinated.resolve()
        return 'forced-hash-collision'
      },
    } as AtomicJsonStoreOptions

    const firstLoad = createStore(path, undefined, options).load()
    void firstLoad.catch(() => undefined)
    await firstBackupStarted.promise
    const secondLoad = createStore(path, undefined, options).load()
    void secondLoad.catch(() => undefined)
    await secondSourceCoordinated.promise
    expect(backupAttempts).toBe(1)

    releaseFirstBackup.resolve()
    await secondBackupStarted.promise
    const results = await Promise.allSettled([firstLoad, secondLoad])

    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected'])
    expect(sourceKeyCalls).toBe(2)
    expect(results.map((result) => (
      result.status === 'rejected' && result.reason instanceof Error ? result.reason.message : undefined
    ))).toEqual([
      'AtomicJsonStore could not read valid JSON data',
      'AtomicJsonStore could not read valid JSON data',
    ])
    const backups = (await readdir(dirname(path)))
      .filter((name) => name.endsWith('.corrupt'))
      .map((name) => join(dirname(path), name))
    expect(backups).toHaveLength(2)
    const contents = await Promise.all(backups.map((backup) => readFile(backup)))
    expect(contents).toEqual(expect.arrayContaining([firstMalformed, secondMalformed]))
  })

  it('retries after a rejected corrupt-backup tail and clears successful coordination state', async () => {
    const path = await createStorePath('state.json')
    const malformed = '{ retryable corrupt source'
    await writeFile(path, malformed, 'utf8')
    const corruptWriteFailure = new Error('injected corrupt backup failure')
    const { fileSystem: firstRealFileSystem } = createInstrumentedFileSystem()
    let failedBackupAttempts = 0
    const failingFileSystem = interceptExclusiveWrites(firstRealFileSystem, async (file, _data, _options, write) => {
      if (file.endsWith('.corrupt')) {
        failedBackupAttempts += 1
        throw corruptWriteFailure
      }
      await write()
    })
    const firstStore = createStore(path, undefined, { fileSystem: failingFileSystem })

    await expect(firstStore.load()).rejects.toBe(corruptWriteFailure)
    expect(failedBackupAttempts).toBe(1)

    const { events: retryEvents, fileSystem: retryFileSystem } = createInstrumentedFileSystem()
    const retryStore = createStore(path, undefined, { fileSystem: retryFileSystem })
    await expect(retryStore.load()).rejects.toThrow('AtomicJsonStore could not read valid JSON data')
    expect(retryEvents.filter((event) => event.includes('.corrupt:'))).toEqual([
      `writeFile:${path}.2026-08-16T12-34-56-789Z.corrupt:utf8:wx`,
    ])

    const { events: postSuccessEvents, fileSystem: postSuccessFileSystem } = createInstrumentedFileSystem()
    const postSuccessStore = createStore(path, undefined, { fileSystem: postSuccessFileSystem })
    await expect(postSuccessStore.load()).rejects.toThrow('AtomicJsonStore could not read valid JSON data')
    expect(postSuccessEvents.filter((event) => event.includes('.corrupt:'))).toEqual([
      `writeFile:${path}.2026-08-16T12-34-56-789Z.corrupt:utf8:wx`,
    ])
    expect((await readdir(dirname(path))).filter((name) => name.endsWith('.corrupt'))).toEqual([
      'state.json.2026-08-16T12-34-56-789Z.corrupt',
    ])
  })

  it('reuses an exclusively-created corrupt backup when its existing content matches', async () => {
    const path = await createStorePath('state.json')
    const malformed = '{ matching malformed source'
    const backupPath = `${path}.2026-08-16T12-34-56-789Z.corrupt`
    await writeFile(path, malformed, 'utf8')
    await writeFile(backupPath, malformed, 'utf8')
    const { events, fileSystem } = createInstrumentedFileSystem()
    const store = createStore(path, undefined, { fileSystem })

    await expect(store.load()).rejects.toThrow('AtomicJsonStore could not read valid JSON data')

    expect(events.filter((event) => event.includes('.corrupt:'))).toEqual([
      `writeFile:${backupPath}:utf8:wx`,
    ])
    await expect(readFile(backupPath, 'utf8')).resolves.toBe(malformed)
    expect((await readdir(dirname(path))).filter((name) => name.endsWith('.corrupt'))).toEqual([
      'state.json.2026-08-16T12-34-56-789Z.corrupt',
    ])
  })

  it('preserves exclusive-name collisions and retries with validated UUID suffixes', async () => {
    const path = await createStorePath('state.json')
    const malformed = '{ new malformed source'
    const baseBackupPath = `${path}.2026-08-16T12-34-56-789Z.corrupt`
    const firstId = '22222222-2222-4222-8222-222222222222'
    const secondId = '33333333-3333-4333-8333-333333333333'
    const firstCandidate = `${path}.2026-08-16T12-34-56-789Z-${firstId}.corrupt`
    const secondCandidate = `${path}.2026-08-16T12-34-56-789Z-${secondId}.corrupt`
    await writeFile(path, malformed, 'utf8')
    await writeFile(baseBackupPath, 'unrelated base collision', 'utf8')
    await writeFile(firstCandidate, 'unrelated UUID collision', 'utf8')
    const ids = [firstId, secondId]
    const { events, fileSystem } = createInstrumentedFileSystem()
    const store = createStore(path, undefined, {
      createId: () => ids.shift() ?? secondId,
      fileSystem,
    })

    await expect(store.load()).rejects.toThrow('AtomicJsonStore could not read valid JSON data')

    expect(events.filter((event) => event.includes('.corrupt:'))).toEqual([
      `writeFile:${baseBackupPath}:utf8:wx`,
      `writeFile:${firstCandidate}:utf8:wx`,
      `writeFile:${secondCandidate}:utf8:wx`,
    ])
    await expect(readFile(baseBackupPath, 'utf8')).resolves.toBe('unrelated base collision')
    await expect(readFile(firstCandidate, 'utf8')).resolves.toBe('unrelated UUID collision')
    await expect(readFile(secondCandidate, 'utf8')).resolves.toBe(malformed)
  })

  it('backs up different corrupt contents separately when their timestamps match', async () => {
    const path = await createStorePath('state.json')
    const firstMalformed = '{ first same-time corruption'
    const secondMalformed = '{ second same-time corruption'
    await writeFile(path, firstMalformed, 'utf8')
    const firstStore = createStore(path)

    await expect(firstStore.load()).rejects.toThrow('AtomicJsonStore could not read valid JSON data')
    await writeFile(path, secondMalformed, 'utf8')
    const secondStore = createStore(path, undefined, {
      createId: () => '44444444-4444-4444-8444-444444444444',
    })
    await expect(secondStore.load()).rejects.toThrow('AtomicJsonStore could not read valid JSON data')

    const backupPaths = (await readdir(dirname(path)))
      .filter((name) => name.endsWith('.corrupt'))
      .map((name) => join(dirname(path), name))
    expect(backupPaths).toHaveLength(2)
    const contents = await Promise.all(backupPaths.map((backupPath) => readFile(backupPath, 'utf8')))
    expect(contents.sort()).toEqual([firstMalformed, secondMalformed].sort())
  })

  it('never overwrites malformed input during a later update attempt', async () => {
    const path = await createStorePath('state.json')
    const malformed = '{ broken'
    await writeFile(path, malformed)
    const store = createStore(path)

    await expect(store.load()).rejects.toThrow('AtomicJsonStore could not read valid JSON data')
    await expect(store.update(() => ({ count: 99, labels: [] }))).rejects.toThrow('AtomicJsonStore could not read valid JSON data')

    await expect(readFile(path, 'utf8')).resolves.toBe(malformed)
    const names = await readdir(dirname(path))
    expect(names.filter((name) => name.endsWith('.corrupt'))).toHaveLength(1)
    expect(names.filter((name) => name.includes('.tmp-'))).toHaveLength(0)
  })

  it('validates updated data before writing and returns an isolated clone', async () => {
    const path = await createStorePath('state.json')
    const store = createStore(path)
    const returned = await store.update(() => ({ count: 1, labels: ['stored'] }))

    returned.labels.push('caller mutation')
    await expect(store.load()).resolves.toEqual({ count: 1, labels: ['stored'] })

    await expect(store.update(() => ({ count: -1, labels: [] }))).rejects.toBeInstanceOf(z.ZodError)
    await expect(store.load()).resolves.toEqual({ count: 1, labels: ['stored'] })
  })

  it('leaves no temporary files after successful writes', async () => {
    const path = await createStorePath('state.json')
    const store = createStore(path)

    await store.update(() => ({ count: 1, labels: [] }))
    await store.update((current) => ({ ...current, count: 2 }))

    expect(await readdir(dirname(path))).toEqual(['state.json'])
  })

  it.each([
    ['writeFile', 'injected writeFile failure'],
    ['rename', 'injected rename failure'],
  ] as const)('preserves the target and unrelated files after a %s failure, then recovers', async (failure, message) => {
    const path = await createStorePath('state.json')
    const original = '{\n  "count": 2,\n  "labels": ["original"]\n}'
    const failingId = '55555555-5555-4555-8555-555555555555'
    const temporaryPath = `${path}.tmp-${failingId}`
    const unrelatedTemporaryPath = `${path}.tmp-unrelated`
    await writeFile(path, original, 'utf8')
    await writeFile(unrelatedTemporaryPath, 'unrelated', 'utf8')
    const { events, fileSystem } = createInstrumentedFileSystem(failure)
    const store = createStore(path, undefined, {
      createId: () => failingId,
      fileSystem,
    })

    await expect(store.update((current) => ({ ...current, count: 3 }))).rejects.toThrow(message)

    await expect(readFile(path, 'utf8')).resolves.toBe(original)
    await expect(readFile(unrelatedTemporaryPath, 'utf8')).resolves.toBe('unrelated')
    expect(await readdir(dirname(path))).not.toContain(`state.json.tmp-${failingId}`)
    expect(events).toEqual(failure === 'writeFile'
      ? [`writeFile:${temporaryPath}:utf8:wx`, `rm:${temporaryPath}`]
      : [
          `writeFile:${temporaryPath}:utf8:wx`,
          `rename:${temporaryPath}:${path}`,
          `rm:${temporaryPath}`,
        ])

    await expect(store.update((current) => ({ ...current, count: 4 })))
      .resolves.toEqual({ count: 4, labels: ['original'] })
    await expect(readFile(path, 'utf8'))
      .resolves.toBe(JSON.stringify({ count: 4, labels: ['original'] }))
    await expect(readFile(unrelatedTemporaryPath, 'utf8')).resolves.toBe('unrelated')
  })

  it('continues with a successful update already queued behind a failed update', async () => {
    const path = await createStorePath('state.json')
    const { fileSystem } = createInstrumentedFileSystem('writeFile')
    const store = createStore(path, undefined, { fileSystem })

    const failed = store.update((current) => ({ ...current, count: current.count + 1 }))
    const succeeding = store.update((current) => ({
      ...current,
      count: current.count + 2,
      labels: [...current.labels, 'after failure'],
    }))

    const failedResult = await failed.then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ status: 'rejected' as const, reason }),
    )
    const succeedingResult = await succeeding.then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ status: 'rejected' as const, reason }),
    )

    expect(failedResult.status).toBe('rejected')
    expect(failedResult.status === 'rejected' ? failedResult.reason : undefined)
      .toMatchObject({ message: 'injected writeFile failure' })
    expect(succeedingResult).toEqual({
      status: 'fulfilled',
      value: { count: 2, labels: ['after failure'] },
    })
    await expect(store.load()).resolves.toEqual({ count: 2, labels: ['after failure'] })
  })
})
