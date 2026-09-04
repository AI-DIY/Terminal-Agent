import { describe, expect, it } from 'vitest'
import * as environment from '../../e2e/sso-e2e-environment'

type CleanupApi = {
  closeE2eResources(...close: Array<() => Promise<void>>): Promise<unknown[]>
  throwCleanupFailures(primaryFailure: { error: unknown } | undefined, failures: unknown[]): void
}

const cleanup = environment as typeof environment & CleanupApi

describe('SSO E2E resource cleanup', () => {
  it('continues attempting every cleanup callback after failures', async () => {
    const first = new Error('first cleanup failed')
    const second = new Error('second cleanup failed')
    const completed: string[] = []

    const failures = await cleanup.closeE2eResources(
      async () => { completed.push('first'); throw first },
      async () => { completed.push('second') },
      async () => { completed.push('third'); throw second },
    )

    expect(completed).toEqual(['first', 'second', 'third'])
    expect(failures).toEqual([first, second])
  })

  it('preserves a primary failure together with every cleanup failure', () => {
    const primary = new Error('assertion failed')
    const firstCleanup = new Error('app close failed')
    const secondCleanup = new Error('temporary root removal failed')

    expect(() => cleanup.throwCleanupFailures(
      { error: primary },
      [firstCleanup, secondCleanup],
    )).toThrow(AggregateError)

    try {
      cleanup.throwCleanupFailures({ error: primary }, [firstCleanup, secondCleanup])
    } catch (error) {
      expect((error as AggregateError).errors).toEqual([primary, firstCleanup, secondCleanup])
    }
  })

  it('keeps a lone cleanup failure directly observable without a primary failure', () => {
    const cleanupFailure = new Error('server close failed')

    expect(() => cleanup.throwCleanupFailures(undefined, [cleanupFailure])).toThrow(cleanupFailure)
  })
})
