import { describe, expect, it } from 'vitest'
import { bastionHostRequest } from '../../../src/renderer/src/components/connections/bastion-host-state'

describe('bastion host form state', () => {
  it('requires a complete target instead of a partial host name', () => {
    expect(bastionHostRequest('web')).toEqual({ error: '请输入完整 IP 或完整主机名。' })
    expect(bastionHostRequest('web-01.example.internal')).toEqual({ kind: 'host', target: 'web-01.example.internal' })
  })
})
