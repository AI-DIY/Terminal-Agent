import { describe, expect, it, vi } from 'vitest'
import {
  ownsRuntimeProcess,
  selectNewRuntimeProcessId,
  terminateOwnedRuntimeProcess,
  type RuntimeProcessIdentity,
} from '../helpers/release-runtime-processes'

describe('selectNewRuntimeProcessId', () => {
  it('selects only a runtime PID that was absent before this launch', () => {
    expect(selectNewRuntimeProcessId([4100, 4200], new Set([4100]))).toBe(4200)
  })

  it('does not select a runtime that already existed before this launch', () => {
    expect(selectNewRuntimeProcessId([4100], new Set([4100]))).toBeUndefined()
  })

  it('does not terminate a PID that now belongs to a different executable', async () => {
    const expected: RuntimeProcessIdentity = {
      processId: 4100,
      executablePath: 'D:/Terminal-Agent/Terminal-Agent-runtime.exe',
      creationDate: '20260811100000.000000+000',
    }
    const current: RuntimeProcessIdentity = {
      ...expected,
      executablePath: 'C:/Windows/System32/notepad.exe',
    }
    const terminate = vi.fn().mockResolvedValue(undefined)

    await terminateOwnedRuntimeProcess(expected, async () => current, terminate)

    expect(terminate).not.toHaveBeenCalled()
    expect(ownsRuntimeProcess(current, expected)).toBe(false)
  })

  it('accepts equivalent executable paths when only Windows path casing differs', () => {
    const expected: RuntimeProcessIdentity = {
      processId: 4100,
      executablePath: 'D:/Terminal-Agent/Terminal-Agent-runtime.exe',
      creationDate: '20260811100000.000000+000',
    }
    expect(ownsRuntimeProcess({
      ...expected,
      executablePath: 'd:\\terminal-agent\\Terminal-Agent-runtime.exe',
    }, expected)).toBe(true)
  })
})
