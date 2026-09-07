import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ShellHistoryRepository, type ShellHistoryRecord } from '../../../src/main/shell-history/shell-history-repository'

describe('ShellHistoryRepository', () => {
  it('stores a versioned envelope and keeps at most 50 records per host', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-shell-history-'))
    const path = join(directory, 'shell-history.json')
    try {
      const repository = new ShellHistoryRepository(path)
      await Promise.all(Array.from({ length: 51 }, (_, index) => repository.save(record({
        id: `history-${index}`,
        hostname: 'web-01',
        endedAt: `2026-08-16T08:${String(index).padStart(2, '0')}:00.000Z`,
      }))))
      await repository.save(record({ id: 'other-host', hostname: 'db-01' }))

      const records = await repository.list({})
      expect(records.filter(item => item.hostname === 'web-01')).toHaveLength(50)
      expect(records.some(item => item.id === 'history-0')).toBe(false)
      expect(records.some(item => item.id === 'history-50')).toBe(true)
      expect(records.some(item => item.id === 'other-host')).toBe(true)
      expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ version: 1 })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('serializes concurrent writes without losing records and supports safe lookup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-shell-history-concurrent-'))
    const path = join(directory, 'shell-history.json')
    try {
      const repository = new ShellHistoryRepository(path)
      await Promise.all([
        repository.save(record({ id: 'history-a', hostname: 'web-01' })),
        repository.save(record({ id: 'history-b', hostname: 'db-01' })),
      ])

      await expect(repository.get('history-a')).resolves.toMatchObject({ id: 'history-a', hostname: 'web-01' })
      await expect(repository.get('missing')).resolves.toBeUndefined()
      expect((await repository.list({ chatId: 'chat-a' })).every(item => item.chatId === 'chat-a')).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('atomically appends a late transfer audit without a stale history save erasing it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-shell-history-transfer-race-'))
    const path = join(directory, 'shell-history.json')
    try {
      const repository = new ShellHistoryRepository(path)
      const initial = record({ id: 'history-transfer-race', fileTransferLogs: [] })
      await repository.save(initial)

      // Reconnect/other history operations can retain a snapshot while an
      // SFTP promise settles after its SSH session has closed.
      const stale = await repository.get(initial.id)
      await repository.appendFileTransferLog(initial.id, {
        id: 'transfer-late', direction: 'download', fileName: 'audit.log', remotePath: '/srv/audit.log',
        status: 'failed', transferredBytes: 0, message: '连接已关闭。',
        startedAt: '2026-09-07T10:00:00.000Z', endedAt: '2026-09-07T10:00:01.000Z',
      })
      await repository.save({ ...stale!, reconnectAudit: { count: 1, lastReconnectedAt: '2026-09-07T10:00:02.000Z' } })

      await expect(repository.get(initial.id)).resolves.toMatchObject({
        reconnectAudit: { count: 1 },
        fileTransferLogs: [expect.objectContaining({ id: 'transfer-late', status: 'failed' })],
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('redacts standard AccessClient temporary paths before they reach shell-history.json', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-shell-history-temp-path-'))
    const path = join(directory, 'shell-history.json')
    const temporaryPath = ['C:', 'Temp', 'access-client', 'session.conf'].join('\\')
    try {
      const repository = new ShellHistoryRepository(path)
      await repository.save(record({ title: temporaryPath, output: `loaded ${temporaryPath}\r\n` }))

      const persisted = await readFile(path, 'utf8')
      const [summary] = await repository.list({})
      const detail = await repository.get('history-default')
      for (const value of [persisted, summary, detail]) {
        expect(JSON.stringify(value)).not.toContain(temporaryPath)
        expect(JSON.stringify(value)).toContain('[REDACTED SENSITIVE CONTENT]')
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('defensively redacts inline credentials from repository saves', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-shell-history-inline-credential-save-'))
    const path = join(directory, 'shell-history.json')
    const inlineCredentialCommands = [
      'curl --user operator:INLINE_CREDENTIAL_PLACEHOLDER https://host.example',
      'sshpass -p INLINE_CREDENTIAL_PLACEHOLDER ssh host.example',
      'redis-cli -a INLINE_CREDENTIAL_PLACEHOLDER',
    ]
    try {
      const repository = new ShellHistoryRepository(path)
      await repository.save(record({
        output: `${inlineCredentialCommands.join('\r\n')}\r\n`,
        commandAudit: { input: `${inlineCredentialCommands.join('\r')}\r` },
      }))

      const persisted = await readFile(path, 'utf8')
      const [summary] = await repository.list({})
      const detail = await repository.get('history-default')
      for (const value of [persisted, summary, detail]) {
        expect(JSON.stringify(value)).not.toContain('INLINE_CREDENTIAL_PLACEHOLDER')
        expect(JSON.stringify(value)).toContain('[REDACTED SENSITIVE CONTENT]')
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rewrites pre-remediation records that contain orphaned private-key tails and unsafe paths', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-shell-history-migration-'))
    const path = join(directory, 'shell-history.json')
    const orphanedKeyMaterial = 'PLACEHOLDER-ORPHANED-KEY-BODY'
    const legacyTemporaryPath = 'tmp:relative folder\\session.conf'
    const legacyPrivateKeyPath = '.ssh/id_ed25519'
    try {
      await writeFile(path, JSON.stringify({
        version: 1,
        records: [{
          id: 'history-legacy', chatId: 'chat-a', sessionId: 'session-a', hostname: 'web-01',
          title: legacyTemporaryPath, startedAt: '2026-08-16T08:00:00.000Z', endedAt: '2026-08-16T08:01:00.000Z',
          status: 'closed',
          output: `[REDACTED SENSITIVE CONTENT]\r\n${orphanedKeyMaterial}\r\n-----END TEST PRIVATE KEY-----\r\nloaded ${legacyPrivateKeyPath}`,
          reconnectable: false, connectionType: 'direct-ssh',
        }],
      }), 'utf8')
      const repository = new ShellHistoryRepository(path)

      const records = await repository.list({})
      const detail = await repository.get('history-legacy')
      const rewritten = await readFile(path, 'utf8')

      for (const unsafeValue of [orphanedKeyMaterial, '-----END TEST PRIVATE KEY-----', legacyTemporaryPath, legacyPrivateKeyPath]) {
        for (const value of [records, detail, rewritten]) expect(JSON.stringify(value)).not.toContain(unsafeValue)
      }
      expect(JSON.parse(rewritten)).toMatchObject({
        version: 1,
        records: [{ id: 'history-legacy', commandAudit: { input: '' } }],
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rewrites legacy inline credentials before records are returned', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-shell-history-inline-credential-migration-'))
    const path = join(directory, 'shell-history.json')
    const inlineCredentialCommands = [
      'curl --user operator:INLINE_CREDENTIAL_PLACEHOLDER https://host.example',
      'sshpass -p INLINE_CREDENTIAL_PLACEHOLDER ssh host.example',
      'redis-cli -a INLINE_CREDENTIAL_PLACEHOLDER',
    ]
    try {
      await writeFile(path, JSON.stringify({
        version: 1,
        records: [record({
          id: 'history-inline-credential-legacy',
          output: `${inlineCredentialCommands.join('\r\n')}\r\n`,
          commandAudit: { input: `${inlineCredentialCommands.join('\r')}\r` },
        })],
      }), 'utf8')
      const repository = new ShellHistoryRepository(path)

      const records = await repository.list({})
      const detail = await repository.get('history-inline-credential-legacy')
      const rewritten = await readFile(path, 'utf8')
      for (const value of [records, detail, rewritten]) {
        expect(JSON.stringify(value)).not.toContain('INLINE_CREDENTIAL_PLACEHOLDER')
        expect(JSON.stringify(value)).toContain('[REDACTED SENSITIVE CONTENT]')
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('sanitizes transfer metadata from an existing history file during migration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-shell-history-transfer-migration-'))
    const path = join(directory, 'shell-history.json')
    const secret = 'TRANSFER_METADATA_SECRET_PLACEHOLDER'
    try {
      await writeFile(path, JSON.stringify({
        version: 1,
        records: [record({
          fileTransferLogs: [{
            id: 'legacy-transfer', direction: 'download', fileName: 'report.txt',
            remotePath: `tmp:C:\\Temp\\access-client\\${secret}.txt`,
            status: 'failed', transferredBytes: 0, message: `password=${secret}`,
            startedAt: '2026-08-16T08:00:00.000Z', endedAt: '2026-08-16T08:01:00.000Z',
          }],
        })],
      }), 'utf8')

      const repository = new ShellHistoryRepository(path)
      const detail = await repository.get('history-default')
      const rewritten = await readFile(path, 'utf8')

      expect(JSON.stringify(detail)).not.toContain(secret)
      expect(JSON.stringify(rewritten)).not.toContain(secret)
      expect(detail?.fileTransferLogs).toEqual([
        expect.objectContaining({
          id: 'legacy-transfer',
          remotePath: '[REDACTED SENSITIVE CONTENT]',
          message: '[REDACTED SENSITIVE CONTENT]',
        }),
      ])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('safely migrates oversized secret-bearing records and deterministically evicts legacy host overflow without corrupt backups', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-shell-history-legacy-bounds-'))
    const path = join(directory, 'shell-history.json')
    const unsafeValue = 'INLINE_CREDENTIAL_PLACEHOLDER'
    try {
      await writeFile(path, JSON.stringify({
        version: 1,
        records: Array.from({ length: 51 }, (_, index) => record({
          id: `existing-${index}`,
          endedAt: `2026-08-16T08:00:${String(index).padStart(2, '0')}.000Z`,
          output: index === 50
            ? `curl -uoperator:${unsafeValue} https://host.example ${'safe output '.repeat(22_000)}`
            : `safe output ${index}`,
          commandAudit: {
            input: index === 50
              ? `redis-cli -a${unsafeValue} ping ${'safe audit '.repeat(24_000)}`
              : `safe audit ${index}`,
          },
        })),
      }), 'utf8')
      const repository = new ShellHistoryRepository(path)

      const records = await repository.list({ hostname: 'web-01' })
      const rewritten = await readFile(path, 'utf8')
      const directoryEntries = await readdir(directory)

      expect(records).toHaveLength(50)
      expect(records.some(item => item.id === 'existing-0')).toBe(false)
      expect(records.some(item => item.id === 'existing-50')).toBe(true)
      expect(records.find(item => item.id === 'existing-1')?.output).toBe('safe output 1')
      for (const value of [records, rewritten, directoryEntries]) {
        expect(JSON.stringify(value)).not.toContain(unsafeValue)
      }
      expect(rewritten).toContain('[REDACTED SENSITIVE CONTENT]')
      expect(directoryEntries.some(entry => entry.endsWith('.corrupt'))).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('never duplicates malformed or schema-invalid shell history source bytes into corrupt backups', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-shell-history-corrupt-source-'))
    const path = join(directory, 'shell-history.json')
    const unsafeValue = 'INLINE_CREDENTIAL_PLACEHOLDER'
    const malformed = `{"version":1,"records":["${unsafeValue}"`
    const schemaInvalid = JSON.stringify({
      version: 1,
      records: [{ ...record(), unexpected: unsafeValue }],
    })
    try {
      for (const source of [malformed, schemaInvalid]) {
        await writeFile(path, source, 'utf8')
        const repository = new ShellHistoryRepository(path)

        await expect(repository.list({})).rejects.toThrow('AtomicJsonStore could not read valid JSON data')

        const additionalFiles = (await readdir(directory)).filter(entry => entry !== 'shell-history.json')
        const copiedContents = await Promise.all(additionalFiles.map(entry => readFile(join(directory, entry), 'utf8')))
        expect(JSON.stringify(copiedContents)).not.toContain(unsafeValue)
        expect(additionalFiles.some(entry => entry.endsWith('.corrupt'))).toBe(false)
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

function record(overrides: Partial<ShellHistoryRecord> = {}): ShellHistoryRecord {
  return {
    id: 'history-default',
    chatId: 'chat-a',
    sessionId: 'session-a',
    hostname: 'web-01',
    title: 'web-01',
    startedAt: '2026-08-16T08:00:00.000Z',
    endedAt: '2026-08-16T08:01:00.000Z',
    status: 'closed',
    output: 'ready\r\n',
    reconnectable: false,
    reconnectAudit: { count: 0 },
    connectionType: 'direct-ssh',
    ...overrides,
    commandAudit: overrides.commandAudit ?? { input: '' },
    fileTransferLogs: overrides.fileTransferLogs ?? [],
  }
}
