import { reactive } from 'vue'
import type {
  ChatChangedEvent,
  ChatListSnapshot,
  ChatPinRequest,
  ChatSessionResolution,
  ChatSummary,
  ChatUnpinRequest,
  ChatUpdateTitleRequest,
  ChatWorkspace,
  ChatWorkspaceSnapshot,
} from '../../../shared/contracts'

export type ChatGroup = {
  label: string
  chats: ChatSummary[]
}

export function isInteractiveWorkbenchWorkspace(
  selected: Pick<ChatWorkspace, 'id' | 'shells'> | null,
  liveChatId: string | null,
): boolean {
  if (selected === null) return liveChatId === null
  return (
    selected.id === liveChatId
    || selected.shells.some(shell => shell.status === 'open' && Boolean(shell.sessionId))
  )
}

export function workbenchSessionAttachmentTarget(
  selectedChatId: string | null,
  liveChatId: string | null,
): string | null {
  return selectedChatId ?? liveChatId
}

export function workbenchReconnectAttachmentTarget(
  sessionChatId: string | null | undefined,
  selectedChatId: string,
): string {
  return sessionChatId ?? selectedChatId
}

export function workbenchOpenedAttachmentTarget(
  sessionChatId: string | null | undefined,
  capturedChatId: string | null,
  currentChatId: string | null,
): string | null {
  return sessionChatId ?? capturedChatId ?? currentChatId
}

export function createWorkbenchSessionOwnershipTracker<TSession extends { id: string }>() {
  let sequence = 0
  const operations = new Map<number, { targetChatId: string; sessionId?: string }>()
  const observed = new Set<string>()
  const owners = new Map<string, string>()
  return {
    begin(targetChatId: string) {
      const operation = ++sequence
      operations.set(operation, { targetChatId })
      return operation
    },
    observe(session: TSession): { tracked: true; targetChatId?: string; pending?: boolean } {
      const targetChatId = owners.get(session.id)
      if (targetChatId) return { tracked: true, targetChatId }
      observed.add(session.id)
      return { tracked: true, pending: [...operations.values()].some(entry => !entry.sessionId) }
    },
    resolve(operation: number, session: TSession): { targetChatId: string; queued: true } {
      const entry = operations.get(operation)
      if (!entry) throw new Error('Unknown workbench session operation.')
      entry.sessionId = session.id
      owners.set(session.id, entry.targetChatId)
      observed.delete(session.id)
      return { targetChatId: entry.targetChatId, queued: true }
    },
    complete(operation: number): TSession[] {
      operations.delete(operation)
      return []
    },
  }
}

export async function runWorkbenchOpenedSessionEvent<TSession extends { id: string; chatId?: string }>(options: {
  tracker: ReturnType<typeof createWorkbenchSessionOwnershipTracker<TSession>>
  session: TSession
  currentChatId: string | null
  attach(session: TSession, targetChatId: string | null): Promise<void>
}): Promise<boolean> {
  const observed = options.tracker.observe(options.session)
  if (observed.pending && !options.session.chatId) return false
  const target = workbenchOpenedAttachmentTarget(options.session.chatId, observed.targetChatId ?? null, options.currentChatId)
  await options.attach(options.session, target)
  return true
}

export async function initializeWorkbenchTask<TResult>(options: {
  load(): Promise<void>
  restore(): Promise<TResult>
  create(): Promise<unknown>
}): Promise<TResult> {
  await options.load()
  const restored = await options.restore()
  await options.create()
  return restored
}

export function createWorkbenchOperationGate() {
  let generation = 0
  return {
    begin(): number { return ++generation },
    capture(): number { return generation },
    invalidate(): void { generation++ },
    isCurrent(operation: number): boolean { return operation === generation },
  }
}

export async function runWorkbenchSessionOpen<TSession>(options: {
  gate: Pick<ReturnType<typeof createWorkbenchOperationGate>, 'begin' | 'isCurrent'>
  targetChatId?: string | null
  open(): Promise<TSession>
  attach(session: TSession, isCurrent: () => boolean, targetChatId?: string | null): Promise<void>
  complete(): void
  fail(error: unknown): void
}): Promise<void> {
  const operation = options.gate.begin()
  const isCurrent = () => options.gate.isCurrent(operation)
  try {
    const session = await options.open()
    if (!isCurrent()) return
    await options.attach(session, isCurrent, options.targetChatId)
    if (isCurrent()) options.complete()
  } catch (error) {
    if (isCurrent()) options.fail(error)
  }
}

export async function runWorkbenchSessionDuplicate<TSession>(options: {
  sessionId: string
  targetChatId: string
  duplicate(sessionId: string, chatId: string): Promise<TSession>
  attach(session: TSession, chatId: string, isCurrent: () => boolean): Promise<void>
  isCurrent(): boolean
}): Promise<void> {
  const targetChatId = options.targetChatId
  const session = await options.duplicate(options.sessionId, targetChatId)
  await options.attach(session, targetChatId, options.isCurrent)
}

export async function runWorkbenchSessionReconnect<TSession>(options: {
  targetChatId: string
  reconnect(): Promise<TSession>
  attach(session: TSession, chatId: string, isCurrent: () => boolean): Promise<void>
  isCurrent(): boolean
}): Promise<void> {
  const targetChatId = options.targetChatId
  const session = await options.reconnect()
  await options.attach(session, targetChatId, options.isCurrent)
}

type ChatApi = {
  list(): Promise<ChatListSnapshot>
  create(request: { requestId: string }): Promise<ChatWorkspaceSnapshot>
  get(chatId: string): Promise<ChatWorkspaceSnapshot>
  resolveSession(request: { sessionId: string }): Promise<ChatSessionResolution>
  updateTitle(request: ChatUpdateTitleRequest): Promise<ChatWorkspaceSnapshot>
  pin(request: ChatPinRequest): Promise<ChatWorkspaceSnapshot>
  unpin(request: ChatUnpinRequest): Promise<ChatWorkspaceSnapshot>
  remove(request: { requestId: string; chatId: string }): Promise<void>
  onChanged(listener: (event: ChatChangedEvent) => void): () => void
}

type StoreOptions = {
  now?: () => Date
  requestId?: () => string
}

function summaryOf(chat: ChatWorkspace): ChatSummary {
  return {
    id: chat.id,
    title: chat.title,
    titleState: chat.titleState,
    pinnedAt: chat.pinnedAt,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    shellCount: chat.shellCount,
    mode: chat.mode,
    live: chat.live,
  }
}

export function groupChatSummaries(chats: readonly ChatSummary[], now: Date): ChatGroup[] {
  const pinned = chats
    .filter(chat => chat.pinnedAt !== null)
    .sort((left, right) => right.pinnedAt!.localeCompare(left.pinnedAt!) || left.id.localeCompare(right.id))
  const today = startOfLocalDay(now)
  const weekStart = startOfLocalWeek(today)
  const weekEnd = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + 7)
  const datedBuckets = new Map<string, { date: number; chats: ChatSummary[] }>()
  const earlier: ChatSummary[] = []
  for (const chat of chats.filter(chat => chat.pinnedAt === null)) {
    const created = new Date(chat.createdAt)
    if (Number.isNaN(created.getTime())) {
      earlier.push(chat)
      continue
    }
    const createdDay = startOfLocalDay(created)
    if (createdDay < weekStart || createdDay >= weekEnd) {
      earlier.push(chat)
      continue
    }
    const label = createdDay.getTime() === today.getTime() ? '今天' : formatCalendarLabel(createdDay)
    const bucket = datedBuckets.get(label) ?? { date: createdDay.getTime(), chats: [] }
    bucket.chats.push(chat)
    datedBuckets.set(label, bucket)
  }
  const groups = [...datedBuckets.entries()]
    .sort(([, left], [, right]) => right.date - left.date)
    .map(([label, bucket]) => ({ label, chats: sortOrdinaryChats(bucket.chats) }))
  if (earlier.length > 0) groups.push({ label: '更早', chats: sortOrdinaryChats(earlier) })
  return pinned.length > 0 ? [{ label: '置顶', chats: pinned }, ...groups] : groups
}

export function createChatWorkspacesStore(api: ChatApi, options: StoreOptions = {}) {
  const now = options.now ?? (() => new Date())
  const requestId = options.requestId ?? (() => crypto.randomUUID())
  const workspaces = new Map<string, ChatWorkspace>()
  const workspaceRevisions = new Map<string, number>()
  const removalSequences = new Map<string, number>()
  const pendingCreates = new Set<Promise<boolean>>()
  let navigationSequence = 0
  let selectedNavigationSequence = 0
  let liveChatRevision = -1
  let eventQueue: Promise<void> = Promise.resolve()

  const state = reactive({
    chats: [] as ChatSummary[],
    groups: [] as ChatGroup[],
    selected: null as ChatWorkspace | null,
    selectedId: null as string | null,
    liveChatId: null as string | null,
    revision: -1,
    loading: false,
    error: '',
  })

  function regroup(): void {
    state.groups = groupChatSummaries(state.chats, now())
  }

  function upsert(chat: ChatWorkspace): void {
    workspaces.set(chat.id, chat)
    const summary = summaryOf(chat)
    const index = state.chats.findIndex(item => item.id === chat.id)
    if (index < 0) state.chats = [summary, ...state.chats]
    else state.chats[index] = summary
    state.chats.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
    if (state.selectedId === chat.id) state.selected = chat
    regroup()
  }

  function commitSelection(chat: ChatWorkspace, sequence: number): void {
    state.selectedId = chat.id
    state.selected = chat
    selectedNavigationSequence = sequence
  }

  async function select(chatId: string, isCurrent: () => boolean = () => true): Promise<void> {
    if (!isCurrent() || !state.chats.some(chat => chat.id === chatId)) return
    const sequence = ++navigationSequence
    state.error = ''
    try {
      while (isCurrent() && sequence === navigationSequence && state.chats.some(chat => chat.id === chatId)) {
        const cached = workspaces.get(chatId)
        if (cached) {
          if (!isCurrent()) return
          commitSelection(cached, sequence)
          return
        }
        const snapshot = await api.get(chatId)
        if (!isCurrent() || sequence !== navigationSequence || !state.chats.some(chat => chat.id === chatId)) return
        if (!mergeSnapshot(snapshot)) continue
        const current = workspaces.get(chatId)
        if (!current) continue
        commitSelection(current, sequence)
        return
      }
    } catch (error) {
      if (isCurrent() && sequence === navigationSequence) state.error = error instanceof Error ? error.message : '无法读取任务。'
    }
  }

  async function apply(event: ChatChangedEvent): Promise<void> {
    if (event.revision < state.revision) return
    state.revision = event.revision
    if (event.revision >= liveChatRevision) {
      liveChatRevision = event.revision
      state.liveChatId = event.liveChatId
    }
    if (event.kind !== 'removed') {
      if (event.revision < (workspaceRevisions.get(event.chat.id) ?? -1)) return
      workspaceRevisions.set(event.chat.id, event.revision)
      upsert(event.chat)
      return
    }
    await removeLocal(event.chatId, removalSequences.get(event.chatId))
  }

  async function removeLocal(chatId: string, removalSequence = selectedNavigationSequence): Promise<void> {
    workspaces.delete(chatId)
    workspaceRevisions.delete(chatId)
    state.chats = state.chats.filter(chat => chat.id !== chatId)
    if (state.selectedId === chatId) {
      state.selectedId = null
      state.selected = null
      const fallback = (state.liveChatId !== chatId ? state.liveChatId : null) ?? state.chats[0]?.id
      if (fallback && removalSequence === navigationSequence) await select(fallback)
    }
    regroup()
  }

  function mergeSnapshot(snapshot: ChatWorkspaceSnapshot): boolean {
    if (snapshot.revision < state.revision) return false
    if (snapshot.revision >= liveChatRevision) {
      liveChatRevision = snapshot.revision
      state.liveChatId = snapshot.liveChatId
    }
    if (snapshot.revision < (workspaceRevisions.get(snapshot.chat.id) ?? -1)) return false
    workspaceRevisions.set(snapshot.chat.id, snapshot.revision)
    upsert(snapshot.chat)
    return true
  }

  async function performCreate(): Promise<boolean> {
    const sequence = ++navigationSequence
    state.error = ''
    try {
      const snapshot = await api.create({ requestId: requestId() })
      mergeSnapshot(snapshot)
      if (sequence !== navigationSequence) return false
      const chat = workspaces.get(snapshot.chat.id)
      if (!chat) return false
      state.selectedId = chat.id
      state.selected = chat
      selectedNavigationSequence = sequence
      return true
    } catch (error) {
      if (sequence === navigationSequence) state.error = error instanceof Error ? error.message : '无法新建任务。'
      return false
    }
  }

  function create(): Promise<boolean> {
    const pending = performCreate()
    pendingCreates.add(pending)
    const remove = () => pendingCreates.delete(pending)
    void pending.then(remove, remove)
    return pending
  }

  async function updateTitle(chatId: string, title: string): Promise<boolean> {
    state.error = ''
    try {
      return mergeSnapshot(await api.updateTitle({ requestId: requestId(), chatId, title }))
    } catch (error) {
      state.error = error instanceof Error ? error.message : '无法更新任务名称。'
      return false
    }
  }

  async function pin(chatId: string): Promise<boolean> {
    state.error = ''
    try {
      return mergeSnapshot(await api.pin({ requestId: requestId(), chatId }))
    } catch (error) {
      state.error = error instanceof Error ? error.message : '无法置顶任务。'
      return false
    }
  }

  async function unpin(chatId: string): Promise<boolean> {
    state.error = ''
    try {
      return mergeSnapshot(await api.unpin({ requestId: requestId(), chatId }))
    } catch (error) {
      state.error = error instanceof Error ? error.message : '无法取消置顶任务。'
      return false
    }
  }

  const unsubscribe = api.onChanged(event => {
    eventQueue = eventQueue.then(() => apply(event))
  })

  return {
    state,
    apply,
    merge(snapshot: ChatWorkspaceSnapshot): boolean {
      return mergeSnapshot(snapshot)
    },
    workspace(chatId: string): ChatWorkspace | undefined {
      return workspaces.get(chatId)
    },
    async resolveSession(sessionId: string, isCurrent: () => boolean = () => true): Promise<ChatWorkspace | null> {
      while (isCurrent()) {
        const resolution = await api.resolveSession({ sessionId })
        if (!isCurrent()) return null
        if (resolution.revision < state.revision) continue
        if (resolution.revision >= liveChatRevision) {
          liveChatRevision = resolution.revision
          state.liveChatId = resolution.liveChatId
        }
        if (!resolution.chat) return null
        mergeSnapshot({ revision: resolution.revision, chat: resolution.chat, liveChatId: resolution.liveChatId })
        return workspaces.get(resolution.chat.id) ?? resolution.chat
      }
      return null
    },
    async load(): Promise<void> {
      const initialNavigationSequence = navigationSequence
      state.loading = true
      state.error = ''
      try {
        let snapshot = await api.list()
        while (snapshot.revision < state.revision || snapshot.revision < liveChatRevision) snapshot = await api.list()
        state.revision = snapshot.revision
        state.chats = [...snapshot.chats]
        liveChatRevision = snapshot.revision
        state.liveChatId = snapshot.liveChatId
        regroup()
        if (initialNavigationSequence !== navigationSequence) return
        const initial = state.liveChatId ?? state.chats[0]?.id
        if (initial) await select(initial)
      } catch (error) {
        state.error = error instanceof Error ? error.message : '无法读取任务列表。'
      } finally {
        state.loading = false
      }
    },
    create,
    updateTitle,
    pin,
    unpin,
    async waitForPendingCreate(): Promise<void> {
      while (pendingCreates.size > 0) await Promise.allSettled([...pendingCreates])
    },
    select,
    async remove(chatId: string, isCurrent: () => boolean = () => true): Promise<void> {
      if (!isCurrent()) return
      const removesSelection = state.selectedId === chatId
      const sequence = removesSelection ? ++navigationSequence : navigationSequence
      if (removesSelection) removalSequences.set(chatId, sequence)
      state.error = ''
      try {
        await api.remove({ requestId: requestId(), chatId })
        await eventQueue
        if (!isCurrent()) return
        if (state.chats.some(chat => chat.id === chatId)) await removeLocal(chatId, sequence)
      } catch (error) {
        if (isCurrent() && sequence === navigationSequence) state.error = error instanceof Error ? error.message : '无法删除任务。'
      } finally {
        if (removalSequences.get(chatId) === sequence) removalSequences.delete(chatId)
      }
    },
    dispose(): void {
      unsubscribe()
    },
  }
}

export async function restoreWorkbenchSessionOwnership<TSession, TWorkspace>(options: {
  sessions: readonly TSession[]
  add(session: TSession): void
  resolve(session: TSession): Promise<TWorkspace | null>
  restore(workspace: TWorkspace): void
  bind(session: TSession, activate: boolean): Promise<void>
}): Promise<Array<{ session: TSession; error: unknown }>> {
  for (const session of options.sessions) options.add(session)
  const failures: Array<{ session: TSession; error: unknown }> = []
  for (const session of options.sessions) {
    try {
      const workspace = await options.resolve(session)
      if (workspace) options.restore(workspace)
      else await options.bind(session, true)
    } catch (error) {
      failures.push({ session, error })
    }
  }
  return failures
}

export function ensureWorkbenchShellView(
  views: Map<string, { visibleSessionIds: string[]; activeSessionId: string | null }>,
  workspace: ChatWorkspace,
): void {
  const openSessionIds = workspace.shells
    .filter(shell => shell.status === 'open' && shell.sessionId)
    .map(shell => shell.sessionId!)
  const existing = views.get(workspace.id)
  const openSessionIdSet = new Set(openSessionIds)
  const valid = existing && (openSessionIds.length === 0
    ? existing.visibleSessionIds.length === 0 && existing.activeSessionId === null
    : existing.visibleSessionIds.length > 0
      && existing.visibleSessionIds.every(sessionId => openSessionIdSet.has(sessionId))
      && existing.activeSessionId !== null
      && existing.visibleSessionIds.includes(existing.activeSessionId))
  if (valid) return
  views.set(workspace.id, { visibleSessionIds: openSessionIds, activeSessionId: openSessionIds[0] ?? null })
}

export async function focusOwnedWorkbenchSession<TWorkspace>(options: {
  sessionId: string
  resolve(sessionId: string, isCurrent: () => boolean): Promise<TWorkspace | null>
  selectChat(workspace: TWorkspace, isCurrent: () => boolean): Promise<void>
  selectSession(sessionId: string): boolean
  isCurrent?: () => boolean
}): Promise<boolean> {
  const isCurrent = options.isCurrent ?? (() => true)
  if (!isCurrent()) return false
  const workspace = await options.resolve(options.sessionId, isCurrent)
  if (!workspace || !isCurrent()) return false
  await options.selectChat(workspace, isCurrent)
  if (!isCurrent()) return false
  return options.selectSession(options.sessionId)
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function sortOrdinaryChats(chats: readonly ChatSummary[]): ChatSummary[] {
  return [...chats].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
}

function startOfLocalWeek(day: Date): Date {
  const daysSinceMonday = (day.getDay() + 6) % 7
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() - daysSinceMonday)
}

function formatCalendarLabel(date: Date): string {
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`
}
