import { dialog } from 'electron'
import { readFile, stat } from 'node:fs/promises'
import { validateModelApiKey, MAX_MODEL_API_KEY_BYTES } from './model-api-key-validation'
import type { ModelProfileService } from './model-profile-service'

export type ModelApiKeyEntryResult = { status: 'imported' | 'cancelled'; hasApiKey: boolean }

export class ModelApiKeyEntryService {
  constructor(private readonly profiles: Pick<ModelProfileService, 'get' | 'saveApiKey'>) {}

  async importFromFile(profileId: string): Promise<ModelApiKeyEntryResult> {
    const selection = await dialog.showOpenDialog({
      title: '导入模型 API Key 文件',
      properties: ['openFile'],
      filters: [{ name: 'Text', extensions: ['txt', 'key'] }],
    })
    if (selection.canceled || selection.filePaths.length === 0) {
      return { status: 'cancelled', hasApiKey: Boolean((await this.profiles.get(profileId))?.hasApiKey) }
    }
    const filePath = selection.filePaths[0]!
    const metadata = await stat(filePath)
    if (metadata.size > MAX_MODEL_API_KEY_BYTES) throw new Error('API key file exceeds the maximum supported size')
    const key = validateModelApiKey(await readFile(filePath, 'utf8'))
    const saved = await this.profiles.saveApiKey(profileId, key)
    return { status: 'imported', hasApiKey: saved.hasApiKey }
  }
}
