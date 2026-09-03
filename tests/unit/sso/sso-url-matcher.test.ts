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
    const matcher = { mode: 'regex' as const, value: '^https://platform\\.example/home\\?code=\\w+$' }
    expect(matchesSsoUrl(matcher, 'https://platform.example/home?code=one#fragment')).toBe(true)
    expect(matchesSsoUrl(matcher, 'https://platform.example/home?code=two')).toBe(true)
    expect(matchesSsoUrl(matcher, 'https://platform.example/home')).toBe(false)
  })

  it('rejects invalid regular expressions and unknown matcher modes', () => {
    expect(() => validateSsoMatcher({ mode: 'regex', value: '[' })).toThrow()
    expect(() => validateSsoMatcher({ mode: 'other' as never, value: 'x' })).toThrow()
  })
})
