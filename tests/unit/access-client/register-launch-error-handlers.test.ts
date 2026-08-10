import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerAccessClientLaunchHandlers } from '../../../src/main/access-client/register-launch-error-handlers'

const { handle, removeHandler } = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn() }))

vi.mock('electron', () => ({ ipcMain: { handle, removeHandler } }))

describe('registerAccessClientLaunchHandlers', () => {
  beforeEach(() => {
    handle.mockReset()
    removeHandler.mockReset()
  })

  it('exposes only sanitized launch failures to the trusted renderer', () => {
    const sender = { send: vi.fn() }
    const source = {
      snapshot: vi.fn(() => ['无法建立 AccessClient 会话。请检查启动参数、连接状态和本次凭据。']),
      onFailure: vi.fn().mockReturnValue(vi.fn()),
    }
    registerAccessClientLaunchHandlers(source, sender as never)

    const handler = handle.mock.calls.find(([channel]) => channel === 'access-client:errors')?.[1] as (event: { sender: unknown }) => unknown
    expect(handler({ sender })).toEqual(source.snapshot())
    expect(() => handler({ sender: { send: vi.fn() } })).toThrow('Untrusted renderer')

    const report = source.onFailure.mock.calls[0]?.[0] as (message: string) => void
    report('无法建立 AccessClient 会话。请检查启动参数、连接状态和本次凭据。')
    expect(sender.send).toHaveBeenCalledWith('access-client:error', '无法建立 AccessClient 会话。请检查启动参数、连接状态和本次凭据。')
  })
})
