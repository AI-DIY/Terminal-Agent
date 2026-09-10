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
/** Recursive local uploads and remote removals must remain predictably bounded. */
export const FILE_TRANSFER_MAX_DIRECTORY_DEPTH = 64

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

/**
 * Mutating an entry always receives a parent path and one validated component.
 * This prevents a renderer request from turning a rename/delete into a root
 * operation or a parent-directory traversal.
 */
export const fileTransferEntryNameSchema = z.string()
  .min(1, '文件名不能为空。')
  .max(255, '文件名过长。')
  .refine(isSafeFileTransferEntryName, '文件名无效。')
export type FileTransferEntryName = z.infer<typeof fileTransferEntryNameSchema>

/** Windows local filesystem names need the additional platform restrictions. */
export const fileTransferLocalEntryNameSchema = fileTransferEntryNameSchema
  .refine(value => !/[<>:"/\\|?*]/.test(value), '本地文件名包含不可用字符。')
  .refine(value => !/[. ]$/.test(value), '本地文件名不能以空格或句点结尾。')
  .refine(value => !isReservedWindowsFileName(value), '本地文件名不能使用系统保留名称。')

/**
 * Directory mutations may target the remote SFTP root, but never a path that
 * includes a parent traversal component.  The actual entry is supplied as a
 * separate fileTransferEntryNameSchema value above.
 */
export const fileTransferRemoteDirectoryPathSchema = fileTransferRemotePathSchema
  .refine(value => !value.includes('\\'), '远程目录路径不能包含反斜杠。')
  .refine(value => !value.split('/').includes('..'), '远程目录路径不能包含上级目录。')

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
  name: fileTransferEntryNameSchema,
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

/** The SFTP subsystem's own session-controlled working directory. */
export const fileTransferWorkingDirectoryRequestSchema = z.object({
  sessionId: terminalSessionIdSchema,
}).strict()
export type FileTransferWorkingDirectoryRequest = z.infer<typeof fileTransferWorkingDirectoryRequestSchema>

export const fileTransferWorkingDirectoryResultSchema = z.object({
  sessionId: terminalSessionIdSchema,
  remotePath: fileTransferRemoteDirectoryPathSchema,
}).strict()
export type FileTransferWorkingDirectoryResult = z.infer<typeof fileTransferWorkingDirectoryResultSchema>

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

export const fileTransferUploadDirectoryRequestSchema = z.object({
  sessionId: terminalSessionIdSchema,
  /** Existing remote directory into which the local root directory is copied. */
  remotePath: fileTransferRemoteDirectoryPathSchema,
  /** Must be within a main-process-picker-authorized local directory root. */
  localPath: fileTransferLocalPathSchema,
  transferId: fileTransferIdSchema.optional(),
}).strict()
export type FileTransferUploadDirectoryRequest = z.infer<typeof fileTransferUploadDirectoryRequestSchema>

export const fileTransferRemoteRenameRequestSchema = z.object({
  sessionId: terminalSessionIdSchema,
  directory: fileTransferRemoteDirectoryPathSchema,
  name: fileTransferEntryNameSchema,
  newName: fileTransferEntryNameSchema,
}).strict()
export type FileTransferRemoteRenameRequest = z.infer<typeof fileTransferRemoteRenameRequestSchema>

export const fileTransferRemoteDeleteRequestSchema = z.object({
  sessionId: terminalSessionIdSchema,
  directory: fileTransferRemoteDirectoryPathSchema,
  name: fileTransferEntryNameSchema,
  kind: z.enum(['file', 'directory', 'symlink', 'other']),
}).strict()
export type FileTransferRemoteDeleteRequest = z.infer<typeof fileTransferRemoteDeleteRequestSchema>

export const fileTransferLocalRenameRequestSchema = z.object({
  directory: fileTransferLocalPathSchema,
  name: fileTransferLocalEntryNameSchema,
  newName: fileTransferLocalEntryNameSchema,
}).strict()
export type FileTransferLocalRenameRequest = z.infer<typeof fileTransferLocalRenameRequestSchema>

export const fileTransferLocalDeleteRequestSchema = z.object({
  directory: fileTransferLocalPathSchema,
  name: fileTransferLocalEntryNameSchema,
  kind: z.enum(['file', 'directory', 'symlink', 'other']),
}).strict()
export type FileTransferLocalDeleteRequest = z.infer<typeof fileTransferLocalDeleteRequestSchema>

export const fileTransferRemoteRenameResultSchema = z.object({
  sessionId: terminalSessionIdSchema,
  directory: fileTransferRemoteDirectoryPathSchema,
  name: fileTransferEntryNameSchema,
  newName: fileTransferEntryNameSchema,
}).strict()
export type FileTransferRemoteRenameResult = z.infer<typeof fileTransferRemoteRenameResultSchema>

export const fileTransferRemoteDeleteResultSchema = z.object({
  sessionId: terminalSessionIdSchema,
  directory: fileTransferRemoteDirectoryPathSchema,
  name: fileTransferEntryNameSchema,
}).strict()
export type FileTransferRemoteDeleteResult = z.infer<typeof fileTransferRemoteDeleteResultSchema>

export const fileTransferLocalRenameResultSchema = z.object({
  directory: fileTransferLocalPathSchema,
  name: fileTransferLocalEntryNameSchema,
  newName: fileTransferLocalEntryNameSchema,
}).strict()
export type FileTransferLocalRenameResult = z.infer<typeof fileTransferLocalRenameResultSchema>

export const fileTransferLocalDeleteResultSchema = z.object({
  directory: fileTransferLocalPathSchema,
  name: fileTransferLocalEntryNameSchema,
}).strict()
export type FileTransferLocalDeleteResult = z.infer<typeof fileTransferLocalDeleteResultSchema>

/** A cancel request is intentionally scoped to one session and transfer id. */
export const fileTransferCancelRequestSchema = z.object({
  sessionId: terminalSessionIdSchema,
  transferId: fileTransferIdSchema,
}).strict()
export type FileTransferCancelRequest = z.infer<typeof fileTransferCancelRequestSchema>

export const fileTransferCancelResultSchema = z.object({
  sessionId: terminalSessionIdSchema,
  transferId: fileTransferIdSchema,
  canceled: z.boolean(),
}).strict()
export type FileTransferCancelResult = z.infer<typeof fileTransferCancelResultSchema>

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
  uploadDirectory: 'file-transfer:upload-directory',
  download: 'file-transfer:download',
  list: 'file-transfer:list',
  workingDirectory: 'file-transfer:working-directory',
  listLocal: 'file-transfer:list-local',
  selectLocalDirectory: 'file-transfer:select-local-directory',
  renameRemote: 'file-transfer:rename-remote',
  deleteRemote: 'file-transfer:delete-remote',
  renameLocal: 'file-transfer:rename-local',
  deleteLocal: 'file-transfer:delete-local',
  cancel: 'file-transfer:cancel',
  progress: 'file-transfer:progress',
} as const)

function containsControlCharacters(value: string): boolean {
  return [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
}

function isSafeFileTransferEntryName(value: string): boolean {
  return value.trim().length > 0
    && value !== '.'
    && value !== '..'
    && !/[\\/]/.test(value)
    && !containsControlCharacters(value)
}

function isReservedWindowsFileName(value: string): boolean {
  const base = value.split('.')[0]?.toUpperCase()
  return base === 'CON'
    || base === 'PRN'
    || base === 'AUX'
    || base === 'NUL'
    || /^COM[1-9]$/.test(base ?? '')
    || /^LPT[1-9]$/.test(base ?? '')
}
