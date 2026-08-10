import { describe, expect, it } from 'vitest'
import { formatAccessClientLaunchFailure } from '../../../src/main/access-client/launch-failure'

describe('formatAccessClientLaunchFailure', () => {
  it('shows the category and the mapped bridge log location only', () => {
    const message = formatAccessClientLaunchFailure('temporary-profile-unreadable', 'D:\\Assess\\putty-bridge.log')

    expect(message).toBe('无法读取堡垒机临时配置。请查看跳转日志：D:\\Assess\\putty-bridge.log')
    expect(message).not.toContain('secret')
  })
})
