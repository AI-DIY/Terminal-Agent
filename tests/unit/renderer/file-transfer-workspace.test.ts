import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('SSH workspace file-transfer controls', () => {
  it('provides one guarded workspace broadcast bar and a persistent transfer dock', () => {
    const canvas = readFileSync(new URL('../../../src/renderer/src/components/workbench/ShellCanvas.vue', import.meta.url), 'utf8')

    expect(canvas).toContain('const broadcastEnabled = ref(false)')
    expect(canvas).toContain('const broadcastInput = ref(\'\')')
    expect(canvas).toContain('function sendBroadcast(): void')
    expect(canvas).toContain('Promise.allSettled')
    expect(canvas).toContain('window.terminalAgent.sessions.write(sessionId, data)')
    expect(canvas.match(/class="broadcast-bar"/g)).toHaveLength(1)
    expect(canvas).toContain(':disabled="!broadcastEnabled"')
    expect(canvas).toContain('发送键输入到所有会话')
    expect(canvas).toContain('发送所有窗口执行')

    expect(canvas).toContain('function toggleFileTransfer(): void')
    expect(canvas).toContain('fileTransferPanelSessionIds')
    expect(canvas).toContain('v-show="fileTransferOpen"')
    expect(canvas).toContain('v-show="session.id === fileTransferSessionId"')
    expect(canvas).toContain('@busy-change="setFileTransferBusy(session.id, $event)"')
    expect(canvas).toContain('文件传输中')
    expect(canvas).toContain('only closing/removing that SSH session destroys its panel')
  })

  it('uses native-dialog-backed local/remote drag targets without exposing local paths', () => {
    const panel = readFileSync(new URL('../../../src/renderer/src/components/workbench/FileTransferPanel.vue', import.meta.url), 'utf8')

    expect(panel).toContain('本地（左）')
    expect(panel).toContain('远程（右）')
    expect(panel).toContain('function onLocalDrop(event: DragEvent): void')
    expect(panel).toContain('function onRemoteDrop(event: DragEvent): void')
    expect(panel).toContain('startRemoteEntryDrag')
    expect(panel).toContain('startLocalEntryDrag')
    expect(panel).toContain('trusted native picker')
    expect(panel).toContain("emit('busyChange', value)")
    expect(panel).toContain('文件传输中')
    expect(panel).not.toContain('localPath:')
  })
})
