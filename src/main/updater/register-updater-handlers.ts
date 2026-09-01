import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import {
  updaterChannels,
  updaterErrorSchema,
  type UpdaterServiceLike,
} from './updater-contracts'

/**
 * The IPC boundary intentionally exposes only fixed, zero-argument commands.
 * The renderer never supplies a URL, path, repository, or process arguments.
 */
export function registerUpdaterHandlers(
  source: UpdaterServiceLike,
  trustedSender: WebContents,
): () => void {
  ipcMain.handle(updaterChannels.check, async (event, ...args: unknown[]) => {
    assertTrustedInvocation(event, trustedSender, args)
    return source.check()
  })
  ipcMain.handle(updaterChannels.download, async (event, ...args: unknown[]) => {
    assertTrustedInvocation(event, trustedSender, args)
    return source.download()
  })
  ipcMain.handle(updaterChannels.install, async (event, ...args: unknown[]) => {
    assertTrustedInvocation(event, trustedSender, args)
    return source.install()
  })
  ipcMain.handle(updaterChannels.restart, async (event, ...args: unknown[]) => {
    assertTrustedInvocation(event, trustedSender, args)
    source.restart()
  })
  ipcMain.handle(updaterChannels.state, async (event, ...args: unknown[]) => {
    assertTrustedInvocation(event, trustedSender, args)
    return source.getState()
  })

  const unsubscribeProgress = source.onProgress(progress => send(trustedSender, updaterChannels.progress, progress))
  const unsubscribeStatus = source.onStatus(state => send(trustedSender, updaterChannels.status, state))
  const unsubscribeError = source.onError(message => send(trustedSender, updaterChannels.error, updaterErrorSchema.parse(message)))
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    unsubscribeProgress()
    unsubscribeStatus()
    unsubscribeError()
    ipcMain.removeHandler(updaterChannels.check)
    ipcMain.removeHandler(updaterChannels.download)
    ipcMain.removeHandler(updaterChannels.install)
    ipcMain.removeHandler(updaterChannels.restart)
    ipcMain.removeHandler(updaterChannels.state)
  }
}

function assertTrustedInvocation(event: IpcMainInvokeEvent, trustedSender: WebContents, args: readonly unknown[]): void {
  if (event.sender !== trustedSender) throw new Error('Untrusted renderer')
  if (args.length !== 0) throw new Error('Updater commands do not accept arguments')
}

function send(sender: WebContents, channel: string, payload: unknown): void {
  if (typeof sender.isDestroyed === 'function' && sender.isDestroyed()) return
  try { sender.send(channel, payload) } catch { /* The window may close between the check and send. */ }
}
