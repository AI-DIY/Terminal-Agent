import { describe, expect, it } from 'vitest'
import { matchesSsoUrl, normalizeSsoUrl, validateSsoMatcher } from '../../../src/main/sso/sso-url-matcher'

describe('SSO URL matcher', () => {
  it('ignores query and fragment for exact matching', () => {
    const matcher = { mode: 'exact' as const, value: 'https://platform.example/home' }
    expect(matchesSsoUrl(matcher, 'https://platform.example/home?code=one#ignored')).toBe(true)
    expect(matchesSsoUrl(matcher, 'https://platform.example/other')).toBe(false)
  })

  it('normalizes protocol, host and path while rejecting non-http URLs', () => {
    expect(normalizeSsoUrl(' HTTPS://PLATFORM.EXAMPLE:443/home#fragment ')).toBe('https://platform.example/home')
    expect(() => normalizeSsoUrl('ftp://platform.example/home')).toThrow()
    expect(() => validateSsoMatcher({ mode: 'exact', value: 'not-a-url' })).toThrow()
  })

  it('retains query for regex matching and is stateless across repeated calls', () => {
    const matcher = { mode: 'regex' as const, value: '^https://platform\\.example/home\\?code=(?:one|two)$' }
    expect(matchesSsoUrl(matcher, 'https://platform.example/home?code=one#fragment')).toBe(true)
    expect(matchesSsoUrl(matcher, 'https://platform.example/home?code=two')).toBe(true)
    expect(matchesSsoUrl(matcher, 'https://platform.example/home')).toBe(false)
  })

  it('matches normalized full URLs by prefix while retaining query and rejecting a different host', () => {
    const matcher = { mode: 'prefix' as const, value: ' HTTPS://platform.example/api/v1#ignored ' }

    expect(matchesSsoUrl(matcher, 'https://platform.example/api/v1/users?request=one#fragment')).toBe(true)
    expect(matchesSsoUrl(matcher, 'https://platform.example/api/v1')).toBe(true)
    expect(matchesSsoUrl(matcher, 'https://platform.example/api/v2/users')).toBe(false)
    expect(matchesSsoUrl(matcher, 'https://platform.example.evil/api/v1/users')).toBe(false)
    expect(matchesSsoUrl(matcher, 'https://platform.example/api/v1-other')).toBe(true)
  })

  it('supports a host-only prefix without allowing a lookalike hostname', () => {
    const matcher = { mode: 'prefix' as const, value: 'https://platform.example' }

    expect(matchesSsoUrl(matcher, 'https://platform.example/path')).toBe(true)
    expect(matchesSsoUrl(matcher, 'https://platform.example.evil/path')).toBe(false)
    expect(() => validateSsoMatcher({ mode: 'prefix', value: 'ftp://platform.example' })).toThrow()
  })

  it('ignores browser-internal candidate URLs while keeping matcher validation strict', () => {
    const exact = { mode: 'exact' as const, value: 'https://platform.example/home' }
    const regex = { mode: 'regex' as const, value: '^https://platform\\.example/home$' }

    expect(matchesSsoUrl(exact, 'about:blank')).toBe(false)
    expect(matchesSsoUrl(exact, 'chrome-error://chromewebdata/')).toBe(false)
    expect(matchesSsoUrl(regex, 'data:text/plain,not-a-platform-page')).toBe(false)
    expect(matchesSsoUrl(regex, 'blob:https://platform.example/9d9c0b4e-7b0e-4f21-9b72-0a7a2c4a6f00')).toBe(false)
    expect(matchesSsoUrl(regex, 'not a URL')).toBe(false)

    expect(() => validateSsoMatcher({ mode: 'exact', value: 'about:blank' })).toThrow()
  })

  it('rejects invalid regular expressions and unknown matcher modes', () => {
    expect(() => validateSsoMatcher({ mode: 'regex', value: '[' })).toThrow()
    expect(() => validateSsoMatcher({ mode: 'other' as never, value: 'x' })).toThrow()
  })
})
