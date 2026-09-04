import { reactive } from 'vue'
import {
  WORKBENCH_LEFT_WIDTH_MAX,
  WORKBENCH_LEFT_WIDTH_MIN,
  WORKBENCH_RIGHT_WIDTH_MAX,
  WORKBENCH_RIGHT_WIDTH_MIN,
  createDefaultWorkbenchPreferences,
  workbenchLayoutPatchSchema,
  workbenchPreferencesSchema,
  workbenchThemeSchema,
  type WorkbenchLayoutPatch,
  type WorkbenchPreferences,
  type ShellFontSize,
  type ShellRowHeightPercent,
  type WorkbenchTheme,
} from '../../../shared/contracts'

export type WorkbenchPreferencesApi = {
  get(): Promise<WorkbenchPreferences>
  saveLayout(input: WorkbenchLayoutPatch): Promise<WorkbenchPreferences>
  saveTheme(theme: WorkbenchTheme): Promise<WorkbenchPreferences>
}

export type LayoutPreferencesStore = ReturnType<typeof createLayoutPreferencesStore>

export const SHELL_ROW_HEIGHT_PRESETS: ReadonlyArray<{ label: string; value: ShellRowHeightPercent }> = [
  { label: '紧凑', value: 48 },
  { label: '标准', value: 64 },
  { label: '宽松', value: 80 },
  { label: '占满', value: 100 },
]

/**
 * Full appearance menu options.  Keep SHELL_ROW_HEIGHT_PRESETS above as the
 * legacy four-item export consumed by older integrations, while using this
 * expanded list for the v3.2 settings and in-workspace menus.
 */
export const SHELL_ROW_HEIGHT_OPTIONS: ReadonlyArray<{ label: string; value: ShellRowHeightPercent }> = [
  { label: '超紧凑', value: 32 },
  { label: '紧凑', value: 40 },
  ...SHELL_ROW_HEIGHT_PRESETS,
  { label: '超宽松', value: 120 },
  { label: '超大', value: 140 },
]

export const SHELL_FONT_SIZE_PRESETS: ReadonlyArray<{ label: string; value: ShellFontSize }> = [
  { label: '小', value: 11 },
  { label: '标准', value: 12 },
  { label: '大', value: 13 },
]

/** Two additional sizes on each side of the original 11/12/13px range. */
export const SHELL_FONT_SIZE_OPTIONS: ReadonlyArray<{ label: string; value: ShellFontSize }> = [
  { label: '特小', value: 9 },
  { label: '较小', value: 10 },
  ...SHELL_FONT_SIZE_PRESETS,
  { label: '较大', value: 14 },
  { label: '特大', value: 15 },
]

export function shellGridStyle(columns: number, rowHeightPercent: ShellRowHeightPercent): Record<string, string> {
  return {
    gridTemplateColumns: `repeat(${Math.max(1, columns)}, minmax(210px, 1fr))`,
    gridAutoRows: `${rowHeightPercent}%`,
  }
}

export function createDelayedLayoutSaver(
  save: (patch: WorkbenchLayoutPatch) => void | Promise<void>,
  delayMs = 180,
) {
  let timeout: ReturnType<typeof setTimeout> | undefined
  let pendingPatch: WorkbenchLayoutPatch = {}

  function flush(): void {
    if (timeout !== undefined) clearTimeout(timeout)
    timeout = undefined
    if (Object.keys(pendingPatch).length === 0) return
    const patch = pendingPatch
    pendingPatch = {}
    void save(patch)
  }

  function queue(patch: WorkbenchLayoutPatch): void {
    pendingPatch = { ...pendingPatch, ...workbenchLayoutPatchSchema.parse(patch) }
    if (timeout !== undefined) clearTimeout(timeout)
    timeout = setTimeout(flush, delayMs)
  }

  return { queue, flush }
}

export function createLayoutPreferencesStore(api: WorkbenchPreferencesApi) {
  const state = reactive({
    ...createDefaultWorkbenchPreferences(),
    ready: false,
    error: '',
  })
  let loadOperation: Promise<void> | undefined
  let mutationRevision = 0

  function apply(preferences: WorkbenchPreferences): void {
    Object.assign(state, workbenchPreferencesSchema.parse(preferences))
  }

  function load(): Promise<void> {
    loadOperation ??= api.get()
      .then(apply)
      .catch(error => {
        state.error = error instanceof Error ? error.message : '无法读取工作台布局。'
        throw error
      })
      .finally(() => { state.ready = true })
    return loadOperation
  }

  async function saveLayout(input: WorkbenchLayoutPatch): Promise<void> {
    const patch = workbenchLayoutPatchSchema.parse(input)
    const revision = ++mutationRevision
    const authoritative = await api.saveLayout(patch)
    if (revision === mutationRevision) apply(authoritative)
  }

  async function saveTheme(input: WorkbenchTheme): Promise<void> {
    const theme = workbenchThemeSchema.parse(input)
    const revision = ++mutationRevision
    const authoritative = await api.saveTheme(theme)
    if (revision === mutationRevision) apply(authoritative)
  }

  function previewLayout(input: WorkbenchLayoutPatch): void {
    const patch = workbenchLayoutPatchSchema.parse(input)
    mutationRevision += 1
    apply({ ...currentPreferences(state), ...patch })
  }

  return { state, load, saveLayout, saveTheme, previewLayout }
}

let sharedLayoutPreferences: LayoutPreferencesStore | undefined

export function getLayoutPreferencesStore(): LayoutPreferencesStore {
  sharedLayoutPreferences ??= createLayoutPreferencesStore(window.terminalAgent.settings.appearance)
  return sharedLayoutPreferences
}

export function clampSidebarWidth(side: 'left' | 'right', width: number): number {
  const [minimum, maximum] = side === 'left'
    ? [WORKBENCH_LEFT_WIDTH_MIN, WORKBENCH_LEFT_WIDTH_MAX]
    : [WORKBENCH_RIGHT_WIDTH_MIN, WORKBENCH_RIGHT_WIDTH_MAX]
  return Math.min(maximum, Math.max(minimum, Math.round(width)))
}

export function keyboardSidebarWidth(
  side: 'left' | 'right',
  width: number,
  key: string,
): number | null {
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return null
  const visualDelta = key === 'ArrowLeft' ? -10 : 10
  return clampSidebarWidth(side, width + (side === 'left' ? visualDelta : -visualDelta))
}

function currentPreferences(state: WorkbenchPreferences & { ready: boolean; error: string }): WorkbenchPreferences {
  return {
    theme: state.theme,
    leftWidth: state.leftWidth,
    rightWidth: state.rightWidth,
    leftCollapsed: state.leftCollapsed,
    rightCollapsed: state.rightCollapsed,
    visibleCount: state.visibleCount,
    columns: state.columns,
    rowHeightPercent: state.rowHeightPercent,
    fontSize: state.fontSize,
  }
}
