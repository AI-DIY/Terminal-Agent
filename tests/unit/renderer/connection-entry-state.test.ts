import { describe, expect, it } from 'vitest'
import {
  isCompleteBastionTarget,
  nextConnectionEntryState,
  type ConnectionEntryState,
} from '../../../src/renderer/src/components/connections/connection-entry-state'

describe('connection entry state', () => {
  it('keeps connection identity while clearing sensitive values on mode changes', () => {
    const state: ConnectionEntryState = {
      mode: 'password',
      host: 'web-01',
      port: 22,
      username: 'ops',
      password: 'secret',
      passphrase: 'phrase',
      keyReference: 'key-1',
    }

    expect(nextConnectionEntryState(state, 'privateKey')).toEqual({
      mode: 'privateKey',
      host: 'web-01',
      port: 22,
      username: 'ops',
      password: '',
      passphrase: '',
      keyReference: null,
    })
  })

  it('recognizes a complete IPv4 address or dotted hostname', () => {
    expect(isCompleteBastionTarget('10.20.5.8')).toBe(true)
    expect(isCompleteBastionTarget('web-01.example.internal')).toBe(true)
    expect(isCompleteBastionTarget('web')).toBe(false)
  })
})
