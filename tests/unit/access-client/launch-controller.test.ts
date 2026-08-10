import { describe, expect, it, vi } from 'vitest'
import { AccessClientLaunchController } from '../../../src/main/access-client/launch-controller'
import { AccessClientLaunchFailure } from '../../../src/main/access-client/launch-failure'

describe('AccessClientLaunchController', () => {
  it('records a categorized local error with its bridge log path when an AccessClient launch fails', async () => {
    const launcher = { tryOpenFromArgv: vi.fn().mockRejectedValue(new AccessClientLaunchFailure('temporary-profile-unreadable')) }
    const controller = new AccessClientLaunchController(launcher)
    const received = vi.fn()
    controller.onFailure(received)

    await expect(controller.tryOpenFromArgv([
      'Terminal-Agent.exe',
      '--terminal-agent-bridge-log', 'D:\\Assess\\putty-bridge.log',
      '--terminal-agent-bridge-id', 'launch-004',
      '--', '-load', 'tmp:C:\\Temp\\secret.conf', '-pw', 'temporary-secret',
    ])).resolves.toBe(false)

    const errors = controller.snapshot()
    expect(errors).toEqual(['无法读取堡垒机临时配置。请查看跳转日志：D:\\Assess\\putty-bridge.log'])
    expect(received).toHaveBeenCalledWith(errors[0])
    expect(JSON.stringify(errors)).not.toContain('temporary-secret')
    expect(JSON.stringify(errors)).not.toContain('secret.conf')
  })
})
