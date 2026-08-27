# Task 3 Report: Unified Shell Labels, Plan Binding, and Terminal Usability

## Changed files

- `src/main/chat/structured-chat-agent.ts`: project ordered online task Shell associations into hostname-based display labels and constrain plan targets to raw hostnames.
- `src/main/chat/chat-runtime.ts`: pass the ordered Shell context into structured generation.
- `src/main/main.ts`: build the structured Shell context from task associations and live sessions.
- `src/renderer/src/components/TerminalPane.vue`: add copy, paste, select-all, and clear-selection context-menu actions with clipboard fallback handling.
- `src/renderer/src/components/workbench/ShellCanvas.vue` and `WorkbenchShell.vue`: retain bounded grid tracks, stable toolbar rows, and internal scrolling contracts.
- `src/renderer/src/stores/sessions.ts`: make visible terminal labels hostname-based with stable same-host ordinals.
- `tests/unit/chat/chat-runtime.test.ts`, `structured-chat-agent.test.ts`, `execution-plan-service.test.ts`, `tests/unit/renderer/sessions.test.ts`, `shell-canvas.test.ts`, and `tests/e2e/workbench.spec.ts`: regression coverage and updated hostname label expectations.

## Verification

- `npx vitest run tests/unit/chat/structured-chat-agent.test.ts tests/unit/chat/execution-plan-service.test.ts tests/unit/chat/chat-runtime.test.ts tests/unit/renderer/sessions.test.ts tests/unit/renderer/shell-canvas.test.ts tests/unit/access-client/temp-session-reader.test.ts`: 6 files passed, 63 tests passed.
- `npx vue-tsc --noEmit`: passed.
- `npx tsc --noEmit --pretty false`: passed.
- Targeted `npx eslint` over changed TypeScript/test files: passed; Vue file is ignored by the repository ESLint configuration.
- `npm run lint`: existing unrelated errors remain in `tests/unit/renderer/chat-workspaces.test.ts` at lines 87 and 106 (`no-useless-assignment`).
- `git diff --check`: passed before commit.

## Review package

- `.superpowers/sdd/2026-08-27-v2-feedback-adjustments/review-79b5e5f..ddaa497.diff`

## Commit

- `ddaa497 feat: unify shell labels and terminal usability`

## Remaining concerns

- Electron/Playwright runtime and full end-to-end browser verification still need to run in the release validation stage.
- The user-owned `package-lock.json`, plan document, and `tmp/` PDF artifacts remain uncommitted and intentionally untouched.

## Review correction

Changed in this correction:

- `tests/e2e/workbench.spec.ts`: the layout persistence test now captures the active task button's accessible name before reload and explicitly reselects that task after reload before opening `Shell 布局`. This preserves the test's original assertions while accommodating the intentional startup behavior that selects a fresh task.

Pre-existing Task 3 behavior verified and preserved:

- The shared `shell-display-label` helper and its renderer/main imports keep same-host labels consistent.
- Structured chat receives ordered Shell context with presentation-only `displayLabel` values while plan targets remain hostnames.
- Same-host plan execution binds to the first still-online associated session.
- Terminal context-menu copy, paste, select-all, and clear-selection actions route through xterm and clipboard-safe renderer APIs.
- The bounded workbench layout and 900x700 geometry assertions remain unchanged except for the updated safety-badge selector already present in the review fixes.

Correction verification:

- Before the correction: the focused layout test timed out after reload while clicking `Shell 布局`, because the fresh startup task had no restored Shell sessions.
- After the correction: `npx playwright test tests/e2e/workbench.spec.ts -g "layout controls persist while hidden terminals remain mounted and online|opens terminal clipboard actions from a right click and routes them through xterm"` — 2 passed.

Correction implementation commit: `c69f4b5 test: preserve layout task across reload`.
