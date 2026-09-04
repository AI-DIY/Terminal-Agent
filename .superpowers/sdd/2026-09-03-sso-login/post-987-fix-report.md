# Post-987 SSO Close-Order Fix Report

## Root cause

Commit `987769e` classified a rejected navigation as a closed window only when
the `closed` event had already fired or `isDestroyed()` was already true. In
Electron, a user close request emits `BrowserWindow`'s `close` event before the
window reaches the `closed` lifecycle event and before `isDestroyed()` reports
true. A pending local `about:blank` `loadURL` can therefore reject in that
interval and was mapped to the generic safe error.

## RED evidence

Added the regression test
`reports window closed when local priming aborts before the close lifecycle completes`
to `tests/unit/sso/sso-authentication-service.test.ts`. The test rejects the
pending `about:blank` navigation with a non-whitelist abort error, verifies the
fake window is not destroyed, then emits `close` and expects the terminal
closed-window snapshot.

Command:

```text
npx vitest run tests/unit/sso/sso-authentication-service.test.ts -t "local priming aborts before"
```

Result before the production change:

```text
1 failed | 32 skipped
Expected errorMessage: SSO sign-in window closed
Received errorMessage: Unable to complete SSO sign-in
exit_code=1
```

## Fix and GREEN evidence

`src/main/sso/sso-authentication-service.ts` now listens for the earlier
`close` event and records close intent in the existing `windowClosed` flag.
The listener is removed together with the existing `closed` listener during
navigation/session teardown. The existing catch path then maps a close-caused
navigation/setup rejection to the exact `SSO sign-in window closed` message,
while a live window without close intent still uses `safeCaptureError` and the
generic message.

Command:

```text
npx vitest run tests/unit/sso/sso-authentication-service.test.ts
```

Result after the production change:

```text
Test Files  1 passed (1)
Tests       33 passed (33)
exit_code=0
```

## Changed files

- `src/main/sso/sso-authentication-service.ts`
- `tests/unit/sso/sso-authentication-service.test.ts`
- `.superpowers/sdd/2026-09-03-sso-login/post-987-fix-report.md`

## Residual concerns

- The close-order behavior is covered by the executable unit fake; no new
  Electron runtime/E2E case was added.
- No request, retry, DOM fallback, URL matcher, capture protocol, or broader
  lifecycle behavior was changed.
