import { computed, reactive } from 'vue'
import type { TerminalAgentApi } from '../../../preload/api'
import {
  createDefaultSsoConfiguration,
  ssoAuthSnapshotSchema,
  ssoConfigurationSchema,
  type SsoAuthSnapshot,
  type SsoConfiguration,
  type SsoIdentity,
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

  async function saveConfig(input: SsoConfiguration): Promise<SsoConfiguration> {
    const saved = await api.saveConfig(ssoConfigurationSchema.parse(input))
    configurationRevision += 1
    applyConfiguration(saved)
    clearIdentity()
    return ssoConfigurationSchema.parse(saved)
  }

  async function retry(): Promise<void> {
    await api.retry()
  }

  function dispose(): void {
    lifecycleRevision += 1
    unsubscribe?.()
    unsubscribe = undefined
    initializeOperation = undefined
  }

  return { state, config, identity, error, skillsAvailable, initialize, saveConfig, retry, dispose }
}

let sharedStore: SsoStore | undefined

export function getSsoStore(): SsoStore {
  sharedStore ??= createSsoStore(window.terminalAgent.sso)
  return sharedStore
}
