import { describe, expect, it, vi } from 'vitest'
import { StructuredChatAgent } from '../../../src/main/chat/structured-chat-agent'

describe('StructuredChatAgent multi-host execution scope', () => {
  it('expands a reviewed command to every explicitly selected distinct host', async () => {
    const complete = vi.fn(async () => JSON.stringify({
      version: 1,
      reply: '准备执行',
      plan: { title: '检查服务', steps: [{ target: 'web-01', explanation: '查看状态', command: 'systemctl status api' }] },
    }))
    const result = await new StructuredChatAgent({ complete }).run({
      messages: [{ role: 'user', content: '在两台主机检查服务' }],
      availableHostnames: ['web-01', 'db-01'],
      availableShells: [
        { hostname: 'web-01', title: 'web-01', displayLabel: 'web-01', ordinal: 1 },
        { hostname: 'db-01', title: 'db-01', displayLabel: 'db-01', ordinal: 1 },
      ],
      preserveShellConnections: true,
    })

    expect(result.plan?.steps.map(step => step.target)).toEqual(['web-01', 'db-01'])
  })
})
