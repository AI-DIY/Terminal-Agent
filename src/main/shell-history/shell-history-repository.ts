import {
  shellHistoryDocumentSchema,
  shellHistoryRecordSchema,
  SHELL_HISTORY_MAX_AUDIT_BYTES,
  SHELL_HISTORY_MAX_OUTPUT_BYTES,
  SHELL_HISTORY_MAX_RECORDS_PER_HOST,
  sanitizeShellHistoryDisplay,
  sanitizeShellHistoryText,
  type ShellHistoryDocument,
} from './shell-history-contracts'
import {
  shellHistoryIdSchema,
  shellHistoryListRequestSchema,
  type ShellHistoryListRequest,
} from '../../shared/contracts'
import { AtomicJsonStore, type AtomicJsonStoreOptions } from '../persistence/atomic-json-store'

export type ShellHistoryRecord = ShellHistoryDocument['records'][number]

export type ShellHistoryRepositoryPort = {
  save(record: ShellHistoryRecord): Promise<void>
  list(filter: ShellHistoryListRequest): Promise<ShellHistoryRecord[]>
  get(historyId: string): Promise<ShellHistoryRecord | undefined>
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
      const withoutExisting = document.records.filter(item => item.id !== parsed.id)
      const hostRecords = [...withoutExisting.filter(item => item.hostname === parsed.hostname), parsed]
        .sort(compareOldestFirst)
      const discard = new Set(hostRecords
        .slice(0, Math.max(0, hostRecords.length - SHELL_HISTORY_MAX_RECORDS_PER_HOST))
        .map(item => item.id))
      return {
        version: 1,
        records: [...withoutExisting.filter(item => !discard.has(item.id)), ...(discard.has(parsed.id) ? [] : [parsed])],
      }
    })
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
  }
}

function compareNewestFirst(left: ShellHistoryRecord, right: ShellHistoryRecord): number {
  return right.endedAt.localeCompare(left.endedAt) || right.id.localeCompare(left.id)
}

function compareOldestFirst(left: ShellHistoryRecord, right: ShellHistoryRecord): number {
  return left.endedAt.localeCompare(right.endedAt) || left.id.localeCompare(right.id)
}
