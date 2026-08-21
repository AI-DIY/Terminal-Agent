import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerBastionLaunchHandlers } from '../../../src/main/access-client/register-bastion-launch-handlers'

const { handle, removeHandler } = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn() }))

vi.mock('electron', () => ({ ipcMain: { handle, removeHandler } }))

describe('registerBastionLaunchHandlers', () => {
  beforeEach(() => {
    handle.mockReset()
    removeHandler.mockReset()
  })

  it('rejects an untrusted renderer before queries or launches', async () => {
    const source = createSource()
    const trustedSender = { send: vi.fn() }
    registerBastionLaunchHandlers(source, trustedSender as never)
    const foreignEvent = { sender: { send: vi.fn() } }

    expect(() => handlerFor('access-client:bastion:catalog')(foreignEvent)).toThrow('Untrusted renderer')
    expect(() => handlerFor('access-client:bastion:hosts')(foreignEvent, 'orders')).toThrow('Untrusted renderer')
    expect(() => handlerFor('access-client:bastion:launch')(
      foreignEvent,
      { kind: 'host', target: 'web-01.example.internal' },
    )).toThrow('Untrusted renderer')

    expect(source.catalog).not.toHaveBeenCalled()
    expect(source.hosts).not.toHaveBeenCalled()
    expect(source.launch).not.toHaveBeenCalled()
  })

  it('passes only parsed named requests to the launch service', async () => {
    const source = createSource()
    const sender = { send: vi.fn() }
    registerBastionLaunchHandlers(source, sender as never)
    const event = { sender }

    await expect(handlerFor('access-client:bastion:catalog')(event)).resolves.toEqual({ available: false, systems: [], message: '未配置堡垒机目录来源。' })
    await expect(handlerFor('access-client:bastion:hosts')(event, ' orders ')).resolves.toEqual([])
    await expect(handlerFor('access-client:bastion:launch')(
      event,
      { kind: 'host', target: ' web-01.example.internal ' },
    )).resolves.toEqual({ kind: 'opened', sessionId: 's-2' })

    expect(source.hosts).toHaveBeenCalledWith('orders')
    expect(source.launch).toHaveBeenCalledWith({ kind: 'host', target: 'web-01.example.internal' })
  })

  it('rejects invalid input and removes every handler on dispose', async () => {
    const source = createSource()
    const sender = { send: vi.fn() }
    const dispose = registerBastionLaunchHandlers(source, sender as never)
    const event = { sender }

    expect(() => handlerFor('access-client:bastion:hosts')(event, '   ')).toThrow()
    expect(() => handlerFor('access-client:bastion:launch')(
      event,
      { kind: 'host', target: 'web', password: 'secret' },
    )).toThrow()
    expect(source.hosts).not.toHaveBeenCalled()
    expect(source.launch).not.toHaveBeenCalled()

    dispose()
    expect(removeHandler.mock.calls.map(([channel]) => channel)).toEqual([
      'access-client:bastion:catalog',
      'access-client:bastion:hosts',
      'access-client:bastion:launch',
    ])
  })
})

function handlerFor(channel: string): (...args: unknown[]) => Promise<unknown> {
  const match = handle.mock.calls.find(([registeredChannel]) => registeredChannel === channel)
  if (!match) throw new Error(`Missing handler: ${channel}`)
  return match[1] as (...args: unknown[]) => Promise<unknown>
}

function createSource() {
  return {
    catalog: vi.fn().mockResolvedValue({ available: false, systems: [], message: '未配置堡垒机目录来源。' }),
    hosts: vi.fn().mockResolvedValue([]),
    launch: vi.fn().mockResolvedValue({ kind: 'opened', sessionId: 's-2' }),
  }
}
