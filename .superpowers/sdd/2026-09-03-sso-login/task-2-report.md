# Task 2 Report: Passive CDP SSO Response Capture

Status: DONE

Final commit: `e975553b54e50701dc60ab6ff76631ec74fde265`

## Files changed

- `src/main/sso/sso-response-capture.ts`
- `tests/unit/sso/sso-response-capture.test.ts`

## RED evidence

Command:

```text
npx vitest run tests/unit/sso/sso-response-capture.test.ts
```

Expected failure: Vitest could not import `../../../src/main/sso/sso-response-capture` because the production module did not yet exist. The suite reported one failed test file and zero executed tests.

## GREEN evidence

Focused capture suite:

```text
npx vitest run tests/unit/sso/sso-response-capture.test.ts
Test Files  1 passed (1)
Tests       7 passed (7)
```

Relevant Task 1 suites:

```text
npx vitest run tests/unit/sso/sso-url-matcher.test.ts tests/unit/sso/sso-field-path.test.ts
Test Files  2 passed (2)
Tests       8 passed (8)
```

Additional verification passed:

- `npx eslint src/main/sso/sso-response-capture.ts tests/unit/sso/sso-response-capture.test.ts`
- `npx tsc --noEmit --pretty false`
- `git diff --check`

## Safety audit

The implementation is passive. It attaches `webContents.debugger`, enables the CDP Network domain, observes `Network.responseReceived` and `Network.loadingFinished`, and calls `Network.getResponseBody` only for a previously matched successful response after its finish event. It does not expose or implement `fetch`, `session.fetch`, `net.request`, replay/retry, request construction from a URL, DOM inspection, renderer JavaScript, localStorage access, cookie access, or renderer DOM handles.

Both platform navigation and user-info response matching use the shared `matchesSsoUrl()` helper. Identity fields are read only through `readSsoField()`. Authentication requires both a matched platform navigation and a usable parsed identity, regardless of arrival order.

Bodies are decoded as base64 only when CDP declares `base64Encoded`; UTF-8 byte size is bounded before JSON parsing. Malformed body encodings, JSON, and field paths are discarded and waiting continues. Only successful HTTP responses (2xx) are retained.

## Cleanup behavior

All exits use one idempotent cleanup path. It removes debugger/window listeners, clears the navigation-started timeout, clears pending request IDs and captured identity, disables Network when still attached, and detaches the debugger. Cleanup is covered for successful capture, timeout, closed auth window, debugger detach, debugger command failure, and repeated explicit `dispose()` calls. User-facing errors are bounded and do not include raw CDP errors, bodies, URLs, headers, or request IDs.

## Self-review

The focused tests exercise the real state transitions through fakes at the Electron/CDP boundary: loading-finished correlation, non-matching and non-success responses, base64 decoding, malformed candidate recovery, byte limits, navigation/identity ordering, timeout start semantics, close/detach cleanup, command-failure masking, and idempotent disposal.

## Concerns

No known functional concerns for Task 2. The module uses narrow structural Electron/CDP types intentionally so unit tests can supply fakes without launching Electron.
