import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('Terminal-Agent branding', () => {
  it('packages one stripe-free TA mark across native and workbench surfaces', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'))
    const packageLock = JSON.parse(readFileSync(new URL('../../../package-lock.json', import.meta.url), 'utf8'))
    const shell = readFileSync(new URL('../../../src/renderer/src/components/workbench/WorkbenchShell.vue', import.meta.url), 'utf8')
    const iconGenerator = readFileSync(new URL('../../../scripts/windows/generate-ta-icon.ps1', import.meta.url), 'utf8')
    const settings = readFileSync(new URL('../../../src/renderer/src/views/SettingsView.vue', import.meta.url), 'utf8')
    const icon = new URL('../../../build-resources/ta-icon.ico', import.meta.url)
    const brandMarkRule = /\.brand-mark\s*\{([^}]*)\}/.exec(shell)?.[1] ?? ''
    const workbenchShellRule = /\.workbench-shell\s*\{([^}]*)\}/.exec(shell)?.[1] ?? ''
    const appHeaderRule = /\.app-header\s*\{([^}]*)\}/.exec(shell)?.[1] ?? ''
    const appHeaderActionsRule = /\.app-header-actions\s*\{([^}]*)\}/.exec(shell)?.[1] ?? ''
    const appHeaderActionsChildrenRule = /\.app-header-actions\s+:deep\(\*\)\s*\{([^}]*)\}/.exec(shell)?.[1] ?? ''

    expect(packageJson.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
    expect(packageJson.version).toBe('2.0.8')
    expect(packageLock.version).toBe(packageJson.version)
    expect(packageLock.packages[''].version).toBe(packageJson.version)
    expect(packageJson.build.nsis.artifactName.replace('${version}', packageJson.version).replace('${ext}', 'exe')).toBe('Terminal-Agent-Setup-2.0.8.exe')
    expect(packageJson.build.win.icon).toBe('build-resources/ta-icon.ico')
    expect(existsSync(icon)).toBe(true)
    expect(readFileSync(icon).subarray(0, 4)).toEqual(Buffer.from([0, 0, 1, 0]))
    expect(shell).toContain('<span class="brand-mark" aria-hidden="true">TA</span>')
    expect(iconGenerator).not.toContain('accentWidth')
    expect(iconGenerator).not.toContain('accentBrush')
    expect(iconGenerator).toContain("[System.Drawing.RectangleF]::new(0, 0, $size, $size)")
    expect(shell).toContain('width: 28px; height: 28px')
    expect(workbenchShellRule).toContain('grid-template-rows: 48px minmax(0, 1fr);')
    expect(workbenchShellRule).toContain('--window-controls-inset: max(138px, calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, calc(100vw - 138px))));')
    expect(appHeaderRule).toContain('padding: 0 calc(14px + var(--window-controls-inset)) 0 14px;')
    expect(appHeaderRule).toContain('-webkit-app-region: drag;')
    expect(appHeaderActionsRule).toContain('-webkit-app-region: no-drag;')
    expect(appHeaderActionsChildrenRule).toContain('-webkit-app-region: no-drag;')
    expect(brandMarkRule).toContain('border: 1px solid #535e6a')
    expect(brandMarkRule).toContain('border-radius: 0')
    expect(brandMarkRule).toContain('background: #1d242c')
    expect(brandMarkRule).toContain('color: #fff')
    expect(brandMarkRule).not.toContain('var(')
    expect(shell).not.toContain('margin: 8px')
    expect(settings).toContain('width: 100vw')
    expect(settings).toContain('height: 100vh')
    expect(settings).not.toContain('margin: 8px')
    expect(settings).not.toContain('border-radius: 8px')
    expect(settings).not.toContain('box-shadow: 0 10px')
  })

  it('names the side regions as task history and AI workspace with directional expand actions', () => {
    const shell = readFileSync(new URL('../../../src/renderer/src/components/workbench/WorkbenchShell.vue', import.meta.url), 'utf8')
    const history = readFileSync(new URL('../../../src/renderer/src/components/workbench/WorkbenchSessionSidebar.vue', import.meta.url), 'utf8')
    const chat = readFileSync(new URL('../../../src/renderer/src/components/chat/GlobalChatPanel.vue', import.meta.url), 'utf8')

    expect(history).toContain('任务历史区')
    expect(history).toContain('scrollbar-width: thin')
    expect(history).toContain('::-webkit-scrollbar-thumb')
    expect(history).toContain('grid-template-columns: minmax(0, 1fr) 28px')
    expect(history).not.toContain('.chat-remove { position: absolute')
    expect(shell).toContain('展开任务历史区')
    expect(shell).toContain('展开 AI工作区')
    expect(shell).toContain('调整任务历史区宽度')
    expect(shell).toContain('调整 AI工作区宽度')
    expect(chat).toContain('aria-label="AI工作区"')
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
