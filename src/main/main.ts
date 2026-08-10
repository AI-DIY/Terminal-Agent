import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { registerSessionHandlers } from './ipc/register-handlers'
import { PpkToOpenSshConverter, PrivateKeyLoader } from './ssh/private-key-loader'
import { KeyMaterialStore } from './ssh/key-material-store'
import { SessionService } from './ssh/session-service'
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
import { SessionModeController } from './agent/session-mode-controller'
import { SessionModeService } from './agent/session-mode-service'
import { registerSessionModeHandlers } from './agent/register-session-mode-handlers'
import { CandidateConfirmationService } from './agent/candidate-confirmation-service'
import { ConfirmationService } from './agent/confirmation-service'
import { registerConfirmationHandlers } from './agent/register-confirmation-handlers'
import { ExecutionGateway } from './agent/execution-gateway'
import { registerExecutionHandlers } from './agent/register-execution-handlers'
import { registerAgentHandlers } from './agent/register-agent-handlers'
import { AgentScheduler } from './agent/scheduler'
import { AgentModelRuntime } from './agent/agent-model-runtime'
import { ChatCompletionsClient } from './model/chat-completions-client'
import { FileRegexRuleRepository } from './settings/regex-rule-repository'
import { RegexRuleSettingsService } from './settings/regex-rule-settings-service'
import { JsonSettingsRepository } from './settings/settings-repository'
import { ElectronSecretStore } from './settings/secret-store'
import { ModelSettingsService } from './settings/model-settings-service'
import { registerSettingsHandlers } from './settings/register-settings-handlers'
import { FileHostFactsRepository } from './facts/host-facts-repository'
import { HostFactsService } from './facts/host-facts-service'
import { registerSessionObservation } from './observation/register-session-observation'

let mainWindow: BrowserWindow | undefined
const sessions = new SessionService(new Ssh2ClientAdapter(), new PrivateKeyLoader(new PpkToOpenSshConverter()), new RawClientAdapter())
const keyMaterials = new KeyMaterialStore()
const sessionModes = new SessionModeController(new SessionModeService(), sessions)
sessionModes.listen()
const confirmations = new ConfirmationService()
const candidateConfirmations = new CandidateConfirmationService(confirmations)
sessions.onClosed(event => candidateConfirmations.closeSession(event.sessionId))
const regexRules = new RegexRuleSettingsService(new FileRegexRuleRepository(join(app.getPath('userData'), 'regex-fence-rules.json')))
const modelSettings = new ModelSettingsService(new JsonSettingsRepository(), new ElectronSecretStore())
const agentScheduler = new AgentScheduler(new AgentModelRuntime(modelSettings, new ChatCompletionsClient()))
const executionGateway = new ExecutionGateway(
  sessionModes,
  confirmations,
  regexRules,
  (sessionId, command) => {
    sessions.write(sessionId, `${command}\n`)
    return { kind: 'sent' as const }
  },
)
const hostFacts = new HostFactsService(new FileHostFactsRepository(join(app.getPath('userData'), 'host-facts.json')))
registerSessionObservation(sessions, hostFacts)
let unregisterSessionEvents: (() => void) | undefined
let unregisterAccessClientLaunchEvents: (() => void) | undefined
let unregisterSessionModeHandlers: (() => void) | undefined
let unregisterConfirmationHandlers: (() => void) | undefined
let unregisterExecutionHandlers: (() => void) | undefined
let unregisterAgentHandlers: (() => void) | undefined
let unregisterSettingsHandlers: (() => void) | undefined
const accessClient = new AccessClientService(
  new AccessSessionResolver(new FileSavedSessionRepository(join(app.getPath('userData'), 'access-client-sessions.json')), readTempSession),
  createAccessClientSessionOpener(sessions),
)
const accessClientLaunches = new AccessClientLaunchController(accessClient)

export function createMainWindow(): BrowserWindow {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (rendererUrl) {
    void mainWindow.loadURL(rendererUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    unregisterSessionEvents?.()
    unregisterSessionEvents = undefined
    unregisterAccessClientLaunchEvents?.()
    unregisterAccessClientLaunchEvents = undefined
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
    mainWindow = undefined
  })

  unregisterSessionEvents = registerSessionHandlers(sessions, keyMaterials, mainWindow.webContents)
  unregisterAccessClientLaunchEvents = registerAccessClientLaunchHandlers(accessClientLaunches, mainWindow.webContents)
  unregisterSessionModeHandlers = registerSessionModeHandlers(sessionModes, mainWindow.webContents)
  unregisterConfirmationHandlers = registerConfirmationHandlers(candidateConfirmations, mainWindow.webContents)
  unregisterExecutionHandlers = registerExecutionHandlers(executionGateway, mainWindow.webContents)
  unregisterAgentHandlers = registerAgentHandlers(agentScheduler, sessions, hostFacts, candidateConfirmations, mainWindow.webContents, executionGateway)
  unregisterSettingsHandlers = registerSettingsHandlers(modelSettings, regexRules, mainWindow.webContents)

  return mainWindow
}

const isPrimaryInstance = configureAccessClientSingleInstance(app, accessClientLaunches)

if (isPrimaryInstance) {
  app.whenReady().then(() => {
    void regexRules.load().catch(() => undefined)
    createMainWindow()
    void accessClientLaunches.tryOpenFromArgv(process.argv)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow()
      }
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
