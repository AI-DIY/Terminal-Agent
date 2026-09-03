import { describe, expect, it, vi } from 'vitest'
import { createSsoStore } from '../../../src/renderer/src/stores/sso'
import type { SsoAuthSnapshot, SsoConfiguration } from '../../../src/shared/sso-contracts'

const configuration: SsoConfiguration = {
  enabled: true,
  loginPageUrl: 'https://login.example.test',
  platformUrlMatcher: { mode: 'exact', value: 'https://platform.example.test' },
  userInfoUrlMatcher: { mode: 'regex', value: '^https://platform\\.example\\.test/api/me$' },
  employeeIdField: 'employee.id',
  nameField: 'profile.name',
}

const authenticated: SsoAuthSnapshot = {
  state: 'authenticated',
  identity: { employeeId: 'E-42', name: 'Ada Lovelace' },
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}

function createApi(overrides: Partial<{
  getConfig(): Promise<SsoConfiguration>
  saveConfig(input: SsoConfiguration): Promise<SsoConfiguration>
  getState(): Promise<SsoAuthSnapshot>
  retry(): Promise<void>
}> = {}) {
  const unsubscribe = vi.fn()
  return {
    getConfig: vi.fn().mockResolvedValue(configuration),
    saveConfig: vi.fn().mockResolvedValue(configuration),
    getState: vi.fn().mockResolvedValue(authenticated),
    retry: vi.fn().mockResolvedValue(undefined),
    onState: vi.fn().mockReturnValue(unsubscribe),
    unsubscribe,
    ...overrides,
  }
}

describe('renderer SSO store', () => {
  it('hydrates once, applies state events, and enables skills only when authenticated', async () => {
    const api = createApi()
    const store = createSsoStore(api)

    await Promise.all([store.initialize(), store.initialize()])
    expect(api.onState).toHaveBeenCalledOnce()
    expect(api.getConfig).toHaveBeenCalledOnce()
    expect(api.getState).toHaveBeenCalledOnce()
    expect(store.config).toEqual(configuration)
    expect(store.state).toEqual(authenticated)
    expect(store.identity.value).toEqual(authenticated.identity)
    expect(store.error.value).toBe('')
    expect(store.skillsAvailable.value).toBe(true)

    const listener = api.onState.mock.calls[0]?.[0]
    listener({ state: 'authenticating' })
    expect(store.skillsAvailable.value).toBe(false)
    listener({ state: 'error', errorMessage: 'Sign in failed' })
    expect(store.error.value).toBe('Sign in failed')
  })

  it('does not let a slower hydration state overwrite a newer state event', async () => {
    const pendingState = deferred<SsoAuthSnapshot>()
    const api = createApi({ getState: vi.fn().mockReturnValue(pendingState.promise) })
    const store = createSsoStore(api)

    const initialize = store.initialize()
    api.onState.mock.calls[0]?.[0]({ state: 'login-disabled', identity: { employeeId: 'old', name: 'Old Name' } })
    pendingState.resolve(authenticated)
    await initialize

    expect(store.state.state).toBe('login-disabled')
    expect(store.identity.value).toBeNull()
    expect(store.skillsAvailable.value).toBe(false)
  })

  it('clears stale identity for disabled/config-required snapshots and after a successful config save', async () => {
    const savedConfiguration = { ...configuration, loginPageUrl: 'https://new-login.example.test' }
    const api = createApi({ saveConfig: vi.fn().mockResolvedValue(savedConfiguration) })
    const store = createSsoStore(api)
    await store.initialize()
    const listener = api.onState.mock.calls[0]?.[0]

    listener({ state: 'login-disabled', identity: authenticated.identity })
    expect(store.identity.value).toBeNull()
    listener({ state: 'authenticated', identity: authenticated.identity })
    listener({ state: 'configuration-required', identity: authenticated.identity })
    expect(store.identity.value).toBeNull()
    listener(authenticated)
    await store.saveConfig(savedConfiguration)

    expect(api.saveConfig).toHaveBeenCalledWith(savedConfiguration)
    expect(store.config.loginPageUrl).toBe('https://new-login.example.test')
    expect(store.identity.value).toBeNull()
  })

  it('relays retry and disposes exactly the registered event subscription', async () => {
    const api = createApi()
    const store = createSsoStore(api)
    await store.initialize()
    await store.retry()
    store.dispose()
    store.dispose()

    expect(api.retry).toHaveBeenCalledOnce()
    expect(api.unsubscribe).toHaveBeenCalledOnce()
  })
})
