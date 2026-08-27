# Task 2 Review Fix Round 1

## Scope

Closed the review findings for the text-only structured AI workspace without changing the existing three-column layout or SSH/Shell behavior.

## Changes

- `GlobalChatPanel.vue` now renders a concise safety-fence risk line only when the persisted execution-plan step has `fence.ruleName` and `fence.ruleId`. It does not parse model text for risk data.
- Plan-step editing uses a local draft keyed by message and step. Input changes update the draft; the save action submits that current draft exactly once, removing the previous change-plus-save stale-command race.
- Removed the unused `Pencil` import and obsolete `.ai-mode-*` CSS.
- `global-chat.ts` keeps hydration of historical image content, but `composeUserContent`, `send`, and `retry` only permit text, preventing new image content from being created or sent through the current renderer API.
- Cancellation persistence failures now clear transient progress as well as the run and active message state.
- Updated renderer visual contracts to require the text-only/manual-confirmation surface and reject autonomous, image-upload, retry, and duplicate-edit UI.

## TDD Evidence

Tests were updated first and run red against the pre-fix implementation:

```text
npx vitest run tests/unit/renderer/global-chat.test.ts tests/unit/renderer/v18-visual-contract.test.ts tests/unit/renderer/shell-canvas.test.ts
4 failed: cancellation progress remained `thinking`; pending-image composition cloned image data; direct image send was accepted; stale `@change="editStep"` remained.
```

After implementation, focused coverage passed:

```text
npx vitest run tests/unit/renderer/global-chat.test.ts tests/unit/renderer/v18-visual-contract.test.ts tests/unit/renderer/shell-canvas.test.ts
3 test files passed; 31 tests passed.
```

The complete renderer suite and typecheck passed:

```text
npx vitest run tests/unit/renderer
26 test files passed; 214 tests passed; 1 skipped.

npx vue-tsc --noEmit
passed

git diff --check
passed
```

## Commit

Implementation and regression tests: `2acb985 fix: close structured chat review findings`

