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

export class WorkbenchPreferencesService {
  private readonly store: AtomicJsonStore<WorkbenchPreferencesDocument>

  constructor(filePath: string) {
    this.store = new AtomicJsonStore(
      filePath,
      workbenchPreferencesDocumentSchema,
      createDefaultDocument,
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
    version: 1,
    appearance: { theme },
    layout,
    routing: {},
    memory: {},
  }
}

function flattenPreferences(document: WorkbenchPreferencesDocument): WorkbenchPreferences {
  return {
    theme: document.appearance.theme,
    ...document.layout,
  }
}
