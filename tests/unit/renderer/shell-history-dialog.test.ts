import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('ShellHistoryDialog log views', () => {
  it('separates SSH operation records from persisted file-transfer logs without reconnect controls', () => {
    const dialog = readFileSync(new URL('../../../src/renderer/src/components/workbench/ShellHistoryDialog.vue', import.meta.url), 'utf8')

    expect(dialog).toContain("type HistoryLogTab = 'operations' | 'transfers'")
    expect(dialog).toContain('SSH连接操作记录')
    expect(dialog).toContain('文件传输日志')
    expect(dialog).toContain('fileTransferLogs')
    expect(dialog).toContain('commandAudit')
    expect(dialog).toContain('暂无 SSH 连接操作记录')
    expect(dialog).toContain('暂无文件传输日志')
    expect(dialog).toContain('role="tablist"')
    expect(dialog).toContain('role="tabpanel"')
    expect(dialog).not.toContain("emit('reconnect'")
    expect(dialog).not.toContain('重新连接')
    expect(dialog).not.toContain('可使用现有安全连接描述')
  })
})
