import {
  createDefaultWorkbenchPreferences,
  workbenchLayoutPatchSchema,
  workbenchPreferencesDocumentSchema,
  workbenchThemeSchema,
  type WorkbenchLayoutPatch,
  type WorkbenchPreferences,
  type WorkbenchPreferencesDocument,
  type WorkbenchTheme,
} from '../../shared/contracts'
import { AtomicJsonStore } from '../persistence/atomic-json-store'
import { z } from 'zod'

const legacyWorkbenchPreferencesDocumentSchema = z.object({
  version: z.literal(1),
  appearance: z.object({ theme: workbenchThemeSchema }).strict(),
  layout: z.object({
    leftWidth: z.number().int(),
    rightWidth: z.number().int(),
    leftCollapsed: z.boolean(),
    rightCollapsed: z.boolean(),
    visibleCount: z.number().int(),
    columns: z.number().int(),
    rowHeight: z.union([z.literal(260), z.literal(330), z.literal(410)]),
  }).strict(),
  routing: z.object({}).strict(),
  memory: z.object({}).strict(),
}).strict()

export class WorkbenchPreferencesService {
  private readonly store: AtomicJsonStore<WorkbenchPreferencesDocument>

  constructor(filePath: string) {
    this.store = new AtomicJsonStore(
      filePath,
      workbenchPreferencesDocumentSchema,
      createDefaultDocument,
      { migrate: migrateWorkbenchPreferencesDocument },
    )
  }

  async load(): Promise<WorkbenchPreferences> {
    return flattenPreferences(await this.store.load())
  }

  async saveLayout(input: WorkbenchLayoutPatch | unknown): Promise<WorkbenchPreferences> {
    const patch = workbenchLayoutPatchSchema.parse(input)
    const document = await this.store.update(current => ({
      ...current,
      layout: { ...current.layout, ...patch },
    }))
    return flattenPreferences(document)
  }

  async saveTheme(input: WorkbenchTheme | unknown): Promise<WorkbenchPreferences> {
    const theme = workbenchThemeSchema.parse(input)
    const document = await this.store.update(current => ({
      ...current,
      appearance: { theme },
    }))
    return flattenPreferences(document)
  }
}

function createDefaultDocument(): WorkbenchPreferencesDocument {
  const { theme, ...layout } = createDefaultWorkbenchPreferences()
  return {
    version: 2,
    appearance: { theme },
    layout,
    routing: {},
    memory: {},
  }
}

function migrateWorkbenchPreferencesDocument(persisted: unknown): { value: unknown; changed: boolean } {
  const legacy = legacyWorkbenchPreferencesDocumentSchema.safeParse(persisted)
  if (!legacy.success) return { value: persisted, changed: false }
  const { rowHeight, ...layout } = legacy.data.layout
  const rowHeightPercent = rowHeight === 260 ? 34 : rowHeight === 330 ? 48 : 64
  return {
    value: {
      ...legacy.data,
      version: 2,
      layout: { ...layout, rowHeightPercent },
    },
    changed: true,
  }
}

function flattenPreferences(document: WorkbenchPreferencesDocument): WorkbenchPreferences {
  return {
    theme: document.appearance.theme,
    ...document.layout,
  }
}
