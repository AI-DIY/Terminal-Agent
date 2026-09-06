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
  it('checks, streams, verifies, launches, and closes for a signed release', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-updater-test-'))
    const payload = Buffer.from('installer payload')
    const digest = createHash('sha256').update(payload).digest('hex')
    const calls: Array<{ url: string; init: Parameters<UpdaterFetch>[1] }> = []
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
        exit: code => { exited = code },
      })

      await expect(service.check()).resolves.toMatchObject({ currentVersion: '2.0.5', updateAvailable: true, release: { version: '2.0.6' } })
      await expect(service.download()).resolves.toMatchObject({ version: '2.0.6', integrityVerified: true, size: payload.length })
      await expect(service.install()).resolves.toMatchObject({ launched: true, version: '2.0.6' })
      service.restart()
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

  it('rejects an unsigned installer by default', async () => {
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

  it('follows a GitHub release asset redirect to the official CDN', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-updater-test-'))
    const payload = Buffer.from('redirected installer')
    const digest = createHash('sha256').update(payload).digest('hex')
    const installerUrl = 'https://github.com/AI-DIY/Terminal-Agent/releases/download/v2.0.6/Terminal-Agent-Setup-2.0.6.exe'
    const cdnUrl = 'https://release-assets.githubusercontent.com/github-production-release-asset-2e65be/123/abc?sp=r&se=2099'
    try {
      const calls: string[] = []
      const service = new UpdaterService({
        currentVersion: '2.0.5', tempDirectory: directory, platform: 'win32', architecture: 'x64',
        fetch: async url => {
          calls.push(url)
          if (url.includes('/releases/latest')) return response(200, JSON.stringify({
            tag_name: 'v2.0.6',
            html_url: 'https://github.com/AI-DIY/Terminal-Agent/releases/tag/v2.0.6',
            assets: [{
              name: 'Terminal-Agent-Setup-2.0.6.exe',
              browser_download_url: installerUrl,
              size: payload.length,
              digest: `sha256:${digest}`,
            }],
          }))
          if (url === installerUrl) return response(302, '', { location: cdnUrl })
          if (url === cdnUrl) return response(200, payload, {
            'content-length': String(payload.length),
            'content-disposition': 'attachment; filename="Terminal-Agent-Setup-2.0.6.exe"',
          })
          throw new Error(`Unexpected updater request: ${url}`)
        },
      })

      await expect(service.check()).resolves.toMatchObject({ updateAvailable: true })
      await expect(service.download()).resolves.toMatchObject({ version: '2.0.6', integrityVerified: true })
      expect(calls).toEqual([
        'https://api.github.com/repos/AI-DIY/Terminal-Agent/releases/latest',
        installerUrl,
        cdnUrl,
      ])
    }
    finally { await rm(directory, { recursive: true, force: true }) }
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

  it('recovers from a temporary Nuts 503 by checking the official latest release', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-updater-test-'))
    const version = '3.2.5'
    const installer = Buffer.from('fallback installer')
    const digest = createHash('sha256').update(installer).digest('hex')
    const nutsUrl = 'http://ta.ai-diy.me/update/win32/3.2.4'
    const githubUrl = 'https://api.github.com/repos/AI-DIY/Terminal-Agent/releases/latest'
    const installerUrl = `https://github.com/AI-DIY/Terminal-Agent/releases/download/v${version}/Terminal-Agent-Setup-${version}.exe`
    try {
      const calls: string[] = []
      const service = new UpdaterService({
        currentVersion: '3.2.4',
        tempDirectory: directory,
        platform: 'win32',
        architecture: 'x64',
        feedUrl: 'http://ta.ai-diy.me/update/win32',
        fetch: async (url) => {
          calls.push(url)
          if (url === nutsUrl) return response(503, '')
          if (url === githubUrl) return response(200, JSON.stringify({
            tag_name: `v${version}`,
            name: `Terminal-Agent ${version}`,
            html_url: `https://github.com/AI-DIY/Terminal-Agent/releases/tag/v${version}`,
            assets: [{
              name: `Terminal-Agent-Setup-${version}.exe`,
              browser_download_url: installerUrl,
              size: installer.length,
              digest: `sha256:${digest}`,
            }],
          }))
          if (url === installerUrl) return response(200, installer, { 'content-length': String(installer.length) })
          throw new Error(`Unexpected updater request: ${url}`)
        },
      })

      await expect(service.check()).resolves.toMatchObject({ updateAvailable: true, release: { version, installerName: `Terminal-Agent-Setup-${version}.exe` } })
      expect(calls).toEqual([nutsUrl, githubUrl])
      await expect(service.download()).resolves.toMatchObject({ version, integrityVerified: true })
    }
    finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('uses Nuts only to select a version and downloads the matching signed GitHub installer', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-updater-test-'))
    const version = '3.2.0'
    const payload = Buffer.from('github installer')
    const digest = createHash('sha256').update(payload).digest('hex')
    const nutsMetadataUrl = 'http://ta.ai-diy.me/update/win32/3.1.1'
    const githubMetadataUrl = `https://api.github.com/repos/AI-DIY/Terminal-Agent/releases/tags/v${version}`
    const githubInstallerUrl = `https://github.com/AI-DIY/Terminal-Agent/releases/download/v${version}/Terminal-Agent-Setup-${version}.exe`
    try {
      const calls: string[] = []
      const service = new UpdaterService({
        currentVersion: '3.1.1', tempDirectory: directory, platform: 'win32', architecture: 'x64',
        feedUrl: 'http://ta.ai-diy.me/update/win32',
        launchInstaller: async () => ({ pid: 7 }),
        fetch: async (url) => {
          calls.push(url)
          if (url === nutsMetadataUrl) return response(200, JSON.stringify({
            name: version,
            // This is the current production-style bridge URL. It must never
            // be rewritten or downloaded as an application installer.
            url: `http://ta.ai-diy.me/download/version/${version}/windows_32?filetype=zip`,
            notes: 'hello',
          }))
          if (url === githubMetadataUrl) return response(200, JSON.stringify({
            tag_name: `v${version}`,
            name: `Terminal-Agent ${version}`,
            html_url: `https://github.com/AI-DIY/Terminal-Agent/releases/tag/v${version}`,
            assets: [{
              name: `Terminal-Agent-Setup-${version}.exe`,
              browser_download_url: githubInstallerUrl,
              size: payload.length,
              digest: `sha256:${digest}`,
            }],
          }))
          if (url !== githubInstallerUrl) throw new Error(`Unexpected updater request: ${url}`)
          return response(200, payload, {
            'content-length': String(payload.length),
            'content-disposition': `attachment; filename="Terminal-Agent-Setup-${version}.exe"`,
          })
        },
      })
      await expect(service.check()).resolves.toMatchObject({
        updateAvailable: true,
        release: {
          version,
          installerName: `Terminal-Agent-Setup-${version}.exe`,
          installerUrl: githubInstallerUrl,
          size: payload.length,
          sha256: digest,
        },
      })
      await expect(service.download()).resolves.toMatchObject({ version, size: payload.length, integrityVerified: true })
      await expect(service.install()).resolves.toMatchObject({ launched: true, version })
      expect(calls).toEqual([nutsMetadataUrl, githubMetadataUrl, githubInstallerUrl])
      expect(calls.some(url => url.includes('/download/version/'))).toBe(false)
    }
    finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('rejects a GitHub Release whose tag does not match the version selected by Nuts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-updater-test-'))
    const version = '3.2.4'
    const nutsMetadataUrl = 'http://ta.ai-diy.me/update/win32/3.2.3'
    const githubMetadataUrl = `https://api.github.com/repos/AI-DIY/Terminal-Agent/releases/tags/v${version}`
    try {
      const calls: string[] = []
      const service = new UpdaterService({
        currentVersion: '3.2.3', tempDirectory: directory, platform: 'win32', architecture: 'x64',
        feedUrl: 'http://ta.ai-diy.me/update/win32',
        fetch: async (url) => {
          calls.push(url)
          if (url === nutsMetadataUrl) return response(200, JSON.stringify({ version }))
          if (url === githubMetadataUrl) return response(200, JSON.stringify({
            tag_name: 'v3.2.5',
            html_url: 'https://github.com/AI-DIY/Terminal-Agent/releases/tag/v3.2.5',
            assets: [],
          }))
          throw new Error(`Unexpected updater request: ${url}`)
        },
      })

      await expect(service.check()).rejects.toThrow('版本不一致')
      expect(calls).toEqual([nutsMetadataUrl, githubMetadataUrl])
    }
    finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('rejects non-installer GitHub assets before offering a Nuts-selected update', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-updater-test-'))
    const version = '3.2.4'
    const nutsMetadataUrl = 'http://ta.ai-diy.me/update/win32/3.2.3'
    const githubMetadataUrl = `https://api.github.com/repos/AI-DIY/Terminal-Agent/releases/tags/v${version}`
    try {
      const calls: string[] = []
      const service = new UpdaterService({
        currentVersion: '3.2.3', tempDirectory: directory, platform: 'win32', architecture: 'x64',
        feedUrl: 'http://ta.ai-diy.me/update/win32',
        fetch: async (url) => {
          calls.push(url)
          if (url === nutsMetadataUrl) return response(200, JSON.stringify({ version }))
          if (url === githubMetadataUrl) return response(200, JSON.stringify({
            tag_name: `v${version}`,
            html_url: `https://github.com/AI-DIY/Terminal-Agent/releases/tag/v${version}`,
            assets: [
              { name: 'putty.exe', browser_download_url: 'https://github.com/AI-DIY/Terminal-Agent/releases/download/v3.2.4/putty.exe', size: 279040 },
              { name: `Terminal-Agent-Quick-Install-${version}.zip`, browser_download_url: `https://github.com/AI-DIY/Terminal-Agent/releases/download/v${version}/Terminal-Agent-Quick-Install-${version}.zip`, size: 100 },
              { name: 'Terminal-Agent-Setup-3.2.3.exe', browser_download_url: 'https://github.com/AI-DIY/Terminal-Agent/releases/download/v3.2.3/Terminal-Agent-Setup-3.2.3.exe', size: 100 },
              { name: `Terminal-Agent-Setup-${version}.exe.blockmap`, browser_download_url: `https://github.com/AI-DIY/Terminal-Agent/releases/download/v${version}/Terminal-Agent-Setup-${version}.exe.blockmap`, size: 100 },
            ],
          }))
          throw new Error(`Unexpected updater request: ${url}`)
        },
      })

      await expect(service.check()).rejects.toThrow('没有可用的 Windows x64 安装包')
      expect(calls).toEqual([nutsMetadataUrl, githubMetadataUrl])
    }
    finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('rejects a Nuts-selected GitHub installer without a published digest during check', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-updater-test-'))
    const version = '3.2.4'
    const nutsMetadataUrl = 'http://ta.ai-diy.me/update/win32/3.2.3'
    const githubMetadataUrl = `https://api.github.com/repos/AI-DIY/Terminal-Agent/releases/tags/v${version}`
    try {
      const calls: string[] = []
      const service = new UpdaterService({
        currentVersion: '3.2.3', tempDirectory: directory, platform: 'win32', architecture: 'x64',
        feedUrl: 'http://ta.ai-diy.me/update/win32',
        fetch: async (url) => {
          calls.push(url)
          if (url === nutsMetadataUrl) return response(200, JSON.stringify({ version }))
          if (url === githubMetadataUrl) return response(200, JSON.stringify({
            tag_name: `v${version}`,
            html_url: `https://github.com/AI-DIY/Terminal-Agent/releases/tag/v${version}`,
            assets: [{
              name: `Terminal-Agent-Setup-${version}.exe`,
              browser_download_url: `https://github.com/AI-DIY/Terminal-Agent/releases/download/v${version}/Terminal-Agent-Setup-${version}.exe`,
              size: 100,
            }],
          }))
          throw new Error(`Unexpected updater request: ${url}`)
        },
      })

      await expect(service.check()).rejects.toThrow('未提供安装包完整性校验值')
      expect(calls).toEqual([nutsMetadataUrl, githubMetadataUrl])
    }
    finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('never launches a payload whose response is identified as putty.exe', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-updater-test-'))
    const version = '3.2.4'
    const payload = Buffer.from('unexpected putty payload')
    const digest = createHash('sha256').update(payload).digest('hex')
    const installerUrl = `https://github.com/AI-DIY/Terminal-Agent/releases/download/v${version}/Terminal-Agent-Setup-${version}.exe`
    try {
      let launchCount = 0
      const service = new UpdaterService({
        currentVersion: '3.2.3', tempDirectory: directory, platform: 'win32', architecture: 'x64',
        fetch: async url => url.includes('/releases/latest')
          ? response(200, JSON.stringify({
            tag_name: `v${version}`,
            html_url: `https://github.com/AI-DIY/Terminal-Agent/releases/tag/v${version}`,
            assets: [{ name: `Terminal-Agent-Setup-${version}.exe`, browser_download_url: installerUrl, size: payload.length, digest: `sha256:${digest}` }],
          }))
          : response(200, payload, {
            'content-length': String(payload.length),
            'content-disposition': 'attachment; filename="putty.exe"',
          }),
        launchInstaller: async () => { launchCount += 1; return { pid: 99 } },
      })

      await expect(service.check()).resolves.toMatchObject({ updateAvailable: true, release: { installerUrl } })
      await expect(service.download()).rejects.toThrow('文件名无效')
      expect(launchCount).toBe(0)
      expect(service.getState().phase).toBe('error')
    }
    finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('uses bounded range workers for large assets and falls back when ranges are declined', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-updater-test-'))
    const bytes = Buffer.alloc(5 * 1024 * 1024, 7)
    const version = '3.2.0'
    const installerUrl = `https://github.com/AI-DIY/Terminal-Agent/releases/download/v${version}/Terminal-Agent-Setup-${version}.exe`
    const digest = createHash('sha256').update(bytes).digest('hex')
    try {
      const rangeCalls: string[] = []
      const service = new UpdaterService({
        currentVersion: '3.1.1', tempDirectory: directory, platform: 'win32', architecture: 'x64',
        feedUrl: 'http://ta.ai-diy.me/update/win32', downloadConcurrency: 3,
        fetch: async (url, init) => {
          if (url.includes('/update/win32/')) return response(200, JSON.stringify({ name: version }))
          if (url.includes(`/releases/tags/v${version}`)) return response(200, JSON.stringify({
            tag_name: `v${version}`,
            html_url: `https://github.com/AI-DIY/Terminal-Agent/releases/tag/v${version}`,
            assets: [{ name: `Terminal-Agent-Setup-${version}.exe`, browser_download_url: installerUrl, size: bytes.length, digest: `sha256:${digest}` }],
          }))
          if (url !== installerUrl) throw new Error(`Unexpected updater request: ${url}`)
          const range = init.headers.Range
          if (range) {
            rangeCalls.push(range)
            const match = /bytes=(\d+)-(\d+)/.exec(range)!
            const start = Number(match[1]); const end = Number(match[2])
            return response(206, bytes.subarray(start, end + 1), { 'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${bytes.length}`, 'content-disposition': `attachment; filename="Terminal-Agent-Setup-${version}.exe"` })
          }
          return response(200, bytes, { 'content-length': String(bytes.length), 'content-disposition': `attachment; filename="Terminal-Agent-Setup-${version}.exe"` })
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
    const version = '3.2.0'
    const installerUrl = `https://github.com/AI-DIY/Terminal-Agent/releases/download/v${version}/Terminal-Agent-Setup-${version}.exe`
    const digest = createHash('sha256').update(bytes).digest('hex')
    try {
      let rangeAttempts = 0
      let fullDownloads = 0
      const service = new UpdaterService({
        currentVersion: '3.1.1', tempDirectory: directory, platform: 'win32', architecture: 'x64',
        feedUrl: 'http://ta.ai-diy.me/update/win32', downloadConcurrency: 3,
        fetch: async (url, init) => {
          if (url.includes('/update/win32/')) return response(200, JSON.stringify({ name: version }))
          if (url.includes(`/releases/tags/v${version}`)) return response(200, JSON.stringify({
            tag_name: `v${version}`,
            html_url: `https://github.com/AI-DIY/Terminal-Agent/releases/tag/v${version}`,
            assets: [{ name: `Terminal-Agent-Setup-${version}.exe`, browser_download_url: installerUrl, size: bytes.length, digest: `sha256:${digest}` }],
          }))
          if (url !== installerUrl) throw new Error(`Unexpected updater request: ${url}`)
          if (init.headers.Range) rangeAttempts += 1
          else fullDownloads += 1
          return response(200, bytes, { 'content-length': String(bytes.length), 'content-disposition': `attachment; filename="Terminal-Agent-Setup-${version}.exe"` })
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
