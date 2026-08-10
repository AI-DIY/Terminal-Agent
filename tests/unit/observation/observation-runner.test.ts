import { describe, expect, it, vi } from 'vitest'
import { ObservationRunner } from '../../../src/main/observation/observation-runner'

describe('ObservationRunner', () => {
  it('sends only its fixed read-only Linux observation commands', async () => {
    const execute = vi.fn().mockResolvedValue('ok')
    await new ObservationRunner(execute).run('linux')

    expect(execute.mock.calls.flat()).toEqual(expect.arrayContaining(['hostname', 'uname -a', 'ps -eo comm=,stat=']))
    expect(execute.mock.calls.flat().join('\n')).toContain('systemctl list-units --type=service --no-pager --no-legend')
    expect(execute.mock.calls.flat().join('\n')).not.toMatch(/\b(kill|rm|vi|systemctl\s+restart)\b/)
  })
})
