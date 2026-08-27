import { describe, expect, it, vi } from 'vitest'
import { StructuredChatAgent } from '../../../src/main/chat/structured-chat-agent'

const request = {
  messages: [{ role: 'user' as const, content: '检查服务' }],
  availableHostnames: ['web-02'],
}

describe('StructuredChatAgent', () => {
  it('returns the first valid JSON response without exposing provider deltas', async () => {
    const complete = vi.fn().mockResolvedValue('{"version":1,"reply":"已准备。","plan":null}')
    await expect(new StructuredChatAgent({ complete }).run(request)).resolves.toMatchObject({ reply: '已准备。', plan: null })
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('repairs invalid JSON twice at most and fails after the third model call', async () => {
    const complete = vi.fn().mockResolvedValueOnce('{not json').mockResolvedValueOnce('{still invalid').mockResolvedValueOnce('{also invalid')
    await expect(new StructuredChatAgent({ complete }).run(request)).rejects.toThrow('AI 未能生成可执行计划，请重试。')
    expect(complete).toHaveBeenCalledTimes(3)
  })

  it('repairs a plan that targets an offline hostname', async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce('{"version":1,"reply":"准备","plan":{"title":"检查","steps":[{"target":"missing-host","explanation":"检查","command":"pwd"}]}}')
      .mockResolvedValueOnce('{"version":1,"reply":"准备","plan":{"title":"检查","steps":[{"target":"web-02","explanation":"检查","command":"pwd"}]}}')
    await expect(new StructuredChatAgent({ complete }).run(request)).resolves.toMatchObject({ plan: { steps: [{ target: 'web-02' }] } })
    expect(complete).toHaveBeenCalledTimes(2)
  })

  it('reports bounded thinking and repairing stages without exposing generated JSON', async () => {
    const stages: string[] = []
    const complete = vi.fn()
      .mockResolvedValueOnce('{not json')
      .mockResolvedValueOnce('{"version":1,"reply":"完成","plan":null}')
    await expect(new StructuredChatAgent({ complete, onStage: stage => stages.push(stage) }).run(request)).resolves.toMatchObject({ reply: '完成' })
    expect(stages).toEqual(['thinking', 'repairing', 'thinking', 'observing'])
    expect(stages.every(stage => ['thinking', 'executing', 'observing', 'repairing'].includes(stage))).toBe(true)
    expect(stages.join(' ')).not.toContain('{')
  })
})
