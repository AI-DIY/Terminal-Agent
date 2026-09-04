import { describe, expect, it } from 'vitest'
import { resolveSsoConfigHomeDirectory } from '../../../src/main/settings/sso-config-home'

describe('resolveSsoConfigHomeDirectory', () => {
  it('keeps Electron home for ordinary runtime launches', () => {
    expect(resolveSsoConfigHomeDirectory('C:\\Users\\actual-user', {
      TERMINAL_AGENT_TEST_SSO_HOME: 'C:\\temp\\should-not-be-used',
    })).toBe('C:\\Users\\actual-user')
  })

  it('uses the isolated E2E home only when the explicit test marker is present', () => {
    expect(resolveSsoConfigHomeDirectory('C:\\Users\\actual-user', {
      TERMINAL_AGENT_E2E: '1',
      TERMINAL_AGENT_TEST_SSO_HOME: 'C:\\temp\\terminal-agent-sso-e2e',
    })).toBe('C:\\temp\\terminal-agent-sso-e2e')
  })

  it('never redirects a packaged application away from Electron home', () => {
    expect(resolveSsoConfigHomeDirectory('C:\\Users\\actual-user', {
      TERMINAL_AGENT_E2E: '1',
      TERMINAL_AGENT_TEST_SSO_HOME: 'C:\\temp\\terminal-agent-sso-e2e',
    }, true)).toBe('C:\\Users\\actual-user')
  })

  it('falls back to Electron home when the marked E2E launch has no usable override', () => {
    expect(resolveSsoConfigHomeDirectory('C:\\Users\\actual-user', {
      TERMINAL_AGENT_E2E: '1',
      TERMINAL_AGENT_TEST_SSO_HOME: '   ',
    })).toBe('C:\\Users\\actual-user')
  })
})
