import { beforeEach, describe, expect, it, vi } from 'vitest'

type ThemePreferences = { theme: 'pearl' | 'graphite' }
type MockWindow = {
  options: {
    show?: boolean
    titleBarStyle?: string
    titleBarOverlay?: { color: string; symbolColor: string; height: number }
  }
  webContents: {
    send: ReturnType<typeof vi.fn>
    on: ReturnType<typeof vi.fn>
    removeListener: ReturnType<typeof vi.fn>
  }
  emitClosed(): void
}

const state = vi.hoisted(() => {
  let recovery = deferred<void>()
  let initialPreferences = deferred<ThemePreferences>()
  const windows: MockWindow[] = []
  const listeners = new Map<string, () => void>()
  const whenReady = vi.fn()
  const recoverInterruptedStreams = vi.fn()
  const loadWorkbenchPreferences = vi.fn()
  const recordPackagedWindowsInstallPath = vi.fn()
  const regexLoad = vi.fn()
  const setApplicationMenu = vi.fn()
  const appOn = vi.fn((event: string, listener: () => void) => { listeners.set(event, listener) })

  const reset = () => {
    recovery = deferred<void>()
    initialPreferences = deferred<ThemePreferences>()
    windows.splice(0)
    listeners.clear()
    whenReady.mockReset().mockResolvedValue(undefined)
    recoverInterruptedStreams.mockReset().mockImplementation(() => recovery.promise)
    loadWorkbenchPreferences.mockReset().mockImplementation(() => initialPreferences.promise)
    recordPackagedWindowsInstallPath.mockReset().mockResolvedValue(undefined)
    regexLoad.mockReset().mockResolvedValue(undefined)
    setApplicationMenu.mockReset()
    appOn.mockClear()
  }

  reset()
  return {
    get recovery() { return recovery },
    get initialPreferences() { return initialPreferences },
    windows,
    listeners,
    whenReady,
    recoverInterruptedStreams,
    loadWorkbenchPreferences,
    recordPackagedWindowsInstallPath,
    regexLoad,
    setApplicationMenu,
    appOn,
    reset,
  }
})

vi.mock('electron', () => {
  class BrowserWindow {
    static getAllWindows() { return state.windows }
    readonly webContents = { send: vi.fn(), on: vi.fn(), removeListener: vi.fn() }
    private readonly listeners = new Map<string, Array<() => void>>()
    readonly options: MockWindow['options']

    constructor(options: MockWindow['options']) {
      this.options = options
      state.windows.push(this as unknown as MockWindow)
    }

    on(event: string, listener: () => void) {
      const listeners = this.listeners.get(event) ?? []
      listeners.push(listener)
      this.listeners.set(event, listeners)
    }
    emitClosed() {
      const index = state.windows.indexOf(this as unknown as MockWindow)
      if (index >= 0) state.windows.splice(index, 1)
      for (const listener of this.listeners.get('closed') ?? []) listener()
    }
    loadURL = vi.fn().mockResolvedValue(undefined)
    loadFile = vi.fn().mockResolvedValue(undefined)
  }

  return {
    app: {
      getPath: vi.fn(() => 'D:\\terminal-agent-user-data'),
      on: state.appOn,
      quit: vi.fn(),
      whenReady: state.whenReady,
      isPackaged: false,
    },
    BrowserWindow,
    Menu: { setApplicationMenu: state.setApplicationMenu },
    safeStorage: { decryptString: vi.fn(), encryptString: vi.fn(), isEncryptionAvailable: vi.fn(() => true) },
    dialog: { showOpenDialog: vi.fn() },
    ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  }
})

vi.mock('../../../src/main/chat/chat-repository', () => ({ ChatRepository: class ChatRepository {} }))
vi.mock('../../../src/main/chat/chat-service', () => ({
  ChatService: class ChatService {
    recoverInterruptedStreams() { return state.recoverInterruptedStreams() }
    onChanged() { return () => undefined }
  },
}))
vi.mock('../../../src/main/settings/regex-rule-settings-service', () => ({
  RegexRuleSettingsService: class RegexRuleSettingsService {
    load() { return state.regexLoad() }
  },
}))
vi.mock('../../../src/main/windows/install-location', () => ({
  recordPackagedWindowsInstallPath: state.recordPackagedWindowsInstallPath,
  writeWindowsInstallPath: vi.fn(),
}))
vi.mock('../../../src/main/access-client/single-instance', () => ({ configureAccessClientSingleInstance: vi.fn(() => true) }))
vi.mock('../../../src/main/observation/register-session-observation', () => ({ registerSessionObservation: vi.fn(() => vi.fn()) }))
vi.mock('../../../src/main/ipc/register-handlers', () => ({ registerSessionHandlers: vi.fn(() => vi.fn()) }))
vi.mock('../../../src/main/access-client/register-launch-error-handlers', () => ({ registerAccessClientLaunchHandlers: vi.fn(() => vi.fn()) }))
vi.mock('../../../src/main/access-client/register-bastion-launch-handlers', () => ({ registerBastionLaunchHandlers: vi.fn(() => vi.fn()) }))
vi.mock('../../../src/main/agent/register-session-mode-handlers', () => ({ registerSessionModeHandlers: vi.fn(() => vi.fn()) }))
vi.mock('../../../src/main/agent/register-confirmation-handlers', () => ({ registerConfirmationHandlers: vi.fn(() => vi.fn()) }))
vi.mock('../../../src/main/agent/register-execution-handlers', () => ({ registerExecutionHandlers: vi.fn(() => vi.fn()) }))
vi.mock('../../../src/main/agent/register-agent-handlers', () => ({ registerAgentHandlers: vi.fn(() => vi.fn()) }))
vi.mock('../../../src/main/settings/register-settings-handlers', () => ({ registerSettingsHandlers: vi.fn(() => vi.fn()) }))
vi.mock('../../../src/main/settings/register-host-memory-handlers', () => ({ registerHostMemoryHandlers: vi.fn(() => vi.fn()) }))
vi.mock('../../../src/main/chat/register-chat-handlers', () => ({ registerChatHandlers: vi.fn(() => vi.fn()) }))
vi.mock('../../../src/main/shell-history/register-shell-history-handlers', () => ({ registerShellHistoryHandlers: vi.fn(() => vi.fn()) }))
vi.mock('../../../src/main/settings/register-workbench-settings-handlers', () => ({ registerWorkbenchSettingsHandlers: vi.fn(() => vi.fn()) }))
vi.mock('../../../src/main/settings/workbench-preferences-service', () => ({
  WorkbenchPreferencesService: class WorkbenchPreferencesService {
    load() { return state.loadWorkbenchPreferences() }
  },
}))

beforeEach(() => {
  state.reset()
  vi.resetModules()
})

describe('main chat startup ordering', () => {
  it('waits for persisted preferences before recovery and creates the first window with its graphite overlay', async () => {
    await importMain()
    await vi.waitFor(() => {
      expect(state.recordPackagedWindowsInstallPath).toHaveBeenCalledOnce()
      expect(state.regexLoad).toHaveBeenCalledOnce()
      expect(state.loadWorkbenchPreferences).toHaveBeenCalledOnce()
    })
    expect(state.recoverInterruptedStreams).not.toHaveBeenCalled()
    expect(state.windows).toHaveLength(0)

    state.initialPreferences.resolve({ theme: 'graphite' })
    await vi.waitFor(() => expect(state.recoverInterruptedStreams).toHaveBeenCalledOnce())
    expect(state.windows).toHaveLength(0)

    state.recovery.resolve()
    await vi.waitFor(() => expect(state.windows).toHaveLength(1))
    expect(state.windows[0]?.options).toMatchObject({
      show: false,
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#25292e', symbolColor: '#f0f3f6', height: 48 },
    })
  }, 15_000)

  it('falls back to the default pearl overlay when the first preference load fails', async () => {
    state.loadWorkbenchPreferences.mockRejectedValueOnce(new Error('preferences unavailable'))
    await importMain()

    await vi.waitFor(() => expect(state.recoverInterruptedStreams).toHaveBeenCalledOnce())
    state.recovery.resolve()
    await vi.waitFor(() => expect(state.windows).toHaveLength(1))
    expect(state.windows[0]?.options.titleBarOverlay).toEqual({ color: '#f0f3f6', symbolColor: '#1d242c', height: 48 })
  })

  it('reloads saved preferences when activating after the last window closes', async () => {
    await importMain()
    await startFirstWindow('pearl')
    state.windows[0]?.emitClosed()
    expect(state.windows).toHaveLength(0)

    const activate = await activateListener()
    state.loadWorkbenchPreferences.mockClear().mockResolvedValueOnce({ theme: 'graphite' })
    activate()

    await vi.waitFor(() => expect(state.loadWorkbenchPreferences).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(state.windows).toHaveLength(1))
    expect(state.windows[0]?.options.titleBarOverlay).toEqual({ color: '#25292e', symbolColor: '#f0f3f6', height: 48 })
  })

  it('serializes consecutive activate events while restored preferences are loading', async () => {
    await importMain()
    await startFirstWindow('pearl')
    state.windows[0]?.emitClosed()
    expect(state.windows).toHaveLength(0)

    const activate = await activateListener()
    const restoredPreferences = deferred<ThemePreferences>()
    state.loadWorkbenchPreferences.mockClear().mockImplementation(() => restoredPreferences.promise)
    activate()
    activate()

    expect(state.loadWorkbenchPreferences).toHaveBeenCalledOnce()
    restoredPreferences.resolve({ theme: 'graphite' })
    await vi.waitFor(() => expect(state.windows).toHaveLength(1))
    expect(state.windows[0]?.options.titleBarOverlay).toEqual({ color: '#25292e', symbolColor: '#f0f3f6', height: 48 })
  })
})

async function startFirstWindow(theme: ThemePreferences['theme']): Promise<void> {
  await vi.waitFor(() => expect(state.loadWorkbenchPreferences).toHaveBeenCalledOnce())
  state.initialPreferences.resolve({ theme })
  await vi.waitFor(() => expect(state.recoverInterruptedStreams).toHaveBeenCalledOnce())
  state.recovery.resolve()
  await vi.waitFor(() => expect(state.windows).toHaveLength(1))
}

async function activateListener(): Promise<() => void> {
  await vi.waitFor(() => expect(state.listeners.get('activate')).toBeTypeOf('function'))
  return state.listeners.get('activate') as () => void
}

async function importMain(): Promise<void> {
  await import('../../../src/main/main')
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}
