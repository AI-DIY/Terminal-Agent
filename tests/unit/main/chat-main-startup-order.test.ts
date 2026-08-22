import { describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => {
  const recovery = deferred<void>()
  return {
    recovery,
    windows: [] as Array<{ webContents: { send: ReturnType<typeof vi.fn> } }>,
    whenReady: vi.fn(async () => undefined),
    recoverInterruptedStreams: vi.fn(() => recovery.promise),
    recordPackagedWindowsInstallPath: vi.fn(async () => undefined),
    regexLoad: vi.fn(async () => undefined),
    setApplicationMenu: vi.fn(),
  }
})

vi.mock('electron', () => {
  class BrowserWindow {
    static getAllWindows() { return state.windows }
    readonly webContents = { send: vi.fn() }
    constructor() { state.windows.push(this) }
    on() {}
    loadURL = vi.fn().mockResolvedValue(undefined)
    loadFile = vi.fn().mockResolvedValue(undefined)
  }

  return {
    app: {
      getPath: vi.fn(() => 'D:\\terminal-agent-user-data'),
      on: vi.fn(),
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

await import('../../../src/main/main')

describe('main chat startup ordering', () => {
  it('starts install and regex initialization before recovery, then creates the first window after recovery settles', async () => {
    try {
      await vi.waitFor(() => {
        expect(state.recordPackagedWindowsInstallPath).toHaveBeenCalledOnce()
        expect(state.regexLoad).toHaveBeenCalledOnce()
        expect(state.recoverInterruptedStreams).toHaveBeenCalledOnce()
      })
      expect(state.windows).toHaveLength(0)

      state.recovery.resolve()
      await vi.waitFor(() => expect(state.windows).toHaveLength(1))
      expect(state.setApplicationMenu).toHaveBeenCalledWith(null)
    } finally {
      state.recovery.resolve()
      await vi.waitFor(() => expect(state.windows).toHaveLength(1))
    }
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}
