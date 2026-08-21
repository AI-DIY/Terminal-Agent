import { describe, expect, it } from 'vitest'
import { activeCmdbHostIds, availableHosts, shouldApplyBastionHostResponse } from '../../../src/renderer/src/components/connections/bastion-cmdb-state'

describe('CMDB form state', () => {
  it('filters hosts to the selected system and excludes connected CMDB targets', () => {
    expect(availableHosts([
      { id: 'web-01', systemId: 'orders', name: 'web-01', address: '10.0.0.8' },
      { id: 'web-02', systemId: 'orders', name: 'web-02', address: '10.0.0.9' },
      { id: 'db-01', systemId: 'data', name: 'db-01', address: '10.0.1.8' },
    ], 'orders', new Set(['web-01']))).toEqual([
      { id: 'web-02', systemId: 'orders', name: 'web-02', address: '10.0.0.9' },
    ])
  })

  it('discards an older system response and makes closed CMDB hosts available again', () => {
    expect(shouldApplyBastionHostResponse({ requestId: 1, latestRequestId: 2, requestedSystemId: 'orders', selectedSystemId: 'data' })).toBe(false)
    expect(shouldApplyBastionHostResponse({ requestId: 2, latestRequestId: 2, requestedSystemId: 'data', selectedSystemId: 'data' })).toBe(true)

    const sessions = new Map([['session-1', 'web-01']])
    expect(activeCmdbHostIds(sessions)).toEqual(new Set(['web-01']))
    sessions.delete('session-1')
    expect(activeCmdbHostIds(sessions)).toEqual(new Set())
  })
})
