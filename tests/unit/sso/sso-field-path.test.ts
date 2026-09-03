import { describe, expect, it } from 'vitest'
import { parseSsoFieldPath, readSsoField } from '../../../src/main/sso/sso-field-path'

describe('SSO field paths', () => {
  it('reads nested array values from Object Path and JSONPath-root forms', () => {
    const payload = { data: { em: [{ name: '张三', employeeId: 42 }] } }
    expect(readSsoField(payload, 'data.em[0].name')).toBe('张三')
    expect(readSsoField(payload, '$.data.em[0].employeeId')).toBe('42')
  })

  it('supports quoted bracket keys', () => {
    expect(readSsoField({ data: { em: [{ employeeId: 7 }] } }, "$['data']['em'][0]['employeeId']")).toBe('7')
  })

  it('rejects unsafe or multi-value syntax', () => {
    for (const path of ['*', '..name', 'data[?(@.active)]', 'data[(@.name)]', 'data[*].name', 'data.__proto__', 'data.constructor', 'data.prototype']) {
      expect(() => parseSsoFieldPath(path)).toThrow()
    }
  })

  it('returns only non-empty strings and finite numbers', () => {
    const payload = { a: '', b: '  ok  ', c: Infinity, d: true, e: null, f: { x: 1 }, g: [1] }
    expect(readSsoField(payload, 'a')).toBeUndefined()
    expect(readSsoField(payload, 'b')).toBe('ok')
    expect(readSsoField(payload, 'c')).toBeUndefined()
    expect(readSsoField(payload, 'd')).toBeUndefined()
    expect(readSsoField(payload, 'e')).toBeUndefined()
    expect(readSsoField(payload, 'f')).toBeUndefined()
    expect(readSsoField(payload, 'g')).toBeUndefined()
    expect(readSsoField({ users: [{ name: 'x' }] }, 'users[4].name')).toBeUndefined()
  })
})
