import type { SsoConfiguration, SsoIdentity } from '../../shared/sso-contracts'
import { readSsoField } from './sso-field-path'
import { matchesSsoUrl } from './sso-url-matcher'

type CdpDebugger = {
  attach(protocolVersion?: string): void
  detach(): void
  send(command: string, parameters?: Record<string, unknown>): Promise<unknown>
  on(event: 'message' | 'detach', listener: (...args: unknown[]) => void): unknown
  removeListener(event: 'message' | 'detach', listener: (...args: unknown[]) => void): unknown
}

type AuthenticationWindow = {
  webContents: { debugger: CdpDebugger }
  on(event: 'closed', listener: () => void): unknown
  removeListener(event: 'closed', listener: () => void): unknown
}

type CaptureOptions = {
  timeoutMs?: number
  maxBodyBytes?: number
}

type ResponseBody = {
  body: string
  base64Encoded: boolean
}

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_MAX_BODY_BYTES = 1_048_576

export class SsoResponseCapture {
  private readonly debugger: CdpDebugger
  private readonly timeoutMs: number
  private readonly maxBodyBytes: number
  private readonly pendingRequestIds = new Set<string>()
  private active = false
  private debuggerAttached = false
  private platformNavigationObserved = false
  private capturedIdentity: SsoIdentity | undefined
  private timeout: ReturnType<typeof setTimeout> | undefined
  private result: Promise<SsoIdentity> | undefined
  private readiness: Promise<void> | undefined
  private resolveReadiness: (() => void) | undefined
  private rejectReadiness: ((reason: Error) => void) | undefined
  private readinessSettled = false
  private resolveResult: ((identity: SsoIdentity) => void) | undefined
  private rejectResult: ((reason: Error) => void) | undefined

  constructor(
    private readonly window: AuthenticationWindow,
    private readonly configuration: SsoConfiguration,
    options: CaptureOptions = {},
  ) {
    this.debugger = window.webContents.debugger
    this.timeoutMs = positiveLimit(options.timeoutMs, DEFAULT_TIMEOUT_MS)
    this.maxBodyBytes = positiveLimit(options.maxBodyBytes, DEFAULT_MAX_BODY_BYTES)
  }

  start(): Promise<SsoIdentity> {
    if (this.result) return this.result

    this.active = true
    this.result = new Promise<SsoIdentity>((resolve, reject) => {
      this.resolveResult = resolve
      this.rejectResult = reject
    })
    void this.result.catch(() => undefined)
    this.readiness = new Promise<void>((resolve, reject) => {
      this.resolveReadiness = resolve
      this.rejectReadiness = reject
    })
    void this.readiness.catch(() => undefined)

    try {
      this.debugger.attach('1.3')
      this.debuggerAttached = true
      this.addListeners()
    } catch {
      void this.fail('Unable to start SSO sign-in')
      return this.result
    }

    void this.enableNetwork()
    return this.result
  }

  ready(): Promise<void> {
    return this.readiness ?? Promise.reject(new Error('SSO sign-in has not started'))
  }

  notifyNavigation(url: string): void {
    if (!this.active || this.platformNavigationObserved) return
    try {
      if (!matchesSsoUrl(this.configuration.platformUrlMatcher, url)) return
    } catch {
      void this.fail('Unable to continue SSO sign-in')
      return
    }

    this.platformNavigationObserved = true
    this.timeout = setTimeout(() => void this.fail('SSO sign-in timed out'), this.timeoutMs)
    if (this.capturedIdentity) void this.succeed(this.capturedIdentity)
  }

  async dispose(): Promise<void> {
    if (!this.active) return
    await this.fail('SSO sign-in cancelled')
  }

  private async enableNetwork(): Promise<void> {
    try {
      await this.debugger.send('Network.enable')
      this.settleReadiness()
    } catch {
      const error = new Error('Unable to start SSO sign-in')
      this.settleReadiness(error)
      await this.fail(error.message)
    }
  }

  private addListeners(): void {
    this.debugger.on('message', this.onDebuggerMessage)
    this.debugger.on('detach', this.onDebuggerDetach)
    this.window.on('closed', this.onWindowClosed)
  }

  private readonly onDebuggerMessage = (_event: unknown, method: unknown, parameters: unknown): void => {
    if (!this.active || typeof method !== 'string' || !isRecord(parameters)) return
    if (method === 'Network.responseReceived') this.recordResponse(parameters)
    if (method === 'Network.loadingFinished') this.readFinishedResponse(parameters)
  }

  private recordResponse(parameters: Record<string, unknown>): void {
    const requestId = parameters.requestId
    const response = parameters.response
    if (typeof requestId !== 'string' || !isRecord(response)) return
    if (typeof response.url !== 'string' || typeof response.status !== 'number' || response.status < 200 || response.status >= 300) return

    try {
      if (matchesSsoUrl(this.configuration.userInfoUrlMatcher, response.url)) this.pendingRequestIds.add(requestId)
    } catch {
      void this.fail('Unable to continue SSO sign-in')
    }
  }

  private readFinishedResponse(parameters: Record<string, unknown>): void {
    const requestId = parameters.requestId
    if (typeof requestId !== 'string' || !this.pendingRequestIds.delete(requestId)) return
    void this.readResponseBody(requestId)
  }

  private async readResponseBody(requestId: string): Promise<void> {
    let response: unknown
    try {
      response = await this.debugger.send('Network.getResponseBody', { requestId })
    } catch {
      return
    }

    if (!this.active || !isResponseBody(response)) return
    const body = decodeBody(response)
    if (!body || Buffer.byteLength(body, 'utf8') > this.maxBodyBytes) return

    let payload: unknown
    try {
      payload = JSON.parse(body)
    } catch {
      return
    }

    let name: string | undefined
    let employeeId: string | undefined
    try {
      name = readSsoField(payload, this.configuration.nameField)
      employeeId = readSsoField(payload, this.configuration.employeeIdField)
    } catch {
      return
    }
    if (!name || !employeeId) return
    this.capturedIdentity = { name, employeeId }
    if (this.platformNavigationObserved) await this.succeed(this.capturedIdentity)
  }

  private readonly onWindowClosed = (): void => {
    void this.fail('SSO sign-in window closed')
  }

  private readonly onDebuggerDetach = (): void => {
    this.debuggerAttached = false
    void this.fail('SSO sign-in connection closed')
  }

  private async succeed(identity: SsoIdentity): Promise<void> {
    if (!this.active) return
    this.settleReadiness()
    await this.cleanup()
    this.resolveResult?.(identity)
  }

  private async fail(message: string): Promise<void> {
    if (!this.active) return
    this.settleReadiness(new Error(message))
    await this.cleanup()
    this.rejectResult?.(new Error(message))
  }

  private async cleanup(): Promise<void> {
    if (!this.active) return
    this.active = false
    this.pendingRequestIds.clear()
    this.capturedIdentity = undefined
    if (this.timeout) clearTimeout(this.timeout)
    this.timeout = undefined
    this.debugger.removeListener('message', this.onDebuggerMessage)
    this.debugger.removeListener('detach', this.onDebuggerDetach)
    this.window.removeListener('closed', this.onWindowClosed)

    if (!this.debuggerAttached) return
    this.debuggerAttached = false
    try {
      await this.debugger.send('Network.disable')
    } catch {
      // Cleanup deliberately hides CDP protocol details from the user.
    }
    try {
      this.debugger.detach()
    } catch {
      // A detached debugger needs no further action.
    }
  }

  private settleReadiness(error?: Error): void {
    if (this.readinessSettled) return
    this.readinessSettled = true
    if (error) {
      this.rejectReadiness?.(error)
      return
    }
    this.resolveReadiness?.()
  }
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isResponseBody(value: unknown): value is ResponseBody {
  return isRecord(value) && typeof value.body === 'string' && typeof value.base64Encoded === 'boolean'
}

function decodeBody(response: ResponseBody): string | undefined {
  try {
    return response.base64Encoded ? Buffer.from(response.body, 'base64').toString('utf8') : response.body
  } catch {
    return undefined
  }
}
