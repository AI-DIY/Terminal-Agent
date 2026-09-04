import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SsoAuthenticationService } from '../../../src/main/sso/sso-authentication-service'
import { registerSsoHandlers } from '../../../src/main/sso/register-sso-handlers'
import type { SsoConfiguration, SsoIdentity } from '../../../src/shared/sso-contracts'

const electron = vi.hoisted(() => ({
  windows: [] as Array<{ options: Record<string, unknown>; close(): void }>,
  handle: vi.fn(),
  removeHandler: vi.fn(),
}))
vi.mock('electron', () => ({
  ipcMain: { handle: electron.handle, removeHandler: electron.removeHandler },
  BrowserWindow: class {
    readonly webContents = { debugger: { attach() {}, detach() {}, sendCommand: async () => undefined, on() {}, removeListener() {} }, on() {}, removeListener() {} }
    destroyed = false
    constructor(readonly options: Record<string, unknown>) { electron.windows.push(this) }
    loadURL = vi.fn(async () => undefined)
    close() { this.destroyed = true }
    destroy() { this.destroyed = true }
    isDestroyed() { return this.destroyed }
    on() {}
    removeListener() {}
  },
}))

const config: SsoConfiguration = {
  enabled: true,
  loginPageUrl: 'https://identity.example/login',
  platformUrlMatcher: { mode: 'exact', value: 'https://platform.example/home' },
  userInfoUrlMatcher: { mode: 'exact', value: 'https://platform.example/api/userinfo' },
  employeeIdField: 'data.employeeId',
  nameField: 'data.name',
}

class FakeWindow extends EventEmitter {
  readonly debugger = { attach() {}, detach() {}, sendCommand: async () => undefined, on() {}, removeListener() {} }
  readonly webContents = {
    debugger: this.debugger,
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => this.on(`webContents:${event}`, listener)),
    removeListener: vi.fn((event: string, listener: (...args: unknown[]) => void) => this.removeListener(`webContents:${event}`, listener)),
  }
  readonly loadURL = vi.fn(async (url: string) => { void url })
  vetoClose = false
  destroyed = false
  readonly close = vi.fn(() => {
    if (this.vetoClose || this.destroyed) return
    this.destroyed = true
    this.emit('closed')
  })
  readonly destroy = vi.fn(() => {
    if (this.destroyed) return
    this.destroyed = true
    this.emit('closed')
  })
  readonly isDestroyed = vi.fn(() => this.destroyed)
}

class FakeCapture {
  readonly start = vi.fn(() => this.result)
  readonly ready = vi.fn<() => Promise<void>>(async () => undefined)
  readonly dispose = vi.fn<() => Promise<void>>(async () => undefined)
  readonly notifyNavigation = vi.fn((url: string) => {
    if (url === 'https://platform.example/home') this.platformObserved = true
    this.settleIdentity()
  })
  private resolve!: (identity: SsoIdentity) => void
  private reject!: (error: Error) => void
  private identity: SsoIdentity | undefined
  private platformObserved = false
  readonly result = new Promise<SsoIdentity>((resolve, reject) => { this.resolve = resolve; this.reject = reject })

  resolveResponse(identity: SsoIdentity): void { this.identity = identity; this.settleIdentity() }
  rejectResponse(error: Error): void { this.reject(error) }

  private settleIdentity(): void {
    if (this.platformObserved && this.identity) this.resolve(this.identity)
  }
}

function createService() {
  const window = new FakeWindow()
  const capture = new FakeCapture()
  const configPort = {
    get: vi.fn(async () => config),
    save: vi.fn(async (next: SsoConfiguration) => next),
    isComplete: vi.fn((value?: SsoConfiguration) => Boolean(value?.loginPageUrl)),
  }
  const service = new SsoAuthenticationService(configPort, {
    createWindow: vi.fn(() => window),
    createCapture: vi.fn(() => capture),
  })
  return { service, window, capture, configPort }
}

afterEach(() => {
  vi.useRealTimers()
  electron.windows.splice(0)
  electron.handle.mockReset()
  electron.removeHandler.mockReset()
})

describe('SsoAuthenticationService', () => {
  it('enters login-disabled when the gate is disabled even if optional fields are blank', async () => {
    const { service, configPort } = createService()
    configPort.get.mockResolvedValueOnce({
      enabled: false,
      loginPageUrl: '',
      platformUrlMatcher: { mode: 'exact', value: '' },
      userInfoUrlMatcher: { mode: 'exact', value: '' },
      employeeIdField: '',
      nameField: '',
    })
    configPort.isComplete.mockReturnValueOnce(false)

    await expect(service.initialize()).resolves.toEqual({ state: 'login-disabled' })
  })

  it('starts in configuration-required when configuration is incomplete', async () => {
    const { service, configPort } = createService()
    configPort.get.mockResolvedValueOnce({ ...config, loginPageUrl: '' })
    configPort.isComplete.mockReturnValueOnce(false)
    await expect(service.initialize()).resolves.toEqual({ state: 'configuration-required' })
  })

  it('initializes complete enabled configuration without opening a remote window', async () => {
    const { service, window } = createService()
    await expect(service.initialize()).resolves.toEqual({ state: 'login-required' })
    expect(window.loadURL).not.toHaveBeenCalled()
  })

  it('clears identity and enters login-disabled for disabled configuration', async () => {
    const { service, capture, window } = createService()
    await service.initialize()
    await service.retry()
    const navigation = window.webContents.on.mock.calls.find(([event]) => event === 'did-navigate')?.[1] as ((event: unknown, url: string) => void)
    navigation({}, 'https://platform.example/home')
    capture.resolveResponse({ name: 'Previous', employeeId: 'OLD' })
    await vi.waitFor(() => expect(service.getState().state).toBe('authenticated'))
    await expect(service.saveConfiguration({ ...config, enabled: false }, 'workbench')).resolves.toEqual({ state: 'login-disabled' })
    expect(service.getState()).toEqual({ state: 'login-disabled' })
  })

  it('keeps enabled and disabled drafts fail-closed in settings without opening authentication', async () => {
    const { service, window, configPort } = createService()
    configPort.get.mockResolvedValueOnce({ ...config, loginPageUrl: '' })
    configPort.isComplete.mockReturnValueOnce(false)
    await service.initialize()

    await expect(service.saveConfiguration(config, 'draft')).resolves.toEqual({ state: 'configuration-required' })
    await expect(service.saveConfiguration({ ...config, enabled: false }, 'draft')).resolves.toEqual({ state: 'configuration-required' })

    expect(window.loadURL).not.toHaveBeenCalled()
    expect(service.getState()).toEqual({ state: 'configuration-required' })
  })

  it('starts exactly one fresh authentication attempt when continuing after an error', async () => {
    const firstWindow = new FakeWindow()
    const secondWindow = new FakeWindow()
    const firstCapture = new FakeCapture()
    const secondCapture = new FakeCapture()
    const windows = [firstWindow, secondWindow]
    const captures = [firstCapture, secondCapture]
    const configPort = {
      get: vi.fn(async () => config),
      save: vi.fn(async (next: SsoConfiguration) => next),
      isComplete: vi.fn(() => true),
    }
    const createWindow = vi.fn(() => windows.shift()!)
    const service = new SsoAuthenticationService(configPort, {
      createWindow,
      createCapture: vi.fn(() => captures.shift()!),
    })
    await service.initialize()
    await service.retry()
    firstCapture.rejectResponse(new Error('Unable to continue SSO sign-in'))
    await vi.waitFor(() => expect(service.getState().state).toBe('error'))

    await expect(service.saveConfiguration(config, 'continue')).resolves.toEqual({ state: 'authenticating' })

    expect(createWindow).toHaveBeenCalledTimes(2)
    expect(secondWindow.loadURL.mock.calls).toEqual([
      ['about:blank'],
      [config.loginPageUrl],
    ])
  })

  it('never enters the workbench through the wrong save intent', async () => {
    const { service, configPort, window } = createService()
    await service.initialize()
    configPort.isComplete.mockReturnValue(false)

    await expect(Promise.resolve().then(() => service.saveConfiguration({ ...config, loginPageUrl: '' }, 'continue'))).rejects.toThrow()
    await expect(Promise.resolve().then(() => service.saveConfiguration(config, 'workbench'))).rejects.toThrow()

    expect(service.getState().state).not.toBe('login-disabled')
    expect(window.loadURL).not.toHaveBeenCalled()
  })

  it('does not let retry turn a disabled draft into an implicit workbench transition', async () => {
    const { service } = createService()
    await service.initialize()
    await service.retry()
    await service.saveConfiguration({ ...config, enabled: false }, 'draft')

    await service.retry()

    expect(service.getState()).toEqual({ state: 'configuration-required' })
  })

  it('authenticates when platform navigation arrives before identity', async () => {
    const { service, capture, window } = createService()
    await service.initialize()
    await service.retry()
    const navigation = window.webContents.on.mock.calls.find(([event]) => event === 'did-navigate-in-page')?.[1] as ((event: unknown, url: string, isMainFrame: boolean) => void)
    navigation({}, 'https://platform.example/home', true)
    expect(service.getState()).toEqual({ state: 'authenticating' })
    capture.resolveResponse({ name: '李四', employeeId: 'E-2' })
    await vi.waitFor(() => expect(service.getState()).toEqual({ state: 'authenticated', identity: { name: '李四', employeeId: 'E-2' } }))
  })

  it('requires platform navigation and identity before publishing authenticated state', async () => {
    const { service, capture, window } = createService()
    await service.initialize()
    await service.retry()
    capture.resolveResponse({ name: '张三', employeeId: 'E-1' })
    await Promise.resolve()
    expect(service.getState().state).toBe('authenticating')
    const navigation = window.webContents.on.mock.calls.find(([event]) => event === 'did-navigate')?.[1] as ((event: unknown, url: string) => void)
    navigation?.({}, 'https://platform.example/home')
    expect(capture.notifyNavigation).toHaveBeenCalledWith('https://platform.example/home')
    await vi.waitFor(() => expect(service.getState()).toMatchObject({ state: 'authenticated', identity: { name: '张三', employeeId: 'E-1' } }))
  })

  it('uses the capture completion signal when response and navigation are driven directly in either order', async () => {
    const { service, capture } = createService()
    await service.initialize()
    await service.retry()
    capture.resolveResponse({ name: '直接捕获', employeeId: 'E-DIRECT' })
    expect(service.getState().state).toBe('authenticating')
    capture.notifyNavigation('https://platform.example/home')
    await vi.waitFor(() => expect(service.getState()).toEqual({ state: 'authenticated', identity: { name: '直接捕获', employeeId: 'E-DIRECT' } }))
  })

  it('forwards only real positional main-frame navigation events to the capture', async () => {
    const { service, capture, window } = createService()
    await service.initialize()
    await service.retry()
    const inPage = window.webContents.on.mock.calls.find(([event]) => event === 'did-navigate-in-page')?.[1] as (event: unknown, url: string, isMainFrame: boolean) => void
    inPage({}, 'https://platform.example/home', false)
    expect(capture.notifyNavigation).not.toHaveBeenCalled()
    inPage({}, 'https://platform.example/home', true)
    expect(capture.notifyNavigation).toHaveBeenCalledWith('https://platform.example/home')

    const frame = window.webContents.on.mock.calls.find(([event]) => event === 'did-frame-navigate')?.[1] as (event: unknown, url: string, status: number, statusText: string, isMainFrame: boolean) => void
    frame({}, 'https://platform.example/home', 200, 'OK', false)
    frame({}, 'https://platform.example/home', 200, 'OK', true)
    expect(capture.notifyNavigation).toHaveBeenCalledTimes(2)
  })

  it('primes the authentication window locally before capture startup and the configured login page', async () => {
    const { service, capture, window } = createService()
    const order: string[] = []
    let releaseBlankNavigation!: () => void
    const blankNavigation = new Promise<void>(resolve => { releaseBlankNavigation = resolve })
    capture.start.mockImplementation(() => { order.push('start'); return capture.result })
    capture.ready.mockImplementation(async () => { order.push('ready') })
    window.loadURL.mockImplementation(async (url: string) => {
      order.push(`loadURL:${url}`)
      if (url === 'about:blank') await blankNavigation
    })
    await service.initialize()
    const retrying = service.retry()
    await vi.waitFor(() => expect(window.loadURL).toHaveBeenCalledWith('about:blank'))
    expect(order).toEqual(['loadURL:about:blank'])
    expect(capture.start).not.toHaveBeenCalled()
    expect(capture.ready).not.toHaveBeenCalled()

    releaseBlankNavigation()
    await retrying

    expect(order).toEqual([
      'loadURL:about:blank',
      'start',
      'ready',
      `loadURL:${config.loginPageUrl}`,
    ])
  })

  it('does not start capture or load the remote login page after cancellation during local priming', async () => {
    const { service, capture, window } = createService()
    let releaseBlankNavigation!: () => void
    const blankNavigation = new Promise<void>(resolve => { releaseBlankNavigation = resolve })
    window.loadURL.mockImplementation(async (url: string) => {
      if (url === 'about:blank') await blankNavigation
    })
    await service.initialize()
    const retrying = service.retry()
    await vi.waitFor(() => expect(window.loadURL).toHaveBeenCalledWith('about:blank'))

    const saving = service.saveConfiguration({ ...config, enabled: false }, 'workbench')
    await vi.waitFor(() => expect(capture.dispose).toHaveBeenCalledOnce())
    releaseBlankNavigation()
    await Promise.all([retrying, saving])

    expect(capture.start).not.toHaveBeenCalled()
    expect(window.loadURL).not.toHaveBeenCalledWith(config.loginPageUrl)
    expect(window.close).toHaveBeenCalledOnce()
    expect(service.getState()).toEqual({ state: 'login-disabled' })
  })

  it('does not start capture or load the remote login page when the primed window closes', async () => {
    const { service, capture, window } = createService()
    let releaseBlankNavigation!: () => void
    const blankNavigation = new Promise<void>(resolve => { releaseBlankNavigation = resolve })
    window.loadURL.mockImplementation(async (url: string) => {
      if (url === 'about:blank') await blankNavigation
    })
    await service.initialize()
    const retrying = service.retry()
    await vi.waitFor(() => expect(window.loadURL).toHaveBeenCalledWith('about:blank'))

    window.isDestroyed.mockReturnValue(true)
    window.emit('closed')
    releaseBlankNavigation()
    await retrying
    await vi.waitFor(() => expect(service.getState()).toEqual({
      state: 'error',
      errorMessage: 'SSO sign-in window closed',
    }))

    expect(capture.start).not.toHaveBeenCalled()
    expect(window.loadURL).not.toHaveBeenCalledWith(config.loginPageUrl)
  })

  it('reports window closed when login navigation rejects after the authentication window is destroyed', async () => {
    const { service, window } = createService()
    let rejectLoginNavigation!: (error: Error) => void
    const loginNavigation = new Promise<void>((_resolve, reject) => { rejectLoginNavigation = reject })
    window.loadURL.mockImplementation(async (url: string) => {
      if (url === config.loginPageUrl) await loginNavigation
    })
    await service.initialize()

    const retrying = service.retry()
    await vi.waitFor(() => expect(window.loadURL).toHaveBeenCalledWith(config.loginPageUrl))
    window.destroyed = true
    rejectLoginNavigation(new Error('ERR_ABORTED (-3) loading login page'))
    await retrying

    expect(service.getState()).toEqual({
      state: 'error',
      errorMessage: 'SSO sign-in window closed',
    })
  })

  it('preserves the terminal window-closed error while asynchronous capture teardown rejects cancellation', async () => {
    const { service, capture, window } = createService()
    let releaseDispose!: () => void
    const disposeGate = new Promise<void>(resolve => { releaseDispose = resolve })
    capture.dispose.mockImplementation(async () => {
      capture.rejectResponse(new Error('SSO sign-in cancelled'))
      await disposeGate
    })

    await service.initialize()
    await service.retry()
    window.emit('closed')
    await vi.waitFor(() => expect(capture.dispose).toHaveBeenCalledOnce())
    releaseDispose()

    await vi.waitFor(() => expect(service.getState()).toEqual({
      state: 'error',
      errorMessage: 'SSO sign-in window closed',
    }))
  })

  it('ignores a stale capture completion after saving a new configuration', async () => {
    const { service, capture, configPort } = createService()
    await service.initialize()
    await service.retry()
    const old = capture.result
    await service.saveConfiguration({ ...config, loginPageUrl: 'https://identity.example/new-login' }, 'draft')
    capture.resolveResponse({ name: 'Old', employeeId: 'OLD' })
    capture.notifyNavigation('https://platform.example/home')
    await old.catch(() => undefined)
    expect(service.getState()).toEqual({ state: 'error', errorMessage: 'SSO sign-in cancelled' })
    expect(configPort.save).toHaveBeenCalledOnce()
  })

  it('serializes retry behind a deferred configuration save so an old-config session cannot authenticate', async () => {
    const firstWindow = new FakeWindow()
    const secondWindow = new FakeWindow()
    const firstCapture = new FakeCapture()
    const secondCapture = new FakeCapture()
    let releaseSave!: (configuration: SsoConfiguration) => void
    const saveDeferred = new Promise<SsoConfiguration>(resolve => { releaseSave = resolve })
    const configPort = {
      get: vi.fn(async () => config),
      save: vi.fn(() => saveDeferred),
      isComplete: vi.fn((value?: SsoConfiguration) => Boolean(value?.loginPageUrl)),
    }
    const windows = [firstWindow, secondWindow]
    const captures = [firstCapture, secondCapture]
    const createWindow = vi.fn(() => windows.shift()!)
    const service = new SsoAuthenticationService(configPort, {
      createWindow,
      createCapture: vi.fn(() => captures.shift()!),
    })

    await service.initialize()
    await service.retry()
    const saving = service.saveConfiguration({ ...config, enabled: false }, 'workbench')
    await vi.waitFor(() => expect(configPort.save).toHaveBeenCalledOnce())
    const retrying = service.retry()
    await Promise.resolve()
    expect(createWindow).toHaveBeenCalledOnce()
    expect(service.getState().state).toBe('authenticating')
    releaseSave({ ...config, enabled: false })
    await Promise.all([saving, retrying])

    secondCapture.resolveResponse({ name: '旧配置身份', employeeId: 'OLD-CONFIG' })
    secondCapture.notifyNavigation('https://platform.example/home')
    await Promise.resolve()
    expect(service.getState()).toEqual({ state: 'login-disabled' })
  })

  it('starts save cancellation while retry is still awaiting capture readiness', async () => {
    const { service, capture } = createService()
    let releaseReadiness!: () => void
    const readiness = new Promise<void>(resolve => { releaseReadiness = resolve })
    capture.ready.mockImplementation(() => readiness)
    await service.initialize()
    const retrying = service.retry()
    await vi.waitFor(() => expect(capture.start).toHaveBeenCalledOnce())
    const saving = service.saveConfiguration({ ...config, enabled: false }, 'workbench')
    await Promise.resolve()
    const cancellationCallsBeforeReadiness = capture.dispose.mock.calls.length
    releaseReadiness()
    await Promise.all([retrying, saving])
    expect(cancellationCallsBeforeReadiness).toBe(1)
    expect(service.getState()).toEqual({ state: 'login-disabled' })
  })

  it('maps capture failures to a safe error snapshot and disposes idempotently', async () => {
    const { service, capture } = createService()
    await service.initialize()
    await service.retry()
    capture.rejectResponse(new Error('raw protocol details with cookies'))
    await vi.waitFor(() => expect(service.getState().state).toBe('error'))
    expect(service.getState()).toMatchObject({ state: 'error' })
    expect(JSON.stringify(service.getState())).not.toContain('raw protocol')
    await service.dispose()
    await service.dispose()
    expect(capture.dispose).toHaveBeenCalledOnce()
  })

  it('force-destroys a vetoed authentication window before relinquishing ownership', async () => {
    const { service, capture, window } = createService()
    window.vetoClose = true
    await service.initialize()
    await service.retry()
    capture.rejectResponse(new Error('Unable to continue SSO sign-in'))

    await vi.waitFor(() => expect(service.getState().state).toBe('error'))
    await vi.waitFor(() => expect(window.destroy).toHaveBeenCalledOnce())
    expect(window.close).toHaveBeenCalledOnce()
    expect(window.isDestroyed()).toBe(true)

    await service.dispose()
    await service.dispose()
    expect(window.destroy).toHaveBeenCalledOnce()
  })

  it('turns an over-limit captured identity into a safe error and cleans up the auth session', async () => {
    const { service, capture, window } = createService()
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
    process.once('unhandledRejection', onUnhandled)
    await service.initialize()
    await service.retry()
    const navigation = window.webContents.on.mock.calls.find(([event]) => event === 'did-navigate')?.[1] as ((event: unknown, url: string) => void)
    navigation({}, 'https://platform.example/home')
    capture.resolveResponse({ name: 'N'.repeat(513), employeeId: 'E-OVERLIMIT' })
    await vi.waitFor(() => expect(service.getState()).toEqual({ state: 'error', errorMessage: 'Unable to complete SSO sign-in' }))
    await Promise.resolve()
    process.removeListener('unhandledRejection', onUnhandled)
    expect(unhandled).toEqual([])
    expect(capture.dispose).toHaveBeenCalledOnce()
    expect(window.close).toHaveBeenCalledOnce()
  })

  it('does not clear a renderer attached while asynchronous session cleanup finishes', async () => {
    const { service, capture } = createService()
    let releaseCleanup!: () => void
    const cleanup = new Promise<void>(resolve => { releaseCleanup = resolve })
    capture.dispose.mockImplementation(() => cleanup)
    await service.initialize()
    await service.retry()
    const disposing = service.dispose()
    const renderer = { send: vi.fn(), isDestroyed: vi.fn(() => false) }
    const listener = vi.fn()
    service.attachRenderer(renderer as never)
    service.onState(listener)
    releaseCleanup()
    await disposing
    await service.initialize()
    expect(renderer.send).toHaveBeenLastCalledWith('sso:state', { state: 'login-required' })
    expect(listener).toHaveBeenLastCalledWith({ state: 'login-required' })
  })

  it('returns an interrupted authentication attempt to login-required on dispose', async () => {
    const { service } = createService()
    await service.initialize()
    await service.retry()
    expect(service.getState()).toEqual({ state: 'authenticating' })
    await service.dispose()
    expect(service.getState()).toEqual({ state: 'login-required' })
  })

  it.each([
    'SSO sign-in timed out',
    'SSO sign-in window closed',
    'SSO sign-in connection closed',
    'Unable to start SSO sign-in',
  ])('publishes the bounded capture error: %s', async errorMessage => {
    const { service, capture } = createService()
    await service.initialize()
    await service.retry()
    capture.rejectResponse(new Error(errorMessage))
    await vi.waitFor(() => expect(service.getState()).toEqual({ state: 'error', errorMessage }))
  })

  it('publishes safe runtime-only snapshots to state listeners and the attached renderer', async () => {
    const { service, capture, window } = createService()
    const listener = vi.fn()
    const renderer = { send: vi.fn(), isDestroyed: vi.fn(() => false) }
    service.onState(listener)
    service.attachRenderer(renderer as never)
    await service.initialize()
    await service.retry()
    const navigation = window.webContents.on.mock.calls.find(([event]) => event === 'did-navigate')?.[1] as ((event: unknown, url: string) => void)
    navigation({}, 'https://platform.example/home')
    capture.resolveResponse({ name: '安全姓名', employeeId: 'SAFE-1' })
    await vi.waitFor(() => expect(service.getState().state).toBe('authenticated'))
    const snapshot = listener.mock.calls.at(-1)?.[0]
    expect(snapshot).toEqual({ state: 'authenticated', identity: { name: '安全姓名', employeeId: 'SAFE-1' } })
    expect(Object.keys(snapshot)).toEqual(['state', 'identity'])
    expect(renderer.send).toHaveBeenLastCalledWith('sso:state', snapshot)
  })

  it('publishes one renderer IPC event per state transition when wired through SSO handlers', async () => {
    const { service, configPort } = createService()
    const renderer = { send: vi.fn(), isDestroyed: vi.fn(() => false) }
    service.attachRenderer(renderer as never)
    const unregister = registerSsoHandlers(configPort as never, service, renderer as never)
    renderer.send.mockClear()

    await service.initialize()

    expect(renderer.send.mock.calls).toEqual([
      ['sso:state', { state: 'login-required' }],
    ])
    unregister()
  })

  it('creates a secure non-persistent authentication window by default', async () => {
    const service = new SsoAuthenticationService({
      get: vi.fn(async () => config),
      save: vi.fn(async (next: SsoConfiguration) => next),
      isComplete: vi.fn(() => true),
    })
    await service.initialize()
    await service.retry()
    await service.retry()
    expect(electron.windows).toHaveLength(2)
    const preferences = electron.windows.map(window => window.options.webPreferences as Record<string, unknown>)
    expect(preferences[0]).toMatchObject({ contextIsolation: true, nodeIntegration: false, sandbox: true })
    expect(preferences[0]).not.toHaveProperty('preload')
    expect(preferences[0]?.partition).toMatch(/^sso-auth-/)
    expect(preferences[1]?.partition).toMatch(/^sso-auth-/)
    expect(preferences[0]?.partition).not.toBe(preferences[1]?.partition)
    expect(String(preferences[0]?.partition)).not.toMatch(/^persist:/)
    await service.dispose()
  })
})
