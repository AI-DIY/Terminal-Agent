import { describe, expect, it, vi } from 'vitest'
import {
  BastionLaunchService,
  UnavailableBastionTargetResolver,
} from '../../../src/main/access-client/bastion-launch-service'
import { AccessClientLaunchFailure } from '../../../src/main/access-client/launch-failure'

describe('BastionLaunchService', () => {
  it('reports an unavailable catalog without leaking provider details', async () => {
    const service = new BastionLaunchService(
      new UnavailableBastionTargetResolver(),
      { openSsh: vi.fn(), openRaw: vi.fn() },
    )

    await expect(service.catalog()).resolves.toEqual({
      available: false,
      systems: [],
      message: '未配置堡垒机目录来源。',
    })
    await expect(service.launch({ kind: 'host', target: 'web-01.example.internal' }))
      .rejects.toThrow('未配置堡垒机目录来源。')
  })

  it('opens a CMDB target once and focuses it on a repeated launch', async () => {
    const openSsh = vi.fn().mockResolvedValue({ id: 's-1' })
    const resolver = {
      listSystems: vi.fn().mockResolvedValue([{ id: 'orders', name: '订单中心' }]),
      listHosts: vi.fn().mockResolvedValue([{
        id: 'host-42', systemId: 'orders', name: 'web-01', address: '10.0.0.8',
      }]),
      resolve: vi.fn().mockResolvedValue({
        protocol: 'ssh', host: '10.0.0.8', port: 22, username: 'ops',
        title: 'web-01', columns: 80, rows: 24,
      }),
    }
    const service = new BastionLaunchService(resolver, { openSsh, openRaw: vi.fn() })

    await expect(service.launch({ kind: 'cmdb', systemId: 'orders', hostId: 'host-42' }))
      .resolves.toEqual({ kind: 'opened', sessionId: 's-1' })
    await expect(service.launch({ kind: 'cmdb', systemId: 'orders', hostId: 'host-42' }))
      .resolves.toEqual({ kind: 'focused', sessionId: 's-1' })

    expect(openSsh).toHaveBeenCalledOnce()
    expect(openSsh).toHaveBeenCalledWith({
      host: '10.0.0.8', port: 22, username: 'ops', title: 'web-01', columns: 80, rows: 24,
    })
  })

  it('deduplicates simultaneous launches for the same target', async () => {
    let completeOpen: ((session: { id: string }) => void) | undefined
    const openSsh = vi.fn().mockImplementation(() => new Promise<{ id: string }>(resolve => { completeOpen = resolve }))
    const resolver = {
      listSystems: vi.fn(),
      listHosts: vi.fn(),
      resolve: vi.fn().mockResolvedValue({
        protocol: 'ssh', host: '10.0.0.8', port: 22, username: 'ops',
        title: 'web-01', columns: 80, rows: 24,
      }),
    }
    const service = new BastionLaunchService(resolver, { openSsh, openRaw: vi.fn() })

    const first = service.launch({ kind: 'host', target: 'web-01.example.internal' })
    const second = service.launch({ kind: 'host', target: 'web-01.example.internal' })
    await vi.waitFor(() => expect(openSsh).toHaveBeenCalledOnce())
    completeOpen?.({ id: 's-1' })

    await expect(first).resolves.toEqual({ kind: 'opened', sessionId: 's-1' })
    await expect(second).resolves.toEqual({ kind: 'focused', sessionId: 's-1' })
  })

  it('clears the target key when the session closes', async () => {
    const openRaw = vi.fn()
      .mockResolvedValueOnce({ id: 's-1' })
      .mockResolvedValueOnce({ id: 's-2' })
    const resolver = {
      listSystems: vi.fn(),
      listHosts: vi.fn(),
      resolve: vi.fn().mockResolvedValue({ protocol: 'raw', host: '10.0.0.8', port: 22022, title: 'web-01', columns: 80, rows: 24 }),
    }
    const service = new BastionLaunchService(resolver, { openSsh: vi.fn(), openRaw })

    await service.launch({ kind: 'host', target: '10.0.0.8' })
    service.closeSession('s-1')
    await expect(service.launch({ kind: 'host', target: '10.0.0.8' }))
      .resolves.toEqual({ kind: 'opened', sessionId: 's-2' })
  })

  it('normalizes resolver failures to a safe public message', async () => {
    const resolver = {
      listSystems: vi.fn(),
      listHosts: vi.fn(),
      resolve: vi.fn().mockRejectedValue(new Error('C:\\secret\\profile.conf password=secret')),
    }
    const service = new BastionLaunchService(resolver, { openSsh: vi.fn(), openRaw: vi.fn() })

    await expect(service.launch({ kind: 'host', target: 'web-01.example.internal' }))
      .rejects.toThrow('无法解析堡垒机目标。')
    await expect(service.launch({ kind: 'host', target: 'web-01.example.internal' }))
      .rejects.not.toThrow('secret')
  })

  it('formats classified connection failures without returning transport details', async () => {
    const resolver = {
      listSystems: vi.fn(),
      listHosts: vi.fn(),
      resolve: vi.fn().mockResolvedValue({
        protocol: 'ssh', host: '10.0.0.8', port: 22, username: 'ops',
        title: 'web-01', columns: 80, rows: 24,
      }),
    }
    const openSsh = vi.fn().mockRejectedValue(new AccessClientLaunchFailure('transport-connect-failed'))
    const service = new BastionLaunchService(resolver, { openSsh, openRaw: vi.fn() })

    await expect(service.launch({ kind: 'host', target: 'web-01.example.internal' }))
      .rejects.toThrow('无法连接堡垒机提供的终端通道。')
  })
})
