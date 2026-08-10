import { describe, expect, it, vi } from 'vitest'
import { AccessClientLaunchController } from '../../../src/main/access-client/launch-controller'

describe('AccessClientLaunchController', () => {
  it('records and publishes a sanitized local error when an AccessClient launch fails', async () => {
    const launcher = { tryOpenFromArgv: vi.fn().mockRejectedValue(new Error('C:\\Temp\\secret.conf -pw temporary-secret')) }
    const controller = new AccessClientLaunchController(launcher)
    const received = vi.fn()
    controller.onFailure(received)

    await expect(controller.tryOpenFromArgv(['Terminal-Agent.exe', '-load', 'tmp:C:\\Temp\\secret.conf', '-pw', 'temporary-secret'])).resolves.toBe(false)

    const errors = controller.snapshot()
    expect(errors).toEqual(['无法建立 AccessClient 会话。请检查启动参数、连接状态和本次凭据。'])
    expect(received).toHaveBeenCalledWith(errors[0])
    expect(JSON.stringify(errors)).not.toContain('temporary-secret')
    expect(JSON.stringify(errors)).not.toContain('secret.conf')
  })
})
