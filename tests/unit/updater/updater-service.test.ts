import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { UpdaterService, type UpdaterFetch, type UpdaterHttpResponse } from '../../../src/main/updater/updater-service'

function response(status: number, body: string | Uint8Array, headers: Record<string, string> = {}): UpdaterHttpResponse {
  const bytes = typeof body === 'string' ? Buffer.from(body) : Buffer.from(body)
  return {
    status,
    headers: { get: name => headers[name.toLowerCase()] ?? null },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  }
}

describe('UpdaterService', () => {
  it('checks, streams, verifies, launches, and restarts a signed release', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-updater-test-'))
    const payload = Buffer.from('installer payload')
    const digest = createHash('sha256').update(payload).digest('hex')
    const calls: Array<{ url: string; init: Parameters<UpdaterFetch>[1] }> = []
    let relaunched = false
    let exited: number | undefined
    try {
      const service = new UpdaterService({
        currentVersion: '2.0.5',
        tempDirectory: directory,
        platform: 'win32',
        architecture: 'x64',
        fetch: async (url, init) => {
          calls.push({ url, init })
          if (url.includes('/releases/latest')) {
            return response(200, JSON.stringify({
              tag_name: 'v2.0.6',
              name: 'Terminal-Agent 2.0.6',
              html_url: 'https://github.com/AI-DIY/Terminal-Agent/releases/tag/v2.0.6',
              published_at: '2026-09-01T00:00:00Z',
              draft: false,
              prerelease: false,
              body: 'notes',
              assets: [{
                name: 'Terminal-Agent-Setup-2.0.6.exe',
                browser_download_url: 'https://github.com/AI-DIY/Terminal-Agent/releases/download/v2.0.6/Terminal-Agent-Setup-2.0.6.exe',
                size: payload.length,
                digest: `sha256:${digest}`,
              }],
            }), { 'content-length': '500' })
          }
          return response(200, payload, { 'content-length': String(payload.length) })
        },
        launchInstaller: async () => ({ pid: 42 }),
        relaunch: () => { relaunched = true },
        exit: code => { exited = code },
      })

      await expect(service.check()).resolves.toMatchObject({ currentVersion: '2.0.5', updateAvailable: true, release: { version: '2.0.6' } })
      await expect(service.download()).resolves.toMatchObject({ version: '2.0.6', integrityVerified: true, size: payload.length })
      await expect(service.install()).resolves.toMatchObject({ launched: true, version: '2.0.6' })
      service.restart()
      expect(relaunched).toBe(true)
      expect(exited).toBe(0)
      expect(calls).toHaveLength(2)
      expect(calls[0]).toMatchObject({
        url: 'https://api.github.com/repos/AI-DIY/Terminal-Agent/releases/latest',
        init: {
          method: 'GET',
          redirect: 'manual',
          headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': 'Terminal-Agent-Updater/1.0',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          signal: expect.any(AbortSignal),
        },
      })
      expect(calls[1]).toMatchObject({
        url: 'https://github.com/AI-DIY/Terminal-Agent/releases/download/v2.0.6/Terminal-Agent-Setup-2.0.6.exe',
        init: {
          method: 'GET',
          redirect: 'manual',
          headers: {
            Accept: 'application/octet-stream',
            'User-Agent': 'Terminal-Agent-Updater/1.0',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          signal: expect.any(AbortSignal),
        },
      })
      expect(service.getState().phase).toBe('installed')
    }
    finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects untrusted release and installer addresses', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-updater-test-'))
    try {
      const service = new UpdaterService({
        currentVersion: '2.0.5', tempDirectory: directory, platform: 'win32', architecture: 'x64',
        fetch: async () => response(200, JSON.stringify({
          tag_name: 'v2.0.6',
          html_url: 'https://github.com/AI-DIY/Terminal-Agent/releases/tag/v2.0.6',
          assets: [{ name: 'Terminal-Agent-Setup-2.0.6.exe', browser_download_url: 'https://evil.example/update.exe', size: 1 }],
        })),
      })
      await expect(service.check()).rejects.toThrow('可用')
    }
    finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects an unsigned installer unless explicitly opted out', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-updater-test-'))
    const payload = Buffer.from('unsigned')
    try {
      const service = new UpdaterService({
        currentVersion: '2.0.5', tempDirectory: directory, platform: 'win32', architecture: 'x64',
        fetch: async url => url.includes('/releases/latest')
          ? response(200, JSON.stringify({
            tag_name: 'v2.0.6', html_url: 'https://github.com/AI-DIY/Terminal-Agent/releases/tag/v2.0.6',
            assets: [{ name: 'Terminal-Agent-Setup-2.0.6.exe', browser_download_url: 'https://github.com/AI-DIY/Terminal-Agent/releases/download/v2.0.6/Terminal-Agent-Setup-2.0.6.exe', size: payload.length }],
          }))
          : response(200, payload),
      })
      await service.check()
      await expect(service.download()).rejects.toThrow('完整性校验')
    }
    finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('consumes Nuts metadata and treats a 204 response as up to date', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-updater-test-'))
    try {
      const calls: string[] = []
      const service = new UpdaterService({
        currentVersion: '3.1.1', tempDirectory: directory, platform: 'win32', architecture: 'x64',
        feedUrl: 'http://ta.ai-diy.me/update/win32',
        fetch: async (url) => { calls.push(url); return response(204, '') },
      })
      await expect(service.check()).resolves.toMatchObject({ updateAvailable: false, release: null })
      expect(calls).toEqual(['http://ta.ai-diy.me/update/win32/3.1.1'])
    }
    finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('parses a Nuts release and rewrites a zip asset to the executable variant', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-updater-test-'))
    const payload = Buffer.from('nuts installer')
    try {
      const calls: string[] = []
      const service = new UpdaterService({
        currentVersion: '3.1.1', tempDirectory: directory, platform: 'win32', architecture: 'x64',
        feedUrl: 'http://ta.ai-diy.me/update/win32',
        launchInstaller: async () => ({ pid: 7 }),
        fetch: async (url) => {
          calls.push(url)
          if (url.includes('/update/win32/')) return response(200, JSON.stringify({
            name: '3.2.0', url: '/download/version/3.2.0/windows_64?filetype=zip', notes: 'hello',
          }))
          return response(200, payload, {
            'content-length': String(payload.length),
            'content-disposition': 'attachment; filename="Terminal-Agent-Setup-3.2.0.exe"',
          })
        },
      })
      await expect(service.check()).resolves.toMatchObject({ updateAvailable: true, release: { version: '3.2.0', size: 0 } })
      await expect(service.download()).resolves.toMatchObject({ version: '3.2.0', size: payload.length, integrityVerified: false })
      await expect(service.install()).resolves.toMatchObject({ launched: true, version: '3.2.0' })
      expect(calls[1]).toContain('filetype=exe')
    }
    finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('uses bounded range workers for large assets and falls back when ranges are declined', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-updater-test-'))
    const bytes = Buffer.alloc(5 * 1024 * 1024, 7)
    try {
      const rangeCalls: string[] = []
      const service = new UpdaterService({
        currentVersion: '3.1.1', tempDirectory: directory, platform: 'win32', architecture: 'x64',
        feedUrl: 'http://ta.ai-diy.me/update/win32', downloadConcurrency: 3,
        fetch: async (url, init) => {
          if (url.includes('/update/win32/')) return response(200, JSON.stringify({ name: '3.2.0', url: 'http://ta.ai-diy.me/download/version/3.2.0/windows_64?filetype=exe', size: bytes.length }))
          const range = init.headers.Range
          if (range) {
            rangeCalls.push(range)
            const match = /bytes=(\d+)-(\d+)/.exec(range)!
            const start = Number(match[1]); const end = Number(match[2])
            return response(206, bytes.subarray(start, end + 1), { 'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${bytes.length}`, 'content-disposition': 'attachment; filename="Terminal-Agent-Setup-3.2.0.exe"' })
          }
          return response(200, bytes, { 'content-length': String(bytes.length), 'content-disposition': 'attachment; filename="Terminal-Agent-Setup-3.2.0.exe"' })
        },
      })
      await service.check()
      await expect(service.download()).resolves.toMatchObject({ size: bytes.length })
      expect(rangeCalls.length).toBeGreaterThan(1)
    }
    finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('falls back to one request when a large-asset server ignores Range', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-updater-test-'))
    const bytes = Buffer.alloc(5 * 1024 * 1024, 9)
    try {
      let rangeAttempts = 0
      let fullDownloads = 0
      const service = new UpdaterService({
        currentVersion: '3.1.1', tempDirectory: directory, platform: 'win32', architecture: 'x64',
        feedUrl: 'http://ta.ai-diy.me/update/win32', downloadConcurrency: 3,
        fetch: async (url, init) => {
          if (url.includes('/update/win32/')) return response(200, JSON.stringify({ name: '3.2.0', url: 'http://ta.ai-diy.me/download/version/3.2.0/windows_64?filetype=exe', size: bytes.length }))
          if (init.headers.Range) rangeAttempts += 1
          else fullDownloads += 1
          return response(200, bytes, { 'content-length': String(bytes.length), 'content-disposition': 'attachment; filename="Terminal-Agent-Setup-3.2.0.exe"' })
        },
      })
      await service.check()
      await expect(service.download()).resolves.toMatchObject({ size: bytes.length })
      expect(rangeAttempts).toBeGreaterThan(0)
      expect(fullDownloads).toBe(1)
    }
    finally { await rm(directory, { recursive: true, force: true }) }
  })
})
