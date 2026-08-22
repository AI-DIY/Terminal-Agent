import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('Terminal-Agent 1.0.6 branding', () => {
  it('packages a TA application icon and presents the same mark in the workbench header', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'))
    const shell = readFileSync(new URL('../../../src/renderer/src/components/workbench/WorkbenchShell.vue', import.meta.url), 'utf8')
    const icon = new URL('../../../build-resources/ta-icon.ico', import.meta.url)

    expect(packageJson.version).toBe('1.0.6')
    expect(packageJson.build.win.icon).toBe('build-resources/ta-icon.ico')
    expect(existsSync(icon)).toBe(true)
    expect(readFileSync(icon).subarray(0, 4)).toEqual(Buffer.from([0, 0, 1, 0]))
    expect(shell).toContain('<span class="brand-mark" aria-hidden="true">TA</span>')
  })

  it('names the V18 side regions as chat sessions and AI chat with directional expand actions', () => {
    const shell = readFileSync(new URL('../../../src/renderer/src/components/workbench/WorkbenchShell.vue', import.meta.url), 'utf8')
    const history = readFileSync(new URL('../../../src/renderer/src/components/workbench/WorkbenchSessionSidebar.vue', import.meta.url), 'utf8')

    expect(history).toContain('聊天会话')
    expect(shell).toContain('展开聊天会话')
    expect(shell).toContain('展开 AI 聊天')
    expect(shell).toContain('PanelLeftOpen')
    expect(shell).toContain('PanelRightOpen')
  })

  it('builds the standalone putty bridge with its C++ runtime linked statically', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'))
    const launcherBuild = packageJson.scripts['build:launcher'] as string

    expect(launcherBuild).toMatch(/(?:^|\s)-static(?:\s|$)/)
    expect(packageJson.build.extraFiles).toContainEqual({
      from: 'build/launcher/putty.exe',
      to: 'putty.exe',
    })
  })
})
