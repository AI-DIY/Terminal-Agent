import { describe, expect, it } from 'vitest'
import { hostnameDisplayLabels } from '../../../src/shared/shell-display-label'

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
})
