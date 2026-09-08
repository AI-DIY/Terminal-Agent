import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { recoverChatStreamsBeforeCreatingMainWindow } from '../../../src/main/chat/chat-startup'

const state = vi.hoisted(() => ({
  windows: [] as Array<{
    webContents: {
      send: ReturnType<typeof vi.fn>
      on: ReturnType<typeof vi.fn>
      removeListener: ReturnType<typeof vi.fn>
    }
    options: { show?: boolean }
    isDestroyed: ReturnType<typeof vi.fn>
    isMinimized: ReturnType<typeof vi.fn>
    restore: ReturnType<typeof vi.fn>
    setTitleBarOverlay: ReturnType<typeof vi.fn>
    show: ReturnType<typeof vi.fn>
    focus: ReturnType<typeof vi.fn>
    shown: boolean
    emitClosed(): void
    emitReadyToShow(): void
  }>,
  chatRepositoryConstructor: vi.fn(),
  chatServiceConstructor: vi.fn(),
  registerChatHandlers: vi.fn(),
  disposeChatHandlers: vi.fn(),
  workbenchPreferencesConstructor: vi.fn(),
  registerWorkbenchSettingsHandlers: vi.fn(),
  disposeWorkbenchSettingsHandlers: vi.fn(),
  ipcHandlers: new Map<string, (event: { sender: unknown }, input?: unknown) => unknown>(),
  workbenchSaveTheme: vi.fn(),
  setApplicationMenu: vi.fn(),
  ssoStateListeners: [] as Array<(snapshot: { state: string }) => void>,
  subscribeSsoState: vi.fn((listener: (snapshot: { state: string }) => void) => {
    state.ssoStateListeners.push(listener)
    return () => {
      const index = state.ssoStateListeners.indexOf(listener)
      if (index >= 0) state.ssoStateListeners.splice(index, 1)
    }
  }),
}))

vi.mock('electron', () => {
  class BrowserWindow {
    static getAllWindows() { return state.windows }
    private readonly contents = { send: vi.fn(), on: vi.fn(), removeListener: vi.fn() }
    private readonly listeners = new Map<string, Array<() => void>>()
    loadURL = vi.fn().mockResolvedValue(undefined)
    loadFile = vi.fn().mockResolvedValue(undefined)
    private destroyed = false
    isDestroyed = vi.fn(() => this.destroyed)
    isMinimized = vi.fn(() => false)
    restore = vi.fn()
    setTitleBarOverlay = vi.fn()
    shown = false
    show = vi.fn(() => { this.shown = true })
    focus = vi.fn()
    readonly options: { show?: boolean }

    constructor(options: { show?: boolean }) {
      this.options = options
      this.shown = options.show !== false
      state.windows.push(this)
    }

    get webContents() {
      if (this.destroyed) throw new TypeError('Object has been destroyed')
      return this.contents
    }

    on(event: string, listener: () => void) {
      const listeners = this.listeners.get(event) ?? []
      listeners.push(listener)
      this.listeners.set(event, listeners)
    }
    emitClosed() {
      this.destroyed = true
      for (const listener of this.listeners.get('closed') ?? []) listener()
    }
    emitReadyToShow() { for (const listener of this.listeners.get('ready-to-show') ?? []) listener() }
  }

  return {
    app: {
      getPath: vi.fn(() => 'D:\\terminal-agent-user-data'),
      requestSingleInstanceLock: vi.fn(() => false),
      quit: vi.fn(),
      on: vi.fn(),
      whenReady: vi.fn(),
      isPackaged: false,
    },
    BrowserWindow,
    Menu: { setApplicationMenu: state.setApplicationMenu },
    safeStorage: {
      decryptString: vi.fn(), encryptString: vi.fn(), isEncryptionAvailable: vi.fn(() => true),
    },
    dialog: { showOpenDialog: vi.fn() },
    ipcMain: {
      handle: vi.fn((channel: string, handler: (event: { sender: unknown }, input?: unknown) => unknown) => {
        state.ipcHandlers.set(channel, handler)
      }),
      removeHandler: vi.fn((channel: string) => { state.ipcHandlers.delete(channel) }),
    },
  }
})

vi.mock('../../../src/main/chat/chat-repository', () => ({
  ChatRepository: class ChatRepository {
    constructor(readonly path: string) { state.chatRepositoryConstructor(path) }
  },
}))
vi.mock('../../../src/main/chat/chat-service', () => ({
  ChatService: class ChatService {
    constructor(readonly repository: unknown) { state.chatServiceConstructor(repository) }
    onChanged() { return () => undefined }
  },
}))
vi.mock('../../../src/main/chat/register-chat-handlers', () => ({ registerChatHandlers: state.registerChatHandlers }))
vi.mock('../../../src/main/settings/workbench-preferences-service', () => ({
  WorkbenchPreferencesService: class WorkbenchPreferencesService {
    constructor(readonly path: string) { state.workbenchPreferencesConstructor(path) }
    saveTheme(theme: 'pearl' | 'graphite') { return state.workbenchSaveTheme(theme) }
  },
}))
vi.mock('../../../src/main/settings/sso-config-service', () => ({
  getSsoConfigPath: vi.fn(() => 'D:\\terminal-agent-home\\.terminal-agent\\user-config.yml'),
  getPreviousSsoConfigPath: vi.fn(() => 'D:\\terminal-agent-home\\.terminal-agent\\user-config'),
  getLegacySsoConfigPath: vi.fn(() => 'D:\\terminal-agent-home\\.ta\\user-config'),
  SsoConfigService: class SsoConfigService { ensureInitialized() { return Promise.resolve() } },
}))
vi.mock('../../../src/main/sso/sso-authentication-service', () => ({
  SsoAuthenticationService: class SsoAuthenticationService {
    initialize() { return Promise.resolve({ state: 'configuration-required' }) }
    attachRenderer() {}
    onState(listener: (snapshot: { state: string }) => void) { return state.subscribeSsoState(listener) }
    getState() { return { state: 'configuration-required' } }
    dispose() { return Promise.resolve() }
  },
}))
vi.mock('../../../src/main/sso/register-sso-handlers', () => ({ registerSsoHandlers: vi.fn(() => vi.fn()) }))
vi.mock('../../../src/main/settings/register-workbench-settings-handlers', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/main/settings/register-workbench-settings-handlers')>()
  return {
    ...actual,
    registerWorkbenchSettingsHandlers: (...args: Parameters<typeof actual.registerWorkbenchSettingsHandlers>) => {
      state.registerWorkbenchSettingsHandlers(...args)
      const dispose = actual.registerWorkbenchSettingsHandlers(...args)
      return () => {
        state.disposeWorkbenchSettingsHandlers()
        dispose()
      }
    },
  }
})
vi.mock('../../../src/main/access-client/single-instance', () => ({ configureAccessClientSingleInstance: vi.fn(() => false) }))
vi.mock('../../../src/main/observation/register-session-observation', () => ({ registerSessionObservation: vi.fn(() => vi.fn()) }))
vi.mock('../../../src/main/ipc/register-handlers', () => ({ registerSessionHandlers: vi.fn(() => vi.fn()) }))
vi.mock('../../../src/main/access-client/register-launch-error-handlers', () => ({ registerAccessClientLaunchHandlers: vi.fn(() => vi.fn()) }))
vi.mock('../../../src/main/access-client/register-bastion-launch-handlers', () => ({ registerBastionLaunchHandlers: vi.fn(() => vi.fn()) }))
vi.mock('../../../src/main/agent/register-session-mode-handlers', () => ({ registerSessionModeHandlers: vi.fn(() => vi.fn()) }))
vi.mock('../../../src/main/agent/register-confirmation-handlers', () => ({ registerConfirmationHandlers: vi.fn(() => vi.fn()) }))
vi.mock('../../../src/main/agent/register-execution-handlers', () => ({ registerExecutionHandlers: vi.fn(() => vi.fn()) }))
vi.mock('../../../src/main/agent/register-agent-handlers', () => ({ registerAgentHandlers: vi.fn(() => vi.fn()) }))
vi.mock('../../../src/main/settings/register-settings-handlers', () => ({ registerSettingsHandlers: vi.fn(() => vi.fn()) }))

state.registerChatHandlers.mockReturnValue(state.disposeChatHandlers)
const { createMainWindow } = await import('../../../src/main/main')

describe('main chat lifecycle', () => {
  it('awaits interrupted chat stream recovery before creating the first main window', async () => {
    const recovery = deferred<void>()
    const recoverInterruptedStreams = vi.fn(() => recovery.promise)
    const createMainWindow = vi.fn()

    const starting = recoverChatStreamsBeforeCreatingMainWindow(recoverInterruptedStreams, createMainWindow)

    expect(recoverInterruptedStreams).toHaveBeenCalledOnce()
    expect(createMainWindow).not.toHaveBeenCalled()
    recovery.resolve()
    await starting
    expect(createMainWindow).toHaveBeenCalledOnce()
  })

  it('creates the main window when task recovery finds an incompatible task document', async () => {
    const createMainWindow = vi.fn()

    await expect(recoverChatStreamsBeforeCreatingMainWindow(
      async () => { throw new Error('任务数据版本不兼容，请清空旧任务数据后重试。') },
      createMainWindow,
    )).resolves.toBeUndefined()

    expect(createMainWindow).toHaveBeenCalledOnce()
  })

  it('registers chat handlers for the window and disposes them when the window closes', () => {
    const window = createMainWindow() as unknown as (typeof state.windows)[number]

    expect(state.chatRepositoryConstructor).toHaveBeenCalledWith(join('D:\\terminal-agent-user-data', 'chat-workspaces.json'))
    expect(state.chatServiceConstructor).toHaveBeenCalledOnce()
    expect(state.registerChatHandlers).toHaveBeenCalledWith(expect.anything(), window.webContents, expect.anything(), expect.anything(), undefined, expect.objectContaining({ skillAuthorization: expect.anything() }))
    expect(state.workbenchPreferencesConstructor).toHaveBeenCalledWith(join('D:\\terminal-agent-user-data', 'workbench-preferences.json'))
    expect(state.registerWorkbenchSettingsHandlers).toHaveBeenCalledWith(expect.anything(), window.webContents, expect.any(Function), expect.any(Function))
    expect(state.setApplicationMenu).toHaveBeenCalledWith(null)
    expect(window.options).toMatchObject({ show: false })
    expect(window.shown).toBe(false)

    window.emitReadyToShow()
    expect(window.shown).toBe(false)
    const rendererReady = state.registerWorkbenchSettingsHandlers.mock.calls[0]?.[2] as (() => void) | undefined
    expect(rendererReady).toBeTypeOf('function')
    rendererReady?.()
    expect(window.shown).toBe(true)

    const onThemeSaved = state.registerWorkbenchSettingsHandlers.mock.calls[0]?.[3] as ((theme: 'pearl' | 'graphite') => void) | undefined
    expect(onThemeSaved).toBeTypeOf('function')
    onThemeSaved?.('graphite')
    expect(window.setTitleBarOverlay).toHaveBeenCalledWith({ color: '#25292e', symbolColor: '#f0f3f6', height: 48 })

    expect(() => window.emitClosed()).not.toThrow()
    expect(state.disposeChatHandlers).toHaveBeenCalledOnce()
    expect(state.disposeWorkbenchSettingsHandlers).toHaveBeenCalledOnce()
  })

  it('restores a minimized main window and returns focus only after SSO authentication succeeds', () => {
    const windowCountBefore = state.windows.length
    const window = createMainWindow() as unknown as (typeof state.windows)[number]
    const listener = state.ssoStateListeners.at(-1)
    expect(listener).toBeTypeOf('function')
    window.isMinimized.mockReturnValue(true)

    listener?.({ state: 'error' })
    expect(window.restore).not.toHaveBeenCalled()
    expect(window.show).not.toHaveBeenCalled()
    expect(window.focus).not.toHaveBeenCalled()

    listener?.({ state: 'authenticated' })

    expect(state.windows).toHaveLength(windowCountBefore + 1)
    expect(window.restore).toHaveBeenCalledOnce()
    expect(window.show).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledOnce()
    expect(window.restore.mock.invocationCallOrder[0]).toBeLessThan(window.show.mock.invocationCallOrder[0]!)
    expect(window.show.mock.invocationCallOrder[0]).toBeLessThan(window.focus.mock.invocationCallOrder[0]!)

    window.emitClosed()
    expect(state.ssoStateListeners).not.toContain(listener)
    listener?.({ state: 'authenticated' })
    expect(window.restore).toHaveBeenCalledOnce()
    expect(window.show).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledOnce()
  })

  it('shows and focuses a non-minimized main window after SSO authentication succeeds', () => {
    const window = createMainWindow() as unknown as (typeof state.windows)[number]
    const listener = state.ssoStateListeners.at(-1)
    expect(listener).toBeTypeOf('function')

    listener?.({ state: 'authenticated' })

    expect(window.restore).not.toHaveBeenCalled()
    expect(window.show).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledOnce()
    window.emitClosed()
  })

  it('finishes an in-flight theme save without touching a destroyed native title bar', async () => {
    const saved = deferred<{ theme: 'graphite' }>()
    state.workbenchSaveTheme.mockImplementationOnce(() => saved.promise)
    const window = createMainWindow() as unknown as (typeof state.windows)[number]
    const saveTheme = state.ipcHandlers.get('settings:workbench:save-theme')
    const saving = saveTheme?.({ sender: window.webContents }, 'pearl')

    expect(state.workbenchSaveTheme).toHaveBeenCalledWith('pearl')
    expect(() => window.emitClosed()).not.toThrow()
    saved.resolve({ theme: 'graphite' })

    await expect(saving).resolves.toEqual({ theme: 'graphite' })
    expect(window.setTitleBarOverlay).not.toHaveBeenCalled()
    expect(window.isDestroyed).toHaveBeenCalledOnce()
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}
