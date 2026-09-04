import { resolve } from 'node:path'

/**
 * A user-config file can be shared by the SSO and model-settings adapters.
 * AtomicJsonStore serialises writes per instance, but two adapters may be
 * backed by separate instances of the store.  This small process-local lock
 * serialises reads/mutations across those adapters so one section cannot
 * overwrite a concurrent update to the other section.
 */
const locks = new Map<string, Promise<void>>()

export async function withUserConfigPathLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const key = normalizePath(path)
  const predecessor = locks.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>(resolvePromise => { release = resolvePromise })
  locks.set(key, current)
  await predecessor
  try {
    return await operation()
  } finally {
    release()
    if (locks.get(key) === current) locks.delete(key)
  }
}

function normalizePath(path: string): string {
  const normalized = resolve(path)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}
