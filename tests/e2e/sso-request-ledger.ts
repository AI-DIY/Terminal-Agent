export type SsoEndpointFixture = {
  origin: string
  loginUrl: string
  platformUrl: string
  userInfoUrl: string
}

/** The ordered, complete requests required for a successful local SSO flow. */
export function expectedSsoEndpointLedger(fixture: Pick<SsoEndpointFixture, 'loginUrl' | 'platformUrl' | 'userInfoUrl'>): string[] {
  return [
    `GET ${fixture.loginUrl}`,
    `GET ${fixture.platformUrl}`,
    `GET ${fixture.userInfoUrl}`,
  ]
}

/** Keep only the SSO endpoints while preserving method, URL, query, and order. */
export function scopedSsoEndpointLedger(
  fixture: Pick<SsoEndpointFixture, 'origin'>,
  entries: readonly string[],
): string[] {
  return entries.filter(entry => {
    const separator = entry.indexOf(' ')
    if (separator <= 0) return false
    try {
      const url = new URL(entry.slice(separator + 1))
      return url.origin === fixture.origin && ['/login', '/platform', '/userinfo'].includes(url.pathname)
    } catch {
      return false
    }
  })
}
