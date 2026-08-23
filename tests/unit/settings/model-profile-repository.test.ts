import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ModelProfileRepository } from '../../../src/main/settings/model-profile-repository'

describe('ModelProfileRepository', () => {
  it('persists a versioned document with active IDs and routing without secrets', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-model-profiles-'))
    try {
      const repository = new ModelProfileRepository(join(directory, 'model-profiles.json'))
      await repository.save({
        version: 2,
        profiles: [{
          id: 'llm-1', kind: 'llm', name: 'Primary', provider: 'openai',
          model: 'gpt-5', endpoint: 'https://api.openai.com/v1/chat/completions', contextLimit: 12_000,
        }],
        activeLlmId: 'llm-1',
        activeVlmId: null,
        routing: 'combined',
        migrations: { legacyModelSettings: 1 },
      })

      const raw = await readFile(join(directory, 'model-profiles.json'), 'utf8')
      expect(raw).not.toContain('secret')
      await expect(repository.load()).resolves.toMatchObject({ version: 2, activeLlmId: 'llm-1', routing: 'combined' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('migrates a legacy single model document only once and preserves the migration marker', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-model-migration-'))
    try {
      const path = join(directory, 'model-profiles.json')
      await writeFile(path, JSON.stringify({
        endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o', contextLimit: 8_000,
      }), 'utf8')
      const repository = new ModelProfileRepository(path)
      await expect(repository.load()).resolves.toMatchObject({ version: 2, profiles: [] })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.each([
    ['credentials and sensitive query parameters', 'https://user:pass@example.com/v1/chat/completions?api_key=embedded'],
    ['sensitive path segments', 'https://example.com/v1/api_key/chat/completions'],
    ['URL fragments', 'https://api.openai.com/v1/chat/completions#token'],
  ])('rejects persisted model endpoints that contain %s', async (_label, unsafeEndpoint) => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-model-endpoint-validation-'))
    try {
      const repository = new ModelProfileRepository(join(directory, 'model-profiles.json'))
      const baseDocument = {
        version: 2 as const,
        profiles: [{
          id: 'llm-1', kind: 'llm' as const, name: 'Primary', provider: 'openai' as const,
          model: 'gpt-5', endpoint: unsafeEndpoint, contextLimit: 12_000,
        }],
        activeLlmId: 'llm-1', activeVlmId: null, routing: 'combined' as const, migrations: {},
      }

      await expect(repository.save(baseDocument)).rejects.toThrow()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('migrates version 1 API-key references into pending version 2 metadata', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-model-key-reference-migration-'))
    try {
      const path = join(directory, 'model-profiles.json')
      await writeFile(path, JSON.stringify({
        version: 1,
        profiles: [
          {
            id: 'shared-llm', kind: 'llm', name: 'Shared LLM', provider: 'openai',
            model: 'gpt-5', endpoint: 'https://api.openai.com/v1/chat/completions', contextLimit: 12_000,
          },
          {
            id: 'vision', kind: 'vlm', name: 'Vision', provider: 'openai',
            model: 'gpt-vision', endpoint: 'https://api.openai.com/v1/chat/completions', maxImages: 4,
            apiKeyProfileId: 'shared-llm',
          },
        ],
        activeLlmId: 'shared-llm',
        activeVlmId: 'vision',
        routing: 'combined',
        migrations: {},
      }), 'utf8')

      const repository = new ModelProfileRepository(path)
      const migrated = await repository.load()

      expect(migrated).toMatchObject({
        version: 2,
        migrations: {
          apiKeyReferences: [{ sourceProfileId: 'shared-llm', targetProfileId: 'vision' }],
        },
      })
      expect(migrated.profiles.find(profile => profile.id === 'vision')).not.toHaveProperty('apiKeyProfileId')
      const persisted = await readFile(path, 'utf8')
      expect(persisted).not.toContain('apiKeyProfileId')
      expect(JSON.parse(persisted)).toMatchObject({ version: 2 })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
