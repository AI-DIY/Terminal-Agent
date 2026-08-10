import { describe, expect, it, vi } from 'vitest'
import { RegexRuleSettingsService } from '../../../src/main/settings/regex-rule-settings-service'

describe('RegexRuleSettingsService', () => {
  it('replaces the gateway rule set only after validated rules are saved', async () => {
    const repository = { load: vi.fn().mockResolvedValue([{ id: 'kill', name: '终止进程', pattern: 'kill\\b', enabled: true }]), save: vi.fn().mockResolvedValue(undefined) }
    const service = new RegexRuleSettingsService(repository)

    await service.load()
    expect(service.match('kill -9 1')).toEqual({ id: 'kill', name: '终止进程' })

    await service.save([{ id: 'editor', name: '编辑器', pattern: 'vim\\b', enabled: true }])
    expect(repository.save).toHaveBeenCalledWith([{ id: 'editor', name: '编辑器', pattern: 'vim\\b', enabled: true }])
    expect(service.match('kill -9 1')).toBeNull()
    expect(service.match('vim /etc/nginx/nginx.conf')).toEqual({ id: 'editor', name: '编辑器' })
  })
})
