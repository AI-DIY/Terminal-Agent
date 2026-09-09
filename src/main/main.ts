import { app, BrowserWindow, Menu, session } from 'electron'
import { join } from 'node:path'
import { registerSessionHandlers } from './ipc/register-handlers'
import { registerFileTransferHandlers } from './ipc/register-file-transfer-handlers'
import { PpkToOpenSshConverter, PrivateKeyLoader } from './ssh/private-key-loader'
import { KeyMaterialStore } from './ssh/key-material-store'
import { SessionService } from './ssh/session-service'
import { FileDirectSessionRepository } from './ssh/direct-session-repository'
import { Ssh2ClientAdapter } from './ssh/ssh2-client-adapter'
import { createSshConnectionDiagnostics } from './ssh/ssh-connection-diagnostics'
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
import { chatRuntimeEventSchema, createDefaultWorkbenchPreferences, type WorkbenchTheme } from '../shared/contracts'
import { titleBarOverlayForTheme } from './windows/title-bar-overlay'
import { DiagnosticsController, publicDiagnosticsError } from './diagnostics/diagnostics-controller'
import { registerDiagnosticsHandlers } from './diagnostics/register-diagnostics-handlers'
import { DEFAULT_NUTS_FEED_URL, UpdaterService } from './updater/updater-service'
import { createElectronSessionUpdaterFetcher } from './updater/electron-session-fetcher'
import { registerUpdaterHandlers } from './updater/register-updater-handlers'
/* eslint-disable @typescript-eslint/no-explicit-any */
import { buildStructuredShellContextEntries, StructuredChatAgent } from './chat/structured-chat-agent'
import { ExecutionPlanService } from './chat/execution-plan-service'
import { PlanResultAutoContinue } from './chat/plan-result-auto-continue'
import { modelHostname, uniqueModelHostnames } from '../shared/model-context'
import { normalizeChatContextSessionIds } from '../shared/chat-context-selection'
import { normalizeBuiltInSkillIds } from '../shared/built-in-skills'
import { SsoConfigService, getLegacySsoConfigPath, getPreviousSsoConfigPath, getSsoConfigPath } from './settings/sso-config-service'
import { isAtomicJsonStoreInvalidDataError } from './persistence/atomic-json-store'
import { resolveSsoConfigHomeDirectory } from './settings/sso-config-home'
import { SsoAuthenticationService } from './sso/sso-authentication-service'
import { registerSsoHandlers } from './sso/register-sso-handlers'
import { SkillService, resolveSkillsDirectory } from './skills/skill-service'
import { registerSkillHandlers } from './skills/register-skill-handlers'

let mainWindow: BrowserWindow | undefined
let isRestoringMainWindow = false
let diagnostics: DiagnosticsController | undefined
// SSO and model settings intentionally share the user-scoped
// `.terminal-agent/user-config.yml` document.  The prior JSON locations are
// supplied only as one-time migration sources and are never written after the
// canonical path is available.
// Keeping one resolved path here prevents the two repositories from
// accidentally writing separate copies when packaged and development homes
// differ.
const userConfigHome = resolveSsoConfigHomeDirectory(app.getPath('home'), process.env, app.isPackaged)
const userConfigPath = getSsoConfigPath(userConfigHome)
const ssoConfig = new SsoConfigService(userConfigPath, {
  legacyPaths: [
    getPreviousSsoConfigPath(userConfigHome),
    getLegacySsoConfigPath(userConfigHome),
  ],
})
const ssoAuth = new SsoAuthenticationService(ssoConfig)

/**
 * Dynamic Skills are a local-code execution capability.  Keep the
 * authentication check in the main process, next to the runtime bridge, so a
 * renderer payload or a stale context snapshot cannot activate it while the
 * SSO identity is absent.
 */
function skillsAuthenticated(): boolean {
  try {
    return ssoAuth.getState().state === 'authenticated'
  } catch {
    return false
  }
}
const sessions = new SessionService(
  new Ssh2ClientAdapter(createSshConnectionDiagnostics(process.execPath)),
  new PrivateKeyLoader(new PpkToOpenSshConverter()),
  new RawClientAdapter(),
)
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
const skills = new SkillService({
  skillsDirectory: resolveSkillsDirectory({
    isPackaged: app.isPackaged,
    appPath: typeof (app as unknown as { getAppPath?: () => string }).getAppPath === 'function'
      ? (app as unknown as { getAppPath: () => string }).getAppPath()
      : undefined,
    executablePath: process.execPath,
  }),
  statePath: join(app.getPath('userData'), 'skills-state.json'),
})
const sessionModes = new SessionModeController(new SessionModeService(), sessions)
sessionModes.listen()
const confirmations = new ConfirmationService()
const candidateConfirmations = new CandidateConfirmationService(confirmations)
sessions.onClosed(event => candidateConfirmations.closeSession(event.sessionId))
const regexRules = new RegexRuleSettingsService(new FileRegexRuleRepository(join(app.getPath('userData'), 'regex-fence-rules.json')))
const legacyModelSettings = new JsonSettingsRepository()
const legacyModelProfiles = new ModelProfileRepository(join(app.getPath('userData'), 'model-profiles.json'))
const modelProfiles = new ModelProfileService(
  new ModelProfileRepository(userConfigPath, { userConfig: true }),
  secretStore,
  // API keys are deliberately stored as plain YAML in the user-config file as
  // requested by the product configuration.  The encrypted secret store is
  // retained solely as a one-time migration/legacy fallback.
  { legacySettings: legacyModelSettings, legacyProfiles: legacyModelProfiles, plaintextApiKeys: true },
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
  getContext: async (chatId, options = {}) => {
    const snapshot = await chats.get(chatId)
    const requestedSshContextLines = options.sshContextLines ?? 50
    const sshContextLines = Number.isFinite(requestedSshContextLines)
      ? Math.max(0, Math.floor(requestedSshContextLines))
      : 50
    const onlineSessions = sessions.snapshot().map(session => ({ ...session, recentLines: sessions.recentLines(session.id, sshContextLines) }))
    const contextEntries = buildStructuredShellContextEntries(snapshot.chat.shells, onlineSessions)
    const selectedSessionIds = normalizeChatContextSessionIds(
      contextEntries.map(entry => ({
        id: entry.sessionId,
        hostname: entry.shell.hostname,
        ...(entry.shell.observedHostname ? { observedHostname: entry.shell.observedHostname } : {}),
        title: entry.shell.title,
        status: 'open' as const,
      })),
      options.sshContextSessionIds === undefined ? undefined : [...options.sshContextSessionIds],
    )
    const selectedSessionIdSet = new Set(selectedSessionIds)
    // Keep all explicitly selected connections (including alternate #2/#3
    // connections).  The structured agent's legacy dedupe remains available
    // to direct callers that do not set preserveShellConnections.
    const availableShells = contextEntries
      .filter(entry => selectedSessionIdSet.has(entry.sessionId))
      .map(entry => entry.shell)
    const allOnlineShells = contextEntries.map(entry => entry.shell)
    // Execution audit entries are connection-scoped too.  Do not leak audit
    // output from a Shell the user explicitly excluded from this request.
    const onlineShellIds = selectedSessionIds
    const facts = await Promise.all(snapshot.chat.shells.map(async shell => {
      if (shell.status !== 'open' || !shell.sessionId || !selectedSessionIdSet.has(shell.sessionId)) return null
      const session = onlineSessions.find(item => item.id === shell.sessionId)
      const observedHostname = shell.sessionId ? sessions.observedHostname(shell.sessionId) : undefined
      // Host facts are keyed only by a validated real hostname. A stale
      // observation may contain the bastion address (or malformed text), so
      // fall back through persisted/session identities without ever using an
      // IP as the host-memory key.
      const hostIdentity = modelHostname(observedHostname)
        ?? modelHostname(shell.observedHostname)
        ?? modelHostname(session?.hostname)
        ?? modelHostname(shell.hostname)
      if (!session || !hostIdentity) return null
      const allowed = await Promise.resolve()
        .then(() => hostMemorySettings.canObserveHost(session.hostname, hostIdentity))
        .catch(() => false)
      if (!allowed) return null
      const record = await hostFacts.snapshot(hostIdentity).catch(() => null)
      if (!record) return null
      const filtered = await hostMemorySettings.filterFacts(record)
      return { hostname: filtered.hostname, scope: 'host', values: filtered as unknown as Record<string, unknown> }
    }))
    const context = buildChatContext({
      messages: snapshot.chat.messages,
      shells: availableShells.map(shell => ({ ...shell, status: 'open' as const })),
      facts: facts.filter((record): record is NonNullable<typeof record> => Boolean(record)),
      audit: approvedExecutionAudit.recent(onlineShellIds),
      ...(options.maxMessages === undefined ? {} : { maxMessages: options.maxMessages }),
    })
    // Do not even expose the dynamic catalogue/documents to an unauthenticated
    // model turn.  The IPC handler applies the same gate to the incoming
    // request, while this second check protects direct/trusted callers of the
    // runtime and closes the logout/context-race window.
    let skillCatalog: import('../shared/skill-contracts').SkillSummary[] = []
    let selectedSkillIds: import('../shared/skill-contracts').SkillId[] = []
    let skillDocuments: import('../shared/skill-contracts').SkillDocument[] = []
    const skillsAllowedForContext = skillsAuthenticated()
    if (skillsAllowedForContext) {
      try { skillCatalog = (await skills.list()).skills.filter(skill => skill.enabled) } catch { /* Skills are optional for ordinary chat. */ }
      const requestedSkillIds = [...new Set(options.selectedSkillIds ?? [])]
      const enabledById = new Map(skillCatalog.map(skill => [skill.id, skill]))
      selectedSkillIds = skillsAuthenticated() ? requestedSkillIds.filter(skillId => enabledById.has(skillId)) : []
      skillDocuments = skillsAuthenticated()
        ? await Promise.all(selectedSkillIds.map(skillId => skills.load({ id: skillId }).catch(() => undefined))).then(items => items.filter((item): item is import('../shared/skill-contracts').SkillDocument => Boolean(item)))
        : []
    }
    if (!skillsAuthenticated()) {
      skillCatalog = []
      selectedSkillIds = []
      skillDocuments = []
    }
    return {
      messages: context,
      hasImages: snapshot.chat.messages.some(message => Array.isArray(message.content)),
      // Host identity is the canonical hostname. When the renderer supplied
      // an explicit selection, restrict the planner's allow-list to those
      // selected hosts so a reviewed plan cannot silently execute elsewhere.
      // Legacy callers that omit the option retain the historical all-online
      // projection.
      availableHostnames: uniqueModelHostnames((options.sshContextSessionIds === undefined ? allOnlineShells : availableShells).map(shell => shell.hostname)),
      availableShells,
      // Selection is intentional, so alternate connections with the same
      // hostname must remain available to the model instead of being
      // collapsed back to the historical one-per-host projection.
      preserveShellConnections: true,
      skillIds: skillsAuthenticated() ? normalizeBuiltInSkillIds(options.skillIds) : [],
      skillCatalog,
      selectedSkillIds,
      skillDocuments,
    }
  },
  resolveModel: async ({ hasImages = false }: { hasImages?: boolean } = {}) => {
    const profile = await modelProfiles.resolveRoute({ hasImages })
    return { ...profile, contextLimit: profile.contextLimit ?? 1_024 }
  },
  runStructured: (settings, input, signal, onStage) => structuredAgent.run(input, signal, onStage),
  materializePlan: plan => executionPlans.materialize(plan),
  stream: (settings, messages, onDelta, format, signal) => chatCompletions.stream(settings, messages, onDelta, format, signal),
  skillRuntime: {
    loadSkill: (skillId, signal) => {
      if (!skillsAuthenticated()) return Promise.reject(new Error('未登录状态不能使用技能'))
      if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
      return skills.load({ id: skillId })
    },
    readSkillFile: (skillId, path, signal) => {
      if (!skillsAuthenticated()) return Promise.reject(new Error('未登录状态不能使用技能'))
      if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
      return skills.readFile({ id: skillId, path })
    },
    runSkillCommand: (request, signal) => {
      if (!skillsAuthenticated()) return Promise.reject(new Error('未登录状态不能使用技能'))
      return skills.runCommand(request, signal)
    },
  },
})
;(chatRuntime as ChatRuntime & { planService?: ExecutionPlanService }).planService = executionPlans
const planResultAutoContinue = new PlanResultAutoContinue(
  sessions,
  chatRuntime,
  event => {
    const target = mainWindow
    if (!target || target.isDestroyed() || target.webContents.isDestroyed()) return
    target.webContents.send('chat:event', chatRuntimeEventSchema.parse(event))
  },
)
executionPlans.setResultOutputWatcher(planResultAutoContinue)
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
const applicationVersion = readApplicationVersion()
const updater = new UpdaterService({
  currentVersion: applicationVersion,
  tempDirectory: join(app.getPath('temp'), 'terminal-agent-updates'),
  // Nuts update service used by production Windows builds.
  feedUrl: DEFAULT_NUTS_FEED_URL,
  downloadConcurrency: 4,
  // Node's fetch ignores Chromium's proxy resolver.  Use the same default
  // session as the app window so update traffic honours Windows/PAC/VPN proxy
  // policy without hard-coding a proxy address.
  fetch: createElectronSessionUpdaterFetcher(() => session.defaultSession),
  // Keep the normal persistence/session shutdown path after the installer
  // launches; NSIS owns replacement and any post-install application launch.
  exit: code => code === 0 ? app.quit() : app.exit(code),
})
let unregisterSessionEvents: (() => void) | undefined
let unregisterFileTransferHandlers: (() => void) | undefined
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
let unregisterUpdaterHandlers: (() => void) | undefined
let unregisterSessionObservation: SessionObservationRegistration | undefined
let unregisterSsoHandlers: (() => void) | undefined
let unregisterSkillHandlers: (() => void) | undefined

/**
 * Electron exposes `app.getVersion()` in production.  A few lightweight
 * startup/test hosts intentionally provide only the small subset of the app
 * API they exercise, so keep updater initialization non-fatal there too.
 */
function readApplicationVersion(): string {
  try {
    const getter = (app as unknown as { getVersion?: () => unknown }).getVersion
    const version = typeof getter === 'function' ? getter.call(app) : undefined
    if (typeof version === 'string' && version.trim()) return version
  } catch { /* Fall through to package/environment defaults. */ }
  const packageVersion = process.env.npm_package_version?.trim()
  return packageVersion || '2.1.1'
}

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
  // The SSO provider uses a short-lived secondary BrowserWindow.  Once its
  // capture succeeds, return attention to this already-created local
  // renderer instead of creating or navigating another application window.
  const unregisterSsoMainWindowState = ssoAuth.onState(snapshot => {
    if (snapshot.state !== 'authenticated') return
    if (mainWindow !== rendererWindow || rendererWindow.isDestroyed()) return
    if (rendererWindow.isMinimized()) rendererWindow.restore()
    rendererWindow.show()
    rendererWindow.focus()
  })
  // The renderer must be visible while SSO is authenticating so its local
  // progress animation can stay in the foreground.  The remote platform page
  // itself is loaded in a hidden, short-lived authentication window.
  const showRendererAfterLoad = (): void => {
    rendererWindow.webContents.removeListener?.('did-finish-load', showRendererAfterLoad)
    if (!rendererWindow.isDestroyed()) rendererWindow.show()
  }
  rendererWindow.webContents.on('did-finish-load', showRendererAfterLoad)
  const windowDiagnostics = new DiagnosticsController(rendererWindow.webContents)
  diagnostics = windowDiagnostics
  unregisterDiagnosticsHandlers = registerDiagnosticsHandlers(windowDiagnostics, rendererWindow.webContents)
  unregisterUpdaterHandlers = registerUpdaterHandlers(updater, rendererWindow.webContents)
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
    unregisterSsoMainWindowState()
    unregisterDiagnosticsHandlers?.()
    unregisterDiagnosticsHandlers = undefined
    unregisterUpdaterHandlers?.()
    unregisterUpdaterHandlers = undefined
    windowDiagnostics.dispose()
    if (diagnostics === windowDiagnostics) diagnostics = undefined
    unregisterSessionEvents?.()
    unregisterSessionEvents = undefined
    unregisterFileTransferHandlers?.()
    unregisterFileTransferHandlers = undefined
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
    unregisterSsoHandlers?.()
    unregisterSsoHandlers = undefined
    unregisterSkillHandlers?.()
    unregisterSkillHandlers = undefined
    void ssoAuth.dispose()
    mainWindow = undefined
  })

  unregisterSessionEvents = registerSessionHandlers(sessions, keyMaterials, mainWindow.webContents, directSessions)
  // Keep transfer audit records attached to the active Shell-history
  // collector.  The handler treats this sink as best-effort, so a history
  // persistence problem cannot interrupt an in-flight SFTP operation.
  unregisterFileTransferHandlers = registerFileTransferHandlers(sessions, mainWindow.webContents, { history: shellHistory })
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
  ssoAuth.attachRenderer(mainWindow.webContents)
  unregisterSsoHandlers = registerSsoHandlers(ssoConfig, ssoAuth, mainWindow.webContents)
  unregisterSkillHandlers = registerSkillHandlers(skills, mainWindow.webContents, {
    skillAuthorization: { isAuthenticated: skillsAuthenticated },
  })
  unregisterChatHandlers = registerChatHandlers(chats, mainWindow.webContents, sessions, chatRuntime, undefined, {
    skillAuthorization: { isAuthenticated: skillsAuthenticated },
  })
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
  registerGracefulApplicationShutdown(
    app,
    () => sessions.closeAll(),
    async () => {
      // Chat mutations are queued independently from Shell history writes.
      // Drain them first so the final message/update is durable before the
      // process is allowed to quit; closing sessions above may enqueue one
      // last closed-history association as well.
      await chats.drain()
      await shellHistoryLifecycle.drain()
    },
    () => {
      // Stop result watchers before closing Shells. In-flight plan IPC work
      // then receives an inert watcher instead of retaining post-shutdown
      // timers or initiating a model turn while Electron is quitting.
      planResultAutoContinue.dispose()
      executionPlans.setResultOutputWatcher(undefined)
      diagnostics?.dispose()
      updater.dispose()
    },
  )
  app.whenReady().then(async () => {
    void recordPackagedWindowsInstallPath({
      platform: process.platform,
      isPackaged: app.isPackaged,
      execPath: process.execPath,
      writeInstallPath: writeWindowsInstallPath,
    })
    void regexRules.load().catch(() => undefined)
    try {
      await ssoConfig.ensureInitialized()
    } catch (error) {
      if (!isAtomicJsonStoreInvalidDataError(error)) throw error
    }
    await ssoAuth.initialize()
    // Skill discovery is best-effort and isolated from ordinary app startup;
    // malformed user-provided directories surface as page diagnostics.
    await skills.initialize().catch(error => {
      console.error('Failed to initialize Skills', error)
    })
    const initialPreferences = await workbenchPreferences.load().catch(createDefaultWorkbenchPreferences)
    await recoverChatStreamsBeforeCreatingMainWindow(
      () => chats.recoverInterruptedStreams(),
      () => createMainWindow(initialPreferences.theme),
    )
    void accessClientLaunches.tryOpenFromArgv(process.argv)

    app.on('activate', () => {
      if (mainWindow || isRestoringMainWindow) return
      isRestoringMainWindow = true
      void workbenchPreferences.load()
        .then(preferences => {
          if (!mainWindow) createMainWindow(preferences.theme)
        })
        .catch(() => {
          if (!mainWindow) createMainWindow()
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
