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

  it.each([
    [
      'an LLM target',
      [
        {
          id: 'source-llm', kind: 'llm', name: 'Source', provider: 'openai',
          model: 'gpt-5', endpoint: 'https://api.openai.com/v1/chat/completions', contextLimit: 8_000,
        },
        {
          id: 'target-llm', kind: 'llm', name: 'Target', provider: 'openai',
          model: 'gpt-5-mini', endpoint: 'https://api.openai.com/v1/chat/completions', contextLimit: 8_000,
          apiKeyProfileId: 'source-llm',
        },
      ],
      'apiKeyProfileId is only valid on VLM profiles',
    ],
    [
      'a missing source profile',
      [{
        id: 'target-vlm', kind: 'vlm', name: 'Target', provider: 'openai',
        model: 'gpt-vision', endpoint: 'https://api.openai.com/v1/chat/completions', maxImages: 4,
        apiKeyProfileId: 'missing-source',
      }],
      'apiKeyProfileId must reference an existing LLM profile',
    ],
    [
      'a VLM source profile',
      [
        {
          id: 'source-vlm', kind: 'vlm', name: 'Source', provider: 'openai',
          model: 'source-vision', endpoint: 'https://api.openai.com/v1/chat/completions', maxImages: 4,
        },
        {
          id: 'target-vlm', kind: 'vlm', name: 'Target', provider: 'openai',
          model: 'target-vision', endpoint: 'https://api.openai.com/v1/chat/completions', maxImages: 4,
          apiKeyProfileId: 'source-vlm',
        },
      ],
      'apiKeyProfileId must reference an existing LLM profile',
    ],
  ])('rejects version 1 API-key references with %s', async (_label, profiles, expectedIssue) => {
    const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-invalid-model-key-reference-'))
    try {
      const path = join(directory, 'model-profiles.json')
      await writeFile(path, JSON.stringify({
        version: 1,
        profiles,
        activeLlmId: null,
        activeVlmId: null,
        routing: 'combined',
        migrations: {},
      }), 'utf8')

      let caught: unknown
      try {
        await new ModelProfileRepository(path).load()
      } catch (error) {
        caught = error
      }

      expect(caught).toBeInstanceOf(Error)
      const issues = ((caught as Error & { cause?: { issues?: Array<{ message: string }> } }).cause?.issues ?? [])
      expect(issues.map(issue => issue.message)).toContain(expectedIssue)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
