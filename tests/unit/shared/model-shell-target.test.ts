import { describe, expect, it } from 'vitest'
import { modelHostnameFromTitle, resolveModelShellTargets, sameModelShellTarget, selectStableModelTargetIndex } from '../../../src/shared/model-shell-target'

describe('model Shell target resolution', () => {
  it('prefers observed/valid hostnames and derives only strict user@hostname title hints', () => {
    expect(resolveModelShellTargets([
      { hostname: '127.0.0.1', observedHostname: 'WEB-PROD', displayName: 'appuser@ignored.example' },
      { hostname: 'db-prod', displayName: 'appuser@ignored.example' },
      { hostname: '127.0.0.1', displayName: 'appuser@c-ce-js-0002' },
    ])).toEqual(['web-prod', 'db-prod', 'c-ce-js-0002'])
  })

  it('allocates unique non-address aliases for hostname-less shells', () => {
    const targets = resolveModelShellTargets([
      { hostname: '127.0.0.1', displayName: 'Raw bridge' },
      { hostname: '192.0.2.10', displayName: 'Raw bridge 2' },
      { hostname: 'online-shell-1', displayName: 'Raw bridge 3' },
    ])
    expect(targets).toEqual(['online-shell-2', 'online-shell-3', 'online-shell-1'])
    expect(targets.some(value => /\d{1,3}(?:\.\d{1,3}){3}/.test(value))).toBe(false)
  })

  it('keeps keyed aliases stable when neighboring hostname-less shells change', () => {
    const first = resolveModelShellTargets([
      { stableKey: 'session-a', hostname: '127.0.0.1', displayName: 'Raw A' },
      { stableKey: 'session-b', hostname: '127.0.0.1', displayName: 'Raw B' },
    ])
    const afterRemoval = resolveModelShellTargets([
      { stableKey: 'session-b', hostname: '127.0.0.1', displayName: 'Raw B' },
    ])
    expect(afterRemoval[0]).toBe(first[1])
    expect(afterRemoval[0]).not.toContain('session-b')
  })

  it('selects the stable #1 session when a model target has duplicate connections', () => {
    expect(selectStableModelTargetIndex(
      'WEB-01.',
      ['web-01', 'web-01', 'db-01'],
      ['session-b', 'session-a', 'session-c'],
    )).toBe(1)
    expect(sameModelShellTarget('web-01', 'WEB-01.')).toBe(true)
    expect(selectStableModelTargetIndex('missing', ['web-01'], ['session-a'])).toBeUndefined()
  })

  it('rejects address-like or malformed title suffixes', () => {
    expect(modelHostnameFromTitle('appuser@192.0.2.10')).toBeUndefined()
    expect(modelHostnameFromTitle('appuser@[2001:db8::10]')).toBeUndefined()
    expect(modelHostnameFromTitle('appuser@host.example:22')).toBeUndefined()
    expect(modelHostnameFromTitle('appuser@host.example')).toBe('host.example')
  })
})
