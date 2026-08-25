import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('electron startup wiring', () => {
  // This is a BrowserWindow option contract; task 9 verifies packaged Windows frame interactions visually.
  it('configures a hidden title bar overlay without disabling the native frame', () => {
    const source = readFileSync(new URL('../../src/main/main.ts', import.meta.url), 'utf8')

    expect(source).toContain("import { app, BrowserWindow, Menu } from 'electron'")
    expect(source).toContain('Menu.setApplicationMenu(null)')
    expect(source).toContain('autoHideMenuBar: true')
    expect(source).toContain("titleBarStyle: 'hidden'")
    expect(source).toContain('titleBarOverlay: titleBarOverlayForTheme(initialTheme)')
    expect(source).toContain('setTitleBarOverlay(titleBarOverlayForTheme(theme))')
    expect(source).not.toContain('frame: false')
  })

  it('bundles zod into the sandbox preload instead of externalizing it', () => {
    const config = readFileSync(new URL('../../electron.vite.config.ts', import.meta.url), 'utf8')
    expect(config).toContain("externalizeDeps: { exclude: ['zod'] }")
  })

  it('registers IPC handlers before renderer navigation can invoke them', () => {
    const source = readFileSync(new URL('../../src/main/main.ts', import.meta.url), 'utf8')
    const navigation = Math.min(...['loadURL', 'loadFile'].map(method => source.indexOf(`mainWindow.${method}`)).filter(index => index >= 0))
    const workbenchRegistration = source.indexOf('registerWorkbenchSettingsHandlers(')
    expect(workbenchRegistration).toBeGreaterThan(-1)
    expect(navigation).toBeGreaterThan(-1)
    expect(workbenchRegistration).toBeLessThan(navigation)
  })

  it('routes Ctrl+Shift+I through the same detached DevTools controller used by the toolbar', () => {
    const source = readFileSync(new URL('../../src/main/main.ts', import.meta.url), 'utf8')

    expect(source).toContain("import { DiagnosticsController, publicDiagnosticsError } from './diagnostics/diagnostics-controller'")
    expect(source).toContain("import { registerDiagnosticsHandlers } from './diagnostics/register-diagnostics-handlers'")
    expect(source).toContain("rendererWindow.webContents.on('before-input-event', onBeforeInput)")
    expect(source).toContain("input.key.toLowerCase() === 'i'")
    expect(source).toContain('input.control && input.shift && !input.alt && !input.meta')
    expect(source).toContain('event.preventDefault()')
    expect(source).toContain('windowDiagnostics.openRendererDevTools()')
    expect(source).toContain("rendererWindow.webContents.send('diagnostics:error', publicDiagnosticsError(error))")
  })

})
