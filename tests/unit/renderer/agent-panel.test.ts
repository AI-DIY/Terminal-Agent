import { describe, expect, it } from 'vitest'
import { isReactive } from 'vue'
import { createAgentPanelStore } from '../../../src/renderer/src/stores/agent-panel'

describe('agent panel state', () => {
  it('keeps stream state reactive so IPC events refresh the visible panel', () => {
    expect(isReactive(createAgentPanelStore().state)).toBe(true)
  })

  it('shows streamed strategy text and one generated candidate for the active session', () => {
    const panel = createAgentPanelStore()
    panel.start('session-a', '检查 nginx', 'run-a1')
    panel.apply({ sessionId: 'session-a', runId: 'run-a1', kind: 'delta', content: '{"analysis":"正在检查"}' })
    panel.apply({
      sessionId: 'session-a', runId: 'run-a1', kind: 'proposal', analysis: 'Nginx 正常运行', evidenceStrategy: ['检查服务状态'],
      candidate: { id: 'candidate-1', sessionId: 'session-a', command: 'systemctl status nginx', explanation: '只读检查' },
    })
    panel.apply({ sessionId: 'session-b', runId: 'run-b1', kind: 'error', message: '忽略其他会话' })

    expect(panel.state).toEqual({
      sessionId: 'session-a', runId: 'run-a1', goal: '检查 nginx', streaming: false, strategy: '{"analysis":"正在检查"}',
      proposal: {
        analysis: 'Nginx 正常运行', evidenceStrategy: ['检查服务状态'],
        candidate: { id: 'candidate-1', sessionId: 'session-a', command: 'systemctl status nginx', explanation: '只读检查' },
      },
      error: '',
    })
  })

  it('replaces a stream with the safe main-process error for its own session', () => {
    const panel = createAgentPanelStore()
    panel.start('session-a', '检查 nginx', 'run-a1')
    panel.apply({ sessionId: 'session-a', runId: 'run-a1', kind: 'error', message: '未配置 AI 模型。请前往设置完成模型连接后重试。' })

    expect(panel.state).toMatchObject({ streaming: false, error: '未配置 AI 模型。请前往设置完成模型连接后重试。', proposal: null })
  })

  it('clears the previous strategy and candidate before a different session becomes active', () => {
    const panel = createAgentPanelStore()
    panel.start('session-a', '检查 nginx', 'run-a1')
    panel.apply({ sessionId: 'session-a', runId: 'run-a1', kind: 'delta', content: '旧会话策略' })
    panel.apply({
      sessionId: 'session-a', runId: 'run-a1', kind: 'proposal', analysis: '旧会话分析', evidenceStrategy: [],
      candidate: { id: 'candidate-a', sessionId: 'session-a', command: 'systemctl status nginx', explanation: '只读检查' },
    })

    panel.activate('session-b')

    expect(panel.state).toMatchObject({ sessionId: 'session-b', runId: null, strategy: '', proposal: null, error: '', streaming: false })
  })

  it('ignores a delayed A1 proposal after A to B to A activation', () => {
    const panel = createAgentPanelStore()
    panel.start('session-a', '首次分析', 'run-a1')

    panel.activate('session-b')
    panel.activate('session-a')
    panel.apply({
      sessionId: 'session-a', runId: 'run-a1', kind: 'proposal', analysis: '过期分析', evidenceStrategy: [],
      candidate: { id: 'candidate-a1', sessionId: 'session-a', command: 'id', explanation: '旧请求' },
    })

    expect(panel.state).toMatchObject({ sessionId: 'session-a', runId: null, streaming: false, proposal: null })
  })

  it('ignores a delayed A1 proposal after A2 starts in the same session', () => {
    const panel = createAgentPanelStore()
    panel.start('session-a', '首次分析', 'run-a1')
    panel.start('session-a', '再次分析', 'run-a2')
    panel.apply({
      sessionId: 'session-a', runId: 'run-a1', kind: 'proposal', analysis: '过期分析', evidenceStrategy: [],
      candidate: { id: 'candidate-a1', sessionId: 'session-a', command: 'id', explanation: '旧请求' },
    })

    expect(panel.state).toMatchObject({ sessionId: 'session-a', runId: 'run-a2', goal: '再次分析', streaming: true, proposal: null })
  })
})
