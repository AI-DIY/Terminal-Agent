import { app, BrowserWindow, Menu } from 'electron'
import { join } from 'node:path'
import { registerSessionHandlers } from './ipc/register-handlers'
import { PpkToOpenSshConverter, PrivateKeyLoader } from './ssh/private-key-loader'
import { KeyMaterialStore } from './ssh/key-material-store'
import { SessionService } from './ssh/session-service'
import { FileDirectSessionRepository } from './ssh/direct-session-repository'
import { Ssh2ClientAdapter } from './ssh/ssh2-client-adapter'
import { RawClientAdapter } from './ssh/raw-client-adapter'
import { AccessClientService } from './access-client/access-client-service'
import { AccessSessionResolver } from './access-client/access-session-resolver'
import { FileSavedSessionRepository } from './access-client/saved-session-repository'
import { readTempSession } from './access-client/temp-session-reader'
import { configureAccessClientSingleInstance } from './access-client/single-instance'
import { createAccessClientSessionOpener } from './access-client/session-opener'
import { AccessClientLaunchController } from './access-client/launch-controller'
import { registerAccessClientLaunchHandlers } from './access-client/register-launch-error-handlers'
import { BastionLaunchService } from './access-client/bastion-launch-service'
import { UnavailableBastionTargetResolver } from './access-client/bastion-target-resolver'
import { registerBastionLaunchHandlers } from './access-client/register-bastion-launch-handlers'
import { SessionModeController } from './agent/session-mode-controller'
import { SessionModeService } from './agent/session-mode-service'
import { registerSessionModeHandlers } from './agent/register-session-mode-handlers'
import { CandidateConfirmationService } from './agent/candidate-confirmation-service'
import { ConfirmationService } from './agent/confirmation-service'
import { registerConfirmationHandlers } from './agent/register-confirmation-handlers'
import { ApprovedExecutionAudit, ExecutionGateway } from './agent/execution-gateway'
import { registerExecutionHandlers } from './agent/register-execution-handlers'
import { registerAgentHandlers } from './agent/register-agent-handlers'
import { AgentScheduler } from './agent/scheduler'
import { AgentModelRuntime } from './agent/agent-model-runtime'
import { ModelProviderRouter } from './model/model-provider-router'
import { FileRegexRuleRepository } from './settings/regex-rule-repository'
import { RegexRuleSettingsService } from './settings/regex-rule-settings-service'
import { JsonSettingsRepository } from './settings/settings-repository'
import { ElectronSecretStore } from './settings/secret-store'
import { ModelSettingsService } from './settings/model-settings-service'
import { ModelProfileRepository } from './settings/model-profile-repository'
import { ModelProfileService } from './settings/model-profile-service'
import { registerSettingsHandlers } from './settings/register-settings-handlers'
import { HostMemorySettingsService } from './settings/host-memory-settings-service'
import { registerHostMemoryHandlers } from './settings/register-host-memory-handlers'
import { FileHostFactsRepository } from './facts/host-facts-repository'
import { HostFactsService } from './facts/host-facts-service'
import { registerSessionObservation, type SessionObservationRegistration } from './observation/register-session-observation'
import { recordPackagedWindowsInstallPath, writeWindowsInstallPath } from './windows/install-location'
import { ChatRepository } from './chat/chat-repository'
import { ChatService } from './chat/chat-service'
import { registerChatHandlers } from './chat/register-chat-handlers'
import { ChatRuntime } from './chat/chat-runtime'
import { buildChatContext } from './chat/chat-context-builder'
import { recoverChatStreamsBeforeCreatingMainWindow } from './chat/chat-startup'
import { WorkbenchPreferencesService } from './settings/workbench-preferences-service'
import { registerWorkbenchSettingsHandlers } from './settings/register-workbench-settings-handlers'
import { ShellHistoryRepository } from './shell-history/shell-history-repository'
import { ShellHistoryService } from './shell-history/shell-history-service'
import { registerShellHistoryHandlers } from './shell-history/register-shell-history-handlers'
import { registerShellHistoryLifecycle } from './shell-history/register-shell-history-lifecycle'
import { registerGracefulApplicationShutdown } from './application-shutdown'
import { createDefaultWorkbenchPreferences, type WorkbenchTheme } from '../shared/contracts'
import { titleBarOverlayForTheme } from './windows/title-bar-overlay'
import { DiagnosticsController, publicDiagnosticsError } from './diagnostics/diagnostics-controller'
import { registerDiagnosticsHandlers } from './diagnostics/register-diagnostics-handlers'
import { StructuredChatAgent } from './chat/structured-chat-agent'
import { ExecutionPlanService } from './chat/execution-plan-service'

let mainWindow: BrowserWindow | undefined
let isRestoringMainWindow = false
let diagnostics: DiagnosticsController | undefined
const sessions = new SessionService(new Ssh2ClientAdapter(), new PrivateKeyLoader(new PpkToOpenSshConverter()), new RawClientAdapter())
const keyMaterials = new KeyMaterialStore()
const secretStore = new ElectronSecretStore()
const directSessions = new FileDirectSessionRepository(join(app.getPath('userData'), 'direct-sessions.json'), secretStore)
const chats = new ChatService(new ChatRepository(join(app.getPath('userData'), 'chat-workspaces.json')))
const hostFacts = new HostFactsService(new FileHostFactsRepository(join(app.getPath('userData'), 'host-facts.json')))
const shellHistory = new ShellHistoryService(
  new ShellHistoryRepository(join(app.getPath('userData'), 'shell-history.json')),
  {
    connectionOpener: {
      canReconnect: reference => sessions.canReconnect(reference),
      duplicate: (sessionId, chatId) => sessions.duplicate(sessionId, chatId),
      reconnect: (reference, chatId) => sessions.reconnect(reference, chatId),
    },
  },
)
const shellHistoryLifecycle = registerShellHistoryLifecycle(sessions, chats, shellHistory)
const workbenchPreferences = new WorkbenchPreferencesService(join(app.getPath('userData'), 'workbench-preferences.json'))
const sessionModes = new SessionModeController(new SessionModeService(), sessions)
sessionModes.listen()
const confirmations = new ConfirmationService()
const candidateConfirmations = new CandidateConfirmationService(confirmations)
sessions.onClosed(event => candidateConfirmations.closeSession(event.sessionId))
const regexRules = new RegexRuleSettingsService(new FileRegexRuleRepository(join(app.getPath('userData'), 'regex-fence-rules.json')))
const legacyModelSettings = new JsonSettingsRepository()
const modelProfiles = new ModelProfileService(
  new ModelProfileRepository(join(app.getPath('userData'), 'model-profiles.json')),
  secretStore,
  { legacySettings: legacyModelSettings },
)
const modelSettings = new ModelSettingsService(modelProfiles)
const chatCompletions = new ModelProviderRouter()
const executionPlans = new ExecutionPlanService(chats as any, sessions, regexRules)
const structuredAgent = new StructuredChatAgent({
  complete: async (messages, format, signal) => {
    let output = ''
    await chatCompletions.stream(await modelProfiles.resolveRoute({ hasImages: messages.some(message => Array.isArray(message.content)) }).then(profile => ({ ...profile, contextLimit: profile.contextLimit ?? 1_024 })), messages, delta => { output += delta }, format, signal)
    return output
  },
})
const agentScheduler = new AgentScheduler(new AgentModelRuntime(modelSettings, chatCompletions, undefined, modelProfiles))
const approvedExecutionAudit = new ApprovedExecutionAudit()
const chatRuntime = new ChatRuntime({
  appendMessage: async request => {
    const snapshot = await chats.appendMessage(request)
    return { messageId: snapshot.chat.messages.at(-1)?.id }
  },
  updateMessage: async request => { await chats.updateMessage(request) },
  getRetryMessageId: (chatId, content) => chats.findRetryMessage(chatId, content),
  getContext: async chatId => {
    const snapshot = await chats.get(chatId)
    const facts = await Promise.all(snapshot.chat.shells.map(async shell => {
      if (shell.status !== 'open') return null
      const session = shell.sessionId ? sessions.snapshot().find(item => item.id === shell.sessionId) : undefined
      const observedHostname = shell.sessionId ? sessions.observedHostname(shell.sessionId) : undefined
      if (!session || !observedHostname) return null
      const allowed = await Promise.resolve()
        .then(() => hostMemorySettings.canObserveHost(session.hostname, observedHostname))
        .catch(() => false)
      if (!allowed) return null
      const record = await hostFacts.snapshot(observedHostname).catch(() => null)
      if (!record) return null
      const filtered = await hostMemorySettings.filterFacts(record)
      return { hostname: filtered.hostname, scope: 'host', values: filtered as unknown as Record<string, unknown> }
    }))
    const context = buildChatContext({
      messages: snapshot.chat.messages,
      shells: snapshot.chat.shells,
      facts: facts.filter((record): record is NonNullable<typeof record> => Boolean(record)),
      audit: approvedExecutionAudit.recent(snapshot.chat.shells.flatMap(shell => shell.sessionId ? [shell.sessionId] : [])),
    })
    return { messages: context, hasImages: snapshot.chat.messages.some(message => Array.isArray(message.content)), availableHostnames: snapshot.chat.shells.filter(shell => shell.status === 'open').map(shell => shell.hostname) }
  },
  resolveModel: async ({ hasImages = false }: { hasImages?: boolean } = {}) => {
    const profile = await modelProfiles.resolveRoute({ hasImages })
    return { ...profile, contextLimit: profile.contextLimit ?? 1_024 }
  },
  runStructured: (settings, input, signal) => structuredAgent.run(input, signal),
  materializePlan: plan => executionPlans.materialize(plan),
  stream: (settings, messages, onDelta, format, signal) => chatCompletions.stream(settings, messages, onDelta, format, signal),
})
const executionGateway = new ExecutionGateway(
  sessionModes,
  confirmations,
  regexRules,
  (sessionId, command) => {
    sessions.write(sessionId, `${command}\n`)
    return { kind: 'sent' as const }
  },
  approvedExecutionAudit,
)
const hostMemorySettings = new HostMemorySettingsService(join(app.getPath('userData'), 'host-memory-settings.json'))
let unregisterSessionEvents: (() => void) | undefined
let unregisterAccessClientLaunchEvents: (() => void) | undefined
let unregisterBastionLaunchEvents: (() => void) | undefined
let unregisterSessionModeHandlers: (() => void) | undefined
let unregisterConfirmationHandlers: (() => void) | undefined
let unregisterExecutionHandlers: (() => void) | undefined
let unregisterAgentHandlers: (() => void) | undefined
let unregisterSettingsHandlers: (() => void) | undefined
let unregisterChatHandlers: (() => void) | undefined
let unregisterShellHistoryHandlers: (() => void) | undefined
let unregisterWorkbenchSettingsHandlers: (() => void) | undefined
let unregisterHostMemoryHandlers: (() => void) | undefined
let unregisterDiagnosticsHandlers: (() => void) | undefined
let unregisterSessionObservation: SessionObservationRegistration | undefined
const accessClient = new AccessClientService(
  new AccessSessionResolver(new FileSavedSessionRepository(join(app.getPath('userData'), 'access-client-sessions.json')), readTempSession),
  createAccessClientSessionOpener(sessions),
)
const accessClientLaunches = new AccessClientLaunchController(accessClient)
const bastionLaunches = new BastionLaunchService(
  new UnavailableBastionTargetResolver(),
  createAccessClientSessionOpener(sessions),
)
sessions.onClosed(event => bastionLaunches.closeSession(event.sessionId))

export function createMainWindow(initialTheme: WorkbenchTheme = createDefaultWorkbenchPreferences().theme): BrowserWindow {
  Menu.setApplicationMenu(null)
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarOverlayForTheme(initialTheme),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  const rendererWindow = mainWindow
  const windowDiagnostics = new DiagnosticsController(rendererWindow.webContents)
  diagnostics = windowDiagnostics
  unregisterDiagnosticsHandlers = registerDiagnosticsHandlers(windowDiagnostics, rendererWindow.webContents)
  const onBeforeInput = (event: Electron.Event, input: Electron.Input): void => {
    const opensDevTools = input.type === 'keyDown'
      && input.control && input.shift && !input.alt && !input.meta
      && input.key.toLowerCase() === 'i'
    if (!opensDevTools) return
    event.preventDefault()
    void windowDiagnostics.openRendererDevTools().catch(error => {
      if (!rendererWindow.isDestroyed()) rendererWindow.webContents.send('diagnostics:error', publicDiagnosticsError(error))
    })
  }
  rendererWindow.webContents.on('before-input-event', onBeforeInput)

  mainWindow.on('closed', () => {
    unregisterDiagnosticsHandlers?.()
    unregisterDiagnosticsHandlers = undefined
    windowDiagnostics.dispose()
    if (diagnostics === windowDiagnostics) diagnostics = undefined
    unregisterSessionEvents?.()
    unregisterSessionEvents = undefined
    unregisterAccessClientLaunchEvents?.()
    unregisterAccessClientLaunchEvents = undefined
    unregisterBastionLaunchEvents?.()
    unregisterBastionLaunchEvents = undefined
    unregisterSessionModeHandlers?.()
    unregisterSessionModeHandlers = undefined
    unregisterConfirmationHandlers?.()
    unregisterConfirmationHandlers = undefined
    unregisterExecutionHandlers?.()
    unregisterExecutionHandlers = undefined
    unregisterAgentHandlers?.()
    unregisterAgentHandlers = undefined
    unregisterSettingsHandlers?.()
    unregisterSettingsHandlers = undefined
    unregisterChatHandlers?.()
    unregisterChatHandlers = undefined
    unregisterShellHistoryHandlers?.()
    unregisterShellHistoryHandlers = undefined
    unregisterWorkbenchSettingsHandlers?.()
    unregisterWorkbenchSettingsHandlers = undefined
    unregisterHostMemoryHandlers?.()
    unregisterHostMemoryHandlers = undefined
    unregisterSessionObservation?.()
    unregisterSessionObservation = undefined
    mainWindow = undefined
  })

  unregisterSessionEvents = registerSessionHandlers(sessions, keyMaterials, mainWindow.webContents, directSessions)
  unregisterAccessClientLaunchEvents = registerAccessClientLaunchHandlers(accessClientLaunches, mainWindow.webContents)
  unregisterBastionLaunchEvents = registerBastionLaunchHandlers(bastionLaunches, mainWindow.webContents)
  unregisterSessionModeHandlers = registerSessionModeHandlers(sessionModes, mainWindow.webContents)
  unregisterConfirmationHandlers = registerConfirmationHandlers(candidateConfirmations, mainWindow.webContents)
  unregisterExecutionHandlers = registerExecutionHandlers(executionGateway, mainWindow.webContents)
  unregisterAgentHandlers = registerAgentHandlers(agentScheduler, sessions, hostFacts, candidateConfirmations, mainWindow.webContents, executionGateway, { hostMemory: hostMemorySettings })
  unregisterSettingsHandlers = registerSettingsHandlers(modelSettings, regexRules, mainWindow.webContents, chatCompletions, modelProfiles)
  unregisterSessionObservation = registerSessionObservation(sessions, hostFacts, hostMemorySettings, mainWindow.webContents)
  unregisterHostMemoryHandlers = registerHostMemoryHandlers(
    hostMemorySettings,
    hostFacts,
    mainWindow.webContents,
    {
      acknowledge: token => unregisterSessionObservation?.acknowledge(token) ?? Promise.reject(new Error('Host memory observation is unavailable')),
      dismiss: token => unregisterSessionObservation?.dismiss(token) ?? Promise.resolve(),
      revokeHost: hostIdentity => unregisterSessionObservation?.revokeHost(hostIdentity) ?? Promise.reject(new Error('Host memory observation is unavailable')),
      restoreHostAuthorization: undo => unregisterSessionObservation?.restoreHostAuthorization(undo) ?? Promise.reject(new Error('Host memory observation is unavailable')),
      pending: () => unregisterSessionObservation?.pending() ?? [],
    },
  )
  unregisterChatHandlers = registerChatHandlers(chats, mainWindow.webContents, sessions, chatRuntime, executionPlans)
  unregisterShellHistoryHandlers = registerShellHistoryHandlers(shellHistory, mainWindow.webContents)
  unregisterWorkbenchSettingsHandlers = registerWorkbenchSettingsHandlers(
    workbenchPreferences,
    mainWindow.webContents,
    () => {
      if (mainWindow === rendererWindow) rendererWindow.show()
    },
    theme => {
      if (!rendererWindow.isDestroyed()) rendererWindow.setTitleBarOverlay(titleBarOverlayForTheme(theme))
    },
  )

  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (rendererUrl) {
    void mainWindow.loadURL(rendererUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

const isPrimaryInstance = configureAccessClientSingleInstance(app, accessClientLaunches)

if (isPrimaryInstance) {
  registerGracefulApplicationShutdown(app, () => sessions.closeAll(), () => shellHistoryLifecycle.drain(), () => diagnostics?.dispose())
  app.whenReady().then(async () => {
    void recordPackagedWindowsInstallPath({
      platform: process.platform,
      isPackaged: app.isPackaged,
      execPath: process.execPath,
      writeInstallPath: writeWindowsInstallPath,
    })
    void regexRules.load().catch(() => undefined)
    const initialPreferences = await workbenchPreferences.load().catch(createDefaultWorkbenchPreferences)
    await recoverChatStreamsBeforeCreatingMainWindow(
      () => chats.recoverInterruptedStreams(),
      () => createMainWindow(initialPreferences.theme),
    )
    void accessClientLaunches.tryOpenFromArgv(process.argv)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length !== 0 || isRestoringMainWindow) return
      isRestoringMainWindow = true
      void workbenchPreferences.load()
        .then(preferences => {
          if (BrowserWindow.getAllWindows().length === 0) createMainWindow(preferences.theme)
        })
        .catch(() => {
          if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
        })
        .finally(() => { isRestoringMainWindow = false })
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
