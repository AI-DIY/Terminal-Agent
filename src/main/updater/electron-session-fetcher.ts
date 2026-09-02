import type { Session } from 'electron'
import type { UpdaterFetch } from './updater-service'

/**
 * Creates updater requests on Electron's Chromium network stack.
 *
 * `session.defaultSession` is available only after Electron is ready, while
 * the updater is constructed during bootstrap.  Taking a getter keeps that
 * initialization safe and ensures each update request uses the current
 * default-session proxy configuration (system proxy, PAC, or setProxy).
 */
export function createElectronSessionUpdaterFetcher(
  getSession: () => Pick<Session, 'fetch'>,
): UpdaterFetch {
  return (url, init) => getSession().fetch(url, init)
}
