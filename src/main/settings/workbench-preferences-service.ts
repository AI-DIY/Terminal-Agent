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

const version2RowHeightSchema = z.union([z.literal(34), z.literal(48), z.literal(64)])
const version2WorkbenchPreferencesDocumentSchema = z.object({
  version: z.literal(2),
  appearance: z.object({ theme: workbenchThemeSchema }).strict(),
  layout: z.object({
    leftWidth: z.number().int(),
    rightWidth: z.number().int(),
    leftCollapsed: z.boolean(),
    rightCollapsed: z.boolean(),
    visibleCount: z.number().int(),
    columns: z.number().int(),
    rowHeightPercent: version2RowHeightSchema,
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
    version: 3,
    appearance: { theme },
    layout,
    routing: {},
    memory: {},
  }
}

function migrateWorkbenchPreferencesDocument(persisted: unknown): { value: unknown; changed: boolean } {
  const legacy = legacyWorkbenchPreferencesDocumentSchema.safeParse(persisted)
  if (legacy.success) {
    const { rowHeight, ...layout } = legacy.data.layout
    const rowHeightPercent = rowHeight === 260 ? 48 : rowHeight === 330 ? 64 : 80
    return {
      value: {
        ...legacy.data,
        version: 3,
        layout: { ...layout, rowHeightPercent },
      },
      changed: true,
    }
  }

  const version2 = version2WorkbenchPreferencesDocumentSchema.safeParse(persisted)
  if (!version2.success) return { value: persisted, changed: false }
  return {
    value: {
      ...version2.data,
      version: 3,
      layout: {
        ...version2.data.layout,
        rowHeightPercent: tallerRowHeight(version2.data.layout.rowHeightPercent),
      },
    },
    changed: true,
  }
}

function tallerRowHeight(value: z.infer<typeof version2RowHeightSchema>): 48 | 64 | 80 {
  return value === 34 ? 48 : value === 48 ? 64 : 80
}

function flattenPreferences(document: WorkbenchPreferencesDocument): WorkbenchPreferences {
  return {
    theme: document.appearance.theme,
    ...document.layout,
  }
}
