import { describe, expect, it } from 'vitest'
import { formFromSavedProfile, savedProfileFromForm } from '../../../src/renderer/src/components/direct-session-profile-form'

describe('direct-session-profile form helpers', () => {
  it('prefills only direct-session metadata and keeps the stable ID while an unchanged password is omitted', () => {
    const form = formFromSavedProfile({
      id: 'prod-api', name: '生产 API', host: 'api.example.com', port: 22, username: 'ops', authKind: 'password',
    })
    const update = savedProfileFromForm({ ...form, name: '生产 API（新名称）' })

    expect(form).toEqual({
      id: 'prod-api', name: '生产 API', host: 'api.example.com', port: 22, username: 'ops', authKind: 'password', privateKeyPath: undefined,
    })
    expect(update).toEqual({
      id: 'prod-api', name: '生产 API（新名称）', host: 'api.example.com', port: 22, username: 'ops', auth: { kind: 'password' },
    })
    expect(JSON.stringify(update)).not.toContain('secret-password')
  })
})
