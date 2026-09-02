import { z } from 'zod'
import { terminalSessionIdSchema } from './contracts'

/**
 * File transfers deliberately use the existing SSH session.  They never send
 * credentials or local file contents through the renderer IPC payload.
 */
export const FILE_TRANSFER_MAX_BYTES = 2 * 1024 * 1024 * 1024
export const FILE_TRANSFER_MAX_PATH_LENGTH = 4_096

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
  progress: 'file-transfer:progress',
} as const)

function containsControlCharacters(value: string): boolean {
  return [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
}
