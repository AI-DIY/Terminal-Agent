import { describe, expect, it } from 'vitest'
import { toDirectConnectionRequest } from '../../../src/renderer/src/components/connections/direct-ssh-form-state'

describe('direct SSH form state', () => {
  it('builds a password connection request', () => {
    expect(toDirectConnectionRequest({
      mode: 'password',
      host: 'server-a',
      port: 22,
      username: 'ops',
      password: 'secret',
    })).toEqual({
      host: 'server-a',
      port: 22,
      username: 'ops',
      auth: { kind: 'password', password: 'secret' },
    })
  })

  it('requires a selected key reference for private-key connections', () => {
    expect(toDirectConnectionRequest({
      mode: 'privateKey',
      host: 'server-a',
      port: 22,
      username: 'ops',
      keyReference: null,
      passphrase: '',
    })).toEqual({ error: '请选择私钥文件。' })
  })

  it('rejects missing identity fields before building either request', () => {
    expect(toDirectConnectionRequest({
      mode: 'password',
      host: ' ',
      port: 22,
      username: '',
      password: '',
    })).toEqual({ error: '请填写主机地址和用户名。' })
  })
})
