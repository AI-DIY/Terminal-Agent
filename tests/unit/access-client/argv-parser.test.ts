import { describe, expect, it } from 'vitest'
import { parseAccessClientArgv } from '../../../src/main/access-client/argv-parser'
import { AccessClientLaunchFailure } from '../../../src/main/access-client/launch-failure'

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
    expectFailure(['Terminal-Agent.exe', '-load'], 'unsupported-launch-arguments')
    expectFailure(['Terminal-Agent.exe', '-raw', '-P', '0'], 'unsupported-launch-arguments')
    expectFailure(['Terminal-Agent.exe', '-ssh', 'server-a'], 'unsupported-launch-arguments')
  })
})

function expectFailure(argv: string[], code: AccessClientLaunchFailure['code']): void {
  try {
    parseAccessClientArgv(argv)
    throw new Error('expected parser to fail')
  } catch (error) {
    expect(error).toBeInstanceOf(AccessClientLaunchFailure)
    expect(error).toMatchObject({ code })
  }
}
