import { describe, expect, it } from 'vitest'
import { expectedSsoEndpointLedger, scopedSsoEndpointLedger } from '../../e2e/sso-request-ledger'

const endpoints = {
  origin: 'http://127.0.0.1:48231',
  loginUrl: 'http://127.0.0.1:48231/login',
  platformUrl: 'http://127.0.0.1:48231/platform?tenant=e2e',
  userInfoUrl: 'http://127.0.0.1:48231/userinfo?request=natural',
}

describe('SSO endpoint request ledger', () => {
  it('keeps the expected local login, platform, and natural user-info requests in order', () => {
    const ledger = scopedSsoEndpointLedger(endpoints, [
      'GET http://127.0.0.1:48231/favicon.ico',
      'GET http://127.0.0.1:48231/login',
      'GET http://127.0.0.1:48231/platform?tenant=e2e',
      'GET http://127.0.0.1:48231/userinfo?request=natural',
      'GET http://127.0.0.1:48231/static/app.js',
    ])

    expect(ledger).toEqual(expectedSsoEndpointLedger(endpoints))
  })

  it('retains endpoint method, query, and duplicate deviations so the strict ledger rejects them', () => {
    const expected = expectedSsoEndpointLedger(endpoints)

    expect(scopedSsoEndpointLedger(endpoints, [
      'POST http://127.0.0.1:48231/login',
      'GET http://127.0.0.1:48231/platform?tenant=e2e',
      'GET http://127.0.0.1:48231/userinfo?request=natural',
    ])).not.toEqual(expected)
    expect(scopedSsoEndpointLedger(endpoints, [
      'GET http://127.0.0.1:48231/login',
      'GET http://127.0.0.1:48231/platform?tenant=e2e',
      'GET http://127.0.0.1:48231/userinfo?request=wrong',
    ])).not.toEqual(expected)
    expect(scopedSsoEndpointLedger(endpoints, [
      ...expected,
      'GET http://127.0.0.1:48231/userinfo?request=natural',
    ])).not.toEqual(expected)
  })
})
