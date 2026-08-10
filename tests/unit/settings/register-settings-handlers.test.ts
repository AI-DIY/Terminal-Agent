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
})

function handler(channel: string): (event: { sender: unknown }, request?: unknown) => Promise<unknown> {
  const match = handle.mock.calls.find(([registered]) => registered === channel)
  if (!match) throw new Error(`Missing handler: ${channel}`)
  return match[1] as (event: { sender: unknown }, request?: unknown) => Promise<unknown>
}
