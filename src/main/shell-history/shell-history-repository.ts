import {
  shellHistoryDocumentSchema,
  shellHistoryRecordSchema,
  SHELL_HISTORY_MAX_AUDIT_BYTES,
  SHELL_HISTORY_MAX_FILE_TRANSFER_LOGS,
  SHELL_HISTORY_MAX_OUTPUT_BYTES,
  SHELL_HISTORY_MAX_RECORDS_PER_HOST,
  sanitizeShellHistoryDisplay,
  sanitizeShellHistoryFileTransferLog,
  sanitizeShellHistoryText,
  type ShellHistoryDocument,
} from './shell-history-contracts'
import {
  shellHistoryIdSchema,
  shellHistoryFileTransferLogSchema,
  shellHistoryListRequestSchema,
  type ShellHistoryFileTransferLog,
  type ShellHistoryListRequest,
} from '../../shared/contracts'
import { AtomicJsonStore, type AtomicJsonStoreOptions } from '../persistence/atomic-json-store'

export type ShellHistoryRecord = ShellHistoryDocument['records'][number]

export type ShellHistoryRepositoryPort = {
  save(record: ShellHistoryRecord): Promise<void>
  list(filter: ShellHistoryListRequest): Promise<ShellHistoryRecord[]>
  get(historyId: string): Promise<ShellHistoryRecord | undefined>
  /** Atomically append or replace a final SFTP audit row for one closed Shell. */
  appendFileTransferLog?(historyId: string, log: ShellHistoryFileTransferLog): Promise<ShellHistoryRecord | undefined>
}

export type ShellHistoryRepositoryOptions = Pick<AtomicJsonStoreOptions, 'fileSystem'>

export class ShellHistoryRepository implements ShellHistoryRepositoryPort {
  private readonly store: AtomicJsonStore<ShellHistoryDocument>

  constructor(path: string, options: ShellHistoryRepositoryOptions = {}) {
    this.store = new AtomicJsonStore(path, shellHistoryDocumentSchema, () => ({ version: 1, records: [] }), {
      ...options,
      backupCorrupt: false,
      migrate: migrateShellHistoryDocument,
    })
  }

  async save(record: ShellHistoryRecord): Promise<void> {
    const parsed = shellHistoryRecordSchema.parse(sanitizeRecord(record))
    await this.store.update(document => {
      const existing = document.records.find(item => item.id === parsed.id)
      // A disconnect can race with the final SFTP result.  Retain any audit
      // rows that landed through appendFileTransferLog while another history
      // operation (for example, a reconnect audit) saves a stale snapshot.
      const persisted = existing
        ? { ...parsed, fileTransferLogs: mergeFileTransferLogs(existing.fileTransferLogs, parsed.fileTransferLogs) }
        : parsed
      const withoutExisting = document.records.filter(item => item.id !== parsed.id)
      const hostRecords = [...withoutExisting.filter(item => item.hostname === persisted.hostname), persisted]
        .sort(compareOldestFirst)
      const discard = new Set(hostRecords
        .slice(0, Math.max(0, hostRecords.length - SHELL_HISTORY_MAX_RECORDS_PER_HOST))
        .map(item => item.id))
      return {
        version: 1,
        records: [...withoutExisting.filter(item => !discard.has(item.id)), ...(discard.has(persisted.id) ? [] : [persisted])],
      }
    })
  }

  async appendFileTransferLog(historyId: string, log: ShellHistoryFileTransferLog): Promise<ShellHistoryRecord | undefined> {
    const id = shellHistoryIdSchema.parse(historyId)
    const parsedLog = shellHistoryFileTransferLogSchema.parse(sanitizeShellHistoryFileTransferLog(log))
    const document = await this.store.update(current => {
      const index = current.records.findIndex(record => record.id === id)
      if (index < 0) return current
      const previous = current.records[index]!
      const updated: ShellHistoryRecord = {
        ...previous,
        fileTransferLogs: mergeFileTransferLogs(previous.fileTransferLogs, [parsedLog]),
      }
      return {
        ...current,
        records: current.records.map((record, recordIndex) => recordIndex === index ? updated : record),
      }
    })
    const record = document.records.find(candidate => candidate.id === id)
    return record ? { ...record } : undefined
  }

  async list(filter: ShellHistoryListRequest): Promise<ShellHistoryRecord[]> {
    const parsed = shellHistoryListRequestSchema.parse(filter)
    const document = await this.store.load()
    return document.records
      .filter(record => (!parsed.chatId || record.chatId === parsed.chatId) && (!parsed.hostname || record.hostname === parsed.hostname))
      .sort(compareNewestFirst)
      .map(record => ({ ...record }))
  }

  async get(historyId: string): Promise<ShellHistoryRecord | undefined> {
    const id = shellHistoryIdSchema.parse(historyId)
    const record = (await this.store.load()).records.find(item => item.id === id)
    return record ? { ...record } : undefined
  }
}

function migrateShellHistoryDocument(persisted: unknown): { value: unknown; changed: boolean } {
  if (!isObject(persisted) || persisted.version !== 1 || !Array.isArray(persisted.records)) {
    return { value: persisted, changed: false }
  }
  let changed = false
  const records = persisted.records.map(record => {
    if (!isObject(record)) return record
    const migrated = { ...record }
    for (const field of ['hostname', 'title'] as const) {
      if (typeof record[field] !== 'string') continue
      const safeValue = sanitizeShellHistoryDisplay(record[field])
      if (safeValue !== record[field]) changed = true
      migrated[field] = safeValue
    }
    if (typeof record.output === 'string') {
      const safeOutput = sanitizeShellHistoryText(record.output, SHELL_HISTORY_MAX_OUTPUT_BYTES)
      if (safeOutput !== record.output) changed = true
      migrated.output = safeOutput
    }
    if (record.commandAudit === undefined) {
      migrated.commandAudit = { input: '' }
      changed = true
    } else if (isObject(record.commandAudit) && typeof record.commandAudit.input === 'string') {
      const safeInput = sanitizeShellHistoryText(record.commandAudit.input, SHELL_HISTORY_MAX_AUDIT_BYTES)
      if (safeInput !== record.commandAudit.input) changed = true
      migrated.commandAudit = { ...record.commandAudit, input: safeInput }
    }
    if (record.fileTransferLogs === undefined) {
      migrated.fileTransferLogs = []
      changed = true
    } else if (Array.isArray(record.fileTransferLogs)) {
      // Transfer metadata was added after the original Shell-history format.
      // Treat an existing file as untrusted too: a previous build or a
      // manually edited history file may contain a temporary/local path or a
      // credential in the remote path/message.  Sanitize and bound valid
      // entries before the strict document schema is applied, then let the
      // schema continue to reject malformed entries rather than silently
      // inventing audit data.
      const boundedLogs = record.fileTransferLogs.slice(-SHELL_HISTORY_MAX_FILE_TRANSFER_LOGS)
      const safeLogs = boundedLogs.map(migrateFileTransferLog)
      if (boundedLogs.length !== record.fileTransferLogs.length || safeLogs.some((log, index) => log !== boundedLogs[index])) changed = true
      migrated.fileTransferLogs = safeLogs
    }
    return migrated
  })
  const boundedRecords = evictExcessHostRecords(records)
  if (boundedRecords !== records) changed = true
  return { value: changed ? { ...persisted, records: boundedRecords } : persisted, changed }
}

function evictExcessHostRecords(records: unknown[]): unknown[] {
  const recordsByHost = new Map<string, Array<{ index: number; id: string; endedAt: string }>>()
  for (const [index, record] of records.entries()) {
    if (!isObject(record) || typeof record.hostname !== 'string' || typeof record.id !== 'string' || typeof record.endedAt !== 'string') continue
    const hostRecords = recordsByHost.get(record.hostname) ?? []
    hostRecords.push({ index, id: record.id, endedAt: record.endedAt })
    recordsByHost.set(record.hostname, hostRecords)
  }
  const discarded = new Set<number>()
  for (const hostRecords of recordsByHost.values()) {
    hostRecords.sort((left, right) => left.endedAt.localeCompare(right.endedAt) || left.id.localeCompare(right.id))
    for (const record of hostRecords.slice(0, Math.max(0, hostRecords.length - SHELL_HISTORY_MAX_RECORDS_PER_HOST))) {
      discarded.add(record.index)
    }
  }
  return discarded.size === 0 ? records : records.filter((_, index) => !discarded.has(index))
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sanitizeRecord(record: ShellHistoryRecord): ShellHistoryRecord {
  return {
    ...record,
    hostname: sanitizeShellHistoryDisplay(record.hostname),
    title: sanitizeShellHistoryDisplay(record.title),
    output: sanitizeShellHistoryText(record.output),
    commandAudit: { input: sanitizeShellHistoryText(record.commandAudit?.input ?? '') },
    fileTransferLogs: (record.fileTransferLogs ?? [])
      .slice(-SHELL_HISTORY_MAX_FILE_TRANSFER_LOGS)
      .map(sanitizeShellHistoryFileTransferLog),
  }
}

function migrateFileTransferLog(value: unknown): unknown {
  if (!isObject(value)) return value
  const migrated = { ...value }
  if (typeof value.fileName === 'string') migrated.fileName = sanitizeShellHistoryDisplay(value.fileName)
  if (typeof value.remotePath === 'string') migrated.remotePath = sanitizeShellHistoryDisplay(value.remotePath)
  if (typeof value.message === 'string') migrated.message = sanitizeShellHistoryText(value.message, 4_000)
  return migrated
}

function mergeFileTransferLogs(
  current: readonly ShellHistoryFileTransferLog[],
  incoming: readonly ShellHistoryFileTransferLog[],
): ShellHistoryFileTransferLog[] {
  const merged = [...current]
  for (const log of incoming) {
    const index = merged.findIndex(candidate => candidate.id === log.id)
    if (index >= 0) merged[index] = log
    else merged.push(log)
  }
  return merged.slice(-SHELL_HISTORY_MAX_FILE_TRANSFER_LOGS)
}

function compareNewestFirst(left: ShellHistoryRecord, right: ShellHistoryRecord): number {
  return right.endedAt.localeCompare(left.endedAt) || right.id.localeCompare(left.id)
}

function compareOldestFirst(left: ShellHistoryRecord, right: ShellHistoryRecord): number {
  return left.endedAt.localeCompare(right.endedAt) || left.id.localeCompare(right.id)
}
