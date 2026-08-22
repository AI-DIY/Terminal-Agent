import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('Terminal-Agent branding', () => {
  it('packages one stripe-free TA mark across native and workbench surfaces', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'))
    const shell = readFileSync(new URL('../../../src/renderer/src/components/workbench/WorkbenchShell.vue', import.meta.url), 'utf8')
    const iconGenerator = readFileSync(new URL('../../../scripts/windows/generate-ta-icon.ps1', import.meta.url), 'utf8')
    const icon = new URL('../../../build-resources/ta-icon.ico', import.meta.url)

    expect(packageJson.version).toBe('1.0.6')
    expect(packageJson.build.win.icon).toBe('build-resources/ta-icon.ico')
    expect(existsSync(icon)).toBe(true)
    expect(readFileSync(icon).subarray(0, 4)).toEqual(Buffer.from([0, 0, 1, 0]))
    expect(shell).toContain('<span class="brand-mark" aria-hidden="true">TA</span>')
    expect(iconGenerator).not.toContain('accentWidth')
    expect(iconGenerator).not.toContain('accentBrush')
    expect(iconGenerator).toContain("[System.Drawing.RectangleF]::new(0, 0, $size, $size)")
    expect(shell).toContain('width: 28px; height: 28px')
    expect(shell).not.toContain('margin: 8px')
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
