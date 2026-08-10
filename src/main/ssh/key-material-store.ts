import { dialog } from 'electron'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { PrivateKeyInput } from './private-key-loader'

export type KeyMaterialReference = { id: string; fileName: string }

type OpenDialogResult = {
  canceled: boolean
  filePaths: string[]
}

export type KeyMaterialStoreDependencies = {
  showOpenDialog: () => Promise<OpenDialogResult>
  readFile: (filePath: string) => Promise<Buffer>
  createId: () => string
  now: () => number
  ttlMs: number
  fileName: (filePath: string) => string
}

type StoredKeyMaterial = {
  input: PrivateKeyInput
  expiresAt: number
}

const DEFAULT_TTL_MS = 5 * 60 * 1_000

export class KeyMaterialStore {
  private readonly values = new Map<string, StoredKeyMaterial>()
  private readonly dependencies: KeyMaterialStoreDependencies

  constructor(dependencies: Partial<KeyMaterialStoreDependencies> = {}) {
    this.dependencies = {
      showOpenDialog: () => dialog.showOpenDialog({
        title: '选择 SSH 私钥',
        properties: ['openFile'],
        filters: [{ name: 'SSH 私钥', extensions: ['pem', 'key', 'ppk'] }, { name: '所有文件', extensions: ['*'] }],
      }),
      readFile,
      createId: randomUUID,
      now: Date.now,
      ttlMs: DEFAULT_TTL_MS,
      fileName: basename,
      ...dependencies,
    }
  }

  async select(): Promise<KeyMaterialReference | null> {
    this.pruneExpired()
    const result = await this.dependencies.showOpenDialog()
    if (result.canceled || !result.filePaths[0]) return null

    const filePath = result.filePaths[0]
    const id = this.dependencies.createId()
    const fileName = this.dependencies.fileName(filePath)
    const content = await this.dependencies.readFile(filePath)
    this.values.set(id, {
      input: { fileName, content },
      expiresAt: this.dependencies.now() + this.dependencies.ttlMs,
    })
    return { id, fileName }
  }

  take(id: string, passphrase?: string): PrivateKeyInput {
    this.pruneExpired()
    const key = this.values.get(id)
    if (!key) throw new Error('私钥引用已失效，请重新选择私钥文件。')
    this.values.delete(id)
    return { ...key.input, passphrase }
  }

  clear(): void {
    this.values.clear()
  }

  private pruneExpired(): void {
    const now = this.dependencies.now()
    for (const [id, material] of this.values) {
      if (material.expiresAt <= now) this.values.delete(id)
    }
  }
}
