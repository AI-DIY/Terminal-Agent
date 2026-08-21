import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('electron startup wiring', () => {
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
})
