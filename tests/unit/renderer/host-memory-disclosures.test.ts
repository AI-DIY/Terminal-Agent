import { describe, expect, it } from 'vitest'
import { createHostMemoryDisclosureQueue } from '../../../src/renderer/src/stores/host-memory-disclosure-queue'

describe('host memory disclosure queue', () => {
  it('keeps concurrent disclosures addressable in arrival order', () => {
    const queue = createHostMemoryDisclosureQueue()
    queue.enqueue({ token: 'a'.repeat(43), hostIdentity: '10.0.0.1' })
    queue.enqueue({ token: 'b'.repeat(43), hostIdentity: '10.0.0.2' })

    expect(queue.current.value).toMatchObject({ hostIdentity: '10.0.0.1' })
    queue.remove('a'.repeat(43))
    expect(queue.current.value).toMatchObject({ hostIdentity: '10.0.0.2' })
    queue.remove('b'.repeat(43))
    expect(queue.current.value).toBeNull()
  })
})
