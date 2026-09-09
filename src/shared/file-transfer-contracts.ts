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

/**
 * Local paths are intentionally represented separately from remote paths.
 * The main process additionally requires them to sit beneath a directory the
 * user selected through the native directory picker before it reads or writes
 * through one of these paths.
 */
export const fileTransferLocalPathSchema = z.string()
  .trim()
  .min(1, '请输入本地路径。')
  .max(FILE_TRANSFER_MAX_PATH_LENGTH, '本地路径过长。')
  .refine(value => !containsControlCharacters(value), '本地路径包含不可用字符。')
export type FileTransferLocalPath = z.infer<typeof fileTransferLocalPathSchema>

const fileTransferRequestBase = {
  sessionId: terminalSessionIdSchema,
  remotePath: fileTransferRemotePathSchema,
  /** Optional so callers can correlate progress; the main process generates one when omitted. */
  transferId: fileTransferIdSchema.optional(),
  /**
   * For uploads this is a selected local file. For downloads it is a selected
   * local directory, into which the main process writes the remote basename.
   * Omitting it retains the existing native file/save dialog behavior.
   */
  localPath: fileTransferLocalPathSchema.optional(),
}

export const fileTransferUploadRequestSchema = z.object(fileTransferRequestBase).strict()
export type FileTransferUploadRequest = z.infer<typeof fileTransferUploadRequestSchema>

/**
 * Upload one native-picker-selected file to several already-connected SSH
 * sessions.  The picker remains in the main process and the renderer only
 * supplies opaque session ids; this keeps the local-file authorization
 * boundary identical to a normal upload.
 */
export const fileTransferUploadAllRequestSchema = z.object({
  sessionIds: z.array(terminalSessionIdSchema)
    .min(1, '至少选择一个 SSH 会话。')
    .max(64, '一次最多上传到 64 个 SSH 会话。')
    .superRefine((sessionIds, context) => {
      if (new Set(sessionIds).size !== sessionIds.length) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'SSH 会话不能重复。' })
      }
    }),
  /** `./` targets the connected user's SFTP home directory by default. */
  remotePath: fileTransferRemotePathSchema.default('./'),
  localPath: fileTransferLocalPathSchema.optional(),
  /** Optional renderer-generated ids let each mounted panel correlate rows. */
  transferIds: z.array(z.object({
    sessionId: terminalSessionIdSchema,
    transferId: fileTransferIdSchema,
  }).strict()).max(64).optional(),
}).strict().superRefine((value, context) => {
  if (value.transferIds === undefined) return
  const ids = value.transferIds.map(item => item.sessionId)
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['transferIds'], message: '批量传输会话不能重复。' })
  }
  const requested = new Set(value.sessionIds)
  if (value.transferIds.some(item => !requested.has(item.sessionId))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['transferIds'], message: '批量传输会话必须来自请求会话列表。' })
  }
  if (value.transferIds.length !== value.sessionIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['transferIds'], message: '批量传输 ID 数量必须与会话数量一致。' })
  }
  const transferValues = value.transferIds.map(item => item.transferId)
  if (new Set(transferValues).size !== transferValues.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['transferIds'], message: '批量传输 ID 不能重复。' })
  }
})
export type FileTransferUploadAllRequest = z.infer<typeof fileTransferUploadAllRequestSchema>

export const fileTransferUploadAllItemSchema = z.object({
  sessionId: terminalSessionIdSchema,
  transferId: fileTransferIdSchema,
  status: z.enum(['completed', 'canceled', 'failed']),
  transferredBytes: z.number().int().nonnegative().max(FILE_TRANSFER_MAX_BYTES),
  fileName: z.string().trim().min(1).max(255).optional(),
  message: z.string().trim().min(1).max(4_000).optional(),
}).strict()
export type FileTransferUploadAllItem = z.infer<typeof fileTransferUploadAllItemSchema>

export const fileTransferUploadAllResultSchema = z.object({
  status: z.enum(['completed', 'canceled', 'partial']),
  fileName: z.string().trim().min(1).max(255).optional(),
  results: z.array(fileTransferUploadAllItemSchema).max(64),
}).strict()
export type FileTransferUploadAllResult = z.infer<typeof fileTransferUploadAllResultSchema>

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

/** A native directory-picker result used to authorize local browsing. */
export const fileTransferLocalDirectorySelectionSchema = z.discriminatedUnion('canceled', [
  z.object({ canceled: z.literal(true) }).strict(),
  z.object({ canceled: z.literal(false), localPath: fileTransferLocalPathSchema }).strict(),
])
export type FileTransferLocalDirectorySelection = z.infer<typeof fileTransferLocalDirectorySelectionSchema>

/**
 * Omit localPath to begin at the stable user-home directory.  A chosen folder
 * can then be supplied on later calls to browse that folder or its children.
 */
export const fileTransferLocalListRequestSchema = z.object({
  localPath: fileTransferLocalPathSchema.optional(),
}).strict()
export type FileTransferLocalListRequest = z.infer<typeof fileTransferLocalListRequestSchema>

/** Local entries deliberately share the metadata-only remote entry shape. */
export const fileTransferLocalListResultSchema = z.object({
  localPath: fileTransferLocalPathSchema,
  entries: z.array(fileTransferDirectoryEntrySchema).max(FILE_TRANSFER_MAX_DIRECTORY_ENTRIES),
}).strict()
export type FileTransferLocalListResult = z.infer<typeof fileTransferLocalListResultSchema>

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
  uploadAll: 'file-transfer:upload-all',
  download: 'file-transfer:download',
  list: 'file-transfer:list',
  listLocal: 'file-transfer:list-local',
  selectLocalDirectory: 'file-transfer:select-local-directory',
  progress: 'file-transfer:progress',
} as const)

function containsControlCharacters(value: string): boolean {
  return [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
}
