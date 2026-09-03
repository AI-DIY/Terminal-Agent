import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SsoResponseCapture } from '../../../src/main/sso/sso-response-capture'
import type { SsoConfiguration } from '../../../src/shared/sso-contracts'

type ResponseBody = { body: string; base64Encoded: boolean }

class FakeDebugger extends EventEmitter {
  readonly attach = vi.fn()
  readonly detach = vi.fn()
  readonly send = vi.fn(async (command: string, parameters?: { requestId?: string }): Promise<ResponseBody | undefined> => {
    if (command === 'Network.getResponseBody') return this.bodies.get(parameters?.requestId ?? '')
    return undefined
  })
  readonly bodies = new Map<string, ResponseBody>()
  attached = false

  constructor() {
    super()
    this.attach.mockImplementation(() => { this.attached = true })
    this.detach.mockImplementation(() => { this.attached = false })
  }
}

class FakeAuthWindow extends EventEmitter {
  readonly debugger = new FakeDebugger()
  readonly webContents = { debugger: this.debugger }

  navigation(url: string): void {
    this.emit('navigation', url)
  }

  response(requestId: string, url: string, status = 200): void {
    this.debugger.emit('message', {}, 'Network.responseReceived', { requestId, response: { url, status } })
  }

  loadingFinished(requestId: string): void {
    this.debugger.emit('message', {}, 'Network.loadingFinished', { requestId })
  }
}

function completeConfig(): SsoConfiguration {
  return {
    enabled: true,
    loginPageUrl: 'https://identity.example/login',
    platformUrlMatcher: { mode: 'exact', value: 'https://platform.example/home' },
    userInfoUrlMatcher: { mode: 'exact', value: 'https://platform.example/api/userinfo' },
    nameField: 'data.em[0].name',
    employeeIdField: 'data.em[0].employeeId',
  }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => vi.useRealTimers())

describe('SsoResponseCapture', () => {
  it('waits for loadingFinished before reading a matching body and resolves after platform navigation', async () => {
    const window = new FakeAuthWindow()
    const capture = new SsoResponseCapture(window, completeConfig())
    const result = capture.start()

    expect(window.debugger.attach).toHaveBeenCalledOnce()
    expect(window.debugger.send).toHaveBeenCalledWith('Network.enable')

    window.response('other', 'https://platform.example/api/other')
    window.response('failed', 'https://platform.example/api/userinfo', 401)
    window.response('r1', 'https://platform.example/api/userinfo')
    expect(window.debugger.send).not.toHaveBeenCalledWith('Network.getResponseBody', { requestId: 'r1' })
    window.loadingFinished('failed')
    expect(window.debugger.send).not.toHaveBeenCalledWith('Network.getResponseBody', { requestId: 'failed' })

    window.debugger.bodies.set('r1', { body: JSON.stringify({ data: { em: [{ name: 'Zhang San', employeeId: 'E-1' }] } }), base64Encoded: false })
    window.loadingFinished('r1')
    await flush()
    expect(window.debugger.send).toHaveBeenCalledWith('Network.getResponseBody', { requestId: 'r1' })

    capture.notifyNavigation('https://platform.example/home?code=secret')
    await expect(result).resolves.toEqual({ name: 'Zhang San', employeeId: 'E-1' })
  })

  it('decodes base64 response bodies and accepts response identity after platform navigation', async () => {
    const window = new FakeAuthWindow()
    const capture = new SsoResponseCapture(window, completeConfig())
    const result = capture.start()
    capture.notifyNavigation('https://platform.example/home')
    window.response('r1', 'https://platform.example/api/userinfo')
    window.debugger.bodies.set('r1', {
      body: Buffer.from(JSON.stringify({ data: { em: [{ name: 'Li Si', employeeId: 'E-2' }] } }), 'utf8').toString('base64'),
      base64Encoded: true,
    })
    window.loadingFinished('r1')

    await expect(result).resolves.toEqual({ name: 'Li Si', employeeId: 'E-2' })
  })

  it('continues after malformed or incomplete matching candidates', async () => {
    const window = new FakeAuthWindow()
    const capture = new SsoResponseCapture(window, completeConfig())
    const result = capture.start()
    capture.notifyNavigation('https://platform.example/home')

    window.response('bad-json', 'https://platform.example/api/userinfo')
    window.debugger.bodies.set('bad-json', { body: '{', base64Encoded: false })
    window.loadingFinished('bad-json')
    await flush()

    window.response('missing-field', 'https://platform.example/api/userinfo')
    window.debugger.bodies.set('missing-field', { body: JSON.stringify({ data: { em: [{ name: 'Only Name' }] } }), base64Encoded: false })
    window.loadingFinished('missing-field')
    await flush()

    window.response('valid', 'https://platform.example/api/userinfo')
    window.debugger.bodies.set('valid', { body: JSON.stringify({ data: { em: [{ name: 'Final Name', employeeId: 'E-3' }] } }), base64Encoded: false })
    window.loadingFinished('valid')

    await expect(result).resolves.toEqual({ name: 'Final Name', employeeId: 'E-3' })
  })

  it('discards bodies above the configured byte limit and keeps waiting', async () => {
    const window = new FakeAuthWindow()
    const capture = new SsoResponseCapture(window, completeConfig(), { maxBodyBytes: 63 })
    const result = capture.start()
    capture.notifyNavigation('https://platform.example/home')

    window.response('too-large', 'https://platform.example/api/userinfo')
    window.debugger.bodies.set('too-large', { body: JSON.stringify({ data: { em: [{ name: 'A very long name', employeeId: 'E-4' }] } }), base64Encoded: false })
    window.loadingFinished('too-large')
    await flush()

    window.response('valid', 'https://platform.example/api/userinfo')
    window.debugger.bodies.set('valid', { body: JSON.stringify({ data: { em: [{ name: 'Ok', employeeId: 'E-4' }] } }), base64Encoded: false })
    window.loadingFinished('valid')

    await expect(result).resolves.toEqual({ name: 'Ok', employeeId: 'E-4' })
  })

  it('rejects with a safe timeout and cleans up once after platform navigation', async () => {
    vi.useFakeTimers()
    const window = new FakeAuthWindow()
    const capture = new SsoResponseCapture(window, completeConfig(), { timeoutMs: 100 })
    const result = capture.start()

    await vi.advanceTimersByTimeAsync(1_000)
    expect(window.debugger.detach).not.toHaveBeenCalled()

    capture.notifyNavigation('https://platform.example/home?token=secret')
    const rejection = expect(result).rejects.toThrow('SSO sign-in timed out')
    await vi.advanceTimersByTimeAsync(100)
    await rejection
    expect(window.debugger.send).toHaveBeenCalledWith('Network.disable')
    expect(window.debugger.detach).toHaveBeenCalledOnce()
    await capture.dispose()
    expect(window.debugger.detach).toHaveBeenCalledOnce()
  })

  it('rejects safely and cleans up when the window closes or the debugger detaches', async () => {
    const closedWindow = new FakeAuthWindow()
    const closedCapture = new SsoResponseCapture(closedWindow, completeConfig())
    const closedResult = closedCapture.start()
    closedWindow.emit('closed')
    await expect(closedResult).rejects.toThrow('SSO sign-in window closed')
    expect(closedWindow.debugger.detach).toHaveBeenCalledOnce()

    const detachedWindow = new FakeAuthWindow()
    const detachedCapture = new SsoResponseCapture(detachedWindow, completeConfig())
    const detachedResult = detachedCapture.start()
    detachedWindow.debugger.emit('detach', {}, 'target closed')
    await expect(detachedResult).rejects.toThrow('SSO sign-in connection closed')
    expect(detachedWindow.debugger.detach).not.toHaveBeenCalled()
    await detachedCapture.dispose()
    expect(detachedWindow.debugger.detach).not.toHaveBeenCalled()
  })

  it('hides debugger command failures and cleans up the attached debugger', async () => {
    const window = new FakeAuthWindow()
    window.debugger.send.mockImplementation(async (command: string) => {
      if (command === 'Network.enable') throw new Error('raw protocol details')
      return undefined
    })
    const capture = new SsoResponseCapture(window, completeConfig())
    const result = capture.start()

    await expect(result).rejects.toThrow('Unable to start SSO sign-in')
    expect(window.debugger.send).toHaveBeenCalledWith('Network.disable')
    expect(window.debugger.detach).toHaveBeenCalledOnce()
  })

  it('does not report readiness until Network.enable completes', async () => {
    let releaseEnable: (() => void) | undefined
    const enableDone = new Promise<void>(resolve => { releaseEnable = resolve })
    const window = new FakeAuthWindow()
    window.debugger.send.mockImplementation(async (command: string, parameters?: { requestId?: string }) => {
      if (command === 'Network.enable') await enableDone
      if (command === 'Network.getResponseBody') return window.debugger.bodies.get(parameters?.requestId ?? '')
      return undefined
    })
    const capture = new SsoResponseCapture(window, completeConfig())
    capture.start()
    let ready = false
    const readiness = capture.ready().then(() => { ready = true })
    await flush()
    expect(ready).toBe(false)
    releaseEnable?.()
    await expect(readiness).resolves.toBeUndefined()
    await capture.dispose()
  })

  it('discards candidates with malformed configured field paths without unhandled rejection', async () => {
    const window = new FakeAuthWindow()
    const configuration = { ...completeConfig(), nameField: 'data..name' }
    const capture = new SsoResponseCapture(window, configuration)
    const result = capture.start()
    capture.notifyNavigation('https://platform.example/home')
    window.response('bad-fields', 'https://platform.example/api/userinfo')
    window.debugger.bodies.set('bad-fields', { body: JSON.stringify({ data: { em: [{ name: 'Ignored', employeeId: 'E-5' }] } }), base64Encoded: false })
    window.loadingFinished('bad-fields')
    await flush()
    await capture.dispose()
    await expect(result).rejects.toThrow('SSO sign-in cancelled')
  })

  it('settles an active identity promise when explicitly disposed', async () => {
    const window = new FakeAuthWindow()
    const capture = new SsoResponseCapture(window, completeConfig())
    const result = capture.start()
    await capture.dispose()
    await expect(result).rejects.toThrow('SSO sign-in cancelled')
    await capture.dispose()
  })

  it('rejects readiness when debugger attach fails', async () => {
    const window = new FakeAuthWindow()
    window.debugger.attach.mockImplementation(() => { throw new Error('raw attach details') })
    const capture = new SsoResponseCapture(window, completeConfig())
    capture.start()
    await expect(capture.ready()).rejects.toThrow('Unable to start SSO sign-in')
  })

  it('rejects readiness promptly on disposal while enable is unresolved and ignores late enable completion', async () => {
    let releaseEnable: (() => void) | undefined
    const enableDone = new Promise<void>(resolve => { releaseEnable = resolve })
    const window = new FakeAuthWindow()
    window.debugger.send.mockImplementation(async (command: string, parameters?: { requestId?: string }) => {
      if (command === 'Network.enable') await enableDone
      if (command === 'Network.getResponseBody') return window.debugger.bodies.get(parameters?.requestId ?? '')
      return undefined
    })
    const capture = new SsoResponseCapture(window, completeConfig())
    capture.start()
    const readiness = expect(capture.ready()).rejects.toThrow('SSO sign-in cancelled')
    await capture.dispose()
    await readiness
    releaseEnable?.()
    await flush()
    await expect(capture.ready()).rejects.toThrow('SSO sign-in cancelled')
  })

  it('rejects readiness promptly when the auth window closes during unresolved enable', async () => {
    let releaseEnable: (() => void) | undefined
    const enableDone = new Promise<void>(resolve => { releaseEnable = resolve })
    const window = new FakeAuthWindow()
    window.debugger.send.mockImplementation(async (command: string) => {
      if (command === 'Network.enable') await enableDone
      return undefined
    })
    const capture = new SsoResponseCapture(window, completeConfig())
    const result = capture.start()
    const readiness = expect(capture.ready()).rejects.toThrow('SSO sign-in window closed')
    window.emit('closed')
    await readiness
    await expect(result).rejects.toThrow('SSO sign-in window closed')
    releaseEnable?.()
    await flush()
  })

  it('keeps readiness pending when navigation and identity arrive before Network.enable completes', async () => {
    let releaseEnable: (() => void) | undefined
    const enableDone = new Promise<void>(resolve => { releaseEnable = resolve })
    const window = new FakeAuthWindow()
    window.debugger.send.mockImplementation(async (command: string, parameters?: { requestId?: string }) => {
      if (command === 'Network.enable') await enableDone
      if (command === 'Network.getResponseBody') return window.debugger.bodies.get(parameters?.requestId ?? '')
      return undefined
    })
    const capture = new SsoResponseCapture(window, completeConfig())
    const result = capture.start()
    let ready = false
    const readiness = capture.ready().then(() => { ready = true })
    capture.notifyNavigation('https://platform.example/home')
    window.response('early', 'https://platform.example/api/userinfo')
    window.debugger.bodies.set('early', { body: JSON.stringify({ data: { em: [{ name: 'Early', employeeId: 'E-6' }] } }), base64Encoded: false })
    window.loadingFinished('early')
    await flush()
    expect(ready).toBe(false)
    releaseEnable?.()
    await readiness
    await expect(result).resolves.toEqual({ name: 'Early', employeeId: 'E-6' })
  })
})
