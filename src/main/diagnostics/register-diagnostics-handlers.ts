import { ipcMain, type WebContents } from 'electron'
import { publicDiagnosticsError, type DiagnosticsController } from './diagnostics-controller'

const channels = ['diagnostics:open-renderer-devtools', 'diagnostics:open-node-inspector'] as const

type DiagnosticsActions = Pick<DiagnosticsController, 'openRendererDevTools' | 'openNodeInspector'>

export function registerDiagnosticsHandlers(
  controller: DiagnosticsActions,
  trustedSender: WebContents,
): () => void {
  const register = (channel: typeof channels[number], open: () => Promise<void>): void => {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      if (event.sender !== trustedSender) throw new Error('Untrusted renderer')
      if (args.length !== 0) throw new Error('Diagnostic commands do not accept arguments')
      try {
        await open()
      } catch (error) {
        throw new Error(publicDiagnosticsError(error), { cause: error })
      }
    })
  }

  register('diagnostics:open-renderer-devtools', () => controller.openRendererDevTools())
  register('diagnostics:open-node-inspector', () => controller.openNodeInspector())

  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    for (const channel of channels) ipcMain.removeHandler(channel)
  }
}
