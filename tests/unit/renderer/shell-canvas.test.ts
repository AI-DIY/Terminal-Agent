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

  it('keeps upgrade control in the AI workspace and removes save and upgrade controls from Shell workspace', () => {
    const canvas = readFileSync(new URL('../../../src/renderer/src/components/workbench/ShellCanvas.vue', import.meta.url), 'utf8')
    const chat = readFileSync(new URL('../../../src/renderer/src/components/chat/GlobalChatPanel.vue', import.meta.url), 'utf8')
    const view = readFileSync(new URL('../../../src/renderer/src/views/WorkbenchView.vue', import.meta.url), 'utf8')

    expect(canvas).not.toContain('已保存会话')
    expect(canvas).not.toContain('升级为全自动驾驶')
    expect(chat).toContain('AI 聊天')
    expect(chat).toContain('辅助驾驶')
    expect(chat).toContain('全自动驾驶')
    expect(chat).toContain("emit('upgrade')")
    expect(view).toContain('@upgrade="requestAutonomousUpgrade"')
  })
})
