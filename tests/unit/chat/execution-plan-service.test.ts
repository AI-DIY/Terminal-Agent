import { describe, expect, it, vi } from 'vitest'
import { ExecutionPlanService } from '../../../src/main/chat/execution-plan-service'

function plan() {
  return {
    id: 'plan-1',
    title: '检查服务',
    status: 'pending_review' as const,
    steps: [{
      id: 'step-1',
      target: 'web-01',
      explanation: '查看状态',
      originalCommand: 'systemctl status api',
      sendState: 'pending' as const,
    }],
  }
}

describe('ExecutionPlanService', () => {
  it('binds a same-host plan to the first online association in stored order', async () => {
    const write = vi.fn()
    const service = new ExecutionPlanService({
      get: vi.fn(async () => ({ chat: {
        messages: [{ id: 'message-1', role: 'assistant', state: 'complete', content: '{}', executionPlan: plan() }],
        shells: [
          { sessionId: 'session-first', hostname: 'web-01', status: 'open' },
          { sessionId: 'session-second', hostname: 'web-01', status: 'open' },
        ],
      } })),
      updateMessage: vi.fn(async () => undefined),
      appendMessage: vi.fn(async () => undefined),
    }, {
      snapshot: () => [
        { id: 'session-second', hostname: 'web-01' },
        { id: 'session-first', hostname: 'web-01' },
      ],
      write,
    }, { match: () => null }, () => '00000000-0000-4000-8000-000000000001')

    await service.execute({ requestId: 'request-1', chatId: 'chat-1', messageId: 'message-1' })

    expect(write).toHaveBeenCalledWith('session-first', 'systemctl status api\n')
    expect(write).not.toHaveBeenCalledWith('session-second', 'systemctl status api\n')
  })
})
