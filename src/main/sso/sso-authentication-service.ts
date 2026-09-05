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
import { matchesSsoUrl } from './sso-url-matcher'

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
  /** Show the user-facing login page after it has finished loading. */
  show?(): void
  /** Remove the remote login page once platform navigation is observed. */
  hide?(): void
  focus?(): void
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
      await this.startAuthentication(saved)
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

    await this.startAuthentication(configuration)
  }

  private async startAuthentication(configuration: SsoConfiguration): Promise<void> {
    await this.cancelCurrentSession()
    this.generation++
    // Keep the local renderer on an actionable login state while the identity
    // provider page is visible. Progress is published only after a committed
    // platform navigation (see notifyNavigation below).
    this.setSnapshot({ state: 'login-required' })
    const generation = ++this.generation
    const window = this.createWindow()
    const capture = this.createCapture(window, configuration)
    this.authWindow = window
    this.capture = capture

    const notifyNavigation = (url: unknown): void => {
      if (generation !== this.generation) return
      if (typeof url !== 'string') return

      // Keep the local renderer on the actionable login surface while the
      // identity provider is displayed.  Only a committed main-frame URL that
      // matches the configured platform route is evidence that the user has
      // finished signing in; at that point switch to the local progress state
      // and get the remote window out of the way before continuing capture.
      let platformNavigation = false
      try {
        platformNavigation = matchesSsoUrl(configuration.platformUrlMatcher, url)
      } catch {
        // The capture owns matcher validation/error publication.  Do not let a
        // malformed runtime candidate prevent it from reporting the bounded
        // failure through its normal path.
      }
      if (platformNavigation && this.snapshot.state === 'login-required') {
        this.setSnapshot({ state: 'authenticating' })
        // A committed navigation can race with BrowserWindow destruction.
        // Hiding an already-destroyed window is best-effort; it must not stop
        // the URL from reaching the response capture.
        try { window.hide?.() } catch { /* window was destroyed */ }
      }
      capture.notifyNavigation(url)
    }
    const onDidNavigate = (_event: unknown, url: unknown): void => { notifyNavigation(url) }
    const onDidNavigateInPage = (_event: unknown, url: unknown, isMainFrame: unknown): void => {
      if (isMainFrame === true) notifyNavigation(url)
    }
    // `will-navigate` fires before a navigation commits and is therefore not
    // authentication evidence. Keep the listener for lifecycle compatibility,
    // but deliberately ignore both modern details and legacy positional args.
    const onWillNavigate = (): void => {}
    const onDidFrameNavigate = (_event: unknown, url: unknown, _status: unknown, _statusText: unknown, isMainFrame: unknown): void => {
      if (isMainFrame === true) notifyNavigation(url)
    }
    window.webContents.on('did-navigate', onDidNavigate)
    window.webContents.on('did-navigate-in-page', onDidNavigateInPage)
    window.webContents.on('will-navigate', onWillNavigate)
    window.webContents.on('did-frame-navigate', onDidFrameNavigate)
    let windowClosed = false
    let resolveCloseSignal!: () => void
    const closeSignal = new Promise<void>(resolve => { resolveCloseSignal = resolve })
    const onClose = (): void => {
      windowClosed = true
      resolveCloseSignal()
    }
    const onClosed = (): void => {
      windowClosed = true
      resolveCloseSignal()
      if (generation !== this.generation || this.capture !== capture) return
      void this.failSession(generation, 'SSO sign-in window closed').catch(() => undefined)
    }
    window.on('close', onClose)
    window.on('closed', onClosed)
    this.removeNavigationListeners = () => {
      resolveCloseSignal()
      // Electron may invalidate the WebContents proxy before the BrowserWindow
      // `closed` callback runs. Listener cleanup is best-effort in that state.
      try {
        window.webContents.removeListener?.('did-navigate', onDidNavigate)
        window.webContents.removeListener?.('did-navigate-in-page', onDidNavigateInPage)
        window.webContents.removeListener?.('will-navigate', onWillNavigate)
        window.webContents.removeListener?.('did-frame-navigate', onDidFrameNavigate)
      } catch {
        // A destroyed WebContents has no listeners that need removal.
      }
      try { window.removeListener('close', onClose) } catch { /* already destroyed */ }
      try { window.removeListener('closed', onClosed) } catch { /* already destroyed */ }
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
          error => this.arbitrateCaptureFailure(generation, error, window, closeSignal, () => windowClosed),
        )
        .catch(() => this.failSession(generation, 'Unable to complete SSO sign-in'))
        .catch(() => undefined)

      await capture.ready()
      if (!this.isCurrentSession(generation, capture, window)) return
      await window.loadURL(configuration.loginPageUrl)
      if (!this.isCurrentSession(generation, capture, window)) return
      // Keep the blank priming document hidden, then reveal the fully loaded
      // identity-provider page so credentials can be entered without a flash
      // of an empty authentication window.
      if (this.snapshot.state === 'login-required') {
        window.show?.()
        window.focus?.()
      }
    } catch (error) {
      if (!windowClosed && !isWindowDestroyed(window)) await waitForCloseSignal(closeSignal)
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

  /**
   * A Chromium debugger detaches before Electron finishes closing a window.
   * Give the close lifecycle a short chance to win so a user-initiated close
   * is reported as such instead of being exposed as a connection failure.
   */
  private async arbitrateCaptureFailure(
    generation: number,
    error: unknown,
    window: AuthenticationWindow,
    closeSignal: Promise<void>,
    wasWindowClosed: () => boolean,
  ): Promise<void> {
    const message = safeCaptureError(error)
    if (message === 'SSO sign-in connection closed' && !wasWindowClosed() && !isWindowDestroyed(window)) {
      await waitForCloseSignal(closeSignal)
    }
    const closed = wasWindowClosed() || isWindowDestroyed(window)
    await this.failSession(generation, closed ? 'SSO sign-in window closed' : message)
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
    // Start hidden while the local priming document and capture listeners are
    // prepared. The committed identity-provider page is shown after it loads;
    // once platform navigation is observed the window is hidden again while
    // the local renderer displays the bounded "登录进行中" state.
    show: false,
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

async function waitForCloseSignal(closeSignal: Promise<void>): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timeoutSignal = new Promise<void>(resolve => {
    timeout = setTimeout(resolve, 100)
  })
  try {
    await Promise.race([closeSignal, timeoutSignal])
  } finally {
    if (timeout) clearTimeout(timeout)
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
  if (!configuration) return { state: 'configuration-required' }
  if (!configuration.enabled) return { state: 'login-disabled' }
  if (!configService.isComplete(configuration)) return { state: 'configuration-required' }
  return { state: 'login-required' }
}
