import { randomUUID } from 'node:crypto'
import { BrowserWindow, type WebContents } from 'electron'
import {
  ssoAuthSnapshotSchema,
  ssoConfigurationSchema,
  type SsoAuthSnapshot,
  type SsoConfiguration,
  type SsoIdentity,
} from '../../shared/sso-contracts'
import type { SsoConfigService } from '../settings/sso-config-service'
import { SsoResponseCapture } from './sso-response-capture'

type ConfigPort = Pick<SsoConfigService, 'get' | 'save' | 'isComplete'>

export type AuthenticationWindow = {
  webContents: {
    debugger: {
      attach(protocolVersion?: string): void
      detach(): void
      send(command: string, parameters?: Record<string, unknown>): Promise<unknown>
      on(event: 'message' | 'detach', listener: (...args: unknown[]) => void): unknown
      removeListener(event: 'message' | 'detach', listener: (...args: unknown[]) => void): unknown
    }
    on(event: string, listener: (...args: unknown[]) => void): unknown
    removeListener?(event: string, listener: (...args: unknown[]) => void): unknown
  }
  loadURL(url: string): Promise<unknown> | unknown
  close(): void
  isDestroyed?(): boolean
  on(event: 'closed', listener: () => void): unknown
  removeListener(event: 'closed', listener: () => void): unknown
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
  private readonly listeners = new Set<(snapshot: SsoAuthSnapshot) => void>()
  private readonly createWindow: () => AuthenticationWindow
  private readonly createCapture: (window: AuthenticationWindow, configuration: SsoConfiguration) => AuthenticationCapture

  constructor(private readonly configService: ConfigPort, options: SsoAuthenticationServiceOptions = {}) {
    this.createWindow = options.createWindow ?? createDefaultAuthenticationWindow
    this.createCapture = options.createCapture ?? ((window, configuration) => new SsoResponseCapture(window, configuration))
  }

  async initialize(): Promise<SsoAuthSnapshot> {
    const configuration = await this.configService.get()
    this.configuration = configuration
    this.disposed = false
    await this.cancelCurrentSession()
    return this.applyConfigurationState(configuration)
  }

  attachRenderer(sender: WebContents): void {
    this.renderer = sender
    this.publish(this.snapshot)
  }

  getState(): SsoAuthSnapshot {
    return cloneSnapshot(this.snapshot)
  }

  async saveConfiguration(input: SsoConfiguration): Promise<SsoAuthSnapshot> {
    const configuration = ssoConfigurationSchema.parse(input)
    this.disposed = false
    await this.cancelCurrentSession()
    const saved = await this.configService.save(configuration)
    this.configuration = saved
    return this.applyConfigurationState(saved)
  }

  async retry(): Promise<void> {
    if (this.disposed) this.disposed = false
    const configuration = this.configuration ?? await this.configService.get()
    this.configuration = configuration
    if (!this.configService.isComplete(configuration)) {
      this.applyConfigurationState(configuration)
      return
    }
    if (!configuration.enabled) {
      this.applyConfigurationState(configuration)
      return
    }

    await this.cancelCurrentSession()
    this.setSnapshot({ state: 'login-required' })
    const generation = ++this.generation
    this.setSnapshot({ state: 'authenticating' })
    const window = this.createWindow()
    const capture = this.createCapture(window, configuration)
    this.authWindow = window
    this.capture = capture

    const notifyNavigation = (_event: unknown, navigation: unknown): void => {
      if (generation !== this.generation) return
      const url = navigationUrl(navigation)
      if (!url) return
      capture.notifyNavigation(url)
    }
    window.webContents.on('did-navigate', notifyNavigation)
    window.webContents.on('did-navigate-in-page', notifyNavigation)
    window.webContents.on('will-navigate', notifyNavigation)
    window.webContents.on('did-frame-navigate', notifyNavigation)
    const onClosed = (): void => {
      if (generation !== this.generation || this.capture !== capture) return
      void this.failSession(generation, 'SSO sign-in window closed')
    }
    window.on('closed', onClosed)
    this.removeNavigationListeners = () => {
      window.webContents.removeListener?.('did-navigate', notifyNavigation)
      window.webContents.removeListener?.('did-navigate-in-page', notifyNavigation)
      window.webContents.removeListener?.('will-navigate', notifyNavigation)
      window.webContents.removeListener?.('did-frame-navigate', notifyNavigation)
      window.removeListener('closed', onClosed)
    }

    const identityPromise = capture.start()
    void identityPromise.then(
      identity => { void this.completeSession(generation, identity) },
      error => { void this.failSession(generation, safeCaptureError(error)) },
    )

    try {
      await capture.ready()
      if (generation !== this.generation || this.capture !== capture) return
      await window.loadURL(configuration.loginPageUrl)
    } catch (error) {
      await this.failSession(generation, safeCaptureError(error))
    }
  }

  onState(listener: (snapshot: SsoAuthSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.generation++
    this.renderer = undefined
    this.listeners.clear()
    if (this.snapshot.state === 'authenticating') {
      this.snapshot = configurationSnapshot(this.configService, this.configuration)
    }
    await this.cancelCurrentSession()
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
    this.setSnapshot({ state: 'authenticated', identity })
    await this.finishSession(generation)
  }

  private async failSession(generation: number, message: string): Promise<void> {
    if (generation !== this.generation || !this.capture) return
    this.setSnapshot({ state: 'error', errorMessage: safeCaptureError(message) })
    await this.finishSession(generation)
  }

  private async cancelCurrentSession(): Promise<void> {
    const capture = this.capture
    const window = this.authWindow
    if (!capture && !window) return
    this.generation++
    this.capture = undefined
    this.authWindow = undefined
    this.removeNavigationListeners?.()
    this.removeNavigationListeners = undefined
    await capture?.dispose().catch(() => undefined)
    closeWindow(window)
  }

  private async finishSession(generation: number): Promise<void> {
    if (generation !== this.generation) return
    const capture = this.capture
    const window = this.authWindow
    this.capture = undefined
    this.authWindow = undefined
    this.removeNavigationListeners?.()
    this.removeNavigationListeners = undefined
    await capture?.dispose().catch(() => undefined)
    closeWindow(window)
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

function closeWindow(window: AuthenticationWindow | undefined): void {
  if (!window) return
  try {
    if (window.isDestroyed?.()) return
    window.close()
  } catch {
    // Window teardown is best effort; capture cleanup remains authoritative.
  }
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
  if (!configuration || !configService.isComplete(configuration)) return { state: 'configuration-required' }
  return { state: configuration.enabled ? 'login-required' : 'login-disabled' }
}

function navigationUrl(navigation: unknown): string | undefined {
  if (typeof navigation === 'string') return navigation
  if (!navigation || typeof navigation !== 'object') return undefined
  const details = navigation as { url?: unknown; isMainFrame?: unknown }
  if (details.isMainFrame === false) return undefined
  return typeof details.url === 'string' ? details.url : undefined
}
