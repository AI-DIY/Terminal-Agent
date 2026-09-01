import { z } from 'zod'

/**
 * Public limits used by the updater.  Keeping these values in one place makes
 * it harder for a caller (or a future release asset) to accidentally turn the
 * updater into an unbounded network/file sink.
 */
export const updaterLimits = Object.freeze({
  maxMetadataBytes: 1 * 1024 * 1024,
  maxInstallerBytes: 512 * 1024 * 1024,
  maxReleaseNotesBytes: 20 * 1024,
  maxRedirects: 3,
  requestTimeoutMs: 20_000,
  downloadTimeoutMs: 15 * 60_000,
})

export const updaterPhaseSchema = z.enum([
  'idle',
  'checking',
  'available',
  'up-to-date',
  'downloading',
  'downloaded',
  'installing',
  'installed',
  'error',
])
export type UpdaterPhase = z.infer<typeof updaterPhaseSchema>

export const updaterProgressPhaseSchema = z.enum(['check', 'download', 'install'])
export type UpdaterProgressPhase = z.infer<typeof updaterProgressPhaseSchema>

const semverSchema = z.string()
  .trim()
  .regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/, 'Invalid semantic version')
  .max(128)

const sha256Schema = z.string().regex(/^[a-f\d]{64}$/i, 'Invalid SHA-256 digest')
const sha512Schema = z.string().regex(/^[a-f\d]{128}$/i, 'Invalid SHA-512 digest')

/** A release selected from the fixed Terminal-Agent GitHub repository. */
export const updateReleaseSchema = z.object({
  version: semverSchema,
  tagName: z.string().trim().min(1).max(128),
  name: z.string().trim().max(256),
  releaseDate: z.string().datetime({ offset: true }).nullable(),
  htmlUrl: z.string().url().max(2_048),
  installerName: z.string().regex(/^Terminal-Agent-Setup-[0-9A-Za-z][0-9A-Za-z._-]*\.exe$/i, 'Invalid installer name').max(256),
  installerUrl: z.string().url().max(4_096),
  size: z.number().int().positive().max(updaterLimits.maxInstallerBytes),
  sha256: sha256Schema.nullable(),
  sha512: sha512Schema.nullable(),
  notes: z.string().max(updaterLimits.maxReleaseNotesBytes),
}).strict()
export type UpdateRelease = z.infer<typeof updateReleaseSchema>
export const updaterReleaseSchema = updateReleaseSchema
export type UpdaterRelease = UpdateRelease

export const updaterCheckResultSchema = z.object({
  currentVersion: semverSchema,
  updateAvailable: z.boolean(),
  release: updateReleaseSchema.nullable(),
}).strict()
export type UpdaterCheckResult = z.infer<typeof updaterCheckResultSchema>

export const updaterDownloadInfoSchema = z.object({
  version: semverSchema,
  fileName: z.string().regex(/^Terminal-Agent-Setup-[0-9A-Za-z][0-9A-Za-z._-]*\.exe$/i).max(256),
  size: z.number().int().positive().max(updaterLimits.maxInstallerBytes),
  sha256: sha256Schema,
  sha512: sha512Schema,
  integrityVerified: z.boolean(),
}).strict()
export type UpdaterDownloadInfo = z.infer<typeof updaterDownloadInfoSchema>

export const updaterInstallResultSchema = z.object({
  launched: z.boolean(),
  version: semverSchema,
  fileName: z.string().regex(/^Terminal-Agent-Setup-[0-9A-Za-z][0-9A-Za-z._-]*\.exe$/i).max(256),
}).strict()
export type UpdaterInstallResult = z.infer<typeof updaterInstallResultSchema>

export const updaterProgressSchema = z.object({
  phase: updaterProgressPhaseSchema,
  percent: z.number().finite().min(0).max(100),
  transferredBytes: z.number().int().nonnegative().max(updaterLimits.maxInstallerBytes).optional(),
  totalBytes: z.number().int().positive().max(updaterLimits.maxInstallerBytes).optional(),
  version: semverSchema.optional(),
}).strict()
export type UpdaterProgress = z.infer<typeof updaterProgressSchema>

export const updaterStateSchema = z.object({
  phase: updaterPhaseSchema,
  currentVersion: semverSchema,
  release: updateReleaseSchema.nullable(),
  downloaded: updaterDownloadInfoSchema.nullable(),
  progress: updaterProgressSchema.nullable(),
  error: z.string().trim().max(2_000).nullable(),
}).strict()
export type UpdaterState = z.infer<typeof updaterStateSchema>

export const updaterErrorSchema = z.string().trim().min(1).max(2_000)

/** Structural seam used by IPC registration and unit tests. */
export type UpdaterServiceLike = {
  check(): Promise<UpdaterCheckResult>
  download(): Promise<UpdaterDownloadInfo>
  install(): Promise<UpdaterInstallResult>
  restart(): void
  getState(): UpdaterState
  onProgress(listener: (event: UpdaterProgress) => void): () => void
  onStatus(listener: (state: UpdaterState) => void): () => void
  onError(listener: (message: string) => void): () => void
}

export const updaterChannels = Object.freeze({
  check: 'updater:check',
  download: 'updater:download',
  install: 'updater:install',
  restart: 'updater:restart',
  state: 'updater:state',
  progress: 'updater:progress',
  status: 'updater:status',
  error: 'updater:error',
} as const)
