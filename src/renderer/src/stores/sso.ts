import { computed, reactive } from 'vue'
import type { TerminalAgentApi } from '../../../preload/api'
import {
  createDefaultSsoConfiguration,
  ssoAuthSnapshotSchema,
  ssoConfigurationSchema,
  type SsoAuthSnapshot,
  type SsoConfiguration,
  type SsoIdentity,
  type SsoSaveIntent,
} from '../../../shared/sso-contracts'

export type SsoApi = Pick<TerminalAgentApi['sso'], 'getConfig' | 'saveConfig' | 'getState' | 'retry' | 'onState'>

export type SsoStore = ReturnType<typeof createSsoStore>

export function createSsoStore(api: SsoApi) {
  const state = reactive<SsoAuthSnapshot>({ state: 'configuration-required' })
  const config = reactive<SsoConfiguration>(createDefaultSsoConfiguration())
  const identity = computed<SsoIdentity | null>(() => state.identity ?? null)
  const error = computed(() => state.errorMessage ?? '')
  const skillsAvailable = computed(() => state.state === 'authenticated')
  let unsubscribe: (() => void) | undefined
  let initializeOperation: Promise<void> | undefined
  let lifecycleRevision = 0
  let snapshotRevision = 0
  let configurationRevision = 0
  let suppressNextAutoRetry = false

  function applyConfiguration(input: SsoConfiguration): void {
    Object.assign(config, ssoConfigurationSchema.parse(input))
  }

  function clearIdentity(): void {
    snapshotRevision += 1
    delete state.identity
  }

  function applyState(input: SsoAuthSnapshot): void {
    const snapshot = ssoAuthSnapshotSchema.parse(input)
    snapshotRevision += 1
    state.state = snapshot.state
    if (snapshot.state === 'login-disabled' || snapshot.state === 'configuration-required' || !snapshot.identity) delete state.identity
    else state.identity = snapshot.identity
    if (snapshot.errorMessage) state.errorMessage = snapshot.errorMessage
    else delete state.errorMessage
  }

  function subscribe(): void {
    unsubscribe ??= api.onState(applyState)
  }

  function initialize(): Promise<void> {
    if (initializeOperation) return initializeOperation

    subscribe()
    const activeLifecycle = lifecycleRevision
    const hydrationSnapshotRevision = snapshotRevision
    const hydrationConfigurationRevision = configurationRevision
    initializeOperation = Promise.all([api.getConfig(), api.getState()])
      .then(([nextConfig, nextState]) => {
        if (activeLifecycle !== lifecycleRevision) return
        if (hydrationConfigurationRevision === configurationRevision) applyConfiguration(nextConfig)
        if (hydrationSnapshotRevision === snapshotRevision) applyState(nextState)
      })
      .catch(error => {
        if (activeLifecycle === lifecycleRevision) initializeOperation = undefined
        throw error
      })
    return initializeOperation
  }

  async function saveConfig(input: SsoConfiguration, intent: SsoSaveIntent = 'draft'): Promise<SsoConfiguration> {
    const parsedInput = ssoConfigurationSchema.parse(input)
    // `continue` starts authentication in the main process before the IPC
    // call resolves. Arm this before awaiting it so LoginView cannot race the
    // first state event and launch a duplicate session on mount.
    // A continue save from the configuration/workbench surfaces changes the
    // root view to LoginView, whose mount hook normally retries authentication.
    // Embedded LoginView settings stay mounted, so leave no stale token there.
    const suppressMountRetry = intent === 'continue' && shouldSuppressAutoRetry(state.state)
    if (suppressMountRetry) suppressNextAutoRetry = true
    try {
      const saved = await api.saveConfig(parsedInput, intent)
      configurationRevision += 1
      applyConfiguration(saved)
      clearIdentity()
      return ssoConfigurationSchema.parse(saved)
    } catch (error) {
      if (suppressMountRetry) suppressNextAutoRetry = false
      throw error
    }
  }

  async function retry(): Promise<void> {
    await api.retry()
  }

  function dispose(): void {
    lifecycleRevision += 1
    suppressNextAutoRetry = false
    unsubscribe?.()
    unsubscribe = undefined
    initializeOperation = undefined
  }

  function consumeAutoRetrySuppression(): boolean {
    const suppressed = suppressNextAutoRetry
    suppressNextAutoRetry = false
    return suppressed
  }

  return { state, config, identity, error, skillsAvailable, initialize, saveConfig, retry, consumeAutoRetrySuppression, dispose }
}

function shouldSuppressAutoRetry(state: SsoAuthSnapshot['state']): boolean {
  return state === 'configuration-required' || state === 'login-disabled' || state === 'authenticated'
}

let sharedStore: SsoStore | undefined

export function getSsoStore(): SsoStore {
  sharedStore ??= createSsoStore(window.terminalAgent.sso)
  return sharedStore
}
