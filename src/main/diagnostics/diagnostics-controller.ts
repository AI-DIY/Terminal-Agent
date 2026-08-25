import { BrowserWindow, type BrowserWindowConstructorOptions } from 'electron'
import * as nodeInspector from 'node:inspector'

type DevToolsContents = {
  focus(): void
}

export type DiagnosticsRenderer = {
  isDestroyed(): boolean
  isDevToolsOpened(): boolean
  openDevTools(options: { mode: 'detach'; activate: boolean }): void
  devToolsWebContents?: DevToolsContents | null
}

export type DiagnosticsWindow = {
  isDestroyed(): boolean
  isMinimized(): boolean
  restore(): void
  focus(): void
  show(): void
  close(): void
  loadURL(url: string): Promise<void>
  on(event: 'closed', listener: () => void): void
}

export type DiagnosticsControllerAdapters = {
  inspector?: Pick<typeof nodeInspector, 'url' | 'open' | 'close'>
  createWindow?: (options: BrowserWindowConstructorOptions) => DiagnosticsWindow
}

export class DiagnosticsError extends Error {
  constructor(message = '无法打开诊断窗口。请关闭后重试。', options?: ErrorOptions) {
    super(message, options)
    this.name = 'DiagnosticsError'
  }
}

export function publicDiagnosticsError(error: unknown): string {
  return error instanceof DiagnosticsError ? error.message : '无法打开诊断窗口。请关闭后重试。'
}

export function nodeInspectorFrontendUrl(address: string): string {
  let target: URL
  try {
    target = new URL(address)
  } catch (error) {
    throw new DiagnosticsError('Node Inspector 地址不可用。请关闭后重试。', { cause: error })
  }
  if (target.protocol !== 'ws:' || target.hostname !== '127.0.0.1' || !target.port || !target.pathname.slice(1)) {
    throw new DiagnosticsError('Node Inspector 只允许连接当前应用的本机回环地址。')
  }
  const websocketTarget = `${target.host}${target.pathname}`
  return `devtools://devtools/bundled/js_app.html?experiments=true&v8only=true&ws=${encodeURIComponent(websocketTarget)}`
}

export class DiagnosticsController {
  private readonly inspector: Pick<typeof nodeInspector, 'url' | 'open' | 'close'>
  private readonly createWindow: (options: BrowserWindowConstructorOptions) => DiagnosticsWindow
  private inspectorWindow: DiagnosticsWindow | undefined
  private ownsInspector = false

  constructor(
    private readonly renderer: DiagnosticsRenderer,
    adapters: DiagnosticsControllerAdapters = {},
  ) {
    this.inspector = adapters.inspector ?? nodeInspector
    this.createWindow = adapters.createWindow ?? (options => new BrowserWindow(options))
  }

  async openRendererDevTools(): Promise<void> {
    if (this.renderer.isDestroyed()) throw new DiagnosticsError('渲染进程已关闭，无法打开诊断窗口。')
    if (this.renderer.isDevToolsOpened()) {
      this.renderer.devToolsWebContents?.focus()
      return
    }
    try {
      this.renderer.openDevTools({ mode: 'detach', activate: true })
    } catch (error) {
      throw new DiagnosticsError(undefined, { cause: error })
    }
  }

  async openNodeInspector(): Promise<void> {
    if (this.focusInspectorWindow()) return

    let window: DiagnosticsWindow | undefined
    try {
      let address = this.inspector.url()
      if (!address) {
        this.inspector.open(0, '127.0.0.1', false)
        this.ownsInspector = true
        address = this.inspector.url()
      }
      if (!address) throw new DiagnosticsError('Node Inspector 地址不可用。请关闭后重试。')
      const frontendUrl = nodeInspectorFrontendUrl(address)
      window = this.createWindow({
        width: 1100,
        height: 760,
        minWidth: 800,
        minHeight: 600,
        show: false,
        autoHideMenuBar: true,
        title: 'Terminal-Agent Node Inspector',
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          devTools: false,
        },
      })
      this.inspectorWindow = window
      window.on('closed', () => {
        if (this.inspectorWindow === window) this.inspectorWindow = undefined
        this.closeOwnedInspector()
      })
      await window.loadURL(frontendUrl)
      if (window.isDestroyed()) {
        this.inspectorWindow = undefined
        throw new DiagnosticsError('诊断窗口已关闭，无法继续打开。')
      }
      window.show()
      window.focus()
    } catch (error) {
      if (window && !window.isDestroyed()) window.close()
      if (this.inspectorWindow === window) this.inspectorWindow = undefined
      this.closeOwnedInspector()
      if (error instanceof DiagnosticsError) throw error
      throw new DiagnosticsError(undefined, { cause: error })
    }
  }

  dispose(): void {
    const window = this.inspectorWindow
    this.inspectorWindow = undefined
    if (window && !window.isDestroyed()) window.close()
    this.closeOwnedInspector()
  }

  private focusInspectorWindow(): boolean {
    const window = this.inspectorWindow
    if (!window || window.isDestroyed()) {
      this.inspectorWindow = undefined
      return false
    }
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
    return true
  }

  private closeOwnedInspector(): void {
    if (!this.ownsInspector) return
    this.ownsInspector = false
    try {
      this.inspector.close()
    } catch {
      // Inspector cleanup should never prevent application shutdown.
    }
  }
}
