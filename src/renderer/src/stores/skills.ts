import { reactive, readonly, type DeepReadonly } from 'vue'
import type {
  SkillCatalog,
  SkillCommandRequest,
  SkillCommandResult,
  SkillDocument,
  SkillFile,
  SkillFileReadRequest,
  SkillId,
  SkillSetEnabledRequest,
} from '../../../shared/skill-contracts'

export type SkillsStoreState = {
  catalog: SkillCatalog
  loading: boolean
  error: string
}

const emptyCatalog: SkillCatalog = { skills: [], diagnostics: [] }
const state = reactive<SkillsStoreState>({
  catalog: emptyCatalog,
  loading: false,
  error: '',
})
let initialized = false
let disposeChanged: (() => void) | undefined
// The catalogue is intentionally a process-wide renderer singleton: the
// settings screen and the chat panel can be mounted at the same time. Keep a
// small reference count so unmounting one consumer cannot tear down the
// `skills:changed` subscription still needed by another consumer.
let consumerCount = 0

function api(): Window['terminalAgent']['skills'] | undefined {
  try { return globalThis.window?.terminalAgent?.skills } catch { return undefined }
}

async function hydrate(refresh = false): Promise<SkillCatalog> {
  const transport = api()
  if (!transport) return state.catalog
  state.loading = true
  state.error = ''
  try {
    const catalog = await (refresh ? transport.refresh() : transport.list())
    state.catalog = catalog
    if (!initialized && consumerCount > 0) {
      disposeChanged = transport.onChanged(next => { state.catalog = next })
      initialized = true
    }
    return catalog
  } catch (error) {
    state.error = error instanceof Error ? error.message : '技能目录加载失败'
    throw error
  } finally {
    state.loading = false
  }
}

async function setEnabled(request: SkillSetEnabledRequest): Promise<SkillCatalog> {
  const transport = api()
  if (!transport) return state.catalog
  state.error = ''
  try {
    const catalog = await transport.setEnabled(request)
    state.catalog = catalog
    return catalog
  } catch (error) {
    state.error = error instanceof Error ? error.message : '技能状态保存失败'
    throw error
  }
}

async function load(request: { id: SkillId }): Promise<SkillDocument> {
  const transport = api()
  if (!transport) throw new Error('技能服务不可用')
  return transport.load(request)
}

async function readFile(request: SkillFileReadRequest): Promise<SkillFile> {
  const transport = api()
  if (!transport) throw new Error('技能服务不可用')
  return transport.readFile(request)
}

async function run(request: SkillCommandRequest): Promise<SkillCommandResult> {
  const transport = api()
  if (!transport) throw new Error('技能服务不可用')
  return transport.run(request)
}

async function cancel(invocationId: string): Promise<boolean> {
  const transport = api()
  if (!transport) return false
  return transport.cancel(invocationId)
}

function enabledSkillIds(): SkillId[] {
  return state.catalog.skills.filter(skill => skill.enabled).map(skill => skill.id)
}

export function getSkillsStore(): {
  // Vue's readonly() is deep: nested arrays in the catalogue are exposed as
  // readonly too.  Returning DeepReadonly keeps the public type aligned with
  // that runtime guarantee and avoids callers accidentally mutating the
  // renderer's shared catalogue.
  state: DeepReadonly<SkillsStoreState>
  hydrate: (refresh?: boolean) => Promise<SkillCatalog>
  refresh: () => Promise<SkillCatalog>
  setEnabled: (request: SkillSetEnabledRequest) => Promise<SkillCatalog>
  load: (request: { id: SkillId }) => Promise<SkillDocument>
  readFile: (request: SkillFileReadRequest) => Promise<SkillFile>
  run: (request: SkillCommandRequest) => Promise<SkillCommandResult>
  cancel: (invocationId: string) => Promise<boolean>
  enabledSkillIds: () => SkillId[]
  dispose: () => void
} {
  consumerCount += 1
  let released = false
  return {
    state: readonly(state),
    hydrate,
    refresh: () => hydrate(true),
    setEnabled,
    load,
    readFile,
    run,
    cancel,
    enabledSkillIds,
    dispose: () => {
      // Vue may invoke an unmount hook more than once during test teardown;
      // make release idempotent for each acquired store facade.
      if (released) return
      released = true
      consumerCount = Math.max(0, consumerCount - 1)
      if (consumerCount > 0) return
      disposeChanged?.()
      disposeChanged = undefined
      initialized = false
    },
  }
}
