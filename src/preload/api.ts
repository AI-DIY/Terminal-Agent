import type { ConnectedSession, TerminalClosedEvent, TerminalDataEvent } from '../main/ssh/session-service'
import { chatRuntimeEventSchema, hostMemoryConsentTokenSchema, hostMemoryDisclosureSchema, hostMemoryInvalidationSchema, hostMemoryRecordSchema, hostMemorySettingsSchema } from '../shared/contracts'
import type {
  AgentDeltaEvent,
  AgentErrorEvent,
  AgentProposalEvent,
  AgentStartRequest,
  BastionCatalogSnapshot,
  BastionHostSummary,
  BastionLaunchRequest,
  BastionLaunchResult,
  ChatChangedEvent,
  ChatBindSessionRequest,
  ChatCreateRequest,
  ChatListSnapshot,
  ChatRemoveRequest,
  ChatResolveSessionRequest,
  ChatSessionResolution,
  ChatSetModeRequest,
  ChatTransferSessionsRequest,
  ChatWorkspaceSnapshot,
  ChatRunRequest,
  ChatRuntimeEvent,
  RendererSessionRequest,
  SavedDirectSessionInput,
  ShellHistoryChangedEvent,
  ShellHistoryConnectedSession,
  ShellHistoryDetail,
  ShellHistoryListRequest,
  ShellHistorySummary,
  RendererModelProfile,
  WorkbenchLayoutPatch,
  WorkbenchPreferences,
  WorkbenchTheme,
  HostMemoryRecord,
  HostMemoryInvalidation,
  HostMemorySettings,
  HostMemoryDisclosure,
} from '../shared/contracts'
import { rendererModelSettingsInputSchema, type ModelProfileKind, type ModelRouting, type RendererModelProfileInput, type RendererModelSettingsInput } from '../shared/validation'
import type { RegexFenceRule } from '../main/agent/regex-fence-service'
import type { DirectSessionSummary } from '../main/ssh/direct-session-repository'

export const terminalAgentNamespace = 'terminalAgent' as const

export type TerminalAgentApi = {
  chats: {
    list(): Promise<ChatListSnapshot>
    create(request: ChatCreateRequest): Promise<ChatWorkspaceSnapshot>
    get(chatId: string): Promise<ChatWorkspaceSnapshot>
    resolveSession(request: ChatResolveSessionRequest): Promise<ChatSessionResolution>
    setMode(request: ChatSetModeRequest): Promise<ChatWorkspaceSnapshot>
    remove(request: ChatRemoveRequest): Promise<void>
    bindSession(request: ChatBindSessionRequest): Promise<ChatWorkspaceSnapshot>
    transferSessions(request: ChatTransferSessionsRequest): Promise<ChatWorkspaceSnapshot>
    onChanged(listener: (event: ChatChangedEvent) => void): () => void
  }
  chat: {
    send(request: ChatRunRequest): Promise<void>
    cancel(chatId: string): Promise<void>
    onEvent(listener: (event: ChatRuntimeEvent) => void): () => void
  }
  shellHistory: {
    list(request: ShellHistoryListRequest): Promise<ShellHistorySummary[]>
    get(historyId: string): Promise<ShellHistoryDetail>
    duplicate(sessionId: string, chatId?: string): Promise<ShellHistoryConnectedSession>
    reconnect(historyId: string): Promise<ShellHistoryConnectedSession>
    onChanged(listener: (event: ShellHistoryChangedEvent) => void): () => void
  }
  sessions: {
    connect(request: RendererSessionRequest): Promise<{ id: string; hostname: string; mode: 'copilot' | 'autonomous' }>
    selectPrivateKey(): Promise<{ id: string; fileName: string; filePath: string } | null>
    write(sessionId: string, data: string): Promise<void>
    resize(sessionId: string, columns: number, rows: number): Promise<void>
    close(sessionId: string): Promise<void>
    list(): Promise<ConnectedSession[]>
    listProfiles(): Promise<DirectSessionSummary[]>
    saveProfile(profile: SavedDirectSessionInput): Promise<void>
    openProfile(id: string): Promise<{ id: string; hostname: string; mode: 'copilot' | 'autonomous' }>
    deleteProfile(id: string): Promise<void>
    onData(listener: (event: TerminalDataEvent) => void): () => void
    onClosed(listener: (event: TerminalClosedEvent) => void): () => void
    onOpened(listener: (session: ConnectedSession) => void): () => void
    onUpdated(listener: (session: ConnectedSession) => void): () => void
  }
  sessionModes: {
    upgrade(sessionId: string): Promise<{ sessionId: string; mode: 'autonomous' }>
  }
  agent: {
    start(request: AgentStartRequest): Promise<void>
    confirmCandidate(request: { sessionId: string; candidateId: string }): Promise<{ id: string }>
    executeCommand(request: { sessionId: string; command: string; confirmationId?: string }): Promise<{ kind: 'sent' } | { kind: 'intercepted'; ruleId: string; ruleName: string }>
    onDelta(listener: (event: AgentDeltaEvent) => void): () => void
    onProposal(listener: (event: AgentProposalEvent) => void): () => void
    onError(listener: (event: AgentErrorEvent) => void): () => void
  }
  settings: {
    getModel(): Promise<{ endpoint: string; model: string; contextLimit: number; hasApiKey: boolean } | null>
    saveModel(input: RendererModelSettingsInput): Promise<void>
    testModel(input: RendererModelSettingsInput): Promise<{ model: string }>
    models: {
      list(kind?: ModelProfileKind): Promise<RendererModelProfile[]>
      get(id: string): Promise<RendererModelProfile | null>
      save(input: RendererModelProfileInput): Promise<RendererModelProfile>
      test(input: RendererModelProfileInput): Promise<{ model: string }>
      activate(id: string): Promise<RendererModelProfile>
      delete(id: string, options?: { replacementId?: string | null; allowNoActive?: boolean }): Promise<void>
      getRouting(): Promise<ModelRouting>
      setRouting(routing: ModelRouting): Promise<ModelRouting>
      importApiKey(profileId: string): Promise<{ status: 'imported' | 'cancelled'; hasApiKey: boolean }>
    }
    getRegexRules(): Promise<RegexFenceRule[]>
    saveRegexRules(rules: RegexFenceRule[]): Promise<void>
    memory: {
      get(): Promise<HostMemorySettings>
      save(input: HostMemorySettings): Promise<HostMemorySettings>
      list(): Promise<HostMemoryRecord[]>
      getHost(hostname: string): Promise<HostMemoryRecord | null>
      update(hostname: string, record: HostMemoryRecord): Promise<HostMemoryRecord>
      remove(hostname: string): Promise<void>
    }
    acknowledgeHostMemory(token: string): Promise<void>
    dismissHostMemory(token: string): Promise<void>
    pendingHostMemoryDisclosures(): Promise<HostMemoryDisclosure[]>
    onHostMemoryDisclosure(listener: (event: HostMemoryDisclosure) => void): () => void
    onHostMemoryInvalidation(listener: (event: HostMemoryInvalidation) => void): () => void
    appearance: {
      ready(): Promise<void>
      get(): Promise<WorkbenchPreferences>
      saveLayout(input: WorkbenchLayoutPatch): Promise<WorkbenchPreferences>
      saveTheme(theme: WorkbenchTheme): Promise<WorkbenchPreferences>
    }
  }
  accessClient: {
    errors(): Promise<string[]>
    onError(listener: (message: string) => void): () => void
    catalog(): Promise<BastionCatalogSnapshot>
    hosts(systemId: string): Promise<BastionHostSummary[]>
    launch(request: BastionLaunchRequest): Promise<BastionLaunchResult>
  }
}

export function createTerminalAgentApi(ipcRenderer: {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  on(channel: string, listener: (event: unknown, payload: unknown) => void): void
  removeListener(channel: string, listener: (event: unknown, payload: unknown) => void): void
}): TerminalAgentApi {
  return Object.freeze({
    chats: Object.freeze({
      list: () => ipcRenderer.invoke('chats:list') as Promise<ChatListSnapshot>,
      create: (request: ChatCreateRequest) => ipcRenderer.invoke('chats:create', request) as Promise<ChatWorkspaceSnapshot>,
      get: (chatId: string) => ipcRenderer.invoke('chats:get', chatId) as Promise<ChatWorkspaceSnapshot>,
      resolveSession: (request: ChatResolveSessionRequest) => ipcRenderer.invoke('chats:resolve-session', request) as Promise<ChatSessionResolution>,
      setMode: (request: ChatSetModeRequest) => ipcRenderer.invoke('chats:set-mode', request) as Promise<ChatWorkspaceSnapshot>,
      remove: async (request: ChatRemoveRequest) => { await ipcRenderer.invoke('chats:remove', request) },
      bindSession: (request: ChatBindSessionRequest) => ipcRenderer.invoke('chats:bind-session', request) as Promise<ChatWorkspaceSnapshot>,
      transferSessions: (request: ChatTransferSessionsRequest) => ipcRenderer.invoke('chats:transfer-sessions', request) as Promise<ChatWorkspaceSnapshot>,
      onChanged: (listener: (event: ChatChangedEvent) => void) => subscribe(ipcRenderer, 'chats:changed', listener),
    }),
    chat: Object.freeze({
      send: (request: ChatRunRequest) => ipcRenderer.invoke('chat:send', request) as Promise<void>,
      cancel: (chatId: string) => ipcRenderer.invoke('chat:cancel', chatId) as Promise<void>,
      onEvent: (listener: (event: ChatRuntimeEvent) => void) => {
        const handler = (_event: unknown, payload: unknown) => listener(chatRuntimeEventSchema.parse(payload))
        ipcRenderer.on('chat:event', handler)
        return () => ipcRenderer.removeListener('chat:event', handler)
      },
    }),
    shellHistory: Object.freeze({
      list: (request: ShellHistoryListRequest) => ipcRenderer.invoke('shell-history:list', request) as Promise<ShellHistorySummary[]>,
      get: (historyId: string) => ipcRenderer.invoke('shell-history:get', historyId) as Promise<ShellHistoryDetail>,
      duplicate: (sessionId: string, chatId?: string) => ipcRenderer.invoke('shell-history:duplicate', chatId === undefined ? sessionId : { sessionId, chatId }) as Promise<ShellHistoryConnectedSession>,
      reconnect: (historyId: string) => ipcRenderer.invoke('shell-history:reconnect', historyId) as Promise<ShellHistoryConnectedSession>,
      onChanged: (listener: (event: ShellHistoryChangedEvent) => void) => subscribe(ipcRenderer, 'shell-history:changed', listener),
    }),
    sessions: Object.freeze({
      connect: (request: RendererSessionRequest) => ipcRenderer.invoke('sessions:connect', request) as Promise<{ id: string; hostname: string; mode: 'copilot' | 'autonomous' }>,
      selectPrivateKey: () => ipcRenderer.invoke('sessions:selectPrivateKey') as Promise<{ id: string; fileName: string; filePath: string } | null>,
      write: async (sessionId: string, data: string) => { await ipcRenderer.invoke('sessions:write', sessionId, data) },
      resize: async (sessionId: string, columns: number, rows: number) => { await ipcRenderer.invoke('sessions:resize', sessionId, columns, rows) },
      close: async (sessionId: string) => { await ipcRenderer.invoke('sessions:close', sessionId) },
      list: () => ipcRenderer.invoke('sessions:list') as Promise<ConnectedSession[]>,
      listProfiles: () => ipcRenderer.invoke('sessions:profiles:list') as Promise<DirectSessionSummary[]>,
      saveProfile: async (profile: SavedDirectSessionInput) => { await ipcRenderer.invoke('sessions:profiles:save', profile) },
      openProfile: (id: string) => ipcRenderer.invoke('sessions:profiles:open', id) as Promise<{ id: string; hostname: string; mode: 'copilot' | 'autonomous' }>,
      deleteProfile: async (id: string) => { await ipcRenderer.invoke('sessions:profiles:delete', id) },
      onData: (listener: (event: TerminalDataEvent) => void) => {
        const handler = (_event: unknown, payload: unknown) => listener(payload as TerminalDataEvent)
        ipcRenderer.on('sessions:data', handler)
        return () => ipcRenderer.removeListener('sessions:data', handler)
      },
      onClosed: (listener: (event: TerminalClosedEvent) => void) => {
        const handler = (_event: unknown, payload: unknown) => listener(payload as TerminalClosedEvent)
        ipcRenderer.on('sessions:closed', handler)
        return () => ipcRenderer.removeListener('sessions:closed', handler)
      },
      onOpened: (listener: (session: ConnectedSession) => void) => {
        const handler = (_event: unknown, payload: unknown) => listener(payload as ConnectedSession)
        ipcRenderer.on('sessions:opened', handler)
        return () => ipcRenderer.removeListener('sessions:opened', handler)
      },
      onUpdated: (listener: (session: ConnectedSession) => void) => {
        const handler = (_event: unknown, payload: unknown) => listener(payload as ConnectedSession)
        ipcRenderer.on('sessions:updated', handler)
        return () => ipcRenderer.removeListener('sessions:updated', handler)
      },
    }),
    sessionModes: Object.freeze({
      upgrade: (sessionId: string) => ipcRenderer.invoke('session-modes:upgrade', sessionId) as Promise<{ sessionId: string; mode: 'autonomous' }>,
    }),
    agent: Object.freeze({
      start: async (request: AgentStartRequest) => { await ipcRenderer.invoke('agent:start', request) },
      confirmCandidate: (request: { sessionId: string; candidateId: string }) => ipcRenderer.invoke('agent:confirm-candidate', request) as Promise<{ id: string }>,
      executeCommand: (request: { sessionId: string; command: string; confirmationId?: string }) => ipcRenderer.invoke('agent:execute-command', request) as Promise<{ kind: 'sent' } | { kind: 'intercepted'; ruleId: string; ruleName: string }>,
      onDelta: (listener: (event: AgentDeltaEvent) => void) => subscribe(ipcRenderer, 'agent:delta', listener),
      onProposal: (listener: (event: AgentProposalEvent) => void) => subscribe(ipcRenderer, 'agent:proposal', listener),
      onError: (listener: (event: AgentErrorEvent) => void) => subscribe(ipcRenderer, 'agent:error', listener),
    }),
    settings: Object.freeze({
      getModel: () => ipcRenderer.invoke('settings:model:get') as Promise<{ endpoint: string; model: string; contextLimit: number; hasApiKey: boolean } | null>,
      saveModel: (input: RendererModelSettingsInput) => ipcRenderer.invoke('settings:model:save', rendererModelSettingsInputSchema.parse(input)) as Promise<void>,
      testModel: (input: RendererModelSettingsInput) => ipcRenderer.invoke('settings:model:test', rendererModelSettingsInputSchema.parse(input)) as Promise<{ model: string }>,
      models: Object.freeze({
        list: (kind?: ModelProfileKind) => ipcRenderer.invoke('settings:models:list', kind === undefined ? undefined : { kind }) as Promise<RendererModelProfile[]>,
        get: (id: string) => ipcRenderer.invoke('settings:models:get', id) as Promise<RendererModelProfile | null>,
        save: (input: RendererModelProfileInput) => ipcRenderer.invoke('settings:models:save', input) as Promise<RendererModelProfile>,
        test: (input: RendererModelProfileInput) => ipcRenderer.invoke('settings:models:test', input) as Promise<{ model: string }>,
        activate: (id: string) => ipcRenderer.invoke('settings:models:activate', id) as Promise<RendererModelProfile>,
        delete: async (id: string, options?: { replacementId?: string | null; allowNoActive?: boolean }) => { await ipcRenderer.invoke('settings:models:delete', { id, ...options }) },
        getRouting: () => ipcRenderer.invoke('settings:models:routing:get') as Promise<ModelRouting>,
        setRouting: (routing: ModelRouting) => ipcRenderer.invoke('settings:models:routing:set', routing) as Promise<ModelRouting>,
        importApiKey: (profileId: string) => ipcRenderer.invoke('settings:models:key:import', { id: profileId }) as Promise<{ status: 'imported' | 'cancelled'; hasApiKey: boolean }>,
      }),
      getRegexRules: () => ipcRenderer.invoke('settings:regex-rules:get') as Promise<RegexFenceRule[]>,
      saveRegexRules: (rules: RegexFenceRule[]) => ipcRenderer.invoke('settings:regex-rules:save', rules) as Promise<void>,
      memory: Object.freeze({
        get: async () => hostMemorySettingsSchema.parse(await ipcRenderer.invoke('settings:host-memory:get')),
        save: async (input: HostMemorySettings) => hostMemorySettingsSchema.parse(await ipcRenderer.invoke('settings:host-memory:save', hostMemorySettingsSchema.parse(input))),
        list: async () => hostMemoryRecordSchema.array().parse(await ipcRenderer.invoke('settings:host-memory:list')),
        getHost: async (hostname: string) => hostMemoryRecordSchema.nullable().parse(await ipcRenderer.invoke('settings:host-memory:get-host', hostname)),
        update: async (hostname: string, record: HostMemoryRecord) => hostMemoryRecordSchema.parse(await ipcRenderer.invoke('settings:host-memory:update', { hostname, record: hostMemoryRecordSchema.parse(record) })),
        remove: async (hostname: string) => { await ipcRenderer.invoke('settings:host-memory:remove', hostname) },
      }),
      acknowledgeHostMemory: async (token: string) => { await ipcRenderer.invoke('host-memory:acknowledge', hostMemoryConsentTokenSchema.parse(token)) },
      dismissHostMemory: async (token: string) => { await ipcRenderer.invoke('host-memory:dismiss', hostMemoryConsentTokenSchema.parse(token)) },
      pendingHostMemoryDisclosures: async () => hostMemoryDisclosureSchema.array().parse(await ipcRenderer.invoke('host-memory:pending')),
      onHostMemoryDisclosure: (listener: (event: HostMemoryDisclosure) => void) => {
        const handler = (_event: unknown, payload: unknown) => listener(hostMemoryDisclosureSchema.parse(payload))
        ipcRenderer.on('host-memory:disclosure', handler)
        return () => ipcRenderer.removeListener('host-memory:disclosure', handler)
      },
      onHostMemoryInvalidation: (listener: (event: HostMemoryInvalidation) => void) => {
        const handler = (_event: unknown, payload: unknown) => listener(hostMemoryInvalidationSchema.parse(payload))
        ipcRenderer.on('host-memory:invalidation', handler)
        return () => ipcRenderer.removeListener('host-memory:invalidation', handler)
      },
      appearance: Object.freeze({
        ready: async () => { await ipcRenderer.invoke('settings:workbench:ready') },
        get: () => ipcRenderer.invoke('settings:workbench:get') as Promise<WorkbenchPreferences>,
        saveLayout: (input: WorkbenchLayoutPatch) => ipcRenderer.invoke('settings:workbench:save-layout', input) as Promise<WorkbenchPreferences>,
        saveTheme: (theme: WorkbenchTheme) => ipcRenderer.invoke('settings:workbench:save-theme', theme) as Promise<WorkbenchPreferences>,
      }),
    }),
    accessClient: Object.freeze({
      errors: () => ipcRenderer.invoke('access-client:errors') as Promise<string[]>,
      onError: (listener: (message: string) => void) => {
        const handler = (_event: unknown, payload: unknown) => listener(payload as string)
        ipcRenderer.on('access-client:error', handler)
        return () => ipcRenderer.removeListener('access-client:error', handler)
      },
      catalog: () => ipcRenderer.invoke('access-client:bastion:catalog') as Promise<BastionCatalogSnapshot>,
      hosts: (systemId: string) => ipcRenderer.invoke('access-client:bastion:hosts', systemId) as Promise<BastionHostSummary[]>,
      launch: (request: BastionLaunchRequest) => ipcRenderer.invoke('access-client:bastion:launch', request) as Promise<BastionLaunchResult>,
    }),
  })
}

function subscribe<T>(
  ipcRenderer: { on(channel: string, listener: (event: unknown, payload: unknown) => void): void; removeListener(channel: string, listener: (event: unknown, payload: unknown) => void): void },
  channel: string,
  listener: (event: T) => void,
): () => void {
  const handler = (_event: unknown, payload: unknown) => listener(payload as T)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}
