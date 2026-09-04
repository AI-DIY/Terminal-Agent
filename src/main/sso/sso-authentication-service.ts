import { randomUUID } from 'node:crypto'
import { BrowserWindow, type WebContents } from 'electron'
import {
  ssoAuthSnapshotSchema,
  ssoConfigurationSchema,
  ssoIdentitySchema,
  ssoSaveIntentSchema,
  type SsoAuthSnapshot,
  type SsoConfiguration,
  type SsoIdentity,
  type SsoSaveIntent,
} from '../../shared/sso-contracts'
import type { SsoConfigService } from '../settings/sso-config-service'
import { SsoResponseCapture } from './sso-response-capture'

type ConfigPort = Pick<SsoConfigService, 'get' | 'save' | 'isComplete'>

export type AuthenticationWindow = {
  webContents: {
    debugger: {
      attach(protocolVersion?: string): void
      detach(): void
      sendCommand(command: string, parameters?: Record<string, unknown>): Promise<unknown>
      on(event: 'message' | 'detach', listener: (...args: unknown[]) => void): unknown
      removeListener(event: 'message' | 'detach', listener: (...args: unknown[]) => void): unknown
    }
    on(event: string, listener: (...args: unknown[]) => void): unknown
    removeListener?(event: string, listener: (...args: unknown[]) => void): unknown
  }
  loadURL(url: string): Promise<unknown> | unknown
  close(): void
  isDestroyed?(): boolean
  on(event: 'close' | 'closed', listener: () => void): unknown
  removeListener(event: 'close' | 'closed', listener: () => void): unknown
  destroy(): void
}

export type AuthenticationCapture = {
  start(): Promise<SsoIdentity>
  ready(): Promise<void>
  notifyNavigation(url: string): void
  dispose(): Promise<void>
}

export type SsoAuthenticationServiceOptions = {
  createWindow?: () => AuthenticationWindow
  createCapture?: (window: AuthenticationWindow, configuration: SsoConfiguration) => AuthenticationCapture
}

const SAFE_CAPTURE_ERRORS = new Set([
  'SSO sign-in timed out',
  'SSO sign-in window closed',
  'SSO sign-in connection closed',
  'SSO sign-in cancelled',
  'Unable to start SSO sign-in',
  'Unable to continue SSO sign-in',
])

/** Owns the in-memory SSO identity and the short-lived remote authentication session. */
export class SsoAuthenticationService {
  private snapshot: SsoAuthSnapshot = { state: 'configuration-required' }
  private configuration: SsoConfiguration | undefined
  private renderer: WebContents | undefined
  private authWindow: AuthenticationWindow | undefined
  private capture: AuthenticationCapture | undefined
  private removeNavigationListeners: (() => void) | undefined
  private generation = 0
  private disposed = false
  private lifecycleTail: Promise<void> = Promise.resolve()
  private readonly listeners = new Set<(snapshot: SsoAuthSnapshot) => void>()
  private readonly createWindow: () => AuthenticationWindow
  private readonly createCapture: (window: AuthenticationWindow, configuration: SsoConfiguration) => AuthenticationCapture

  constructor(private readonly configService: ConfigPort, options: SsoAuthenticationServiceOptions = {}) {
    this.createWindow = options.createWindow ?? createDefaultAuthenticationWindow
    this.createCapture = options.createCapture ?? ((window, configuration) => new SsoResponseCapture(window, configuration))
  }

  initialize(): Promise<SsoAuthSnapshot> {
    this.disposed = false
    return this.enqueueLifecycle(async () => {
      const configuration = await this.configService.get()
      this.configuration = configuration
      await this.cancelCurrentSession()
      return this.applyConfigurationState(configuration)
    })
  }

  attachRenderer(sender: WebContents): void {
    this.renderer = sender
    this.publish(this.snapshot)
  }

  getState(): SsoAuthSnapshot {
    return cloneSnapshot(this.snapshot)
  }

  saveConfiguration(input: SsoConfiguration, intent: SsoSaveIntent = 'draft'): Promise<SsoAuthSnapshot> {
    const configuration = ssoConfigurationSchema.parse(input)
    const saveIntent = ssoSaveIntentSchema.parse(intent)
    const previousSnapshot = this.getState()
    if (saveIntent === 'workbench' && configuration.enabled) throw new Error('SSO configuration must be disabled to enter the workbench')
    if (saveIntent === 'continue' && (!configuration.enabled || !this.configService.isComplete(configuration))) {
      throw new Error('SSO configuration is incomplete')
    }
    this.disposed = false
    // Reserve the next generation immediately, before persistence or queued
    // cleanup can yield, so the old capture can no longer publish identity.
    this.generation++
    const cancellation = this.cancelCurrentSession()
    return this.enqueueLifecycle(async () => {
      await cancellation
      const saved = await this.configService.save(configuration)
      this.configuration = saved
      if (saveIntent === 'draft') return this.applyDraftState(previousSnapshot, saved)
      if (saveIntent === 'workbench') {
        return this.applyConfigurationState(saved)
      }
      await this.startAuthentication(saved, false)
      return this.getState()
    })
  }

  retry(): Promise<void> {
    this.disposed = false
    return this.enqueueLifecycle(() => this.retryExclusive())
  }

  private async retryExclusive(): Promise<void> {
    const configuration = this.configuration ?? await this.configService.get()
    this.configuration = configuration
    if (!this.configService.isComplete(configuration)) {
      this.applyConfigurationState(configuration)
      return
    }
    if (!configuration.enabled) {
      if (this.snapshot.state === 'login-required' || this.snapshot.state === 'authenticating' || this.snapshot.state === 'error') {
        this.setSnapshot({ state: 'configuration-required' })
      } else {
        this.applyConfigurationState(configuration)
      }
      return
    }

    await this.startAuthentication(configuration, true)
  }

  private async startAuthentication(configuration: SsoConfiguration, publishLoginRequired: boolean): Promise<void> {
    await this.cancelCurrentSession()
    this.generation++
    if (publishLoginRequired) this.setSnapshot({ state: 'login-required' })
    const generation = ++this.generation
    this.setSnapshot({ state: 'authenticating' })
    const window = this.createWindow()
    const capture = this.createCapture(window, configuration)
    this.authWindow = window
    this.capture = capture

    const notifyNavigation = (url: unknown): void => {
      if (generation !== this.generation) return
      if (typeof url !== 'string') return
      capture.notifyNavigation(url)
    }
    const onDidNavigate = (_event: unknown, url: unknown): void => { notifyNavigation(url) }
    const onDidNavigateInPage = (_event: unknown, url: unknown, isMainFrame: unknown): void => {
      if (isMainFrame === true) notifyNavigation(url)
    }
    const onWillNavigate = (details: unknown, legacyUrl: unknown, _isInPlace: unknown, legacyIsMainFrame: unknown): void => {
      const current = navigationDetails(details)
      if (current) {
        if (current.isMainFrame) notifyNavigation(current.url)
        return
      }
      if (legacyIsMainFrame === true) notifyNavigation(legacyUrl)
    }
    const onDidFrameNavigate = (_event: unknown, url: unknown, _status: unknown, _statusText: unknown, isMainFrame: unknown): void => {
      if (isMainFrame === true) notifyNavigation(url)
    }
    window.webContents.on('did-navigate', onDidNavigate)
    window.webContents.on('did-navigate-in-page', onDidNavigateInPage)
    window.webContents.on('will-navigate', onWillNavigate)
    window.webContents.on('did-frame-navigate', onDidFrameNavigate)
    let windowClosed = false
    const onClose = (): void => {
      windowClosed = true
    }
    const onClosed = (): void => {
      windowClosed = true
      if (generation !== this.generation || this.capture !== capture) return
      void this.failSession(generation, 'SSO sign-in window closed')
    }
    window.on('close', onClose)
    window.on('closed', onClosed)
    this.removeNavigationListeners = () => {
      window.webContents.removeListener?.('did-navigate', onDidNavigate)
      window.webContents.removeListener?.('did-navigate-in-page', onDidNavigateInPage)
      window.webContents.removeListener?.('will-navigate', onWillNavigate)
      window.webContents.removeListener?.('did-frame-navigate', onDidFrameNavigate)
      window.removeListener('close', onClose)
      window.removeListener('closed', onClosed)
    }

    try {
      // Electron does not settle Network.enable for a brand-new WebContents
      // until it has a navigation target. Prime only a local document first,
      // then preserve the capture readiness barrier before remote navigation.
      await window.loadURL('about:blank')
      if (!this.isCurrentSession(generation, capture, window)) return

      const identityPromise = capture.start()
      void identityPromise
        .then(
          identity => this.completeSession(generation, identity),
          error => this.failSession(generation, safeCaptureError(error)),
        )
        .catch(() => this.failSession(generation, 'Unable to complete SSO sign-in'))
        .catch(() => undefined)

      await capture.ready()
      if (!this.isCurrentSession(generation, capture, window)) return
      await window.loadURL(configuration.loginPageUrl)
    } catch (error) {
      await this.failSession(generation, windowClosed || isWindowDestroyed(window) ? 'SSO sign-in window closed' : safeCaptureError(error))
    }
  }

  onState(listener: (snapshot: SsoAuthSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  dispose(): Promise<void> {
    if (this.disposed) return this.lifecycleTail
    this.disposed = true
    this.generation++
    this.renderer = undefined
    this.listeners.clear()
    if (this.snapshot.state === 'authenticating') {
      this.snapshot = configurationSnapshot(this.configService, this.configuration)
    }
    const cancellation = this.cancelCurrentSession()
    return this.enqueueLifecycle(() => cancellation)
  }

  private applyConfigurationState(configuration: SsoConfiguration): SsoAuthSnapshot {
    this.snapshot = configurationSnapshot(this.configService, configuration)
    this.publish(this.snapshot)
    return this.getState()
  }

  private setSnapshot(snapshot: SsoAuthSnapshot): void {
    this.snapshot = ssoAuthSnapshotSchema.parse(snapshot)
    this.publish(this.snapshot)
  }

  private publish(snapshot: SsoAuthSnapshot): void {
    const safe = cloneSnapshot(snapshot)
    for (const listener of this.listeners) listener(safe)
    const renderer = this.renderer
    if (!renderer || renderer.isDestroyed?.()) return
    renderer.send('sso:state', safe)
  }

  private async completeSession(generation: number, identity: SsoIdentity): Promise<void> {
    if (generation !== this.generation || !this.capture) return
    const parsed = ssoIdentitySchema.safeParse(identity)
    if (!parsed.success) {
      await this.failSession(generation, 'Unable to complete SSO sign-in')
      return
    }
    this.setSnapshot({ state: 'authenticated', identity: parsed.data })
    await this.finishSession(generation)
  }

  private async failSession(generation: number, message: string): Promise<void> {
    if (generation !== this.generation || !this.capture) return
    this.setSnapshot({ state: 'error', errorMessage: safeCaptureError(message) })
    await this.finishSession(generation)
  }

  private isCurrentSession(generation: number, capture: AuthenticationCapture, window: AuthenticationWindow): boolean {
    return generation === this.generation
      && this.capture === capture
      && this.authWindow === window
      && !isWindowDestroyed(window)
  }

  private async cancelCurrentSession(): Promise<void> {
    const capture = this.capture
    const window = this.authWindow
    if (!capture && !window) return
    this.generation++
    this.removeNavigationListeners?.()
    this.removeNavigationListeners = undefined
    await capture?.dispose().catch(() => undefined)
    await closeWindow(window)
    if (this.capture === capture) this.capture = undefined
    if (this.authWindow === window) this.authWindow = undefined
  }

  private async finishSession(generation: number): Promise<void> {
    if (generation !== this.generation) return
    this.generation++
    const capture = this.capture
    const window = this.authWindow
    this.removeNavigationListeners?.()
    this.removeNavigationListeners = undefined
    await capture?.dispose().catch(() => undefined)
    await closeWindow(window)
    if (this.capture === capture) this.capture = undefined
    if (this.authWindow === window) this.authWindow = undefined
  }

  private applyDraftState(previousSnapshot: SsoAuthSnapshot, configuration: SsoConfiguration): SsoAuthSnapshot {
    if (previousSnapshot.state === 'login-required' || previousSnapshot.state === 'error') {
      this.setSnapshot(previousSnapshot)
      return this.getState()
    }
    if (previousSnapshot.state === 'authenticating') {
      this.setSnapshot({ state: 'error', errorMessage: 'SSO sign-in cancelled' })
      return this.getState()
    }
    if (previousSnapshot.state === 'login-disabled' && !configuration.enabled) {
      this.setSnapshot({ state: 'login-disabled' })
      return this.getState()
    }
    this.setSnapshot({ state: 'configuration-required' })
    return this.getState()
  }

  private enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycleTail.then(operation, operation)
    this.lifecycleTail = result.then(() => undefined, () => undefined)
    return result
  }
}

function createDefaultAuthenticationWindow(): AuthenticationWindow {
  const partition = `sso-auth-${randomUUID()}`
  return new BrowserWindow({
    width: 900,
    height: 700,
    show: true,
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  }) as unknown as AuthenticationWindow
}

async function closeWindow(window: AuthenticationWindow | undefined): Promise<void> {
  if (!window || isWindowDestroyed(window)) return
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const settle = (): void => {
      if (settled) return
      settled = true
      window.removeListener('closed', onClosed)
      resolve()
    }
    const onClosed = (): void => settle()
    window.on('closed', onClosed)
    try { window.close() } catch { /* fall through to forceful destruction */ }
    if (isWindowDestroyed(window)) { settle(); return }
    try { window.destroy() } catch { /* verify below before releasing ownership */ }
    if (isWindowDestroyed(window)) { settle(); return }
    window.removeListener('closed', onClosed)
    reject(new Error('Unable to destroy SSO sign-in window'))
  })
}

function isWindowDestroyed(window: AuthenticationWindow): boolean {
  return window.isDestroyed?.() === true
}

function cloneSnapshot(snapshot: SsoAuthSnapshot): SsoAuthSnapshot {
  return ssoAuthSnapshotSchema.parse({
    state: snapshot.state,
    ...(snapshot.identity ? { identity: { ...snapshot.identity } } : {}),
    ...(snapshot.errorMessage ? { errorMessage: snapshot.errorMessage } : {}),
  })
}

function safeCaptureError(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return SAFE_CAPTURE_ERRORS.has(message) ? message : 'Unable to complete SSO sign-in'
}

function configurationSnapshot(configService: Pick<ConfigPort, 'isComplete'>, configuration: SsoConfiguration | undefined): SsoAuthSnapshot {
  if (!configuration) return { state: 'configuration-required' }
  if (!configuration.enabled) return { state: 'login-disabled' }
  if (!configService.isComplete(configuration)) return { state: 'configuration-required' }
  return { state: 'login-required' }
}

function navigationDetails(value: unknown): { url: string; isMainFrame: boolean } | undefined {
  if (!value || typeof value !== 'object') return undefined
  const details = value as { url?: unknown; isMainFrame?: unknown }
  if (typeof details.url !== 'string' || typeof details.isMainFrame !== 'boolean') return undefined
  return { url: details.url, isMainFrame: details.isMainFrame }
}
