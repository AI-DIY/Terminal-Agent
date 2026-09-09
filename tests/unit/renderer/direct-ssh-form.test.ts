import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { toDirectConnectionRequest } from '../../../src/renderer/src/components/connections/direct-ssh-form-state'

const form = readFileSync(new URL('../../../src/renderer/src/components/connections/DirectSshForm.vue', import.meta.url), 'utf8')

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

  it('uses a responsive theme-aware layout for password and private-key fields', () => {
    expect(form).toContain(':class="`auth-${mode}`"')
    expect(form).toContain('.direct-fields { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(120px, .65fr);')
    expect(form).toContain('@container (max-width: 430px)')
    expect(form).toContain('.field-host, .field-password, .field-key, .field-passphrase { grid-column: 1 / -1; }')
    expect(form).toContain('background: var(--surface-soft)')
    expect(form).toContain('.key-button-label { min-width: 0; overflow: hidden; text-overflow: ellipsis;')
  })
})
