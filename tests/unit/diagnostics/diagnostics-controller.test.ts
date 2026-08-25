import { describe, expect, it, vi } from 'vitest'
import { DiagnosticsController, nodeInspectorFrontendUrl, publicDiagnosticsError } from '../../../src/main/diagnostics/diagnostics-controller'

type Listener = () => void

function createFixture(options: { inspectorUrls?: Array<string | undefined> } = {}) {
  const listeners = new Map<string, Listener>()
  const window = {
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    focus: vi.fn(),
    show: vi.fn(),
    close: vi.fn(),
    loadURL: vi.fn().mockResolvedValue(undefined),
    on: vi.fn((event: string, listener: Listener) => { listeners.set(event, listener) }),
    emitClosed: () => listeners.get('closed')?.(),
  }
  const renderer = {
    isDestroyed: vi.fn(() => false),
    isDevToolsOpened: vi.fn(() => false),
    openDevTools: vi.fn(),
    devToolsWebContents: { focus: vi.fn() },
  }
  const inspectorUrls = [...(options.inspectorUrls ?? [])]
  const inspector = {
    url: vi.fn(() => inspectorUrls.shift()),
    open: vi.fn(),
    close: vi.fn(),
  }
  const createWindow = vi.fn(() => window)
  return {
    controller: new DiagnosticsController(renderer, { inspector, createWindow }),
    renderer,
    inspector,
    createWindow,
    window,
  }
}

describe('DiagnosticsController', () => {
  it('opens detached renderer tools once and focuses the existing tools on repeat', async () => {
    const fixture = createFixture()

    await fixture.controller.openRendererDevTools()
    fixture.renderer.isDevToolsOpened.mockReturnValue(true)
    await fixture.controller.openRendererDevTools()

    expect(fixture.renderer.openDevTools).toHaveBeenCalledOnce()
    expect(fixture.renderer.openDevTools).toHaveBeenCalledWith({ mode: 'detach', activate: true })
    expect(fixture.renderer.devToolsWebContents.focus).toHaveBeenCalledOnce()
  })

  it('starts an owned loopback inspector and attaches one reusable Electron window', async () => {
    const fixture = createFixture({ inspectorUrls: [undefined, 'ws://127.0.0.1:43123/target-id'] })

    await fixture.controller.openNodeInspector()
    await fixture.controller.openNodeInspector()

    expect(fixture.inspector.open).toHaveBeenCalledWith(0, '127.0.0.1', false)
    expect(fixture.createWindow).toHaveBeenCalledOnce()
    expect(fixture.window.loadURL).toHaveBeenCalledWith(
      'devtools://devtools/bundled/js_app.html?experiments=true&v8only=true&ws=127.0.0.1%3A43123%2Ftarget-id',
    )
    expect(fixture.window.show).toHaveBeenCalledTimes(2)
    expect(fixture.window.focus).toHaveBeenCalledTimes(2)
  })

  it('keeps an externally owned inspector running and closes one it started', async () => {
    const owned = createFixture({ inspectorUrls: [undefined, 'ws://127.0.0.1:43123/target-id'] })
    await owned.controller.openNodeInspector()
    owned.window.emitClosed()
    owned.controller.dispose()
    expect(owned.inspector.close).toHaveBeenCalledOnce()

    const external = createFixture({ inspectorUrls: ['ws://127.0.0.1:43124/target-id'] })
    await external.controller.openNodeInspector()
    external.window.emitClosed()
    external.controller.dispose()
    expect(external.inspector.open).not.toHaveBeenCalled()
    expect(external.inspector.close).not.toHaveBeenCalled()
  })

  it('restores and focuses a minimized Inspector window instead of creating another', async () => {
    const fixture = createFixture({ inspectorUrls: [undefined, 'ws://127.0.0.1:43123/target-id'] })
    await fixture.controller.openNodeInspector()
    fixture.window.isMinimized.mockReturnValue(true)

    await fixture.controller.openNodeInspector()

    expect(fixture.createWindow).toHaveBeenCalledOnce()
    expect(fixture.window.restore).toHaveBeenCalledOnce()
    expect(fixture.window.focus).toHaveBeenCalledTimes(2)
  })

  it('rejects non-loopback targets without opening a window', async () => {
    const fixture = createFixture({ inspectorUrls: ['ws://0.0.0.0:43123/target-id'] })

    await expect(fixture.controller.openNodeInspector()).rejects.toThrow('Node Inspector 只允许连接当前应用的本机回环地址。')
    expect(fixture.createWindow).not.toHaveBeenCalled()
  })

  it('formats only a valid loopback WebSocket target for the bundled inspector frontend', () => {
    expect(nodeInspectorFrontendUrl('ws://127.0.0.1:9229/a/b')).toBe(
      'devtools://devtools/bundled/js_app.html?experiments=true&v8only=true&ws=127.0.0.1%3A9229%2Fa%2Fb',
    )
    expect(() => nodeInspectorFrontendUrl('wss://127.0.0.1:9229/a')).toThrow('Node Inspector 只允许连接当前应用的本机回环地址。')
    expect(() => nodeInspectorFrontendUrl('ws://localhost:9229/a')).toThrow('Node Inspector 只允许连接当前应用的本机回环地址。')
  })

  it('maps implementation failures to stable public diagnostics text', () => {
    expect(publicDiagnosticsError(new Error('details that must not reach renderer'))).toBe('无法打开诊断窗口。请关闭后重试。')
  })
})
