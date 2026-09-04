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

## Post-987 fix round 2

### Confirmed root cause

The runtime trace showed that the configured remote login navigation can reject
with Electron `ERR_FAILED (-2)` while the authentication window is still live.
In the failing ordering, neither `close` nor `closed` had reached the service;
the immediate catch therefore published the generic terminal snapshot and
removed the listeners before Electron delivered the close lifecycle events.
The prior `close` listener fix handled an earlier close event but could not
arbitrate this later event ordering.

### RED evidence

Added two executable tests to
`tests/unit/sso/sso-authentication-service.test.ts`:

- `lets a close signal arriving after login navigation rejection win terminal arbitration`
  rejects the configured login `loadURL` with `ERR_FAILED (-2)`, verifies the
  fake window is live at rejection, waits one event-loop turn so the current
  implementation can settle, then emits `close`/`closed` and requires the
  exact closed-window snapshot.
- `maps an equivalent live-window navigation failure to the generic safe error`
  records that the window is live at an equivalent rejection and preserves the
  bounded generic safe error.

Command:

```text
npx vitest run tests/unit/sso/sso-authentication-service.test.ts -t "terminal arbitration|equivalent live-window"
```

Result on `2f39c4c` before the production change:

```text
1 failed | 1 passed | 33 skipped
Expected errorMessage: SSO sign-in window closed
Received errorMessage: Unable to complete SSO sign-in
exit_code=1
```

### Arbitration design and GREEN evidence

The catch path now waits for a close signal belonging to the same session or a
100 ms condition-based timeout. A close/closed event resolves the signal and
wins terminal classification; an equivalent failure on a genuinely live
window reaches the bounded timeout and remains `Unable to complete SSO sign-in`.
The timeout is cleared when either side wins. Session teardown resolves the
signal before removing listeners, so cancellation and generation invalidation
cannot leave a pending wait, timer, or listener holding window/capture
ownership. Existing safe error sanitization and all other terminal paths remain
unchanged.

Focused regression command:

```text
npx vitest run tests/unit/sso/sso-authentication-service.test.ts -t "terminal arbitration|equivalent live-window"
```

Result after the production change:

```text
Tests  2 passed | 33 skipped
exit_code=0
```

Complete focused SSO unit group:

```text
npx vitest run tests/unit/sso
Test Files  5 passed (5)
Tests       61 passed (61)
exit_code=0
```

Build, lint, and diff checks all exited 0. The required embedded save-and-
continue E2E was run serially with one worker and the original assertion:

```text
npx playwright test tests/e2e/sso-login.spec.ts --grep "save-and-continue from embedded" --repeat-each=20 --workers=1 --timeout 60000 --reporter=line
Running 20 tests using 1 worker
20 passed (41.4s)
exit_code=0
```

### Round 2 residual concerns

- The 100 ms fallback is intentionally bounded; it adds up to that delay only
  to uncategorized navigation/setup failures while a window remains live.
- The late-event arbitration is covered by the unit fake and repeated embedded
  Electron E2E, but no new production logging was added.
