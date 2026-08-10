import { describe, expect, it } from 'vitest'
import { parseAccessClientArgv } from '../../../src/main/access-client/argv-parser'

describe('parseAccessClientArgv', () => {
  it.each([
    [['Terminal-Agent.exe', '@prod'], { kind: 'saved-session', name: 'prod' }],
    [['Terminal-Agent.exe', '-load', 'prod'], { kind: 'saved-session', name: 'prod' }],
    [['Terminal-Agent.exe', '-load', 'tmp:C:\\temp\\session.conf', '-pw', 'secret'], { kind: 'temporary-session', path: 'C:\\temp\\session.conf', password: 'secret' }],
    [['Terminal-Agent.exe', '-raw', '-P', '22022'], { kind: 'raw-port', port: 22022 }],
  ])('parses %j', (argv, expected) => {
    expect(parseAccessClientArgv(argv)).toEqual(expected)
  })

  it('rejects malformed or unsupported invocations locally', () => {
    expect(() => parseAccessClientArgv(['Terminal-Agent.exe', '-load'])).toThrow('Unsupported AccessClient invocation')
    expect(() => parseAccessClientArgv(['Terminal-Agent.exe', '-raw', '-P', '0'])).toThrow('Invalid port')
    expect(() => parseAccessClientArgv(['Terminal-Agent.exe', '-ssh', 'server-a'])).toThrow('Unsupported AccessClient invocation')
  })
})
