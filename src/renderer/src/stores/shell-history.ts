import { reactive } from 'vue'
import type {
  ShellHistoryConnectedSession,
  ShellHistoryDetail,
  ShellHistoryListRequest,
  ShellHistorySummary,
} from '../../../shared/contracts'

export const SHELL_HISTORY_RECONNECT_ELIGIBILITY_REFRESH_MS = 5_000

type ShellHistoryApi = {
  list(request: ShellHistoryListRequest): Promise<ShellHistorySummary[]>
  get(historyId: string): Promise<ShellHistoryDetail>
  duplicate(sessionId: string, chatId?: string): Promise<ShellHistoryConnectedSession>
  reconnect(historyId: string): Promise<ShellHistoryConnectedSession>
}

export type ShellHistoryEligibilityRefreshScheduler = {
  setInterval(callback: () => void, delay: number): number
  clearInterval(handle: number): void
}

export type ReadOnlyHistoryTerminal = {
  readOnly: true
  output: string
}

export function createShellHistoryStore(api: ShellHistoryApi) {
  const state = reactive({
    records: [] as ShellHistorySummary[],
    details: {} as Record<string, ShellHistoryDetail>,
    selectedId: null as string | null,
    selected: null as ShellHistoryDetail | null,
    loading: false,
    error: '',
  })
  let selectionGeneration = 0
  let lastRequest: ShellHistoryListRequest | null = null

  async function open(request: ShellHistoryListRequest): Promise<void> {
    lastRequest = { ...request }
    const generation = ++selectionGeneration
    let loadingInitialSelection = false
    state.loading = true
    state.error = ''
    // Do not leave the previous host's records visible while a newly selected
    // host list is in flight.  The dialog opens immediately, so stale rows
    // here could otherwise be mistaken for the newly requested connection.
    state.records = []
    state.details = {}
    state.selectedId = null
    state.selected = null
    try {
      const records = await api.list(request)
      if (generation !== selectionGeneration) return
      state.records = records
      const initialRecord = records[0]
      if (initialRecord) {
        loadingInitialSelection = true
        void select(initialRecord.id, generation)
      }
      void prefetchLatestHistoryDetails(records, initialRecord?.id, generation)
    } catch (error) {
      if (generation !== selectionGeneration) return
      state.error = error instanceof Error ? error.message : '无法读取 Shell 历史。'
    } finally {
      if (generation === selectionGeneration && !loadingInitialSelection) state.loading = false
    }
  }

  function prefetchLatestHistoryDetails(
    records: readonly ShellHistorySummary[],
    selectedHistoryId: string | undefined,
    generation: number,
  ): void {
    void Promise.all(latestHistoryByHost(records)
      .filter(record => record.id !== selectedHistoryId)
      .map(async record => {
        const detail = await api.get(record.id)
        if (generation === selectionGeneration) state.details[detail.id] = detail
      }))
      .catch(error => {
        if (generation !== selectionGeneration) return
        state.error = error instanceof Error ? error.message : '无法读取 Shell 历史。'
      })
  }

  async function select(historyId: string, expectedGeneration = ++selectionGeneration): Promise<void> {
    state.loading = true
    state.error = ''
    try {
      const detail = await api.get(historyId)
      if (expectedGeneration !== selectionGeneration) return
      state.selectedId = detail.id
      state.selected = detail
      state.details[detail.id] = detail
    } catch (error) {
      if (expectedGeneration !== selectionGeneration) return
      state.error = error instanceof Error ? error.message : '无法读取 Shell 历史。'
    } finally {
      if (expectedGeneration === selectionGeneration) state.loading = false
    }
  }

  function clear(): void {
    selectionGeneration += 1
    lastRequest = null
    state.records = []
    state.details = {}
    state.selectedId = null
    state.selected = null
    state.error = ''
    state.loading = false
  }

  function applyReconnectEligibility(detail: ShellHistoryDetail): void {
    state.records = state.records.map(record => (
      record.id === detail.id ? { ...record, reconnectable: detail.reconnectable } : record
    ))
    if (state.selected?.id === detail.id) state.selected = detail
    if (state.details[detail.id]) state.details[detail.id] = detail
  }

  async function reconnect(historyId: string): Promise<ShellHistoryConnectedSession> {
    const generation = selectionGeneration
    const detail = await api.get(historyId)
    if (generation === selectionGeneration) applyReconnectEligibility(detail)
    if (!detail.reconnectable) throw new Error('Shell 历史重连不可用。')
    return api.reconnect(historyId)
  }

  async function refreshReconnectEligibility(): Promise<void> {
    if (!lastRequest) return
    const request = { ...lastRequest }
    const generation = selectionGeneration
    let records: ShellHistorySummary[]
    try {
      records = await api.list(request)
    } catch {
      return
    }
    if (generation !== selectionGeneration) return
    const reconnectableById = new Map(records.map(record => [record.id, record.reconnectable]))
    state.records = state.records.map(record => {
      const reconnectable = reconnectableById.get(record.id)
      return reconnectable === undefined ? record : { ...record, reconnectable }
    })
    if (state.selected) {
      const reconnectable = reconnectableById.get(state.selected.id)
      if (reconnectable !== undefined) state.selected = { ...state.selected, reconnectable }
    }
    for (const [historyId, detail] of Object.entries(state.details)) {
      const reconnectable = reconnectableById.get(historyId)
      if (reconnectable !== undefined) state.details[historyId] = { ...detail, reconnectable }
    }
  }

  function startEligibilityRefresh(scheduler: ShellHistoryEligibilityRefreshScheduler): () => void {
    let refreshing = false
    let stopped = false
    const handle = scheduler.setInterval(() => {
      if (refreshing) return
      refreshing = true
      void refreshReconnectEligibility().finally(() => { refreshing = false })
    }, SHELL_HISTORY_RECONNECT_ELIGIBILITY_REFRESH_MS)
    return () => {
      if (stopped) return
      stopped = true
      scheduler.clearInterval(handle)
    }
  }

  return {
    state,
    open,
    async refresh(): Promise<void> {
      if (!lastRequest) return
      await open(lastRequest)
    },
    select,
    clear,
    startEligibilityRefresh,
    duplicate: (sessionId: string, chatId?: string) => chatId === undefined ? api.duplicate(sessionId) : api.duplicate(sessionId, chatId),
    reconnect,
  }
}

export function readOnlyHistoryTerminal(detail: ShellHistoryDetail | null): ReadOnlyHistoryTerminal {
  return { readOnly: true, output: detail?.output ?? '' }
}

export function latestHistoryByHost(records: readonly ShellHistorySummary[]): ShellHistorySummary[] {
  const newestByHost = new Map<string, ShellHistorySummary>()
  for (const record of [...records].sort((left, right) => (
    right.endedAt.localeCompare(left.endedAt) || right.id.localeCompare(left.id)
  ))) {
    if (!newestByHost.has(record.hostname)) newestByHost.set(record.hostname, record)
  }
  return [...newestByHost.values()]
}
