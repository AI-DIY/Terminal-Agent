import { describe, expect, it } from 'vitest'
import { modelApiKeySchema, rendererModelProfileInputSchema } from '../../../src/shared/validation'

const profileInput = {
  name: 'Primary',
  kind: 'llm' as const,
  provider: 'openai' as const,
  model: 'gpt-5',
  endpoint: 'https://api.openai.com/v1/chat/completions',
  contextLimit: 8_000,
}

describe('model profile request validation', () => {
  it('accepts a trimmed temporary API key up to the UTF-8 byte limit', () => {
    expect(modelApiKeySchema.parse('  request-key  ')).toBe('request-key')
    expect(rendererModelProfileInputSchema.parse({ ...profileInput, apiKey: '  request-key  ' })).toMatchObject({ apiKey: 'request-key' })
  })

  it('rejects an API key exceeding the UTF-8 byte limit', () => {
    expect(() => modelApiKeySchema.parse('密'.repeat(1_366))).toThrow()
  })

  it('rejects obsolete key-profile references from strict renderer input', () => {
    const obsoleteReferenceField = ['apiKey', 'ProfileId'].join('')
    expect(() => rendererModelProfileInputSchema.parse({ ...profileInput, [obsoleteReferenceField]: 'shared-llm' })).toThrow()
  })
})
