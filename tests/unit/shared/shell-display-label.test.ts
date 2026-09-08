import { describe, expect, it } from 'vitest'
import { hostnameDisplayLabels, resolvedHostnames, sshHostnameDisplayLabels } from '../../../src/shared/shell-display-label'

describe('hostname display labels', () => {
  it('uses source order to add ordinals only to repeated hostnames', () => {
    expect(hostnameDisplayLabels([
      { hostname: 'web-01' },
      { hostname: 'db-01' },
      { hostname: 'web-01' },
    ])).toEqual([
      { displayLabel: 'web-01 #1', ordinal: 1 },
      { displayLabel: 'db-01', ordinal: 1 },
      { displayLabel: 'web-01 #2', ordinal: 2 },
    ])
  })

  it('uses observed names first and connection titles to disambiguate shared routes', () => {
    expect(resolvedHostnames([
      { hostname: '127.0.0.1', displayName: 'AI中台_10.54.98.34' },
      { hostname: '127.0.0.1', displayName: 'AI中台_98.29' },
      { hostname: '127.0.0.1', displayName: 'AI中台_10.54.98.34', observedHostname: 'prod-web' },
    ])).toEqual(['AI中台_10.54.98.34', 'AI中台_98.29', 'prod-web'])
  })

  it('keeps duplicate observed names addressable with normalized connection titles', () => {
    expect(resolvedHostnames([
      { hostname: '127.0.0.1', observedHostname: 'same-prod', displayName: 'Primary target' },
      { hostname: '127.0.0.1', observedHostname: 'same-prod', displayName: 'Secondary target' },
    ])).toEqual(['Primary-target', 'Secondary-target'])
  })

  it('adds whitespace-free ordinals when shared connections have no usable titles', () => {
    expect(resolvedHostnames([
      { hostname: '127.0.0.1' },
      { hostname: '127.0.0.1' },
    ])).toEqual(['127.0.0.1#1', '127.0.0.1#2'])
    expect(resolvedHostnames([
      { hostname: '127.0.0.1', displayName: '堡垒 目标' },
      { hostname: '127.0.0.1', displayName: '堡垒 目标' },
    ])).toEqual(['堡垒-目标#1', '堡垒-目标#2'])
  })

  it('does not turn distinct bastion target names sharing one route IP into duplicates', () => {
    expect(sshHostnameDisplayLabels([
      { hostname: '10.10.10.10', displayName: 'app-prod-01', stableKey: 'connection-a' },
      { hostname: '10.10.10.10', displayName: 'db-prod-01', stableKey: 'connection-b' },
    ])).toEqual([
      { displayLabel: 'app-prod-01', ordinal: 1 },
      { displayLabel: 'db-prod-01', ordinal: 1 },
    ])
  })

  it('adds badges only when the resolved target hostname is the same', () => {
    expect(sshHostnameDisplayLabels([
      { hostname: '10.10.10.10', observedHostname: 'app-prod-01', stableKey: 'connection-a' },
      { hostname: '10.10.10.10', observedHostname: 'app-prod-01', stableKey: 'connection-b' },
      { hostname: '10.10.10.10', observedHostname: 'db-prod-01', stableKey: 'connection-c' },
    ])).toEqual([
      { displayLabel: 'app-prod-01 #1', ordinal: 1 },
      { displayLabel: 'app-prod-01 #2', ordinal: 2 },
      { displayLabel: 'db-prod-01', ordinal: 1 },
    ])
  })
})
