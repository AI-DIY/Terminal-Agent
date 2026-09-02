import type { Session } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { createElectronSessionUpdaterFetcher } from '../../../src/main/updater/electron-session-fetcher'
import type { UpdaterHttpResponse } from '../../../src/main/updater/updater-service'

describe('createElectronSessionUpdaterFetcher', () => {
  it('lazily delegates each updater request to the Electron session fetcher', async () => {
    const response: UpdaterHttpResponse = {
      status: 200,
      headers: { get: () => null },
    }
    const chromiumFetch = vi.fn(async () => response)
    const getSession = vi.fn(() => ({ fetch: chromiumFetch }) as unknown as Pick<Session, 'fetch'>)
    const fetcher = createElectronSessionUpdaterFetcher(getSession)
    const init = {
      method: 'GET' as const,
      headers: { Accept: 'application/vnd.github+json' },
      redirect: 'manual' as const,
      signal: new AbortController().signal,
    }

    // Electron exposes defaultSession only after app readiness, so creating
    // the updater must not resolve it during main-process bootstrap.
    expect(getSession).not.toHaveBeenCalled()

    await expect(fetcher('https://api.github.com/repos/AI-DIY/Terminal-Agent/releases/latest', init)).resolves.toBe(response)

    expect(getSession).toHaveBeenCalledOnce()
    expect(chromiumFetch).toHaveBeenCalledOnce()
    expect(chromiumFetch).toHaveBeenCalledWith('https://api.github.com/repos/AI-DIY/Terminal-Agent/releases/latest', init)
  })
})
