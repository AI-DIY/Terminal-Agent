import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerSsoHandlers } from '../../../src/main/sso/register-sso-handlers'
import type { SsoConfiguration } from '../../../src/shared/sso-contracts'

const { handle, removeHandler } = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle, removeHandler } }))

const config: SsoConfiguration = {
  enabled: true,
  loginPageUrl: 'https://identity.example/login',
  platformUrlMatcher: { mode: 'exact', value: 'https://platform.example/home' },
  userInfoUrlMatcher: { mode: 'exact', value: 'https://platform.example/api/userinfo' },
  employeeIdField: 'data.employeeId',
  nameField: 'data.name',
}

function handlerFor(channel: string): (...args: unknown[]) => unknown {
  const registered = handle.mock.calls.find(([name]) => name === channel)?.[1]
  if (!registered) throw new Error(`Missing handler: ${channel}`)
  return registered as (...args: unknown[]) => unknown
}

describe('registerSsoHandlers', () => {
  beforeEach(() => { handle.mockReset(); removeHandler.mockReset() })

  it('rejects foreign senders before parsing any payload', async () => {
    const auth = { getState: vi.fn(() => ({ state: 'login-required' as const })), initialize: vi.fn(), saveConfiguration: vi.fn(), retry: vi.fn(), onState: vi.fn(() => () => undefined) }
    const configPort = { get: vi.fn(async () => config) }
    const trusted = { send: vi.fn(), isDestroyed: vi.fn(() => false) }
    const dispose = registerSsoHandlers(configPort as never, auth as never, trusted as never)
    const foreign = { sender: {} }
    const unreadable = new Proxy({}, { get: () => { throw new Error('parsed') }, ownKeys: () => { throw new Error('parsed') } })
    expect(() => handlerFor('sso:config:get')(foreign)).toThrow('Untrusted renderer')
    await expect(handlerFor('sso:config:save')(foreign, unreadable)).rejects.toThrow('Untrusted renderer')
    expect(() => handlerFor('sso:state:get')(foreign)).toThrow('Untrusted renderer')
    await expect(handlerFor('sso:retry')(foreign, unreadable)).rejects.toThrow('Untrusted renderer')
    dispose()
  })

  it('validates save input and sends only validated state events', async () => {
    const auth = {
      getState: vi.fn(() => ({ state: 'login-required' as const })),
      saveConfiguration: vi.fn(async () => ({ state: 'login-required' as const })),
      retry: vi.fn(async () => undefined),
      onState: vi.fn(() => vi.fn()),
    }
    const configPort = { get: vi.fn(async () => config) }
    const trusted = { send: vi.fn(), isDestroyed: vi.fn(() => false) }
    const dispose = registerSsoHandlers(configPort as never, auth as never, trusted as never)
    await expect(handlerFor('sso:config:save')({ sender: trusted }, { ...config, enabled: 'yes' })).rejects.toThrow()
    expect(auth.saveConfiguration).not.toHaveBeenCalled()
    await handlerFor('sso:config:save')({ sender: trusted }, config, 'continue')
    expect(auth.saveConfiguration).toHaveBeenCalledWith(config, 'continue')
    await expect(handlerFor('sso:config:save')({ sender: trusted }, config, 'invalid')).rejects.toThrow()
    await expect(handlerFor('sso:config:save')({ sender: trusted }, config, 'draft')).resolves.toEqual(config)
    await expect(handlerFor('sso:retry')({ sender: trusted }, 'unexpected')).rejects.toThrow()
    await handlerFor('sso:retry')({ sender: trusted })
    expect(auth.retry).toHaveBeenCalledOnce()
    dispose()
  })

  it('validates configuration and state DTOs returned to the trusted renderer', async () => {
    const auth = { getState: vi.fn(() => ({ state: 'authenticated', identity: { name: 'Safe', employeeId: 'E-3' } })), saveConfiguration: vi.fn(), retry: vi.fn(), onState: vi.fn(() => () => undefined) }
    const configPort = { get: vi.fn(async () => config) }
    const trusted = { send: vi.fn(), isDestroyed: vi.fn(() => false) }
    const dispose = registerSsoHandlers(configPort as never, auth as never, trusted as never)
    await expect(handlerFor('sso:config:get')({ sender: trusted })).resolves.toEqual(config)
    expect(handlerFor('sso:state:get')({ sender: trusted })).toEqual({ state: 'authenticated', identity: { name: 'Safe', employeeId: 'E-3' } })
    auth.getState.mockReturnValueOnce({ state: 'authenticated', identity: { name: 'Safe', employeeId: 'E-3' }, headers: { authorization: 'secret' } } as never)
    expect(() => handlerFor('sso:state:get')({ sender: trusted })).toThrow()
    dispose()
  })

  it('removes every handler exactly once without installing a second state publisher', () => {
    const unsubscribe = vi.fn()
    const auth = { getState: vi.fn(() => ({ state: 'login-required' as const })), onState: vi.fn(() => unsubscribe) }
    const configPort = { get: vi.fn(async () => config) }
    const trusted = { send: vi.fn(), isDestroyed: vi.fn(() => false) }
    const dispose = registerSsoHandlers(configPort as never, auth as never, trusted as never)
    dispose(); dispose()
    expect(auth.onState).not.toHaveBeenCalled()
    expect(unsubscribe).not.toHaveBeenCalled()
    expect(removeHandler).toHaveBeenCalledTimes(4)
  })
})
