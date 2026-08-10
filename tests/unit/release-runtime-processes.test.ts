import { describe, expect, it } from 'vitest'
import { selectNewRuntimeProcessId } from '../helpers/release-runtime-processes'

describe('selectNewRuntimeProcessId', () => {
  it('selects only a runtime PID that was absent before this launch', () => {
    expect(selectNewRuntimeProcessId([4100, 4200], new Set([4100]))).toBe(4200)
  })

  it('does not select a runtime that already existed before this launch', () => {
    expect(selectNewRuntimeProcessId([4100], new Set([4100]))).toBeUndefined()
  })
})
