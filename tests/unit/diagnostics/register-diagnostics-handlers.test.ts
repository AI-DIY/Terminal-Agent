import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerDiagnosticsHandlers } from '../../../src/main/diagnostics/register-diagnostics-handlers'

const { handle, removeHandler } = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle, removeHandler } }))

function handlerFor(channel: string): (...args: unknown[]) => unknown {
  const registered = handle.mock.calls.find(([name]) => name === channel)?.[1]
  if (!registered) throw new Error(`Missing handler: ${channel}`)
  return registered as (...args: unknown[]) => unknown
}

describe('registerDiagnosticsHandlers', () => {
  beforeEach(() => { handle.mockReset(); removeHandler.mockReset() })

  it('accepts only trusted zero-argument diagnostic commands', async () => {
    const controller = {
      openRendererDevTools: vi.fn(async () => undefined),
      openNodeInspector: vi.fn(async () => undefined),
    }
    const trusted = { send: vi.fn() }
    const dispose = registerDiagnosticsHandlers(controller, trusted as never)

    await handlerFor('diagnostics:open-renderer-devtools')({ sender: trusted })
    await handlerFor('diagnostics:open-node-inspector')({ sender: trusted })
    await expect(handlerFor('diagnostics:open-node-inspector')(
      { sender: trusted }, 'ws://127.0.0.1:9229/forged',
    )).rejects.toThrow('Diagnostic commands do not accept arguments')
    await expect(handlerFor('diagnostics:open-renderer-devtools')({ sender: {} })).rejects.toThrow('Untrusted renderer')

    expect(controller.openRendererDevTools).toHaveBeenCalledOnce()
    expect(controller.openNodeInspector).toHaveBeenCalledOnce()
    dispose()
  })

  it('maps internal controller errors and unregisters each handler once', async () => {
    const controller = {
      openRendererDevTools: vi.fn(async () => { throw new Error('private URL and port') }),
      openNodeInspector: vi.fn(async () => undefined),
    }
    const trusted = { send: vi.fn() }
    const dispose = registerDiagnosticsHandlers(controller, trusted as never)

    await expect(handlerFor('diagnostics:open-renderer-devtools')({ sender: trusted }))
      .rejects.toThrow('无法打开诊断窗口。请关闭后重试。')
    dispose()
    dispose()

    expect(removeHandler).toHaveBeenCalledTimes(2)
    expect(removeHandler).toHaveBeenCalledWith('diagnostics:open-renderer-devtools')
    expect(removeHandler).toHaveBeenCalledWith('diagnostics:open-node-inspector')
  })
})
