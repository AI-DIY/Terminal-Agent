import type { ConnectedSession, TerminalClosedEvent, TerminalDataEvent } from '../main/ssh/session-service'
import type {
  AgentDeltaEvent,
  AgentErrorEvent,
  AgentProposalEvent,
  AgentStartRequest,
  RendererSessionRequest,
  SavedDirectSessionInput,
} from '../shared/contracts'
import type { RendererModelSettingsInput } from '../shared/validation'
import type { RegexFenceRule } from '../main/agent/regex-fence-service'
import type { DirectSessionSummary } from '../main/ssh/direct-session-repository'

export const terminalAgentNamespace = 'terminalAgent' as const

export type TerminalAgentApi = {
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
    getRegexRules(): Promise<RegexFenceRule[]>
    saveRegexRules(rules: RegexFenceRule[]): Promise<void>
  }
  accessClient: {
    errors(): Promise<string[]>
    onError(listener: (message: string) => void): () => void
  }
}

export function createTerminalAgentApi(ipcRenderer: {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  on(channel: string, listener: (event: unknown, payload: unknown) => void): void
  removeListener(channel: string, listener: (event: unknown, payload: unknown) => void): void
}): TerminalAgentApi {
  return Object.freeze({
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
      saveModel: (input: RendererModelSettingsInput) => ipcRenderer.invoke('settings:model:save', input) as Promise<void>,
      testModel: (input: RendererModelSettingsInput) => ipcRenderer.invoke('settings:model:test', input) as Promise<{ model: string }>,
      getRegexRules: () => ipcRenderer.invoke('settings:regex-rules:get') as Promise<RegexFenceRule[]>,
      saveRegexRules: (rules: RegexFenceRule[]) => ipcRenderer.invoke('settings:regex-rules:save', rules) as Promise<void>,
    }),
    accessClient: Object.freeze({
      errors: () => ipcRenderer.invoke('access-client:errors') as Promise<string[]>,
      onError: (listener: (message: string) => void) => {
        const handler = (_event: unknown, payload: unknown) => listener(payload as string)
        ipcRenderer.on('access-client:error', handler)
        return () => ipcRenderer.removeListener('access-client:error', handler)
      },
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
