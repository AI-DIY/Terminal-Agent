import { describe, expect, it } from 'vitest'
import { bastionLaunchRequestSchema } from '../../../src/shared/contracts'

describe('bastion launch contract', () => {
  it('accepts a CMDB system and host identifier without credentials', () => {
    expect(bastionLaunchRequestSchema.parse({ kind: 'cmdb', systemId: 'orders', hostId: 'host-42' }))
      .toEqual({ kind: 'cmdb', systemId: 'orders', hostId: 'host-42' })
  })

  it('accepts only a complete bastion host target', () => {
    expect(bastionLaunchRequestSchema.parse({ kind: 'host', target: 'web-01.example.internal' }))
      .toEqual({ kind: 'host', target: 'web-01.example.internal' })
    expect(() => bastionLaunchRequestSchema.parse({ kind: 'host', target: 'web' })).toThrow()
    expect(() => bastionLaunchRequestSchema.parse({ kind: 'host', target: '999.20.5.8' })).toThrow()
  })

  it('rejects credentials, temporary paths, and unknown renderer fields', () => {
    expect(() => bastionLaunchRequestSchema.parse({
      kind: 'cmdb',
      systemId: 'orders',
      hostId: 'host-42',
      password: 'secret',
      temporaryProfilePath: 'C:\\temp\\jump',
    })).toThrow()
  })
})
