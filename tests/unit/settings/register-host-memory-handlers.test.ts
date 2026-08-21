import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerHostMemoryHandlers } from '../../../src/main/settings/register-host-memory-handlers'

const { handle, removeHandler } = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle, removeHandler } }))

describe('registerHostMemoryHandlers', () => {
  beforeEach(() => { handle.mockReset(); removeHandler.mockReset() })

  it('keeps the original host identity on update and rejects unsafe records before reaching the service', async () => {
    const settings = { load: vi.fn(), save: vi.fn(), acknowledge: vi.fn() }
    const facts = { list: vi.fn(), snapshot: vi.fn(), update: vi.fn().mockResolvedValue(record()), remove: vi.fn() }
    const sender = {}
    registerHostMemoryHandlers(settings, facts, sender as never)
    const update = handler('settings:host-memory:update')

    await update({ sender }, { hostname: 'API-PROD', record: record() })
    expect(facts.update).toHaveBeenCalledWith('API-PROD', record())

    expect(() => update({ sender }, {
      hostname: 'api-prod',
      record: { ...record(), workingDirectory: '/tmp/access-client-session.ini' },
    })).toThrow()
    expect(() => update({ sender }, {
      hostname: 'api-prod',
      record: { ...record(), configurationHashes: { '/etc/hosts': 'a'.repeat(64) } },
    })).toThrow()
    expect(() => update({ sender }, {
      hostname: 'api-prod',
      record: { ...record(), connectionIp: 'api-prod' },
    })).toThrow()
    expect(() => update({ sender }, {
      hostname: 'api-prod',
      record: { ...record(), processes: [{ name: 'api-server', pid: 42, commandLine: '--token=sample-value' }] },
    })).toThrow()
    expect(() => update({ sender }, {
      hostname: 'api-prod',
      record: { ...record(), operatingSystem: { name: 'postgres://user:pass@db/app' } },
    })).toThrow()
    expect(facts.update).toHaveBeenCalledTimes(1)
    expect(() => update({ sender: {} }, { hostname: 'api-prod', record: record() })).toThrow('Untrusted renderer')
  })

  it('passes only an opaque consent token to the main-owned acknowledgement controller', async () => {
    const events: string[] = []
    const settings = {
      load: vi.fn(), save: vi.fn(),
    }
    const facts = { list: vi.fn(), snapshot: vi.fn(), update: vi.fn(), remove: vi.fn() }
    const consent = { acknowledge: vi.fn(async () => { events.push('acknowledge') }), dismiss: vi.fn(async () => { events.push('dismiss') }) }
    const sender = {}
    registerHostMemoryHandlers(settings, facts, sender as never, consent)
    const token = 'a'.repeat(43)

    await handler('host-memory:acknowledge')({ sender }, token)
    await handler('host-memory:dismiss')({ sender }, token)

    expect(events).toEqual(['acknowledge', 'dismiss'])
    expect(consent.acknowledge).toHaveBeenCalledWith(token)
    expect(consent.dismiss).toHaveBeenCalledWith(token)
    expect(settings).not.toHaveProperty('acknowledge')
  })

  it('rejects a renderer hostname before it can reach the acknowledgement controller', async () => {
    const settings = { load: vi.fn(), save: vi.fn() }
    const facts = { list: vi.fn(), snapshot: vi.fn(), update: vi.fn(), remove: vi.fn() }
    const consent = { acknowledge: vi.fn(), dismiss: vi.fn() }
    const sender = {}
    registerHostMemoryHandlers(settings, facts, sender as never, consent)

    await expect(handler('host-memory:acknowledge')({ sender }, 'api-prod\npassword=secret')).rejects.toThrow()

    expect(consent.acknowledge).not.toHaveBeenCalled()
  })

  it('removes facts and revokes only the requested host connection authorization', async () => {
    const settings = { load: vi.fn(), save: vi.fn() }
    const facts = { list: vi.fn(), snapshot: vi.fn(), update: vi.fn(), remove: vi.fn().mockResolvedValue(undefined) }
    const consent = { acknowledge: vi.fn(), dismiss: vi.fn(), revokeHost: vi.fn().mockResolvedValue(undefined) }
    const sender = {}
    registerHostMemoryHandlers(settings, facts, sender as never, consent)

    await handler('settings:host-memory:remove')({ sender }, 'API-PROD')

    expect(facts.remove).toHaveBeenCalledWith('api-prod')
    expect(consent.revokeHost).toHaveBeenCalledWith('api-prod')
  })

  it('rejects an unsafe hostname before removing facts or revoking authorization', async () => {
    const settings = { load: vi.fn(), save: vi.fn() }
    const facts = { list: vi.fn(), snapshot: vi.fn(), update: vi.fn(), remove: vi.fn() }
    const consent = { acknowledge: vi.fn(), dismiss: vi.fn(), revokeHost: vi.fn() }
    const sender = {}
    registerHostMemoryHandlers(settings, facts, sender as never, consent)

    await expect(handler('settings:host-memory:remove')({ sender }, 'api-prod\npassword=secret')).rejects.toThrow()
    expect(facts.remove).not.toHaveBeenCalled()
    expect(consent.revokeHost).not.toHaveBeenCalled()
  })

  it('does not remove facts when host authorization revocation fails', async () => {
    const settings = { load: vi.fn(), save: vi.fn() }
    const facts = {
      list: vi.fn(), snapshot: vi.fn(), update: vi.fn(), remove: vi.fn(),
    }
    const consent = {
      acknowledge: vi.fn(), dismiss: vi.fn(), revokeHost: vi.fn().mockRejectedValue(new Error('settings unavailable')),
    }
    const sender = {}
    registerHostMemoryHandlers(settings, facts, sender as never, consent)

    await expect(handler('settings:host-memory:remove')({ sender }, 'API-PROD')).rejects.toThrow('settings unavailable')
    expect(facts.snapshot).not.toHaveBeenCalled()
    expect(facts.remove).not.toHaveBeenCalled()
    expect(facts.update).not.toHaveBeenCalled()
  })

  it('revokes authorization before removing facts and restores it if facts removal fails', async () => {
    const events: string[] = []
    const settings = { load: vi.fn(), save: vi.fn() }
    const undo = { token: 'opaque-undo-token' }
    const facts = {
      list: vi.fn(), snapshot: vi.fn(), update: vi.fn(), remove: vi.fn(async () => { events.push('facts.remove'); throw new Error('facts unavailable') }),
    }
    const consent = {
      acknowledge: vi.fn(), dismiss: vi.fn(),
      revokeHost: vi.fn(async () => { events.push('revoke'); return undo }),
      restoreHostAuthorization: vi.fn(async (value: unknown) => { events.push('restore'); expect(value).toBe(undo) }),
    }
    const sender = {}
    registerHostMemoryHandlers(settings, facts, sender as never, consent)

    await expect(handler('settings:host-memory:remove')({ sender }, 'API-PROD')).rejects.toThrow('facts unavailable')
    expect(events).toEqual(['revoke', 'facts.remove', 'restore'])
    expect(facts.snapshot).not.toHaveBeenCalled()
    expect(facts.update).not.toHaveBeenCalled()
  })

  it('does not remove facts when authorization revocation fails', async () => {
    const settings = { load: vi.fn(), save: vi.fn() }
    const facts = { list: vi.fn(), snapshot: vi.fn(), update: vi.fn(), remove: vi.fn() }
    const consent = { acknowledge: vi.fn(), dismiss: vi.fn(), revokeHost: vi.fn().mockRejectedValue(new Error('settings unavailable')), restoreHostAuthorization: vi.fn() }
    const sender = {}
    registerHostMemoryHandlers(settings, facts, sender as never, consent)

    await expect(handler('settings:host-memory:remove')({ sender }, 'API-PROD')).rejects.toThrow('settings unavailable')
    expect(facts.remove).not.toHaveBeenCalled()
    expect(consent.restoreHostAuthorization).not.toHaveBeenCalled()
  })

  it('serializes same-host revoke and facts removal transactions', async () => {
    const events: string[] = []
    let releaseFirst!: () => void
    const firstRemoval = new Promise<void>(resolve => { releaseFirst = resolve })
    const settings = { load: vi.fn(), save: vi.fn() }
    const facts = {
      list: vi.fn(), snapshot: vi.fn(), update: vi.fn(),
      remove: vi.fn()
        .mockImplementationOnce(async () => { events.push('remove-1'); await firstRemoval })
        .mockImplementationOnce(async () => { events.push('remove-2') }),
    }
    const consent = {
      acknowledge: vi.fn(), dismiss: vi.fn(),
      revokeHost: vi.fn()
        .mockImplementationOnce(async () => { events.push('revoke-1'); return { token: 'undo-1' } })
        .mockImplementationOnce(async () => { events.push('revoke-2'); return { token: 'undo-2' } }),
      restoreHostAuthorization: vi.fn(),
    }
    const sender = {}
    registerHostMemoryHandlers(settings, facts, sender as never, consent)
    const remove = handler('settings:host-memory:remove')

    const first = remove({ sender }, 'API-PROD')
    await vi.waitFor(() => expect(events).toEqual(['revoke-1', 'remove-1']))
    const second = remove({ sender }, 'API-PROD')
    await new Promise(resolve => setImmediate(resolve))
    expect(events).toEqual(['revoke-1', 'remove-1'])

    releaseFirst()
    await Promise.all([first, second])
    expect(events).toEqual(['revoke-1', 'remove-1', 'revoke-2', 'remove-2'])
  })

  it('serializes case-variant host removals as one canonical host transaction', async () => {
    const events: string[] = []
    let releaseFirst!: () => void
    const firstRemoval = new Promise<void>(resolve => { releaseFirst = resolve })
    const settings = { load: vi.fn(), save: vi.fn() }
    const facts = {
      list: vi.fn(), snapshot: vi.fn(), update: vi.fn(),
      remove: vi.fn()
        .mockImplementationOnce(async (hostname: string) => { events.push(`remove-1:${hostname}`); await firstRemoval })
        .mockImplementationOnce(async (hostname: string) => { events.push(`remove-2:${hostname}`) }),
    }
    const consent = {
      acknowledge: vi.fn(), dismiss: vi.fn(),
      revokeHost: vi.fn()
        .mockImplementationOnce(async (hostname: string) => { events.push(`revoke-1:${hostname}`); return { token: 'undo-1' } })
        .mockImplementationOnce(async (hostname: string) => { events.push(`revoke-2:${hostname}`); return { token: 'undo-2' } }),
      restoreHostAuthorization: vi.fn(),
    }
    const sender = {}
    registerHostMemoryHandlers(settings, facts, sender as never, consent)
    const remove = handler('settings:host-memory:remove')

    const first = remove({ sender }, 'API-PROD')
    await vi.waitFor(() => expect(events).toEqual(['revoke-1:api-prod', 'remove-1:api-prod']))
    const second = remove({ sender }, 'api-prod')
    await new Promise(resolve => setImmediate(resolve))
    expect(events).toEqual(['revoke-1:api-prod', 'remove-1:api-prod'])

    releaseFirst()
    await Promise.all([first, second])
    expect(events).toEqual(['revoke-1:api-prod', 'remove-1:api-prod', 'revoke-2:api-prod', 'remove-2:api-prod'])
  })
})

function handler(channel: string): (event: { sender: unknown }, input?: unknown) => Promise<unknown> {
  const match = handle.mock.calls.find(([registered]) => registered === channel)
  if (!match) throw new Error(`Missing handler: ${channel}`)
  return match[1] as (event: { sender: unknown }, input?: unknown) => Promise<unknown>
}

function record() {
  return {
    hostname: 'api-prod',
    observedAt: '2026-08-17T00:00:00.000Z',
    connectionIp: '192.0.2.10',
    operatingSystem: { name: 'Linux', version: '6.1.0' },
    cpu: { model: 'Example CPU', architecture: 'x86_64', logicalCores: 8 },
    memory: { totalBytes: 8_589_934_592 },
    disks: [{ name: 'sda', totalBytes: 128_000_000_000 }],
    networkInterfaces: [{ name: 'eth0', addresses: ['192.0.2.10'] }],
    processes: [{ name: 'api-server', pid: 42, workingDirectory: '/srv/apps/api' }],
    currentUser: 'appuser',
    workingDirectory: '/srv/apps/api',
    services: { 'nginx.service': 'active running' },
  }
}
