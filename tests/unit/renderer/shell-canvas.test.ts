import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('ShellCanvas Task 7 reconnect actions', () => {
  it('exposes reconnectable historical tabs through the same ID-only context menu', () => {
    const canvas = readFileSync(new URL('../../../src/renderer/src/components/workbench/ShellCanvas.vue', import.meta.url), 'utf8')
    const view = readFileSync(new URL('../../../src/renderer/src/views/WorkbenchView.vue', import.meta.url), 'utf8')

    expect(canvas).toContain('historyRecords')
    expect(canvas).toContain("@contextmenu.prevent=\"emit('historyMenu', shell.historyId)\"")
    expect(canvas).toContain('historyRecord(shell.historyId)?.reconnectable')
    expect(canvas).toContain('重新连接')
    expect(view).toContain(':history-records="shellHistory.state.records"')
    expect(view).toContain('@reconnect="reconnectShell"')
  })

  it('keeps closed history associations available beside an active terminal after a fresh authority check', () => {
    const canvas = readFileSync(new URL('../../../src/renderer/src/components/workbench/ShellCanvas.vue', import.meta.url), 'utf8')
    const view = readFileSync(new URL('../../../src/renderer/src/views/WorkbenchView.vue', import.meta.url), 'utf8')
    const openHistory = view.slice(view.indexOf('async function openShellHistory'), view.indexOf('function closeShellHistory'))

    expect(view).toContain("const historyShells = computed(() => (chatStore.state.selected?.shells ?? []).filter(shell => shell.status === 'closed'))")
    expect(canvas).toContain('v-if="historyShells.length"')
    expect(canvas).not.toContain('v-if="!isLive && historyShells.length"')
    expect(canvas).toContain("historyMenu: [historyId: string]")
    expect(canvas).toContain('defineExpose({ openHistoryMenu })')
    expect(view).toContain('ref="shellCanvas"')
    expect(view).toContain('@history-menu="openHistoricalShellMenu"')
    expect(view).toContain('async function openHistoricalShellMenu(historyId: string): Promise<void>')
    expect(view).toContain('shellCanvas.value?.openHistoryMenu(historyId)')
    expect(openHistory.indexOf('await shellHistory.open({ chatId')).toBeLessThan(openHistory.indexOf('showHistoryDialog.value = true'))
  })
})
