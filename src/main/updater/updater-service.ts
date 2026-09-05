import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, realpath, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import {
  updaterLimits,
  type UpdateRelease,
  type UpdaterCheckResult,
  type UpdaterDownloadInfo,
  type UpdaterInstallResult,
  type UpdaterProgress,
  type UpdaterState,
} from './updater-contracts'

/** The small subset of fetch's response shape used by the updater. */
export type UpdaterHttpResponse = {
  status: number
  headers: { get(name: string): string | null | undefined }
  body?: unknown
  text?: () => Promise<string>
  arrayBuffer?: () => Promise<ArrayBuffer>
}

export type UpdaterFetch = (
  url: string,
  init: {
    method: 'GET'
    headers: Record<string, string>
    redirect: 'manual'
    signal: AbortSignal
  },
) => Promise<UpdaterHttpResponse>

export type InstallerLauncher = (filePath: string) => Promise<{ pid?: number }>

export type UpdaterServiceOptions = {
  /** Current application version. A leading `v` is accepted. */
  currentVersion: string
  /** Directory under which a private, temporary update directory is created. */
  tempDirectory: string
  owner?: string
  repository?: string
  /** Optional Nuts update feed root (for example http://ta.ai-diy.me/update/win32). */
  feedUrl?: string
  platform?: NodeJS.Platform
  architecture?: string
  fetch?: UpdaterFetch
  maxMetadataBytes?: number
  maxInstallerBytes?: number
  maxRedirects?: number
  requestTimeoutMs?: number
  downloadTimeoutMs?: number
  /** Require a cryptographic digest from release metadata before installing. */
  requireIntegrity?: boolean
  /** Number of HTTP range workers used for sufficiently large assets. */
  downloadConcurrency?: number
  launchInstaller?: InstallerLauncher
  exit?: (code: number) => void
}

type GithubReleasePayload = {
  tag_name?: unknown
  name?: unknown
  html_url?: unknown
  published_at?: unknown
  draft?: unknown
  prerelease?: unknown
  body?: unknown
  assets?: unknown
}

type GithubReleaseAsset = {
  name?: unknown
  browser_download_url?: unknown
  size?: unknown
  digest?: unknown
  sha256?: unknown
  sha512?: unknown
  content_type?: unknown
}

type NutsReleasePayload = {
  version?: unknown
  tag_name?: unknown
  name?: unknown
}

type NutsReleaseCandidate = {
  version: string
}

type Semver = {
  major: number
  minor: number
  patch: number
  prerelease: string[]
}

type ActiveRequest = {
  controller: AbortController
  timeout: ReturnType<typeof setTimeout>
}

type UpdaterRequestResult = {
  response: UpdaterHttpResponse
  request: ActiveRequest
}

type UpdateSource = 'github' | 'nuts'

const DEFAULT_OWNER = 'AI-DIY'
const DEFAULT_REPOSITORY = 'Terminal-Agent'
const DEFAULT_API_BASE = 'https://api.github.com'
/** Production update feed.  The main process passes this explicitly so the
 * generic service remains backwards compatible with GitHub integrations and
 * existing embedders/tests that do not opt into Nuts. */
export const DEFAULT_NUTS_FEED_URL = 'http://ta.ai-diy.me/update/win32'
const USER_AGENT = 'Terminal-Agent-Updater/1.0'
const DEFAULT_DOWNLOAD_CONCURRENCY = 4
const RANGE_DOWNLOAD_THRESHOLD = 1 * 1024 * 1024
const installerNamePattern = /^Terminal-Agent-Setup-([0-9A-Za-z][0-9A-Za-z._-]*)\.exe$/i
const safeRepositoryPartPattern = /^[A-Za-z0-9_.-]{1,100}$/
const sha256Pattern = /^[a-f\d]{64}$/i
const sha512Pattern = /^[a-f\d]{128}$/i

const githubHosts = new Set([
  'api.github.com',
  'github.com',
  'objects.githubusercontent.com',
  'github-releases.githubusercontent.com',
  'release-assets.githubusercontent.com',
])

/**
 * Error type used for expected, user-displayable updater failures.  Internal
 * network details are deliberately not propagated to the renderer.
 */
export class UpdaterError extends Error {
  readonly code: string

  constructor(message: string, code = 'UPDATE_FAILED') {
    super(message)
    this.name = 'UpdaterError'
    this.code = code
  }
}

/**
 * A deliberately small updater implementation. It can consume the fixed
 * GitHub release API for legacy callers or a bounded Nuts feed for production
 * builds, caps every response, follows a bounded set of redirects, streams
 * the installer to disk, and verifies any digest advertised by the release
 * before making it executable.
 */
export class UpdaterService {
  private readonly currentVersion: string
  private readonly currentSemver: Semver
  private readonly tempDirectory: string
  private readonly owner: string
  private readonly repository: string
  private readonly feedUrl: string | undefined
  private readonly feedOrigin: string | undefined
  private readonly feedPath: string | undefined
  private readonly downloadConcurrency: number
  private readonly platform: NodeJS.Platform
  private readonly architecture: string
  private readonly fetcher: UpdaterFetch
  private readonly maxMetadataBytes: number
  private readonly maxInstallerBytes: number
  private readonly maxRedirects: number
  private readonly requestTimeoutMs: number
  private readonly downloadTimeoutMs: number
  private readonly requireIntegrity: boolean
  private readonly launchInstaller: InstallerLauncher
  private readonly exit?: (code: number) => void
  private readonly progressListeners = new Set<(event: UpdaterProgress) => void>()
  private readonly statusListeners = new Set<(state: UpdaterState) => void>()
  private readonly errorListeners = new Set<(message: string) => void>()
  private checkPromise: Promise<UpdaterCheckResult> | undefined
  private downloadPromise: Promise<UpdaterDownloadInfo> | undefined
  private installPromise: Promise<UpdaterInstallResult> | undefined
  private operationTail: Promise<void> = Promise.resolve()
  private readonly activeRequests = new Set<ActiveRequest>()
  private updateDirectory: string | undefined
  private installerPath: string | undefined
  private release: UpdateRelease | null = null
  private downloaded: UpdaterDownloadInfo | null = null
  private disposed = false
  private state: UpdaterState

  constructor(options: UpdaterServiceOptions) {
    if (!options || typeof options !== 'object' || typeof options.currentVersion !== 'string') {
      throw new UpdaterError('当前应用版本无效。', 'INVALID_CURRENT_VERSION')
    }
    this.currentVersion = normalizeVersion(options.currentVersion)
    const parsedCurrent = parseSemver(this.currentVersion)
    if (!parsedCurrent) throw new UpdaterError('当前应用版本无效。', 'INVALID_CURRENT_VERSION')
    this.currentSemver = parsedCurrent

    if (!options.tempDirectory || typeof options.tempDirectory !== 'string') {
      throw new UpdaterError('更新临时目录无效。', 'INVALID_TEMP_DIRECTORY')
    }
    this.tempDirectory = resolve(options.tempDirectory)
    this.owner = validateRepositoryPart(options.owner ?? DEFAULT_OWNER, '仓库所有者')
    this.repository = validateRepositoryPart(options.repository ?? DEFAULT_REPOSITORY, '仓库名称')
    const parsedFeed = options.feedUrl === undefined ? undefined : parseFeedUrl(options.feedUrl)
    this.feedUrl = parsedFeed?.root
    this.feedOrigin = parsedFeed?.origin
    this.feedPath = parsedFeed?.path
    this.platform = options.platform ?? process.platform
    this.architecture = options.architecture ?? process.arch
    this.fetcher = options.fetch ?? defaultFetcher
    this.maxMetadataBytes = boundedPositiveInteger(options.maxMetadataBytes ?? updaterLimits.maxMetadataBytes, 1, 10 * 1024 * 1024, '元数据大小上限')
    this.maxInstallerBytes = boundedPositiveInteger(options.maxInstallerBytes ?? updaterLimits.maxInstallerBytes, 1, updaterLimits.maxInstallerBytes, '安装包大小上限')
    this.maxRedirects = boundedPositiveInteger(options.maxRedirects ?? updaterLimits.maxRedirects, 0, 10, '重定向上限')
    this.requestTimeoutMs = boundedPositiveInteger(options.requestTimeoutMs ?? updaterLimits.requestTimeoutMs, 1, 10 * 60_000, '请求超时')
    this.downloadTimeoutMs = boundedPositiveInteger(options.downloadTimeoutMs ?? updaterLimits.downloadTimeoutMs, 1, 60 * 60_000, '下载超时')
    // Every executable update must be anchored to a published digest. The
    // production Nuts feed supplies only release selection; its installer is
    // resolved from the matching official GitHub Release below.
    this.requireIntegrity = options.requireIntegrity ?? true
    this.downloadConcurrency = boundedPositiveInteger(options.downloadConcurrency ?? DEFAULT_DOWNLOAD_CONCURRENCY, 1, 16, '下载并发数')
    this.launchInstaller = options.launchInstaller ?? (filePath => defaultInstallerLauncher(filePath, this.platform))
    this.exit = options.exit
    this.state = {
      phase: 'idle',
      currentVersion: this.currentVersion,
      release: null,
      downloaded: null,
      progress: null,
      error: null,
    }
  }

  /** Current immutable state snapshot for a renderer. */
  getState(): UpdaterState {
    return cloneState(this.state)
  }

  onProgress(listener: (event: UpdaterProgress) => void): () => void {
    this.progressListeners.add(listener)
    return () => this.progressListeners.delete(listener)
  }

  onStatus(listener: (state: UpdaterState) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  onError(listener: (message: string) => void): () => void {
    this.errorListeners.add(listener)
    return () => this.errorListeners.delete(listener)
  }

  /** Backwards-friendly alias for callers that use the electron-updater name. */
  onState(listener: (state: UpdaterState) => void): () => void {
    return this.onStatus(listener)
  }

  async check(): Promise<UpdaterCheckResult> {
    if (this.disposed) throw new UpdaterError('更新服务已关闭。', 'DISPOSED')
    if (this.checkPromise) return this.checkPromise

    const operation = this.enqueue(() => this.performCheck())
    this.checkPromise = operation
    try {
      return await operation
    }
    finally {
      if (this.checkPromise === operation) this.checkPromise = undefined
    }
  }

  /** Alias used by some renderer integrations. */
  checkForUpdates(): Promise<UpdaterCheckResult> {
    return this.check()
  }

  checkLatestRelease(): Promise<UpdaterCheckResult> {
    return this.check()
  }

  async download(): Promise<UpdaterDownloadInfo> {
    if (this.disposed) throw new UpdaterError('更新服务已关闭。', 'DISPOSED')
    if (this.downloadPromise) return this.downloadPromise

    const operation = this.enqueue(() => this.performDownload())
    this.downloadPromise = operation
    try {
      return await operation
    }
    finally {
      if (this.downloadPromise === operation) this.downloadPromise = undefined
    }
  }

  /** Alias used by some renderer integrations. */
  downloadUpdate(): Promise<UpdaterDownloadInfo> {
    return this.download()
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operationTail.then(operation, operation)
    this.operationTail = run.then(() => undefined, () => undefined)
    return run
  }

  async install(): Promise<UpdaterInstallResult> {
    if (this.disposed) throw new UpdaterError('更新服务已关闭。', 'DISPOSED')
    if (this.installPromise) return this.installPromise
    const operation = this.enqueue(() => this.performInstall())
    this.installPromise = operation
    try {
      return await operation
    }
    finally {
      if (this.installPromise === operation) this.installPromise = undefined
    }
  }

  private async performInstall(): Promise<UpdaterInstallResult> {
    this.assertActive()
    if (this.platform !== 'win32') {
      return this.fail('当前平台暂不支持安装更新。', 'UNSUPPORTED_PLATFORM')
    }
    if (!this.release || !this.downloaded || !this.installerPath) {
      return this.fail('请先下载可用更新。', 'UPDATE_NOT_DOWNLOADED')
    }
    assertStrictContainedPath(this.updateDirectory, this.tempDirectory)
    assertContainedPath(this.installerPath, this.updateDirectory)

    this.setState({ phase: 'installing', error: null })
    this.emitProgress({ phase: 'install', percent: 0, version: this.release.version })
    try {
      await verifyDownloadedFile(this.installerPath, this.downloaded, this.maxInstallerBytes, this.updateDirectory)
      this.assertActive()
      await this.launchInstaller(this.installerPath)
      this.emitProgress({ phase: 'install', percent: 100, version: this.release.version })
      this.setState({ phase: 'installed', error: null })
      return { launched: true, version: this.release.version, fileName: this.downloaded.fileName }
    }
    catch (error) {
      return this.fail(publicUpdaterError(error), 'INSTALL_FAILED')
    }
  }

  /** Alias used by some renderer integrations. */
  installUpdate(): Promise<UpdaterInstallResult> {
    return this.install()
  }

  /**
   * Closes the running application after the installer has been launched.
   * The NSIS installer owns the replacement and optional post-install launch;
   * relaunching the old executable here can race file replacement.
   */
  restart(): void {
    if (this.disposed) throw new UpdaterError('更新服务已关闭。', 'DISPOSED')
    if (this.state.phase !== 'installed') throw new UpdaterError('请先启动安装程序。', 'UPDATE_NOT_INSTALLED')
    if (!this.exit) throw new UpdaterError('应用关闭功能不可用。', 'RESTART_UNAVAILABLE')
    this.exit(0)
  }

  /** Alias used by some renderer integrations. */
  restartApp(): void {
    this.restart()
  }

  /** Abort in-flight requests. A downloaded installer is intentionally kept. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const request of this.activeRequests) {
      request.controller.abort(new UpdaterError('更新服务已关闭。', 'DISPOSED'))
      clearTimeout(request.timeout)
    }
    this.activeRequests.clear()
    this.progressListeners.clear()
    this.statusListeners.clear()
    this.errorListeners.clear()
  }

  private async performCheck(): Promise<UpdaterCheckResult> {
    this.release = null
    this.downloaded = null
    await this.removeUpdateDirectory()
    this.assertActive()
    this.setState({ phase: 'checking', error: null, progress: null, release: null, downloaded: null })
    this.emitProgress({ phase: 'check', percent: 0 })
    let request: UpdaterRequestResult | undefined
    try {
      if (this.platform !== 'win32' || !isSupportedArchitecture(this.architecture)) {
        const result: UpdaterCheckResult = { currentVersion: this.currentVersion, updateAvailable: false, release: null }
        this.setState({ phase: 'up-to-date', release: null, downloaded: null, error: null })
        this.emitProgress({ phase: 'check', percent: 100 })
        return result
      }

      const metadataUrl = this.feedUrl
        ? `${this.feedUrl}/${encodeURIComponent(this.currentVersion)}`
        : `${DEFAULT_API_BASE}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repository)}/releases/latest`
      const metadataSource: UpdateSource = this.feedUrl ? 'nuts' : 'github'
      request = await this.request(metadataUrl, {
        maxBytes: this.maxMetadataBytes,
        timeoutMs: this.requestTimeoutMs,
      }, {}, metadataSource)
      this.assertActive()
      // Nuts follows the Squirrel update convention: a 204 response means
      // that the current version is up to date and intentionally has no body.
      if (request.response.status === 204) {
        this.release = null
        this.downloaded = null
        this.installerPath = undefined
        await this.removeUpdateDirectory()
        this.setState({ phase: 'up-to-date', release: null, downloaded: null, error: null })
        this.emitProgress({ phase: 'check', percent: 100 })
        return { currentVersion: this.currentVersion, updateAvailable: false, release: null }
      }
      const payload = parseJsonObject(await readResponseText(request.response, this.maxMetadataBytes, request.request.controller.signal), this.maxMetadataBytes, metadataSource === 'nuts' ? '更新服务' : 'GitHub')
      this.assertActive()
      const release = this.feedUrl ? await this.resolveNutsRelease(payload as NutsReleasePayload) : this.parseRelease(payload)
      const updateAvailable = release !== null
      this.release = release
      this.downloaded = null
      this.installerPath = undefined
      await this.removeUpdateDirectory()
      this.setState({ phase: updateAvailable ? 'available' : 'up-to-date', release, downloaded: null, error: null })
      this.emitProgress({ phase: 'check', percent: 100, version: release?.version })
      return { currentVersion: this.currentVersion, updateAvailable, release }
    }
    catch (error) {
      this.release = null
      this.downloaded = null
      await this.removeUpdateDirectory()
      this.setState({ release: null, downloaded: null })
      return this.fail(publicUpdaterError(error), 'CHECK_FAILED')
    }
    finally {
      // The body is consumed above; release only this operation's request.
      // (A concurrent download may own another request.)
      if (typeof request !== 'undefined') this.releaseRequest(request.request)
    }
  }

  private async performDownload(): Promise<UpdaterDownloadInfo> {
    // An operation can sit behind another queued updater operation.  Recheck
    // the lifecycle state when it actually starts so disposal cannot allow a
    // stale queued download to begin network or filesystem work.
    this.assertActive()
    if (!this.release) {
      const result = await this.performCheck()
      if (!result.release) return this.fail('当前已是最新版本。', 'NO_UPDATE')
    }
    const release = this.release
    if (!release) return this.fail('没有可下载的更新。', 'NO_UPDATE')
    if (this.downloaded && this.installerPath) return this.downloaded

    this.setState({ phase: 'downloading', error: null })
    this.emitProgress({ phase: 'download', percent: 0, transferredBytes: 0, totalBytes: release.size > 0 ? release.size : undefined, version: release.version })
    let directory: string | undefined
    let path: string | undefined
    let fileHandle: Awaited<ReturnType<typeof open>> | undefined
    let request: UpdaterRequestResult | undefined
    try {
      request = await this.request(release.installerUrl, {
        maxBytes: this.maxInstallerBytes,
        timeoutMs: this.downloadTimeoutMs,
      }, {}, 'github')
      this.assertActive()
      const initialRequest = request
      const response = initialRequest.response
      assertInstallerResponseName(response, release.installerName)
      const contentLength = parseContentLength(response.headers.get('content-length'))
      if (contentLength !== undefined && contentLength > this.maxInstallerBytes) {
        throw new UpdaterError('更新安装包超过允许的大小上限。', 'PAYLOAD_TOO_LARGE')
      }
      await mkdir(this.tempDirectory, { recursive: true })
      directory = await mkdtemp(join(this.tempDirectory, 'terminal-agent-update-'))
      path = join(directory, 'Terminal-Agent-Setup.exe')
      assertContainedPath(path, directory)
      fileHandle = await open(path, 'wx', 0o600)

      let transferred = 0
      const rangeTotal = contentLength ?? (release.size > 0 ? release.size : undefined)
      const useRanges = Boolean(rangeTotal && rangeTotal >= RANGE_DOWNLOAD_THRESHOLD && this.downloadConcurrency > 1)
      if (useRanges && rangeTotal) {
        try {
          await fileHandle.truncate(rangeTotal)
          transferred = await this.downloadWithRanges(release.installerUrl, rangeTotal, fileHandle, release, 'github')
          // The initial full response was only a size probe. Close it after
          // range workers succeed; otherwise its unread body could retain a
          // connection in Chromium's session pool.
          this.abortRequest(initialRequest.request)
          request = undefined
        }
        catch (error) {
          if (!(error instanceof RangeUnsupportedError)) {
            this.abortRequest(initialRequest.request)
            request = undefined
            throw error
          }
          await fileHandle.truncate(0)
          // Reuse the probe response when the server returned a normal 200;
          // this avoids downloading the same large payload twice merely
          // because Range is unsupported. A non-200 probe is re-requested.
          let fallbackResponse = initialRequest.response
          let fallbackRequest = initialRequest
          if (fallbackResponse.status !== 200) {
            this.abortRequest(initialRequest.request)
            fallbackRequest = await this.request(release.installerUrl, {
              maxBytes: this.maxInstallerBytes,
              timeoutMs: this.downloadTimeoutMs,
            }, {}, 'github')
            request = fallbackRequest
            fallbackResponse = fallbackRequest.response
          }
          const fallbackLength = parseContentLength(fallbackResponse.headers.get('content-length'))
          transferred = 0
          for await (const chunk of responseChunks(fallbackResponse, fallbackRequest.request.controller.signal)) {
            this.assertActive()
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
            transferred += bytes.byteLength
            if (transferred > this.maxInstallerBytes) throw new UpdaterError('更新安装包超过允许的大小上限。', 'PAYLOAD_TOO_LARGE')
            await writeAll(fileHandle, bytes)
            const total = release.size > 0 ? release.size : fallbackLength
            const percent = total ? Math.min(99, (transferred / total) * 100) : 0
            this.emitProgress({ phase: 'download', percent, transferredBytes: transferred, totalBytes: total && total > 0 ? total : undefined, version: release.version })
          }
        }
      }
      else {
        for await (const chunk of responseChunks(response, initialRequest.request.controller.signal)) {
          this.assertActive()
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          transferred += bytes.byteLength
          if (transferred > this.maxInstallerBytes) throw new UpdaterError('更新安装包超过允许的大小上限。', 'PAYLOAD_TOO_LARGE')
          await writeAll(fileHandle, bytes)
          const total = release.size > 0 ? release.size : contentLength
          const percent = total ? Math.min(99, (transferred / total) * 100) : 0
          this.emitProgress({ phase: 'download', percent, transferredBytes: transferred, totalBytes: total && total > 0 ? total : undefined, version: release.version })
        }
      }
      await fileHandle.close()
      fileHandle = undefined
      if (transferred <= 0) throw new UpdaterError('更新安装包为空。', 'EMPTY_PAYLOAD')
      if (release.size > 0 && transferred !== release.size) throw new UpdaterError('更新安装包大小校验失败。', 'SIZE_MISMATCH')
      if (release.size <= 0 && contentLength !== undefined && contentLength > 0 && transferred !== contentLength) {
        throw new UpdaterError('更新安装包大小校验失败。', 'SIZE_MISMATCH')
      }

      const { sha256: calculatedSha256, sha512: calculatedSha512 } = await hashFile(path)
      this.assertActive()
      if (release.sha256 && calculatedSha256.toLowerCase() !== release.sha256.toLowerCase()) throw new UpdaterError('更新安装包完整性校验失败。', 'DIGEST_MISMATCH')
      if (release.sha512 && calculatedSha512.toLowerCase() !== release.sha512.toLowerCase()) throw new UpdaterError('更新安装包完整性校验失败。', 'DIGEST_MISMATCH')
      if (this.requireIntegrity && !release.sha256 && !release.sha512) throw new UpdaterError('发布未提供安装包完整性校验值。', 'MISSING_DIGEST')

      const result: UpdaterDownloadInfo = {
        version: release.version,
        fileName: release.installerName,
        size: transferred,
        sha256: calculatedSha256,
        sha512: calculatedSha512,
        integrityVerified: Boolean(release.sha256 || release.sha512),
      }
      this.assertActive()
      this.updateDirectory = directory
      this.installerPath = path
      this.downloaded = result
      this.setState({ phase: 'downloaded', downloaded: result, error: null })
      this.emitProgress({ phase: 'download', percent: 100, transferredBytes: transferred, totalBytes: transferred, version: release.version })
      return result
    }
    catch (error) {
      if (fileHandle) await fileHandle.close().catch(() => undefined)
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined)
      return this.fail(publicUpdaterError(error), 'DOWNLOAD_FAILED')
    }
    finally {
      if (typeof request !== 'undefined') this.releaseRequest(request.request)
    }
  }

  private abortRequest(request: ActiveRequest): void {
    clearTimeout(request.timeout)
    this.activeRequests.delete(request)
    try { request.controller.abort(new UpdaterError('更新请求已切换下载方式。', 'RANGE_RETRY')) } catch { /* already aborted */ }
  }

  /** Download a large asset using bounded HTTP byte-range workers. */
  private async downloadWithRanges(
    url: string,
    total: number,
    fileHandle: Awaited<ReturnType<typeof open>>,
    release: UpdateRelease,
    source: UpdateSource,
  ): Promise<number> {
    // Keep segments reasonably small for memory usage, while ensuring a
    // couple of workers are useful even in test/dev feeds with 1–5 MiB
    // payloads.
    const chunkSize = Math.min(4 * 1024 * 1024, Math.max(1 * 1024 * 1024, Math.ceil(total / (this.downloadConcurrency * 2))))
    const ranges: Array<{ start: number; end: number }> = []
    for (let start = 0; start < total; start += chunkSize) ranges.push({ start, end: Math.min(total - 1, start + chunkSize - 1) })
    if (ranges.length === 0) throw new RangeUnsupportedError()
    let transferred = 0
    const first = await this.fetchRange(url, ranges[0], total, source)
    await writeAt(fileHandle, first.start, first.bytes)
    transferred += first.bytes.byteLength
    this.emitProgress({ phase: 'download', percent: Math.min(99, (transferred / total) * 100), transferredBytes: transferred, totalBytes: total, version: release.version })

    let cursor = 1
    const workerCount = Math.min(this.downloadConcurrency, Math.max(1, ranges.length - 1))
    const worker = async (): Promise<void> => {
      while (true) {
        this.assertActive()
        const index = cursor
        cursor += 1
        if (index >= ranges.length) return
        const range = ranges[index]
        const result = await this.fetchRange(url, range, total, source)
        await writeAt(fileHandle, result.start, result.bytes)
        transferred += result.bytes.byteLength
        this.emitProgress({ phase: 'download', percent: Math.min(99, (transferred / total) * 100), transferredBytes: transferred, totalBytes: total, version: release.version })
      }
    }
    // Wait for every worker to settle before falling back. This prevents a
    // late range response from racing the sequential rewrite of the file.
    const workerResults = await Promise.allSettled(Array.from({ length: workerCount }, () => worker()))
    const failed = workerResults.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failed) throw failed.reason
    if (transferred !== total) throw new UpdaterError('更新安装包大小校验失败。', 'SIZE_MISMATCH')
    return transferred
  }

  private async fetchRange(url: string, range: { start: number; end: number }, total: number, source: UpdateSource): Promise<{ start: number; bytes: Buffer }> {
    const length = range.end - range.start + 1
    let request: UpdaterRequestResult | undefined
    try {
      try {
        // Use the complete asset limit here, not the segment length: a server
        // that ignores Range commonly responds 200 with the full payload. We
        // need to inspect that status and trigger the sequential fallback
        // instead of misclassifying it as an oversized response.
        request = await this.request(url, { maxBytes: Math.min(total, this.maxInstallerBytes), timeoutMs: this.downloadTimeoutMs }, { Range: `bytes=${range.start}-${range.end}` }, source)
      }
      catch (error) {
        // 416 is the conventional response when a server does not honor the
        // requested range (or has a stale length); let the caller retry once
        // with the proven sequential transfer path.
        if (error instanceof UpdaterError && /(?:\(416\)|（416）)/.test(error.message)) throw new RangeUnsupportedError()
        throw error
      }
      this.assertActive()
      if (request.response.status !== 206) {
        this.abortRequest(request.request)
        throw new RangeUnsupportedError()
      }
      const contentRange = request.response.headers.get('content-range')
      const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(contentRange?.trim() ?? '')
      if (!match || Number(match[1]) !== range.start || Number(match[2]) !== range.end || (match[3] !== '*' && Number(match[3]) !== total)) {
        this.abortRequest(request.request)
        throw new RangeUnsupportedError()
      }
      let bytes: Buffer
      try {
        bytes = await readResponseBytes(request.response, length, request.request.controller.signal)
      }
      catch (error) {
        if (error instanceof UpdaterError && error.code === 'PAYLOAD_TOO_LARGE') throw new RangeUnsupportedError()
        throw error
      }
      if (bytes.byteLength !== length) throw new RangeUnsupportedError()
      return { start: range.start, bytes }
    }
    finally {
      if (request) this.releaseRequest(request.request)
    }
  }

  private parseRelease(payload: GithubReleasePayload): UpdateRelease | null {
    if (!isRecord(payload)) throw new UpdaterError('GitHub 返回的版本信息格式无效。', 'INVALID_METADATA')
    if (payload.draft === true || payload.prerelease === true) return null
    const tagName = boundedString(payload.tag_name, 128)
    if (!tagName) throw new UpdaterError('GitHub 版本标签无效。', 'INVALID_METADATA')
    const version = normalizeVersion(tagName)
    const semver = parseSemver(version)
    if (!semver) throw new UpdaterError('GitHub 版本标签无效。', 'INVALID_METADATA')
    if (compareSemver(semver, this.currentSemver) <= 0) return null

    const assets = Array.isArray(payload.assets) ? payload.assets.filter(isRecord) as GithubReleaseAsset[] : []
    const candidates = assets
      .map(asset => this.parseInstallerAsset(asset, version))
      .filter((asset): asset is NonNullable<typeof asset> => asset !== null)
      .sort((left, right) => left.name.localeCompare(right.name))
    const installer = candidates[0]
    if (!installer) throw new UpdaterError('GitHub 版本没有可用的 Windows x64 安装包。', 'MISSING_INSTALLER')

    const htmlUrl = boundedString(payload.html_url, 2_048)
    if (!htmlUrl || !isAllowedGithubUrl(htmlUrl, this.owner, this.repository, 'release')) throw new UpdaterError('GitHub 版本链接不受信任。', 'UNTRUSTED_URL')
    const publishedAt = boundedString(payload.published_at, 128)
    const releaseDate = publishedAt && !Number.isNaN(Date.parse(publishedAt)) ? new Date(publishedAt).toISOString() : null
    const name = boundedString(payload.name, 256) ?? `Terminal-Agent ${version}`
    const notes = typeof payload.body === 'string' ? truncateUtf8(payload.body, updaterLimits.maxReleaseNotesBytes) : ''

    return {
      version,
      tagName,
      name,
      releaseDate,
      htmlUrl,
      installerName: installer.name,
      installerUrl: installer.url,
      size: installer.size,
      sha256: installer.sha256,
      sha512: installer.sha512,
      notes,
    }
  }

  /**
   * Nuts decides whether a newer version exists. Its current public endpoint
   * can advertise a ZIP/bridge URL rather than the NSIS installer, so the
   * executable and digest are resolved from the same version's GitHub Release.
   */
  private async resolveNutsRelease(payload: NutsReleasePayload): Promise<UpdateRelease | null> {
    const candidate = this.parseNutsRelease(payload)
    if (!candidate) return null
    let request: UpdaterRequestResult | undefined
    try {
      const url = githubReleaseTagUrl(this.owner, this.repository, candidate.version)
      request = await this.request(url, {
        maxBytes: this.maxMetadataBytes,
        timeoutMs: this.requestTimeoutMs,
      }, {}, 'github')
      const githubPayload = parseJsonObject(
        await readResponseText(request.response, this.maxMetadataBytes, request.request.controller.signal),
        this.maxMetadataBytes,
        'GitHub',
      )
      this.assertActive()
      return this.mergeNutsReleaseWithGithubInstaller(candidate, githubPayload)
    }
    finally {
      if (request) this.releaseRequest(request.request)
    }
  }

  /** Parse only the version selected by the compact Nuts response (HTTP 200). */
  private parseNutsRelease(payload: NutsReleasePayload): NutsReleaseCandidate | null {
    if (!isRecord(payload)) throw new UpdaterError('更新服务返回的版本信息格式无效。', 'INVALID_METADATA')
    const rawVersionValue = boundedString(payload.version ?? payload.tag_name ?? payload.name, 128)
    const rawVersion = rawVersionValue && (/^v?\d+\.\d+\.\d+/.test(rawVersionValue) ? rawVersionValue : rawVersionValue.match(/v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/)?.[0] ?? null)
    if (!rawVersion) throw new UpdaterError('更新服务返回的版本号无效。', 'INVALID_METADATA')
    let version: string
    try { version = normalizeVersion(rawVersion) }
    catch { throw new UpdaterError('更新服务返回的版本号无效。', 'INVALID_METADATA') }
    const semver = parseSemver(version)
    if (!semver) throw new UpdaterError('更新服务返回的版本号无效。', 'INVALID_METADATA')
    if (compareSemver(semver, this.currentSemver) <= 0) return null

    return { version }
  }

  private mergeNutsReleaseWithGithubInstaller(candidate: NutsReleaseCandidate, payload: GithubReleasePayload): UpdateRelease {
    if (!isRecord(payload) || payload.draft === true || payload.prerelease === true) {
      throw new UpdaterError('官方 GitHub Release 不可用于升级。', 'MISSING_INSTALLER')
    }
    const tagName = boundedString(payload.tag_name, 128)
    if (!tagName) throw new UpdaterError('官方 GitHub Release 版本标签无效。', 'INVALID_METADATA')
    let version: string
    try { version = normalizeVersion(tagName) }
    catch { throw new UpdaterError('官方 GitHub Release 版本标签无效。', 'INVALID_METADATA') }
    if (version !== candidate.version) throw new UpdaterError('更新服务与官方 Release 版本不一致。', 'INVALID_METADATA')

    const assets = Array.isArray(payload.assets) ? payload.assets.filter(isRecord) as GithubReleaseAsset[] : []
    const installer = assets
      .map(asset => this.parseInstallerAsset(asset, version))
      .find((asset): asset is NonNullable<typeof asset> => asset !== null)
    if (!installer) throw new UpdaterError('官方 GitHub Release 没有可用的 Windows x64 安装包。', 'MISSING_INSTALLER')
    if (!installer.sha256 && !installer.sha512) {
      throw new UpdaterError('官方 GitHub Release 未提供安装包完整性校验值。', 'MISSING_DIGEST')
    }

    const htmlUrl = boundedString(payload.html_url, 2_048)
    if (!htmlUrl || !isAllowedGithubUrl(htmlUrl, this.owner, this.repository, 'release')) {
      throw new UpdaterError('官方 GitHub Release 链接不受信任。', 'UNTRUSTED_URL')
    }
    const publishedAt = boundedString(payload.published_at, 128)
    const releaseDate = publishedAt && !Number.isNaN(Date.parse(publishedAt)) ? new Date(publishedAt).toISOString() : null
    const name = boundedString(payload.name, 256) ?? `Terminal-Agent ${version}`
    const notes = typeof payload.body === 'string' ? truncateUtf8(payload.body, updaterLimits.maxReleaseNotesBytes) : ''
    return {
      version,
      tagName: `v${version}`,
      name,
      releaseDate,
      htmlUrl,
      installerName: installer.name,
      installerUrl: installer.url,
      size: installer.size,
      sha256: installer.sha256,
      sha512: installer.sha512,
      notes,
    }
  }

  private parseInstallerAsset(asset: GithubReleaseAsset, version: string): {
    name: string
    url: string
    size: number
    sha256: string | null
    sha512: string | null
  } | null {
    const name = boundedString(asset.name, 256)
    const url = boundedString(asset.browser_download_url, 4_096)
    if (!name || !url || !installerNamePattern.test(name)) return null
    // GitHub's API returns a github.com release URL.  CDN hosts are accepted
    // only as bounded redirects during the actual request, never as metadata
    // supplied directly by a release payload.
    if (!isAllowedGithubUrl(url, this.owner, this.repository, 'asset')) return null
    const match = installerNamePattern.exec(name)
    if (!match) return null
    let assetVersion: string
    try { assetVersion = normalizeVersion(match[1]) } catch { return null }
    if (assetVersion !== version) return null
    if (!isCanonicalGithubAssetUrl(url, this.owner, this.repository, version, name)) return null
    const size = typeof asset.size === 'number' && Number.isSafeInteger(asset.size) ? asset.size : 0
    if (size <= 0 || size > this.maxInstallerBytes) return null
    // Prefer GitHub's `digest` field, but tolerate older API fixtures that
    // expose a valid sha256/sha512 field when `digest` is absent or malformed.
    const digestCandidates: unknown[] = [
      asset.digest,
      typeof asset.sha256 === 'string' ? `sha256:${asset.sha256}` : undefined,
      typeof asset.sha512 === 'string' ? `sha512:${asset.sha512}` : undefined,
    ]
    let digest = { sha256: null as string | null, sha512: null as string | null }
    for (const candidate of digestCandidates) {
      const parsed = parseDigest(candidate)
      if (parsed.sha256 || parsed.sha512) {
        digest = parsed
        break
      }
    }
    return { name, url, size, sha256: digest.sha256, sha512: digest.sha512 }
  }

  private async request(
    url: string,
    limits: { maxBytes: number; timeoutMs: number },
    extraHeaders: Record<string, string> = {},
    source: UpdateSource = this.feedUrl ? 'nuts' : 'github',
  ): Promise<UpdaterRequestResult> {
    let currentUrl = url
    for (let redirect = 0; redirect <= this.maxRedirects; redirect += 1) {
      const isInitialRequest = redirect === 0 && currentUrl === url
      const allowed = source === 'nuts'
        ? isAllowedNutsUrl(currentUrl, this.feedOrigin, this.feedPath, isInitialRequest && isNutsMetadataUrl(currentUrl, this.feedPath) ? 'metadata' : 'any')
        : isAllowedGithubUrl(
          currentUrl,
          this.owner,
          this.repository,
          isInitialRequest
            ? (isGithubMetadataUrl(currentUrl, this.owner, this.repository) ? 'api' : 'asset')
            : 'any',
        )
      if (!allowed) throw new UpdaterError('更新地址不受信任。', 'UNTRUSTED_URL')
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(new UpdaterError('更新请求超时。', 'TIMEOUT')), limits.timeoutMs)
      const request: ActiveRequest = { controller, timeout }
      this.activeRequests.add(request)
      let handedOff = false
      try {
        const isMetadataRequest = source === 'nuts'
          ? isNutsMetadataUrl(currentUrl, this.feedPath)
          : isGithubMetadataUrl(currentUrl, this.owner, this.repository)
        const response = await this.fetcher(currentUrl, {
          method: 'GET',
          headers: {
            Accept: isMetadataRequest ? (source === 'nuts' ? 'application/json' : 'application/vnd.github+json') : 'application/octet-stream',
            'User-Agent': USER_AGENT,
            ...(source === 'github' ? { 'X-GitHub-Api-Version': '2022-11-28' } : {}),
            ...extraHeaders,
          },
          redirect: 'manual',
          signal: controller.signal,
        })
        // Fetch implementations supplied by tests or embedders may not honor
        // AbortSignal.  The explicit check keeps the timeout contract intact
        // even when such a fetcher resolves after the timer fired.
        throwIfRequestAborted(controller.signal)
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location')
          if (!location || redirect === this.maxRedirects) throw new UpdaterError('更新下载重定向次数过多。', 'TOO_MANY_REDIRECTS')
          const nextUrl = new URL(location, currentUrl).toString()
          const redirectAllowed = source === 'nuts'
            ? isAllowedNutsUrl(nextUrl, this.feedOrigin, this.feedPath, 'any')
            : isAllowedGithubUrl(nextUrl, this.owner, this.repository, 'any')
          if (!redirectAllowed) throw new UpdaterError('更新下载重定向到不受信任的地址。', 'UNTRUSTED_REDIRECT')
          currentUrl = nextUrl
          continue
        }
        if (response.status < 200 || response.status >= 300) {
          if (response.status === 404) throw new UpdaterError('暂未找到可用版本。', 'NOT_FOUND')
          if (response.status === 403) throw new UpdaterError(source === 'nuts' ? '更新服务请求受限，请稍后重试。' : 'GitHub 请求受限，请稍后重试。', 'RATE_LIMITED')
          throw new UpdaterError(`${source === 'nuts' ? '更新服务' : 'GitHub'} 请求失败（${response.status}）。`, 'HTTP_ERROR')
        }
        const contentLength = parseContentLength(response.headers.get('content-length'))
        if (contentLength !== undefined && contentLength > limits.maxBytes) throw new UpdaterError('更新响应超过允许的大小上限。', 'PAYLOAD_TOO_LARGE')
        handedOff = true
        return { response, request }
      }
      catch (error) {
        if (error instanceof UpdaterError) throw error
        if (controller.signal.aborted) throwIfRequestAborted(controller.signal)
        if (isAbortError(error)) throw new UpdaterError('更新请求超时。', 'TIMEOUT')
        throw new UpdaterError(`无法连接${source === 'nuts' ? '更新' : 'GitHub'}服务。`, 'NETWORK_ERROR')
      }
      finally {
        if (!handedOff) {
          clearTimeout(timeout)
          this.activeRequests.delete(request)
        }
      }
    }
    throw new UpdaterError('更新下载重定向次数过多。', 'TOO_MANY_REDIRECTS')
  }

  private releaseRequest(request: ActiveRequest): void {
    clearTimeout(request.timeout)
    this.activeRequests.delete(request)
  }

  private setState(patch: Partial<UpdaterState>): void {
    if (this.disposed) return
    this.state = {
      ...this.state,
      ...patch,
      release: patch.release === undefined ? this.state.release : patch.release,
      downloaded: patch.downloaded === undefined ? this.state.downloaded : patch.downloaded,
      progress: patch.progress === undefined ? this.state.progress : patch.progress,
      error: patch.error === undefined ? this.state.error : patch.error,
    }
    const snapshot = this.getState()
    for (const listener of this.statusListeners) {
      try { listener(snapshot) } catch { /* A renderer listener must not break the updater. */ }
    }
  }

  private emitProgress(event: UpdaterProgress): void {
    if (this.disposed) return
    this.state = { ...this.state, progress: event }
    const snapshot = { ...event }
    for (const listener of this.progressListeners) {
      try { listener(snapshot) } catch { /* A renderer listener must not break the updater. */ }
    }
    // `onStatus` is the complete state stream.  Keep progress updates visible
    // there as well as through the dedicated progress channel for callers that
    // subscribe to only one event source.
    const stateSnapshot = this.getState()
    for (const listener of this.statusListeners) {
      try { listener(stateSnapshot) } catch { /* A renderer listener must not break the updater. */ }
    }
  }

  private fail<T = never>(message: string, code: string): T {
    const safeMessage = message.slice(0, 2_000)
    this.setState({ phase: 'error', error: safeMessage })
    for (const listener of this.errorListeners) {
      try { listener(safeMessage) } catch { /* Error listeners are observational only. */ }
    }
    throw new UpdaterError(safeMessage, code)
  }

  private assertActive(): void {
    if (this.disposed) throw new UpdaterError('更新服务已关闭。', 'DISPOSED')
  }

  private async removeUpdateDirectory(): Promise<void> {
    const directory = this.updateDirectory
    this.updateDirectory = undefined
    this.installerPath = undefined
    if (directory && isStrictContainedPath(directory, this.tempDirectory)) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

function normalizeVersion(value: string): string {
  const trimmed = value.trim().replace(/^v/i, '')
  const match = /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/.exec(trimmed)
  if (!match) throw new UpdaterError('版本号无效。', 'INVALID_VERSION')
  const parsed = parseSemver(match[1])
  if (!parsed) throw new UpdaterError('版本号无效。', 'INVALID_VERSION')
  return match[1]
}

function parseSemver(value: string): Semver | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value)
  if (!match) return null
  const major = Number(match[1]); const minor = Number(match[2]); const patch = Number(match[3])
  if (![major, minor, patch].every(Number.isSafeInteger)) return null
  return { major, minor, patch, prerelease: match[4]?.split('.') ?? [] }
}

function compareSemver(left: Semver, right: Semver): number {
  for (const field of ['major', 'minor', 'patch'] as const) {
    if (left[field] !== right[field]) return left[field] > right[field] ? 1 : -1
  }
  if (left.prerelease.length === 0 && right.prerelease.length > 0) return 1
  if (left.prerelease.length > 0 && right.prerelease.length === 0) return -1
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index += 1) {
    const a = left.prerelease[index]; const b = right.prerelease[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    if (a === b) continue
    const aNumeric = /^\d+$/.test(a); const bNumeric = /^\d+$/.test(b)
    if (aNumeric && bNumeric) return Number(a) > Number(b) ? 1 : -1
    if (aNumeric) return -1
    if (bNumeric) return 1
    return a > b ? 1 : -1
  }
  return 0
}

function parseDigest(value: unknown): { sha256: string | null; sha512: string | null } {
  if (typeof value !== 'string') return { sha256: null, sha512: null }
  const match = /^(sha256|sha512):([a-f\d]+)$/i.exec(value.trim())
  if (!match) return { sha256: null, sha512: null }
  const digest = match[2].toLowerCase()
  if (match[1].toLowerCase() === 'sha256' && sha256Pattern.test(digest)) return { sha256: digest, sha512: null }
  if (match[1].toLowerCase() === 'sha512' && sha512Pattern.test(digest)) return { sha256: null, sha512: digest }
  return { sha256: null, sha512: null }
}

/** Internal signal used to trigger a safe sequential-download fallback. */
class RangeUnsupportedError extends Error {
  constructor() {
    super('服务器不支持分段下载')
    this.name = 'RangeUnsupportedError'
  }
}

type ParsedFeedUrl = { root: string; origin: string; path: string }

function parseFeedUrl(value: string): ParsedFeedUrl {
  let url: URL
  try { url = new URL(value) }
  catch { throw new UpdaterError('更新服务地址无效。', 'INVALID_FEED_URL') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port || url.search || url.hash) {
    throw new UpdaterError('更新服务地址无效。', 'INVALID_FEED_URL')
  }
  const path = url.pathname.replace(/\/+$/, '')
  if (!path || path === '/') throw new UpdaterError('更新服务地址无效。', 'INVALID_FEED_URL')
  url.pathname = path
  return { root: url.toString().replace(/\/$/, ''), origin: url.origin.toLowerCase(), path }
}

function isAllowedNutsUrl(value: string, origin: string | undefined, feedPath: string | undefined, kind: 'metadata' | 'any'): boolean {
  if (!origin || !feedPath) return false
  let url: URL
  try { url = new URL(value) } catch { return false }
  if (url.origin.toLowerCase() !== origin || url.username || url.password || url.port || url.hash) return false
  const path = url.pathname.replace(/\/+$/, '')
  try {
    if (path.split('/').some(segment => ['.', '..'].includes(decodeURIComponent(segment)))) return false
  }
  catch { return false }
  if (kind === 'metadata') {
    // Metadata must be exactly `${feedRoot}/<version>`; this prevents a
    // caller-controlled feed URL from being used as an open proxy.
    let suffix = path.startsWith(`${feedPath}/`) ? path.slice(feedPath.length + 1) : ''
    try { suffix = decodeURIComponent(suffix) } catch { return false }
    return !url.search && Boolean(suffix) && suffix.split('/').length === 1 && /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(suffix)
  }
  // Nuts download endpoints are conventionally under /download. Also allow
  // a direct executable beneath the configured feed path for self-hosted feeds.
  return path.startsWith('/download/') || path === feedPath || path.startsWith(`${feedPath}/`)
}

function isNutsMetadataUrl(value: string, feedPath: string | undefined): boolean {
  if (!feedPath) return false
  try {
    const path = new URL(value).pathname.replace(/\/+$/, '')
    const suffix = path.startsWith(`${feedPath}/`) ? decodeURIComponent(path.slice(feedPath.length + 1)) : ''
    return Boolean(suffix && suffix.split('/').length === 1 && /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(suffix))
  }
  catch { return false }
}

function githubReleaseTagUrl(owner: string, repository: string, version: string): string {
  return `${DEFAULT_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/releases/tags/${encodeURIComponent(`v${version}`)}`
}

/**
 * Metadata must use one of GitHub's exact release API endpoints. Keeping
 * this separate from asset validation prevents a Release payload from
 * redirecting the client into another API path.
 */
function isGithubMetadataUrl(value: string, owner: string, repository: string): boolean {
  let url: URL
  try { url = new URL(value) } catch { return false }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'api.github.com' || url.username || url.password || url.port || url.search || url.hash) return false
  const releasePrefix = `/repos/${owner}/${repository}/releases/`
  if (url.pathname === `${releasePrefix}latest`) return true
  const tagPrefix = `${releasePrefix}tags/`
  if (!url.pathname.startsWith(tagPrefix)) return false
  const encodedTag = url.pathname.slice(tagPrefix.length)
  if (!encodedTag || encodedTag.includes('/')) return false
  let tag: string
  try { tag = decodeURIComponent(encodedTag) } catch { return false }
  if (encodeURIComponent(tag) !== encodedTag || !tag.startsWith('v')) return false
  try { return tag === `v${normalizeVersion(tag)}` } catch { return false }
}

function isAllowedGithubUrl(value: string, owner: string, repository: string, kind: 'api' | 'release' | 'asset' | 'any'): boolean {
  let url: URL
  try { url = new URL(value) } catch { return false }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false
  const host = url.hostname.toLowerCase()
  if (!githubHosts.has(host)) return false
  const expectedPrefix = `/repos/${owner}/${repository}`
  if (kind === 'api') return isGithubMetadataUrl(value, owner, repository)
  if (kind === 'asset') return host === 'github.com' && url.pathname.startsWith(`/${owner}/${repository}/releases/download/`)
  if (host === 'api.github.com') return url.pathname.startsWith(`${expectedPrefix}/`)
  if (host === 'github.com') {
    const releasePrefix = `/${owner}/${repository}/releases/`
    return url.pathname.startsWith(releasePrefix)
  }
  // CDN hosts are only accepted after GitHub has issued a redirect. They do
  // not accept caller-controlled repository paths, but still must be HTTPS.
  return kind === 'any'
}

/**
 * Validate the complete GitHub release-asset path, not only its directory
 * prefix.  A metadata payload that names version A but points at version B (or
 * an arbitrary file under the release directory) must never be downloaded.
 */
function isCanonicalGithubAssetUrl(value: string, owner: string, repository: string, version: string, fileName: string): boolean {
  let url: URL
  try { url = new URL(value) } catch { return false }
  if (url.hostname.toLowerCase() !== 'github.com') return false
  const segments = url.pathname.split('/').filter(Boolean)
  if (segments.length !== 6) return false
  if (segments[0] !== owner || segments[1] !== repository || segments[2] !== 'releases' || segments[3] !== 'download') return false
  let tag: string
  let file: string
  try {
    tag = decodeURIComponent(segments[4])
    file = decodeURIComponent(segments[5])
  }
  catch { return false }
  if (file !== fileName) return false
  try { return normalizeVersion(tag) === version } catch { return false }
}

function validateRepositoryPart(value: string, label: string): string {
  if (!safeRepositoryPartPattern.test(value) || value === '.' || value === '..') throw new UpdaterError(`${label}无效。`, 'INVALID_REPOSITORY')
  return value
}

function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : null
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  let end = Math.min(value.length, maxBytes)
  while (end > 0 && Buffer.byteLength(value.slice(0, end), 'utf8') > maxBytes) end -= 1
  // Never return a string ending in an unpaired UTF-16 surrogate.  This can
  // happen when a byte cap falls between the two code units of an emoji.
  const last = end > 0 ? value.charCodeAt(end - 1) : 0
  const previous = end > 1 ? value.charCodeAt(end - 2) : 0
  const isHigh = last >= 0xd800 && last <= 0xdbff
  const isLow = last >= 0xdc00 && last <= 0xdfff
  if (isHigh || (isLow && !(previous >= 0xd800 && previous <= 0xdbff))) end -= 1
  return value.slice(0, end)
}

function boundedPositiveInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new UpdaterError(`${label}无效。`, 'INVALID_LIMIT')
  return value
}

function parseContentLength(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined || value.trim() === '') return undefined
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined
}

function assertInstallerResponseName(response: UpdaterHttpResponse, expectedName: string): void {
  let disposition: string | null | undefined
  try { disposition = response.headers.get('content-disposition') } catch { return }
  if (!disposition) return
  const match = /(?:^|;)\s*filename\*?\s*=\s*(?:UTF-8'')?(?:"([^"]+)"|'([^']+)'|([^;\s]+))/i.exec(disposition)
  if (!match) return
  let fileName = (match[1] ?? match[2] ?? match[3] ?? '').trim()
  try { fileName = decodeURIComponent(fileName) } catch { /* keep raw value */ }
  // A Nuts endpoint can legally redirect to a different asset. Never launch
  // a payload named putty.exe (or any unrelated executable) as our installer.
  if (fileName.toLowerCase() !== expectedName.toLowerCase()) {
    throw new UpdaterError('更新服务返回的安装包文件名无效。', 'MISSING_INSTALLER')
  }
}

function parseJsonObject(text: string, maxBytes: number, source = 'GitHub'): GithubReleasePayload {
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new UpdaterError(`${source} 元数据超过允许的大小上限。`, 'PAYLOAD_TOO_LARGE')
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new UpdaterError(`${source} 返回的版本信息无法解析。`, 'INVALID_METADATA') }
  if (!isRecord(value)) throw new UpdaterError(`${source} 返回的版本信息格式无效。`, 'INVALID_METADATA')
  return value as GithubReleasePayload
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSupportedArchitecture(architecture: string): boolean {
  return architecture === 'x64' || architecture === 'amd64'
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || /aborted|timeout/i.test(error.message))
}

function publicUpdaterError(error: unknown): string {
  if (error instanceof UpdaterError) return error.message
  if (isAbortError(error)) return '更新请求超时。'
  return '更新操作失败，请稍后重试。'
}

function cloneState(state: UpdaterState): UpdaterState {
  return {
    ...state,
    release: state.release ? { ...state.release } : null,
    downloaded: state.downloaded ? { ...state.downloaded } : null,
    progress: state.progress ? { ...state.progress } : null,
  }
}

async function readResponseText(response: UpdaterHttpResponse, maxBytes: number, signal?: AbortSignal): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of responseChunks(response, signal)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += bytes.byteLength
    if (total > maxBytes) throw new UpdaterError('更新响应超过允许的大小上限。', 'PAYLOAD_TOO_LARGE')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function* responseChunks(response: UpdaterHttpResponse, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
  throwIfRequestAborted(signal)
  const body = response.body as {
    getReader?: () => { read(): Promise<{ done: boolean; value?: Uint8Array }>; releaseLock?: () => void }
    [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array>
  } | null | undefined
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
    yield body
    return
  }
  if (body?.getReader) {
    const reader = body.getReader()
    try {
      while (true) {
        const result = await awaitWithAbort(reader.read(), signal)
        if (result.done) break
        if (result.value) yield normalizeChunk(result.value)
      }
    }
    finally { reader.releaseLock?.() }
    return
  }
  if (body?.[Symbol.asyncIterator]) {
    const iterator = (body as AsyncIterable<unknown>)[Symbol.asyncIterator]()
    try {
      while (true) {
        const result = await awaitWithAbort(iterator.next(), signal)
        if (result.done) break
        if (result.value !== undefined) yield normalizeChunk(result.value)
      }
    }
    finally {
      // Give custom iterators a chance to release sockets/resources after an
      // abort.  Do not let a non-compliant return() prevent cleanup.
      try { await iterator.return?.() } catch { /* best effort */ }
    }
    return
  }
  if (response.arrayBuffer) {
    yield new Uint8Array(await awaitWithAbort(response.arrayBuffer(), signal))
    return
  }
  if (response.text) {
    yield Buffer.from(await awaitWithAbort(response.text(), signal), 'utf8')
    return
  }
  throw new UpdaterError('更新响应为空。', 'EMPTY_RESPONSE')
}

function throwIfRequestAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  if (signal.reason instanceof UpdaterError) throw signal.reason
  throw new UpdaterError('更新请求超时。', 'TIMEOUT')
}

/**
 * Race a potentially non-compliant fetch/body promise with the request's
 * abort signal.  Native fetch already rejects on abort; this wrapper also
 * protects injected fetchers and stream readers used by tests or embedders.
 */
function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  throwIfRequestAborted(signal)
  return new Promise<T>((resolvePromise, rejectPromise) => {
    let settled = false
    const cleanup = (): void => signal.removeEventListener('abort', onAbort)
    const onAbort = (): void => {
      if (settled) return
      settled = true
      cleanup()
      try { throwIfRequestAborted(signal) } catch (error) { rejectPromise(error); return }
      rejectPromise(new UpdaterError('更新请求超时。', 'TIMEOUT'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => {
        if (settled) return
        settled = true
        cleanup()
        resolvePromise(value)
      },
      error => {
        if (settled) return
        settled = true
        cleanup()
        rejectPromise(error)
      },
    )
  })
}

function normalizeChunk(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk
  if (typeof chunk === 'number') return Uint8Array.of(chunk & 0xff)
  if (typeof chunk === 'string') return Buffer.from(chunk, 'utf8')
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk)
  if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
  throw new UpdaterError('更新响应格式无效。', 'INVALID_RESPONSE')
}

async function defaultFetcher(url: string, init: Parameters<UpdaterFetch>[1]): Promise<UpdaterHttpResponse> {
  return fetch(url, init) as unknown as UpdaterHttpResponse
}

async function defaultInstallerLauncher(filePath: string, platform: NodeJS.Platform): Promise<{ pid?: number }> {
  if (platform !== 'win32') throw new UpdaterError('当前平台暂不支持安装更新。', 'UNSUPPORTED_PLATFORM')
  return new Promise((resolvePromise, reject) => {
    const child = spawn(filePath, [], { detached: true, shell: false, windowsHide: false, stdio: 'ignore' })
    const onError = (): void => reject(new UpdaterError('无法启动更新安装程序。', 'INSTALL_LAUNCH_FAILED'))
    child.once('error', onError)
    child.once('spawn', () => {
      child.removeListener('error', onError)
      child.unref()
      resolvePromise({ pid: child.pid })
    })
  })
}

async function verifyDownloadedFile(
  filePath: string,
  expected: UpdaterDownloadInfo,
  maxInstallerBytes: number,
  trustedDirectory?: string,
): Promise<void> {
  let pathStat: Awaited<ReturnType<typeof lstat>>
  try {
    // lstat (rather than stat) intentionally rejects symbolic links and
    // Windows reparse-point aliases before opening the installer.
    pathStat = await lstat(filePath)
  }
  catch {
    throw new UpdaterError('更新安装包不存在。', 'MISSING_PAYLOAD')
  }
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
    throw new UpdaterError('更新安装包路径无效。', 'INVALID_PATH')
  }
  if (trustedDirectory) {
    try {
      const [canonicalDirectory, canonicalFile] = await Promise.all([realpath(trustedDirectory), realpath(filePath)])
      if (!isStrictContainedPath(canonicalFile, canonicalDirectory)) throw new UpdaterError('更新安装包路径无效。', 'INVALID_PATH')
    }
    catch (error) {
      if (error instanceof UpdaterError) throw error
      throw new UpdaterError('更新安装包路径无效。', 'INVALID_PATH')
    }
  }
  let fileHandle: Awaited<ReturnType<typeof open>>
  try {
    // Keep the descriptor open while checking and hashing. This avoids a
    // path-swap between a metadata check and the bytes that are verified. On
    // platforms exposing O_NOFOLLOW, also prevent a symlink substitution in
    // the lstat/open gap. Windows falls back to the lstat + realpath checks
    // above because Node does not expose this flag consistently there.
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0
    const flags = noFollow ? fsConstants.O_RDONLY | noFollow : 'r'
    fileHandle = await open(filePath, flags)
  }
  catch {
    throw new UpdaterError('更新安装包不存在。', 'MISSING_PAYLOAD')
  }
  try {
    const fileStat = await fileHandle.stat()
    if (!fileStat.isFile() || fileStat.size !== expected.size || fileStat.size <= 0 || fileStat.size > maxInstallerBytes) {
      throw new UpdaterError('更新安装包大小校验失败。', 'SIZE_MISMATCH')
    }
    const sha256 = createHash('sha256')
    const sha512 = createHash('sha512')
    const buffer = Buffer.allocUnsafe(64 * 1024)
    let position = 0
    while (position < fileStat.size) {
      const result = await fileHandle.read(buffer, 0, Math.min(buffer.byteLength, fileStat.size - position), position)
      if (result.bytesRead <= 0) throw new UpdaterError('无法读取更新安装包。', 'PAYLOAD_READ_FAILED')
      const bytes = buffer.subarray(0, result.bytesRead)
      sha256.update(bytes)
      sha512.update(bytes)
      position += result.bytesRead
    }
    const finalStat = await fileHandle.stat()
    if (finalStat.size !== expected.size) throw new UpdaterError('更新安装包大小校验失败。', 'SIZE_MISMATCH')
    if (sha256.digest('hex') !== expected.sha256 || sha512.digest('hex') !== expected.sha512) throw new UpdaterError('更新安装包完整性校验失败。', 'DIGEST_MISMATCH')
  }
  catch (error) {
    if (error instanceof UpdaterError) throw error
    throw new UpdaterError('无法读取更新安装包。', 'PAYLOAD_READ_FAILED')
  }
  finally {
    await fileHandle.close().catch(() => undefined)
  }
}

async function writeAll(fileHandle: Awaited<ReturnType<typeof open>>, bytes: Uint8Array): Promise<void> {
  let offset = 0
  while (offset < bytes.byteLength) {
    const result = await fileHandle.write(bytes, offset, bytes.byteLength - offset)
    if (!Number.isSafeInteger(result.bytesWritten) || result.bytesWritten <= 0) throw new UpdaterError('无法写入更新安装包。', 'PAYLOAD_WRITE_FAILED')
    offset += result.bytesWritten
  }
}

async function writeAt(fileHandle: Awaited<ReturnType<typeof open>>, position: number, bytes: Uint8Array): Promise<void> {
  let offset = 0
  while (offset < bytes.byteLength) {
    const result = await fileHandle.write(bytes, offset, bytes.byteLength - offset, position + offset)
    if (!Number.isSafeInteger(result.bytesWritten) || result.bytesWritten <= 0) throw new UpdaterError('无法写入更新安装包。', 'PAYLOAD_WRITE_FAILED')
    offset += result.bytesWritten
  }
}

async function readResponseBytes(response: UpdaterHttpResponse, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of responseChunks(response, signal)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += bytes.byteLength
    if (total > maxBytes) throw new UpdaterError('更新响应超过允许的大小上限。', 'PAYLOAD_TOO_LARGE')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks)
}

async function hashFile(filePath: string | undefined): Promise<{ sha256: string; sha512: string }> {
  if (!filePath) throw new UpdaterError('更新安装包路径无效。', 'INVALID_PATH')
  const fileHandle = await open(filePath, 'r')
  try {
    const sha256 = createHash('sha256')
    const sha512 = createHash('sha512')
    const buffer = Buffer.allocUnsafe(64 * 1024)
    let position = 0
    while (true) {
      const result = await fileHandle.read(buffer, 0, buffer.byteLength, position)
      if (result.bytesRead <= 0) break
      const bytes = buffer.subarray(0, result.bytesRead)
      sha256.update(bytes)
      sha512.update(bytes)
      position += result.bytesRead
    }
    return { sha256: sha256.digest('hex'), sha512: sha512.digest('hex') }
  }
  finally { await fileHandle.close().catch(() => undefined) }
}

function assertContainedPath(filePath: string, directory: string | undefined): void {
  if (!directory) throw new UpdaterError('更新文件路径无效。', 'INVALID_PATH')
  const root = resolve(directory)
  const candidate = resolve(filePath)
  if (candidate !== root && !candidate.startsWith(root + '\\') && !candidate.startsWith(`${root}/`)) throw new UpdaterError('更新文件路径无效。', 'INVALID_PATH')
}

function assertStrictContainedPath(filePath: string | undefined, directory: string): void {
  if (!filePath || !isStrictContainedPath(filePath, directory)) throw new UpdaterError('更新文件路径无效。', 'INVALID_PATH')
}

function isStrictContainedPath(filePath: string, directory: string): boolean {
  const root = resolve(directory)
  const candidate = resolve(filePath)
  if (candidate === root) return false
  return candidate.startsWith(`${root}\\`) || candidate.startsWith(`${root}/`)
}
