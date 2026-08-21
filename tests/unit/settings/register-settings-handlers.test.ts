import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerSettingsHandlers } from '../../../src/main/settings/register-settings-handlers'

const { handle, removeHandler } = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle, removeHandler } }))

describe('registerSettingsHandlers', () => {
  beforeEach(() => { handle.mockReset(); removeHandler.mockReset() })

  it('exposes only the two MVP setting groups to the trusted renderer', async () => {
    const models = { loadForRenderer: vi.fn().mockResolvedValue({ endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-5', contextLimit: 12_000, hasApiKey: true }), saveFromRenderer: vi.fn().mockResolvedValue(undefined) }
    const rules = { list: vi.fn(() => []), save: vi.fn().mockResolvedValue(undefined) }
    const sender = {}
    const dispose = registerSettingsHandlers(models, rules, sender as never)

    await expect(handler('settings:model:get')({ sender })).resolves.toMatchObject({ hasApiKey: true })
    await expect(handler('settings:regex-rules:save')({ sender }, [{ id: 'kill', name: '终止进程', pattern: 'kill\\b', enabled: true }])).resolves.toEqual(undefined)
    expect(rules.save).toHaveBeenCalledWith([{ id: 'kill', name: '终止进程', pattern: 'kill\\b', enabled: true }])
    expect(() => handler('settings:model:get')({ sender: {} })).toThrow('Untrusted renderer')

    dispose()
    expect(removeHandler.mock.calls.map(([channel]) => channel).sort()).toEqual([
      'settings:model:get', 'settings:model:save', 'settings:regex-rules:get', 'settings:regex-rules:save',
    ])
  })

  it('tests the unsaved renderer model input through the named connection checker', async () => {
    const models = {
      loadForRenderer: vi.fn(), saveFromRenderer: vi.fn(),
      prepareForConnectionTest: vi.fn().mockResolvedValue({ endpoint: 'https://compatible.example/v1/chat/completions', model: 'compatible-model', contextLimit: 8_000, apiKey: 'sk-protected' }),
    }
    const tester = { verify: vi.fn().mockResolvedValue({ model: 'compatible-model' }) }
    const sender = {}
    registerSettingsHandlers(models, { list: vi.fn(() => []), save: vi.fn() }, sender as never, tester)

    await expect(handler('settings:model:test')({ sender }, {
      endpoint: 'https://compatible.example/v1/chat/completions', model: 'compatible-model', contextLimit: 8_000,
    })).resolves.toEqual({ model: 'compatible-model' })

    expect(models.prepareForConnectionTest).toHaveBeenCalledWith({
      endpoint: 'https://compatible.example/v1/chat/completions', model: 'compatible-model', contextLimit: 8_000,
    })
    expect(tester.verify).toHaveBeenCalledWith({ endpoint: 'https://compatible.example/v1/chat/completions', model: 'compatible-model', contextLimit: 8_000, apiKey: 'sk-protected' })
  })

  it('rejects plaintext API keys on the legacy renderer model save and test channels', async () => {
    const legacyInput = {
      endpoint: 'https://compatible.example/v1/chat/completions', model: 'compatible-model', contextLimit: 8_000, apiKey: 'legacy-direct-key',
    }
    const models = {
      loadForRenderer: vi.fn(),
      saveFromRenderer: vi.fn().mockResolvedValue(undefined),
      prepareForConnectionTest: vi.fn().mockResolvedValue({ ...legacyInput }),
    }
    const tester = { verify: vi.fn().mockResolvedValue({ model: 'compatible-model' }) }
    const sender = {}
    registerSettingsHandlers(models, { list: vi.fn(() => []), save: vi.fn() }, sender as never, tester)

    await expect(handler('settings:model:save')({ sender }, legacyInput)).rejects.toThrow()
    await expect(handler('settings:model:test')({ sender }, legacyInput)).rejects.toThrow()

    expect(models.saveFromRenderer).not.toHaveBeenCalled()
    expect(models.prepareForConnectionTest).not.toHaveBeenCalled()
    expect(tester.verify).not.toHaveBeenCalled()
  })

  it('rejects API keys in the profile settings IPC request', async () => {
    const profiles = {
      list: vi.fn(), get: vi.fn(), save: vi.fn(), activate: vi.fn(), delete: vi.fn(),
      prepareForConnectionTest: vi.fn(), getRouting: vi.fn(), setRouting: vi.fn(),
    }
    const sender = {}
    registerSettingsHandlers(
      { loadForRenderer: vi.fn(), saveFromRenderer: vi.fn(), prepareForConnectionTest: vi.fn() },
      { list: vi.fn(() => []), save: vi.fn() }, sender as never, { verify: vi.fn() }, profiles as never,
    )

    const profileInputWithKey = {
      name: 'Primary', kind: 'llm', provider: 'openai', model: 'gpt-5', endpoint: 'https://api.openai.com/v1/chat/completions', contextLimit: 8_000, apiKey: 'secret',
    }
    await expect(handler('settings:models:save')({ sender }, profileInputWithKey)).rejects.toThrow()
    await expect(handler('settings:models:test')({ sender }, profileInputWithKey)).rejects.toThrow()
    expect(profiles.save).not.toHaveBeenCalled()
    expect(profiles.prepareForConnectionTest).not.toHaveBeenCalled()
  })

  it('requires explicit no-route authorization on the profile delete IPC', async () => {
    const profiles = {
      list: vi.fn(), get: vi.fn(), save: vi.fn(), activate: vi.fn(), delete: vi.fn().mockResolvedValue(undefined),
      prepareForConnectionTest: vi.fn(), getRouting: vi.fn(), setRouting: vi.fn(),
    }
    const sender = {}
    registerSettingsHandlers(
      { loadForRenderer: vi.fn(), saveFromRenderer: vi.fn(), prepareForConnectionTest: vi.fn() },
      { list: vi.fn(() => []), save: vi.fn() }, sender as never, undefined, profiles as never,
    )

    await expect(handler('settings:models:delete')({ sender }, { id: 'active', replacementId: null })).rejects.toThrow()
    expect(profiles.delete).not.toHaveBeenCalled()

    await expect(handler('settings:models:delete')({ sender }, { id: 'active', replacementId: null, allowNoActive: true })).resolves.toBeUndefined()
    expect(profiles.delete).toHaveBeenCalledWith('active', { replacementId: null, allowNoActive: true })
  })
})

function handler(channel: string): (event: { sender: unknown }, request?: unknown) => Promise<unknown> {
  const match = handle.mock.calls.find(([registered]) => registered === channel)
  if (!match) throw new Error(`Missing handler: ${channel}`)
  return match[1] as (event: { sender: unknown }, request?: unknown) => Promise<unknown>
}
