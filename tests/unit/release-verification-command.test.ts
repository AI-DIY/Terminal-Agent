import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('release integration verification command', () => {
  it('runs the release launcher suite with its integration-specific Vitest configuration', async () => {
    const packageJson = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }

    expect(packageJson.scripts['test:integration']).toBe('vitest run --config vitest.integration.config.ts')
    expect(packageJson.scripts['pretest:integration']).toBe('node scripts/release-integration-artifacts.cjs')
    expect(packageJson.scripts['make:win']).toContain('node scripts/windows/finalize-windows-release-artifacts.cjs')
  })
})
