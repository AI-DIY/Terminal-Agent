# Terminal-Agent V18 Prototype Visual Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the production Electron renderer visually match the approved V18 prototype while retaining all real 1.0.5 data, SSH, chat, history, settings, persistence, and safety behavior.

**Architecture:** Keep the existing Vue component boundaries and move only presentation-specific responsibilities. `App.vue` owns the shared V18 design tokens and global control/focus rules, `WorkbenchShell.vue` owns the inset desktop frame and three-column geometry, and each existing workbench/settings component owns its prototype-matching markup and styles. Prototype sample data and scripted demo behavior must never enter production.

**Tech Stack:** Electron 43, Vue 3, TypeScript 6, Vitest, Playwright, xterm.js, @lucide/vue.

---

### Task 1: Lock the V18 visual contract

**Files:**
- Create: `tests/unit/renderer/v18-visual-contract.test.ts`
- Modify: `tests/e2e/workbench.spec.ts`

- [x] **Step 1: Write a failing source-level visual contract test**

Assert that the production components expose the approved V18 labels and component ownership:

```ts
expect(read('WorkbenchSessionSidebar.vue')).toContain('聊天会话')
expect(read('WorkbenchSessionSidebar.vue')).toContain('标题由 AI 自动生成')
expect(read('GlobalChatPanel.vue')).toContain('AI 聊天')
expect(read('GlobalChatPanel.vue')).toContain('辅助驾驶')
expect(read('GlobalChatPanel.vue')).toContain('全自动驾驶')
expect(read('SettingsView.vue')).toContain('settings-layout')
expect(read('SessionTabs.vue')).not.toContain('辅助驾驶')
```

- [x] **Step 2: Add geometry checks to the existing layout E2E test**

At the existing `1440x900` viewport, assert a 48px app header, prototype-width side panels within persisted constraints, a single 42px Shell host bar, and an AI composer fully inside the right panel. Add a `1024x768` step asserting no overlap and no page-level horizontal overflow.

- [x] **Step 3: Run the focused tests and confirm the intended failure**

Run: `npm test -- tests/unit/renderer/v18-visual-contract.test.ts tests/unit/renderer/workbench-layout.test.ts`

Expected: FAIL because production still uses `任务历史`, `AI 工作区`, and the old settings layout.

### Task 2: Establish the shared V18 visual system

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/renderer/src/App.vue`
- Modify: `src/renderer/index.html`

- [x] **Step 1: Install the renderer icon dependency**

Run: `npm install @lucide/vue`

Expected: `@lucide/vue` is recorded in both package files without unrelated dependency upgrades.

- [x] **Step 2: Define the approved pearl and graphite tokens**

Add the prototype's semantic tokens for chrome, panel, surface, hover, selected, text levels, borders, accent, focus, success, warning, danger, and terminal surfaces to `App.vue`, with `:root[data-theme="graphite"]` overrides. Add global `focus-visible`, scrollbar, disabled-control, and typography rules. Keep all letter spacing at zero.

- [x] **Step 3: Match the prototype's renderer background**

Set the light root background to `#e7ebf0`, the graphite root background to `#121416`, and retain the initial render gate so no theme flash is introduced.

- [x] **Step 4: Run the visual contract test**

Run: `npm test -- tests/unit/renderer/v18-visual-contract.test.ts`

Expected: still FAIL only on component structure assertions.

### Task 3: Rebuild the workbench frame and chat-session sidebar

**Files:**
- Modify: `src/renderer/src/components/workbench/WorkbenchShell.vue`
- Modify: `src/renderer/src/components/workbench/WorkbenchSessionSidebar.vue`
- Modify: `src/renderer/src/views/WorkbenchView.vue`

- [x] **Step 1: Match the desktop frame and three-column grid**

Use the prototype's inset 8px shell, 8px outer radius, 48px top bar, 222px/390px default side regions, 3px separators, and collapsed rails. Keep persisted resizing values authoritative, but apply the same min/max behavior and 1024px narrowing rules as the production constraints.

- [x] **Step 2: Match the top bar**

Render the 28px TA mark, compact product name, current-chat breadcrumb, and a quiet Settings icon/text control. Remove the floating collapse buttons from the workspace and place labeled collapse controls in each panel header, matching the prototype.

- [x] **Step 3: Match the chat-session sidebar**

Render `聊天会话`, `标题由 AI 自动生成`, a full-width `新建聊天` command row, quiet date groups, and compact history rows. Preserve the existing delete behavior as a hover/focus icon action so no functionality is lost.

- [x] **Step 4: Run focused renderer tests**

Run: `npm test -- tests/unit/renderer/chat-workspaces.test.ts tests/unit/renderer/workbench-layout.test.ts tests/unit/renderer/v18-visual-contract.test.ts`

Expected: PASS for sidebar and shell contract assertions.

### Task 4: Rebuild the Shell host bar, canvas, and terminal chrome

**Files:**
- Modify: `src/renderer/src/components/workbench/ShellCanvas.vue`
- Modify: `src/renderer/src/components/SessionTabs.vue`
- Modify: `src/renderer/src/components/TerminalPane.vue`
- Modify: `src/renderer/src/views/WorkbenchView.vue`

- [x] **Step 1: Merge host tabs and workspace tools into one row**

Move the Shell count, new SSH action, and layout action into a sticky tool group at the right of the host-tab strip. Remove driving-mode labels from Shell tabs and the Shell toolbar; mode belongs to the AI panel in the approved prototype.

- [x] **Step 2: Match terminal framing**

Use a 6px terminal frame radius, 36px light/dark panel header, active top accent, compact host/user status, and Lucide history/maximize/more/close actions. Keep xterm's dark terminal body and mounted/hidden behavior unchanged.

- [x] **Step 3: Match grid and history states**

Use 10px canvas padding/gaps, retain persisted columns/row height, and style historical Shells as readable disconnected panels without global grayscale. Keep context menus and layout popovers within the frame.

- [x] **Step 4: Match the empty SSH state**

Restyle the existing four real connection modes to the centered V18 empty-state composition: terminal icon, compact heading/copy/status, segmented two-by-two mode selector, 36px fields, and one full-width primary connection action. The same launcher remains reusable in the existing dialog.

- [x] **Step 5: Run Shell and SSH tests**

Run: `npm test -- tests/unit/renderer/shell-canvas.test.ts tests/unit/renderer/sessions.test.ts tests/unit/renderer/direct-ssh-form.test.ts tests/unit/renderer/bastion-host-form.test.ts tests/unit/renderer/bastion-cmdb-form.test.ts`

Expected: PASS.

### Task 5: Rebuild the AI conversation panel

**Files:**
- Modify: `src/renderer/src/components/chat/GlobalChatPanel.vue`
- Modify: `src/renderer/src/views/WorkbenchView.vue`
- Test: `tests/unit/renderer/v18-visual-contract.test.ts`
- Test: `tests/unit/renderer/global-chat.test.ts`

- [x] **Step 1: Match the AI header and mode presentation**

Render the 30px AI avatar, `AI 聊天`/`AI 历史交互` title, current chat mode as a two-option segmented radio presentation, and the labeled panel-collapse action. The existing upgrade confirmation remains the authority for entering autonomous mode; no prototype-only fake state is introduced.

- [x] **Step 2: Match message presentation**

Render real user, assistant, and system messages with the prototype's avatars, metadata hierarchy, constrained message surfaces, assistant accent edge, readable wrapping, streaming state, retry action, and history-only treatment.

- [x] **Step 3: Match the composer**

Use the prototype's integrated composer shell, placeholder, context label, Send icon/button, Cancel state, and Ctrl/Cmd+Enter behavior. Preserve sanitization, per-chat drafts, retry, cancellation, and readonly history behavior.

- [x] **Step 4: Run chat tests**

Run: `npm test -- tests/unit/renderer/global-chat.test.ts tests/unit/renderer/chat-workspaces.test.ts tests/unit/renderer/v18-visual-contract.test.ts`

Expected: PASS.

### Task 6: Rebuild Settings as the approved desktop settings view

**Files:**
- Modify: `src/renderer/src/views/SettingsView.vue`
- Modify: `src/renderer/src/components/settings/ModelRoutingSettings.vue`
- Modify: `src/renderer/src/components/settings/ModelProfileManager.vue`
- Modify: `src/renderer/src/components/settings/RegexFenceRules.vue`
- Modify: `src/renderer/src/components/settings/HostMemorySettings.vue`
- Modify: `src/renderer/src/components/settings/AppearanceSettings.vue`

- [x] **Step 1: Match settings navigation**

Use a 56px header, `返回工作台`, a fixed 216px left navigation, and a scrollable right content pane. Preserve all six real settings routes and their existing form behavior.

- [x] **Step 2: Flatten panel presentation**

Remove webpage-style floating cards from page sections. Use unframed settings groups, quiet dividers, 5-6px control radii, left-edge selection accents, compact list/editor layouts, and prototype theme previews.

- [x] **Step 3: Run settings tests**

Run: `npm test -- tests/unit/renderer/settings-panels.test.ts tests/unit/renderer/model-profiles.test.ts tests/unit/renderer/host-memory-settings.test.ts tests/unit/renderer/layout-preferences.test.ts tests/unit/renderer/v18-visual-contract.test.ts`

Expected: PASS.

### Task 7: Verify behavior and visual parity

**Files:**
- Modify only if verification finds a scoped defect.

- [x] **Step 1: Run all unit tests**

Run: `npm test`

Expected: all tests pass with zero failures.

- [x] **Step 2: Run lint and production build**

Run: `npm run lint`

Run: `npm run build`

Expected: both commands exit 0 without TypeScript or Vue template errors.

- [x] **Step 3: Run focused Electron E2E coverage**

Run: `npx playwright test tests/e2e/workbench.spec.ts --grep "layout controls persist|collapse rails|keeps an existing SSH terminal mounted"`

Expected: all focused scenarios pass.

- [x] **Step 4: Perform visual regression at desktop sizes**

Launch the real Electron app, capture `1440x900` and `1024x768` screenshots for empty, connected, history, graphite, and settings states, and compare them with `.superpowers/brainstorm/ui-20260811185554/content/simplified-core-workbench-v18-unified-ssh-connection.html`. Verify that no controls overlap, text clips, panel scroll leaks, or blank xterm canvases appear.

- [x] **Step 5: Review the final diff**

Run: `git diff --check` and `git status --short`.

Expected: no whitespace errors and only the intended renderer, test, package, and plan files are modified.
