import { z } from 'zod'
import { terminalSessionIdSchema } from './contracts'

/**
 * File transfers deliberately use the existing SSH session.  They never send
 * credentials or local file contents through the renderer IPC payload.
 */
export const FILE_TRANSFER_MAX_BYTES = 2 * 1024 * 1024 * 1024
export const FILE_TRANSFER_MAX_PATH_LENGTH = 4_096
/** A directory response is metadata-only and is intentionally bounded. */
export const FILE_TRANSFER_MAX_DIRECTORY_ENTRIES = 10_000

export const fileTransferIdSchema = z.string().uuid()
export const fileTransferDirectionSchema = z.enum(['upload', 'download'])
export type FileTransferDirection = z.infer<typeof fileTransferDirectionSchema>

export const fileTransferPhaseSchema = z.enum(['selecting', 'transferring', 'completed', 'canceled', 'failed'])
export type FileTransferPhase = z.infer<typeof fileTransferPhaseSchema>

/** Remote paths are passed to SFTP, never interpolated into a shell command. */
export const fileTransferRemotePathSchema = z.string()
  .trim()
  .min(1, '请输入远程路径。')
  .max(FILE_TRANSFER_MAX_PATH_LENGTH, '远程路径过长。')
  .refine(value => !containsControlCharacters(value), '远程路径包含不可用字符。')

const fileTransferRequestBase = {
  sessionId: terminalSessionIdSchema,
  remotePath: fileTransferRemotePathSchema,
  /** Optional so callers can correlate progress; the main process generates one when omitted. */
  transferId: fileTransferIdSchema.optional(),
}

export const fileTransferUploadRequestSchema = z.object(fileTransferRequestBase).strict()
export type FileTransferUploadRequest = z.infer<typeof fileTransferUploadRequestSchema>

export const fileTransferDownloadRequestSchema = z.object({
  ...fileTransferRequestBase,
  /** Used only as the suggested name in the native save dialog. */
  fileName: z.string().trim().min(1).max(255).optional(),
}).strict()
export type FileTransferDownloadRequest = z.infer<typeof fileTransferDownloadRequestSchema>

export const fileTransferEntryKindSchema = z.enum(['file', 'directory', 'symlink', 'other'])
export type FileTransferEntryKind = z.infer<typeof fileTransferEntryKindSchema>

/**
 * Metadata returned by a remote SFTP directory listing.  Names are validated
 * as single path components so a renderer cannot accidentally turn an entry
 * into a path traversal when it navigates or starts a transfer.
 */
export const fileTransferDirectoryEntrySchema = z.object({
  name: z.string().min(1).max(255)
    .refine(value => value.trim().length > 0, '远程文件名无效。')
    .refine(value => value !== '.' && value !== '..', '远程文件名无效。')
    .refine(value => !/[\\/]/.test(value), '远程文件名无效。')
    .refine(value => !containsControlCharacters(value), '远程文件名包含不可用字符。'),
  kind: fileTransferEntryKindSchema,
  // Listing is metadata-only, so a large remote file remains visible even
  // when it exceeds the per-transfer size limit.
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  modifiedAt: z.string().datetime({ offset: true }).optional(),
  mode: z.number().int().nonnegative().max(0o7777).optional(),
  uid: z.number().int().nonnegative().max(0xffffffff).optional(),
  gid: z.number().int().nonnegative().max(0xffffffff).optional(),
}).strict()
export type FileTransferDirectoryEntry = z.infer<typeof fileTransferDirectoryEntrySchema>

export const fileTransferListRequestSchema = z.object({
  sessionId: terminalSessionIdSchema,
  remotePath: fileTransferRemotePathSchema,
}).strict()
export type FileTransferListRequest = z.infer<typeof fileTransferListRequestSchema>

export const fileTransferListResultSchema = z.object({
  sessionId: terminalSessionIdSchema,
  remotePath: fileTransferRemotePathSchema,
  entries: z.array(fileTransferDirectoryEntrySchema).max(FILE_TRANSFER_MAX_DIRECTORY_ENTRIES),
}).strict()
export type FileTransferListResult = z.infer<typeof fileTransferListResultSchema>

export const fileTransferProgressSchema = z.object({
  transferId: fileTransferIdSchema,
  sessionId: terminalSessionIdSchema,
  direction: fileTransferDirectionSchema,
  phase: fileTransferPhaseSchema,
  transferredBytes: z.number().int().nonnegative().max(FILE_TRANSFER_MAX_BYTES),
  totalBytes: z.number().int().nonnegative().max(FILE_TRANSFER_MAX_BYTES).optional(),
  fileName: z.string().trim().min(1).max(255).optional(),
  message: z.string().trim().min(1).max(4_000).optional(),
}).strict()
export type FileTransferProgress = z.infer<typeof fileTransferProgressSchema>

export const fileTransferResultSchema = z.object({
  transferId: fileTransferIdSchema,
  sessionId: terminalSessionIdSchema,
  direction: fileTransferDirectionSchema,
  status: z.enum(['completed', 'canceled']),
  transferredBytes: z.number().int().nonnegative().max(FILE_TRANSFER_MAX_BYTES),
  fileName: z.string().trim().min(1).max(255).optional(),
}).strict()
export type FileTransferResult = z.infer<typeof fileTransferResultSchema>

export const fileTransferChannels = Object.freeze({
  upload: 'file-transfer:upload',
  download: 'file-transfer:download',
  list: 'file-transfer:list',
  progress: 'file-transfer:progress',
} as const)

function containsControlCharacters(value: string): boolean {
  return [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
}
