import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('ShellCanvas Task 7 reconnect actions', () => {
  it('exposes reconnectable historical tabs through the same ID-only context menu', () => {
    const canvas = readFileSync(new URL('../../../src/renderer/src/components/workbench/ShellCanvas.vue', import.meta.url), 'utf8')
    const view = readFileSync(new URL('../../../src/renderer/src/views/WorkbenchView.vue', import.meta.url), 'utf8')

    expect(canvas).toContain('historyHosts')
    expect(canvas).toContain("@contextmenu.prevent=\"emit('historyMenu', host.id)\"")
    expect(canvas).toContain('host.reconnectable')
    expect(canvas).toContain('重新连接')
    expect(view).toContain(':history-hosts="historyHosts"')
    expect(view).toContain('@reconnect="reconnectShell"')
  })

  it('keeps closed history associations available beside an active terminal after a fresh authority check', () => {
    const canvas = readFileSync(new URL('../../../src/renderer/src/components/workbench/ShellCanvas.vue', import.meta.url), 'utf8')
    const view = readFileSync(new URL('../../../src/renderer/src/views/WorkbenchView.vue', import.meta.url), 'utf8')
    const openHistory = view.slice(view.indexOf('async function openShellHistory'), view.indexOf('function closeShellHistory'))

    expect(view).toContain('const historyHosts = computed(() => latestHistoryByHost(shellHistory.state.records))')
    expect(canvas).toContain('v-if="historyHosts.length"')
    expect(canvas).not.toContain('v-if="!isLive && historyHosts.length"')
    expect(canvas).toContain("historyMenu: [historyId: string]")
    expect(canvas).toContain('defineExpose({ openHistoryMenu })')
    expect(view).toContain('ref="shellCanvas"')
    expect(view).toContain('@history-menu="openHistoricalShellMenu"')
    expect(view).toContain('async function openHistoricalShellMenu(historyId: string): Promise<void>')
    expect(view).toContain('shellCanvas.value?.openHistoryMenu(historyId)')
    expect(openHistory.indexOf('await shellHistory.open({ chatId')).toBeLessThan(openHistory.indexOf('showHistoryDialog.value = true'))
  })

  it('renders historical hosts as a selectable compact workspace linked to the shared layout', () => {
    const canvas = readFileSync(new URL('../../../src/renderer/src/components/workbench/ShellCanvas.vue', import.meta.url), 'utf8')
    const view = readFileSync(new URL('../../../src/renderer/src/views/WorkbenchView.vue', import.meta.url), 'utf8')

    expect(canvas).toContain('历史 Shell 连接')
    expect(canvas).toContain(':aria-pressed="selectedHistoryHosts.includes(host.hostname)"')
    expect(canvas).toContain("emit('toggleHistoryHost', host.hostname)")
    expect(canvas).toContain('历史 Shell 布局')
    expect(view).toContain('filterHistoryByHosts')
    expect(view).toContain(':selected-history-hosts="selectedHistoryHosts"')
    expect(view).toContain(':style="historyGridStyle"')
  })

  it('labels historical-only tasks as closed read-only playback instead of live Shell activity', () => {
    const canvas = readFileSync(new URL('../../../src/renderer/src/components/workbench/ShellCanvas.vue', import.meta.url), 'utf8')

    expect(canvas).toContain('Shell 历史回放')
    expect(canvas).toContain('{{ historyHosts.length }} 台主机')
    expect(canvas).toContain('以下 Shell 已关闭，仅提供只读回放')
    expect(canvas).toContain('v-if="isLive" class="shell-title"')
  })

  it('vertically centers the closed-Shell history title and summary in their toolbar', () => {
    const canvas = readFileSync(new URL('../../../src/renderer/src/components/workbench/ShellCanvas.vue', import.meta.url), 'utf8')
    const titleRule = /\.history-toolbar-title\s*\{([^}]*)\}/.exec(canvas)?.[1] ?? ''

    expect(titleRule).toContain('align-items: center;')
    expect(titleRule).not.toContain('align-items: baseline;')
  })

  it('removes autonomous upgrade controls from the workbench while preserving compatibility modules', () => {
    const canvas = readFileSync(new URL('../../../src/renderer/src/components/workbench/ShellCanvas.vue', import.meta.url), 'utf8')
    const chat = readFileSync(new URL('../../../src/renderer/src/components/chat/GlobalChatPanel.vue', import.meta.url), 'utf8')
    const view = readFileSync(new URL('../../../src/renderer/src/views/WorkbenchView.vue', import.meta.url), 'utf8')

    expect(canvas).not.toContain('已保存会话')
    expect(canvas).not.toContain('升级为全自动驾驶')
    expect(chat).toContain('AI工作区')
    expect(chat).toContain('计划需手动确认')
    expect(chat).not.toContain('辅助驾驶')
    expect(chat).not.toContain('全自动驾驶')
    expect(chat).not.toContain('type="file"')
    expect(chat).not.toContain('添加图片')
    expect(chat).not.toContain('重试')
    expect(view).not.toContain('createAutonomousUpgradeStore')
    expect(view).not.toContain('requestAutonomousUpgrade')
    expect(view).not.toContain('confirmAutonomousUpgrade')
    expect(view).not.toContain(':can-upgrade=')
    expect(view).not.toContain('@upgrade=')
    expect(view).not.toContain('autonomous-upgrade-dialog')
  })

  it('keeps clipboard actions in the terminal context menu and bounds the terminal grid', () => {
    const canvas = readFileSync(new URL('../../../src/renderer/src/components/workbench/ShellCanvas.vue', import.meta.url), 'utf8')
    const terminal = readFileSync(new URL('../../../src/renderer/src/components/TerminalPane.vue', import.meta.url), 'utf8')
    const shell = readFileSync(new URL('../../../src/renderer/src/components/workbench/WorkbenchShell.vue', import.meta.url), 'utf8')

    expect(terminal).toContain('复制')
    expect(terminal).toContain('粘贴')
    expect(terminal).toContain('全选')
    expect(terminal).toContain('取消选择')
    expect(terminal).toContain('navigator.clipboard')
    expect(terminal).toContain('ref="paneElement"')
    expect(terminal).toContain('paneElement.value?.getBoundingClientRect()')
    const pasteHandler = terminal.slice(terminal.indexOf('async function pasteClipboard'), terminal.indexOf('function selectAll'))
    expect(pasteHandler).toContain('terminal.focus()')
    expect(pasteHandler.indexOf('closeContextMenu()')).toBeLessThan(pasteHandler.indexOf('terminal.focus()'))
    const terminalPaneRule = /\.terminal-pane\s*\{([^}]*)\}/.exec(terminal)?.[1] ?? ''
    const terminalElementRule = /\.terminal-element\s*\{([^}]*)\}/.exec(terminal)?.[1] ?? ''
    expect(terminalPaneRule).toContain('padding: 11px 12px')
    expect(terminalElementRule).not.toContain('padding:')
    expect(canvas).toContain('minmax(0, 1fr)')
    expect(canvas).toContain('min-height: 0')
    expect(shell).toContain('grid-template-rows: 48px minmax(0, 1fr)')
  })
})
