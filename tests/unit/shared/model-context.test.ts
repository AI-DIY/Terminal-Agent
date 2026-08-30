import { describe, expect, it } from 'vitest'
import {
  isIpLiteral,
  modelHostname,
  projectModelFacts,
  sanitizeModelContent,
  sanitizeModelMessages,
  stripIpLiterals,
  uniqueModelHostnames,
} from '../../../src/shared/model-context'

describe('model context projection', () => {
  it('recognizes and removes IPv4, IPv6, and zone-index literals', () => {
    expect(isIpLiteral('192.0.2.10')).toBe(true)
    expect(isIpLiteral('[2001:db8::10]')).toBe(true)
    expect(isIpLiteral('fe80::1%eth0')).toBe(true)
    expect(stripIpLiterals('route 192.0.2.10 via [fe80::1%eth0]')).toBe('route  via ')
    expect(stripIpLiterals('loopback ::1 unspecified :: mapped ::ffff:192.0.2.1')).toBe('loopback  unspecified  mapped ')
    expect(stripIpLiterals('link-local ::1%eth0')).toBe('link-local ')
  })

  it('removes addresses next to URL, CIDR, and sentence punctuation without deleting ordinary text', () => {
    expect(stripIpLiterals('https://192.0.2.10:22/host')).toBe('https://:22/host')
    expect(stripIpLiterals('https://[2001:db8::10]:443/host')).toBe('https://:443/host')
    expect(stripIpLiterals('2001:db8::10/64.')).toBe('/64.')
    expect(stripIpLiterals('gateway 2001:db8::10.')).toBe('gateway .')
    expect(stripIpLiterals('time 12:34:56; label foo:bar')).toBe('time 12:34:56; label foo:bar')
    expect(stripIpLiterals('identifierx2001:db8::10')).toBe('identifierx2001:db8::10')
  })

  it('keeps only stable non-address host identities and de-duplicates them', () => {
    expect(modelHostname('VM-01.example.')).toBe('vm-01.example')
    expect(modelHostname('192.0.2.10')).toBeUndefined()
    expect(modelHostname('host:2001:db8::1')).toBeUndefined()
    expect(modelHostname('ssh://host.example')).toBeUndefined()
    expect(uniqueModelHostnames(['VM-01', 'vm-01', '192.0.2.10', 'fe80::1%eth0'])).toEqual(['vm-01'])
  })

  it('removes address fields and address-bearing object keys from facts', () => {
    const projected = projectModelFacts({
      hostname: 'vm-01',
      connectionIp: '192.0.2.10',
      networkInterfaces: [{ name: 'eth0', addresses: ['192.0.2.10'] }],
      services: { '10.0.0.1': 'active', web: 'active at 2001:db8::1' },
      nested: { remoteAddress: 'fe80::1%eth0', safe: 'ok' },
    }) as Record<string, unknown>

    expect(projected).toEqual({
      hostname: 'vm-01',
      services: { web: 'active at ' },
      nested: { safe: 'ok' },
    })
  })

  it('removes common singular, plural, and scoped address field variants', () => {
    const projected = projectModelFacts({
      hostname: 'vm-01',
      address: '192.0.2.1',
      ipAddresses: ['192.0.2.2'],
      remoteAddresses: ['192.0.2.3'],
      localAddresses: ['192.0.2.4'],
      connectionAddress: '192.0.2.5',
      interfaceAddresses: ['192.0.2.6'],
      safe: 'ok',
    }) as Record<string, unknown>
    expect(projected).toEqual({ hostname: 'vm-01', safe: 'ok' })
  })

  it('preserves opaque image data and ordinary user text while sanitizing generated messages', () => {
    const image = { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,AA==' } }
    const messages = sanitizeModelMessages([
      { role: 'user' as const, content: 'inspect 192.0.2.10' },
      { role: 'assistant' as const, content: 'observed 192.0.2.10' },
      { role: 'system' as const, content: [{ type: 'text' as const, text: 'host 192.0.2.10' }, image] },
    ])

    expect(messages[0]?.content).toBe('inspect 192.0.2.10')
    expect(messages[1]?.content).toBe('observed ')
    expect(messages[2]?.content).toEqual([{ type: 'text', text: 'host ' }, image])
    expect(sanitizeModelContent(image)).toEqual(image)
  })

  it('sanitizes address-bearing fields in structured text blocks', () => {
    expect(sanitizeModelContent([
      { type: 'text', text: 'host 192.0.2.10' },
      { type: 'text', text: 'safe', connectionIp: '192.0.2.10' } as unknown as { type: 'text'; text: string },
    ])).toEqual([
      { type: 'text', text: 'host ' },
      { type: 'text', text: 'safe' },
    ])
  })
})
