import { describe, expect, it } from 'vitest'
import { broadcastCommandPayload } from '../../../src/renderer/src/components/workbench/broadcast-command'

describe('broadcast command payloads', () => {
  it('executes an ordinary compact command immediately', () => {
    expect(broadcastCommandPayload('hostname')).toBe('hostname\r')
  })

  it('completes the final command from the expanded multiline editor', () => {
    expect(broadcastCommandPayload('echo first\necho second', true)).toBe('echo first\necho second\r')
    expect(broadcastCommandPayload('echo first\necho second\n', true)).toBe('echo first\necho second\n')
  })

  it('does not alter pasted terminal control sequences', () => {
    expect(broadcastCommandPayload('\u001b[200~echo pasted', true)).toBe('\u001b[200~echo pasted')
    expect(broadcastCommandPayload('\u0003')).toBe('\u0003')
  })
})
