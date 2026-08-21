import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('Terminal-Agent 1.0.5 branding', () => {
  it('packages a TA application icon and presents the same mark in the workbench header', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'))
    const shell = readFileSync(new URL('../../../src/renderer/src/components/workbench/WorkbenchShell.vue', import.meta.url), 'utf8')
    const icon = new URL('../../../build-resources/ta-icon.ico', import.meta.url)

    expect(packageJson.version).toBe('1.0.5')
    expect(packageJson.build.win.icon).toBe('build-resources/ta-icon.ico')
    expect(existsSync(icon)).toBe(true)
    expect(readFileSync(icon).subarray(0, 4)).toEqual(Buffer.from([0, 0, 1, 0]))
    expect(shell).toContain('<span class="brand-mark" aria-hidden="true">TA</span>')
  })

  it('names the side regions as task history and AI workspace with directional expand actions', () => {
    const shell = readFileSync(new URL('../../../src/renderer/src/components/workbench/WorkbenchShell.vue', import.meta.url), 'utf8')
    const history = readFileSync(new URL('../../../src/renderer/src/components/workbench/WorkbenchSessionSidebar.vue', import.meta.url), 'utf8')

    expect(history).toContain('任务历史')
    expect(shell).toContain('展开任务历史')
    expect(shell).toContain('展开 AI 工作区')
    expect(shell).toContain('<span class="restore-icon" aria-hidden="true">→</span>')
    expect(shell).toContain('<span class="restore-icon" aria-hidden="true">←</span>')
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
