import { describe, expect, it } from 'vitest'
import { planTargetLabelForShells } from '../../../src/renderer/src/components/chat/plan-target-label'

describe('plan target labels', () => {
  it('uses the stable #1 duplicate-host label regardless of shell source order', () => {
    expect(planTargetLabelForShells('web-01', [
      { sessionId: 'session-b', hostname: 'web-01', title: '第二连接' },
      { sessionId: 'session-a', hostname: 'web-01', title: '第一连接' },
    ])).toBe('第一连接 #1')
  })
})
