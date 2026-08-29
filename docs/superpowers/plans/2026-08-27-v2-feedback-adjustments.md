# Terminal-Agent 2.0 Feedback Adjustments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a Windows-installable Terminal-Agent 2.0 build that applies the approved feedback without changing the established three-column workbench layout or removing existing supported workflows.

**Architecture:** Start from the existing `codex/ai-workspace-shell-plan` implementation, which already supplies structured AI JSON, controlled plan execution, and multimodal persistence. Restrict the renderer to text-only AI input, render approved plan data as the existing workbench design specifies, and make shell/task ownership deterministic in the renderer and main-process execution boundary. Keep old agent/session-mode internals only for backward compatibility; make them unreachable from the workbench.

**Tech Stack:** Electron 43, Vue 3, TypeScript, Vitest, Playwright, xterm.js, Zod, `@langchain/langgraph`, electron-builder/NSIS.

**Spec:** `docs/superpowers/specs/2026-08-25-ai-workspace-shell-plan-approval-design.md`; user-approved feedback extracted from `C:/Users/User/Desktop/开源TA修改意见 - 此次修改.pdf`.

## Global Constraints

- The PDF is the authority for this adjustment; where it conflicts with the previous design, remove the image-upload UI and keep only text chat.
- Preserve the existing three-column layout, existing shell/SSH/bastion/history/settings workflows, and all existing user data compatibility.
- Remove all workbench-reachable full-autonomous-driving UI, confirmation dialogs, and automatic command-send paths. Do not delete legacy compatibility modules solely for this task.
- The only AI command path must be a persisted structured plan with one explicit group confirmation; no re-run control is rendered or callable through the UI.
- Same-host Shell display names must be stable in connection order: first `host #1`, second `host #2`, and so on. AI-visible labels use that same display convention; command resolution uses the first online matching Shell.
- Opening a shell while a history task is selected appends it to that selected task. A new task becomes the target only after the user explicitly chooses New Task. On application startup, select a fresh new task page.
- Terminal input must remain visible and reachable at 900x700 and ordinary desktop sizes; page-level overflow is forbidden.
- Decode AccessClient temporary profiles according to declared UTF-8/CP936/GBK-family encodings; do not depend on the Windows system UTF-8 locale switch.
- Release version and installer artifact must begin with `2.0.` and the final installer must be a Windows NSIS executable.

---

## File Map

| File | Responsibility |
| --- | --- |
| `package.json`, `package-lock.json`, release docs | 2.0.x version and installer naming metadata. |
| `src/renderer/src/stores/sessions.ts` | Pure stable same-host display-label calculation. |
| `src/renderer/src/stores/chat-workspaces.ts` | Explicit current-task ownership and startup/new-task helper behavior. |
| `src/renderer/src/views/WorkbenchView.vue` | Startup new-task selection, bastion/direct shell attachment, and removal of autonomous UI. |
| `src/renderer/src/components/SessionTabs.vue`, `src/renderer/src/components/workbench/ShellCanvas.vue` | Indexed Shell labels, context menu, terminal frame bounds. |
| `src/renderer/src/components/TerminalPane.vue` | Native clipboard/menu actions and fit-safe terminal viewport. |
| `src/renderer/src/components/chat/GlobalChatPanel.vue` | Text-only composer, transient structured-AI progress, safe reply/plan/audit rendering and group plan controls. |
| `src/renderer/src/stores/global-chat.ts` | Structured message projection, progress state, and plan operation actions. |
| `src/main/chat/chat-runtime.ts`, `src/main/chat/structured-chat-agent.ts` | Final JSON-only persistence and transient stage event delivery. |
| `src/main/chat/execution-plan-service.ts`, `src/main/main.ts` | Stable first-online session binding and display-label context passed to AI. |
| `src/main/access-client/temp-session-reader.ts` | Byte-safe UTF-8/CP936 profile title decoding. |
| focused tests under `tests/unit`, `tests/integration`, `tests/e2e` | Regression evidence for each behavior and packaging artifact. |

## Task 1: Establish 2.0 Defaults and Deterministic Task/Shell Ownership

**Files:**
- Modify: `src/renderer/src/stores/sessions.ts`
- Modify: `src/renderer/src/stores/chat-workspaces.ts`
- Modify: `src/renderer/src/views/WorkbenchView.vue`
- Modify: `src/renderer/src/components/SessionTabs.vue`
- Modify: `src/renderer/src/components/workbench/ShellCanvas.vue`
- Test: `tests/unit/renderer/sessions.test.ts`
- Test: `tests/unit/renderer/chat-workspaces.test.ts`
- Test: `tests/unit/renderer/workbench-view.test.ts` or existing focused workbench coverage

**Interfaces:**
- Produces `sessionDisplayLabel(session, orderedSessions): string`, returning a title/hostname with an ordinal only when that hostname has more than one live session.
- Produces explicit workbench selection helpers so `attachSession()` receives the selected task id, rather than silently preferring the previous `liveChatId`.

- [ ] **Step 1: Write failing tests** for same-host labels (`web-01 #1`, `web-01 #2`), single-host labels, and the rule that attachment targets the selected task after selecting history but targets a new task after `create()` completes.
- [ ] **Step 2: Run the focused renderer tests** and confirm the new assertions fail because labels are not ordinal and `attachSession` falls back to `liveChatId`.
- [ ] **Step 3: Add the smallest pure label helper** in the session store and route all SessionTabs/ShellCanvas labels through it with the ordered current session list.
- [ ] **Step 4: Make task attachment explicit** in WorkbenchView: a user selection remains the target for direct/bastion opens; `createChat()` records the new task as the target; startup creates/selects one fresh task after loading existing history; reconnect restoration retains its original task ownership.
- [ ] **Step 5: Remove workbench-reachable autonomous UI** from WorkbenchView while retaining legacy services: remove the upgrade store, event handlers, dialog, modal state, and props passed to the AI panel.
- [ ] **Step 6: Re-run focused tests and the existing workbench ownership suite** and commit the completed task.

## Task 2: Make AI Workspace Text-Only, Structured, and Calm During Generation

**Files:**
- Modify: `src/renderer/src/components/chat/GlobalChatPanel.vue`
- Modify: `src/renderer/src/stores/global-chat.ts`
- Modify: `src/main/chat/chat-runtime.ts`
- Modify: `src/main/chat/structured-chat-agent.ts`
- Modify: `src/shared/contracts.ts`
- Test: `tests/unit/renderer/global-chat.test.ts`
- Test: `tests/unit/renderer/v18-visual-contract.test.ts`
- Test: `tests/unit/chat/chat-runtime.test.ts`
- Test: `tests/unit/chat/structured-chat-agent.test.ts`

**Interfaces:**
- Consumes persisted `ChatMessageRecord.executionPlan` and execution audit messages.
- Produces a transient `chat:progress` event carrying only a bounded stage label (`thinking`, `executing`, `observing`, `repairing`) and never raw model JSON or secret data.
- Produces UI actions that use existing `window.terminalAgent.chat.plans.{editStep,removeStep,cancel,execute}` APIs.

- [ ] **Step 1: Write failing tests** that require no file input/image button/full-autonomous text/re-run control in GlobalChatPanel; require the manual-confirmation badge, plan card controls, audit rendering, and final JSON reply parsing.
- [ ] **Step 2: Write failing runtime tests** for stage events before and during structured generation and for no `chat:delta` exposure when the structured path succeeds.
- [ ] **Step 3: Run those tests** and confirm they fail against the current bare plan rendering and legacy streaming behavior.
- [ ] **Step 4: Implement the text-only composer**: remove image selection/pending-image controls from the visible surface; retain content-contract compatibility for pre-existing image messages but do not allow creation of new image content.
- [ ] **Step 5: Implement classified message rendering**: ordinary user/assistant text, independent execution audits, parsed assistant reply, risk summary derived only from fences, per-step original/final command views, edit/delete/cancel, and the single `确认并执行 N 步` action. Disable controls outside `pending_review`; never display re-run.
- [ ] **Step 6: Add bounded transient progress** in runtime/structured agent and render it as a replaceable process item. Clear it when valid final JSON, error, cancellation, or timeout reaches the UI. It may communicate thought/execute/observe/repair stages but must never persist intermediate JSON.
- [ ] **Step 7: Re-run focused unit tests and commit the completed task.**

## Task 3: Unify AI Target Labels, Plan Binding, Terminal Usability, and Context Menu

**Files:**
- Modify: `src/main/main.ts`
- Modify: `src/main/chat/structured-chat-agent.ts`
- Modify: `src/main/chat/execution-plan-service.ts`
- Modify: `src/renderer/src/components/workbench/ShellCanvas.vue`
- Modify: `src/renderer/src/components/TerminalPane.vue`
- Modify: `src/renderer/src/components/workbench/WorkbenchShell.vue`
- Modify: `src/renderer/src/stores/layout-preferences.ts` if a pure size helper is needed
- Test: `tests/unit/chat/execution-plan-service.test.ts`
- Test: `tests/unit/renderer/shell-canvas.test.ts`
- Test: `tests/unit/renderer/layout-preferences.test.ts`
- Test: `tests/e2e/workbench.spec.ts`

**Interfaces:**
- AI system context receives ordered current-task shell entries `{ hostname, title, displayLabel, ordinal }` and tells the model to use the display label only for presentation while plan targets remain hostname values.
- `ExecutionPlanService.execute()` always binds same-host commands to the first still-online task-associated session in stored association order.

- [ ] **Step 1: Write failing tests** for an AI context containing hostname labels rather than IP aliases, first-online same-host execution binding, and no use of a later same-host session.
- [ ] **Step 2: Write failing renderer/e2e tests** that right-clicking a terminal exposes standard clipboard actions and that terminal/composer controls stay inside a 900x700 workbench viewport.
- [ ] **Step 3: Run the focused tests** and confirm the existing context lacks ordinal labels, terminal context menu lacks paste, and viewport bounds are not covered.
- [ ] **Step 4: Add display-label context without changing plan target keys**; keep `target` as the actual hostname and have execution bind in association order, not arbitrary snapshot order.
- [ ] **Step 5: Add terminal context menu actions** (copy, paste, select all, clear selection) through xterm APIs and clipboard-safe renderer APIs; preserve keyboard behavior and all existing terminal controls.
- [ ] **Step 6: Repair grid/terminal height constraints** using `minmax(0, 1fr)`, `min-height: 0`, stable toolbar rows, and internal scrolling only. Verify resize/fit uses the final bounded terminal element size.
- [ ] **Step 7: Re-run focused and browser checks and commit the completed task.**

## Task 4: Make AccessClient Title Decoding Independent of Windows UTF-8 Locale

**Files:**
- Modify: `src/main/access-client/temp-session-reader.ts`
- Test: `tests/unit/access-client/temp-session-reader.test.ts`
- Test: `tests/unit/access-client/access-client-service.test.ts` if profile propagation coverage is absent

**Interfaces:**
- `readTempSession(path, readFile)` decodes complete temporary profile bytes with declared `LineCodePage`; known CP936/GBK/GB2312/GB18030 routes to `gb18030`, UTF-8 routes to `utf-8`, and an absent/unknown declaration tries strict UTF-8 then safe Windows-936 fallback for textual title fields.

- [ ] **Step 1: Write a failing regression test** using bytes for `AI中台_10.54.98.34` with no `LineCodePage`, expecting the correct Chinese title without changing the OS locale.
- [ ] **Step 2: Run the focused test** and confirm that the current UTF-8-only fallback produces replacement characters or a malformed title.
- [ ] **Step 3: Implement strict deterministic fallback decoding** that preserves ASCII config keys, prefers declared encoding, and only applies GB18030 fallback when UTF-8 decoding is invalid.
- [ ] **Step 4: Re-run CP936, UTF-8, malformed-data, raw-profile, and new locale-independent tests; commit the completed task.**

## Task 5: Release Evidence and Windows Installer

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `RELEASE_NOTES.md`
- Modify: `README.md`, `README-en.md` only where versioned install filenames occur
- Modify: `scripts/release-integration-artifacts.cjs` and relevant tests if artifact version assumptions require it
- Test: `tests/unit/release-integration-artifacts.test.ts`
- Test: `tests/unit/windows/app-branding.test.ts`

**Interfaces:**
- Produces `release/Terminal-Agent-Setup-2.0.0.exe` from `npm run make:win` and retains the existing bridge and cleanup artifacts.

- [ ] **Step 1: Write/adjust failing release tests** that assert `2.0.0` metadata and a `Terminal-Agent-Setup-2.0.0.exe` artifact name.
- [ ] **Step 2: Run the focused release tests** and confirm they fail against 1.0.13 metadata.
- [ ] **Step 3: Update versioned metadata/docs and exact release notes** for manual confirmation plans, disabled image uploading, stable same-host labels, task attachment behavior, terminal menu, and encoding correction.
- [ ] **Step 4: Run full validation**: `npm test`, `npm run build`, `npm run test:integration`, `npm run test:e2e`, then `npm run make:win`.
- [ ] **Step 5: Inspect the generated release directory** for the NSIS installer, runtime bridge, cleanup ZIP, and artifact validation report. Commit the release task only after fresh command evidence is available.

## Final Review Checklist

- [ ] No GlobalChatPanel string, button, event, or modal offers full autonomous driving, image upload, or re-run.
- [ ] A valid structured AI final response shows ordinary reply content and a separately rendered plan card; intermediate model JSON never persists or renders.
- [ ] All command execution is only initiated through one group confirmation and binds same-host targets to connection #1.
- [ ] Startup is a new task page; subsequent direct/bastion session opens append to the selected task until a user clicks New Task.
- [ ] Same-host shell labels are consistent between terminal title/tab and AI-visible context.
- [ ] Terminal right click exposes copy/paste/select-all behavior; 900x700 has no page-level scroll or obscured command input.
- [ ] `AI中台_10.54.98.34` decodes correctly on default non-UTF-8 Windows locale.
- [ ] Installer version begins `2.0.` and the generated NSIS `.exe` is present.
