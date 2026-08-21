import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ModelApiKeyEntryService } from '../../../src/main/settings/model-api-key-entry-service'

const { showOpenDialog, stat, readFile } = vi.hoisted(() => ({ showOpenDialog: vi.fn(), stat: vi.fn(), readFile: vi.fn() }))
vi.mock('electron', () => ({ dialog: { showOpenDialog } }))
vi.mock('node:fs/promises', () => ({ stat, readFile }))

describe('ModelApiKeyEntryService', () => {
  beforeEach(() => {
    showOpenDialog.mockReset()
    stat.mockReset()
    readFile.mockReset()
  })
  it('imports a selected key file in the main process and returns status without plaintext', async () => {
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['C:\\secure\\model.key'] })
    stat.mockResolvedValue({ size: 11 })
    readFile.mockResolvedValue('secret-key\n')
    const profiles = {
      get: vi.fn(),
      saveApiKey: vi.fn().mockResolvedValue({ hasApiKey: true }),
    }
    const service = new ModelApiKeyEntryService(profiles)

    await expect(service.importFromFile('llm-1')).resolves.toEqual({ status: 'imported', hasApiKey: true })
    expect(profiles.saveApiKey).toHaveBeenCalledWith('llm-1', 'secret-key')
    expect(JSON.stringify(showOpenDialog.mock.calls)).not.toContain('secret-key')
  })

  it('rejects oversized files before reading them', async () => {
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['C:\\secure\\model.key'] })
    stat.mockResolvedValue({ size: 4097 })
    const profiles = { get: vi.fn(), saveApiKey: vi.fn() }

    await expect(new ModelApiKeyEntryService(profiles).importFromFile('llm-1')).rejects.toThrow()
    expect(readFile).not.toHaveBeenCalled()
    expect(profiles.saveApiKey).not.toHaveBeenCalled()
  })

  it('rejects PEM private-key material without exposing it to persistence', async () => {
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['C:\\secure\\model.key'] })
    stat.mockResolvedValue({ size: 80 })
    readFile.mockResolvedValue('-----BEGIN OPENSSH PRIVATE KEY-----\nmaterial\n-----END OPENSSH PRIVATE KEY-----')
    const profiles = { get: vi.fn(), saveApiKey: vi.fn() }

    await expect(new ModelApiKeyEntryService(profiles).importFromFile('llm-1')).rejects.toThrow()
    expect(profiles.saveApiKey).not.toHaveBeenCalled()
  })

  it('returns the existing non-secret key state when key selection is cancelled', async () => {
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    const profiles = { get: vi.fn().mockResolvedValue({ hasApiKey: true }), saveApiKey: vi.fn() }

    await expect(new ModelApiKeyEntryService(profiles).importFromFile('llm-1')).resolves.toEqual({ status: 'cancelled', hasApiKey: true })
    expect(profiles.saveApiKey).not.toHaveBeenCalled()
  })
})
