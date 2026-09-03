import type { SsoUrlMatcher } from '../../shared/sso-contracts'

type ParsedSsoUrl = {
  full: string
  exact: string
}

export function normalizeSsoUrl(value: string): string {
  return parseSsoUrl(value).full
}

export function validateSsoMatcher(matcher: SsoUrlMatcher): void {
  if (matcher.mode === 'exact') {
    normalizeSsoUrl(matcher.value)
    return
  }

  if (matcher.mode === 'regex') {
    if (matcher.value.trim().length === 0) throw new Error('SSO regular expression cannot be empty')
    try {
      new RegExp(matcher.value)
    } catch (error) {
      throw new Error('Invalid SSO regular expression', { cause: error })
    }
    return
  }

  throw new Error('Invalid SSO URL matcher mode')
}

export function matchesSsoUrl(matcher: SsoUrlMatcher, candidateUrl: string): boolean {
  validateSsoMatcher(matcher)
  const candidate = parseSsoUrl(candidateUrl)

  if (matcher.mode === 'exact') return parseSsoUrl(matcher.value).exact === candidate.exact

  return new RegExp(matcher.value).test(candidate.full)
}

function parseSsoUrl(value: string): ParsedSsoUrl {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch (error) {
    throw new Error('SSO URL must be an HTTP or HTTPS URL', { cause: error })
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('SSO URL must be an HTTP or HTTPS URL')
  }

  url.hash = ''
  return {
    full: url.toString(),
    exact: `${url.protocol}//${url.host}${url.pathname}`,
  }
}
