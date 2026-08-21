import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { hostMemoryDisclosureSchema, hostMemoryRecordSchema, hostMemorySettingsSchema } from '../../../src/shared/contracts'
import { SETTINGS_TABS } from '../../../src/renderer/src/views/settings-tabs'
import { summarizeHostMemoryRecord } from '../../../src/renderer/src/components/settings/host-memory-summary'

describe('host memory renderer contracts', () => {
  it('rejects synthetic bare credential formats recursively from renderer DTOs', () => {
    for (const value of syntheticBareCredentials) {
      expect(() => hostMemoryRecordSchema.parse({
        hostname: 'api-prod',
        observedAt: '2026-08-18T00:00:00.000Z',
        operatingSystem: { name: 'Linux', version: value },
      })).toThrow()
    }
  })

  it('models the four authoritative V18 categories and a separate safe legacy snapshot', () => {
    const record = hostMemoryRecordSchema.parse({
      hostname: 'api-prod',
      observedAt: '2026-08-18T00:00:00.000Z',
      connectionIp: '192.0.2.10',
      operatingSystem: { name: 'Linux', version: '6.1.0' },
      cpu: { model: 'Example CPU', architecture: 'x86_64', logicalCores: 8 },
      memory: { totalBytes: 8_589_934_592 },
      disks: [{ name: 'sda', totalBytes: 128_000_000_000 }],
      networkInterfaces: [{ name: 'eth0', addresses: ['192.0.2.10', '2001:db8::10'] }],
      processes: [{ name: 'api-server', pid: 1842, workingDirectory: '/srv/apps/api' }],
      currentUser: 'appuser',
      workingDirectory: '/srv/apps/api',
      services: { 'nginx.service': 'active running' },
      legacyFacts: {
        software: { nginx: '1.25' },
        processes: [{ name: 'nginx', status: 'Ssl' }],
        installLocations: { nginx: '/usr/sbin/nginx' },
        services: { 'nginx.service': 'active running' },
        logLocations: ['/var/log/nginx/error.log'],
        configurationHashes: { '/etc/nginx/nginx.conf': 'a'.repeat(64) },
      },
    })

    expect(record).not.toHaveProperty('software')
    expect(record).not.toHaveProperty('installLocations')
    expect(record).not.toHaveProperty('logLocations')
    expect(record).not.toHaveProperty('configurationHashes')
    expect(record.legacyFacts).toMatchObject({ software: { nginx: '1.25' }, processes: [{ name: 'nginx', status: 'Ssl' }] })
    expect(() => hostMemoryRecordSchema.parse({ ...record, connectionIp: 'api-prod' })).toThrow()
    expect(() => hostMemoryRecordSchema.parse({ ...record, processes: [{ name: 'api-server', pid: 1842, commandLine: '--mode=inspect' }] })).toThrow()
    expect(() => hostMemoryRecordSchema.parse({ ...record, environment: { EXAMPLE: 'value' } })).toThrow()
    expect(() => hostMemoryRecordSchema.parse({ ...record, rawOutput: 'unstructured data' })).toThrow()
    expect(() => hostMemoryRecordSchema.parse({ ...record, legacyFacts: { software: { nginx: 'token=sample-value' } } })).toThrow()
    expect(() => hostMemoryRecordSchema.parse({ ...record, legacyFacts: { processes: [{ name: 'nginx', status: 'running --token=sample-value' }] } })).toThrow()
    for (const name of ['password', 'token', 'apiKey', 'rawOutput', 'terminalOutput', 'stdout', 'stderr', 'commandOutput', 'terminalHistory']) {
      expect(() => hostMemoryRecordSchema.parse({ ...record, legacyFacts: { software: { [name]: '1.0.0' } } })).toThrow()
    }
  })

  it('uses the four V18 scope identities and rejects the legacy scope names', () => {
    expect(hostMemorySettingsSchema.parse({ enabled: true, scopes: { identity: true, hardware: false, processes: true, runtime: false } })).toMatchObject({ enabled: true })
    expect(() => hostMemorySettingsSchema.parse({ enabled: true, scopes: { software: true, processes: true, services: true, configuration: true } })).toThrow()
  })

  it('allows only the safe record DTO and marks memory ready', () => {
    const record = hostMemoryRecordSchema.parse({
      hostname: 'api-prod',
      observedAt: '2026-08-17T00:00:00.000Z',
      operatingSystem: { name: 'Linux', version: '6.1.0' },
      processes: [{ name: 'api-server', pid: 1842, workingDirectory: '/srv/apps/api' }],
      currentUser: 'appuser',
      workingDirectory: '/srv/apps/api',
      services: { 'nginx.service': 'active running' },
    })
    expect(() => hostMemoryRecordSchema.parse({ ...record, rawOutput: 'password=secret' })).toThrow()
    expect(() => hostMemoryRecordSchema.parse({ ...record, environment: { DATABASE_URL: 'postgres://user:pass@db/app' } })).toThrow()
    const forbidden = [
      { operatingSystem: { name: 'token=sample-value' } },
      { workingDirectory: '/tmp/session.ini' },
      { services: { 'nginx.service': 'Authorization sample-value' } },
      { processes: [{ name: 'DATABASE_URL', pid: 1842 }] },
      { processes: [{ name: 'api-server', pid: 1842, commandLine: '--token=sample-value' }] },
      { connectionIp: 'ssh://user:pass@example.invalid' },
    ]
    for (const fields of forbidden) expect(() => hostMemoryRecordSchema.parse({ ...record, ...fields })).toThrow()
    expect(SETTINGS_TABS.find(tab => tab.id === 'memory')?.status).toBe('ready')
  })

  it('accepts IP literals but rejects credential-shaped connection labels', () => {
    const token = 'a'.repeat(43)
    for (const hostIdentity of ['192.0.2.10', '2001:db8::10', '::1']) {
      expect(hostMemoryDisclosureSchema.parse({ token, hostIdentity }).hostIdentity).toBe(hostIdentity)
    }
    for (const hostIdentity of ['user:pass@example.invalid', 'ssh://user:pass@example.invalid', 'not:an:ipv6', 'sk-proj-' + '0'.repeat(32)]) {
      expect(() => hostMemoryDisclosureSchema.parse({ token, hostIdentity })).toThrow()
    }
  })

  it('enforces typed and bounded hardware facts', () => {
    const record = { hostname: 'api-prod', observedAt: '2026-08-17T00:00:00.000Z' }
    expect(hostMemoryRecordSchema.parse({
      ...record,
      cpu: { model: 'Example CPU', architecture: 'x86_64', logicalCores: 8 },
      memory: { totalBytes: 8_589_934_592 },
      disks: [{ name: 'sda', totalBytes: 128_000_000_000 }],
      networkInterfaces: [{ name: 'eth0', addresses: ['192.0.2.10'] }],
    })).toMatchObject({ cpu: { logicalCores: 8 }, memory: { totalBytes: 8_589_934_592 } })
    expect(() => hostMemoryRecordSchema.parse({ ...record, memory: { totalBytes: -1 } })).toThrow()
    expect(() => hostMemoryRecordSchema.parse({ ...record, disks: Array.from({ length: 65 }, (_, index) => ({ name: `disk${index}`, totalBytes: 1 })) })).toThrow()
    expect(() => hostMemoryRecordSchema.parse({ ...record, networkInterfaces: [{ name: 'eth0', addresses: ['not-an-ip'] }] })).toThrow()
  })
  it('accepts legitimate process names and complete systemd states', () => {
    expect(hostMemoryRecordSchema.parse({
      hostname: 'api-prod', observedAt: '2026-08-17T00:00:00.000Z',
      processes: [{ name: 'ImageMagick', pid: 42 }],
      services: { 'cleanup.service': 'maintenance failed', 'refresh.service': 'refreshing reload' },
    }).processes).toEqual([{ name: 'ImageMagick', pid: 42 }])
  })
  it('accepts the filesystem root as a safe structured working directory', () => {
    expect(hostMemoryRecordSchema.parse({
      hostname: 'api-prod', observedAt: '2026-08-17T00:00:00.000Z', workingDirectory: '/',
      processes: [{ name: 'init', pid: 1, workingDirectory: '/' }],
    })).toMatchObject({ workingDirectory: '/', processes: [{ workingDirectory: '/' }] })
  })
  it('supports the four persisted scope controls', () => {
    expect(hostMemorySettingsSchema.parse({ enabled: true, scopes: { identity: true, hardware: false, processes: true, runtime: false } })).toEqual({
      enabled: true,
      scopes: { identity: true, hardware: false, processes: true, runtime: false },
    })
  })

  it('summarizes each real host record using category counts without exposing fact values', () => {
    const summary = summarizeHostMemoryRecord({
      hostname: 'api-prod', observedAt: '2026-08-17T00:00:00.000Z', connectionIp: '192.0.2.10',
      operatingSystem: { name: 'Linux', version: '6.1.0' }, cpu: { architecture: 'x86_64', logicalCores: 8 },
      memory: { totalBytes: 8_589_934_592 }, disks: [{ name: 'sda', totalBytes: 128_000_000_000 }],
      networkInterfaces: [{ name: 'eth0', addresses: ['192.0.2.10'] }],
      processes: [{ name: 'nginx', pid: 42 }, { name: 'node', pid: 84, workingDirectory: '/srv/apps/api' }],
      currentUser: 'appuser', workingDirectory: '/srv/apps/api', services: { 'nginx.service': 'active running' },
    })
    expect(summary).toBe('身份 3 项；硬件 4 项；进程 2 项；运行环境 3 项')
    expect(summary).not.toContain('nginx')
    expect(summary).not.toContain('192.0.2.10')
  })

  it('uses the authoritative scope copy and structured fact controls instead of a JSON editor', () => {
    const source = readFileSync(new URL('../../../src/renderer/src/components/settings/HostMemorySettings.vue', import.meta.url), 'utf8')
    for (const label of [
      '主机名、连接 IP、操作系统和基础版本',
      'CPU、内存、磁盘、网络等基础信息',
      '运行进程名称、PID 和进程工作目录',
      '当前用户、工作目录和常用服务状态',
    ]) expect(source).toContain(label)
    for (const field of ['连接 IP', '操作系统', 'CPU 型号', '内存总量', '进程名称', '进程 PID', '当前用户', '服务名称']) {
      expect(source).toContain(field)
    }
    for (const field of ['迁移保留事实', '软件版本', '安装目录', '旧进程状态', '配置哈希']) expect(source).toContain(field)
    expect(source).toContain('legacyFacts: record.legacyFacts ? structuredClone(record.legacyFacts) : undefined')
    expect(source).not.toContain('主机记忆 JSON')
    expect(source).not.toContain('JSON.stringify(record, null, 2)')
  })

  it('keeps the authoritative migrated software and installation facts editable', () => {
    const source = readFileSync(new URL('../../../src/renderer/src/components/settings/HostMemorySettings.vue', import.meta.url), 'utf8')

    expect(source).toContain('v-model.trim="software.name"')
    expect(source).toContain('v-model.trim="software.version"')
    expect(source).toContain('v-model.trim="location.name"')
    expect(source).toContain('v-model.trim="location.path"')
    expect(source).not.toContain('旧版安全事实保持原样')
  })
})

const syntheticBareCredentials = [
  'sk-proj-' + '0'.repeat(32),
  'ghp_' + '0'.repeat(36),
  'github_pat_' + '0'.repeat(82),
  ...['gho_', 'ghu_', 'ghs_', 'ghr_'].map(prefix => prefix + '0'.repeat(36)),
  ...['AKIA', 'ASIA'].map(prefix => prefix + '0'.repeat(16)),
  'glpat-' + '0'.repeat(20),
  'npm_' + '0'.repeat(36),
  'xoxb-' + '0'.repeat(10) + '-' + '0'.repeat(10) + '-' + '0'.repeat(12),
  'sk_live_' + '0'.repeat(24),
  'rk_live_' + '0'.repeat(24),
  'dckr_pat_' + '0'.repeat(36),
  'aws-secret-access-key=' + 'A'.repeat(40),
  'eyJzeW50aGV0aWMiOiJ0ZXN0In0.eyJub25mdW5jdGlvbmFsIjp0cnVlfQ.invalidsignature',
  'Bearer synthetic-nonfunctional-value-00000000',
]
