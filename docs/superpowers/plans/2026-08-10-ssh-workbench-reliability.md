# SSH Workbench Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Terminal-Agent keep its SSH workspace across settings, act as a single-file Assess Client `putty.exe` bridge, diagnose standard Chat Completions connections, show hostnames, and manage persisted direct SSH sessions without caching bastion jumps.

**Architecture:** Keep the renderer workbench alive while settings are visible. Add an explicit direct-session persistence boundary (JSON metadata plus Electron safe storage secrets), while leaving Access Client temporary invocations memory-only. Extend the model client with a standard request verifier and make the native launcher resolve the installed runtime through a per-user registry entry.

**Tech Stack:** Electron 43, Vue 3, TypeScript, Vitest, Electron `safeStorage`, Windows Registry API, C++17 launcher.

---

### Task 1: Preserve the workbench and promote observed hostnames

**Files:**
- Modify: `src/renderer/src/App.vue`, `src/main/ssh/session-service.ts`, `src/main/observation/register-session-observation.ts`, `src/renderer/src/stores/sessions.ts`, `src/renderer/src/components/SessionTabs.vue`
- Test: `tests/unit/ssh/session-service.test.ts`, `tests/unit/renderer/sessions.test.ts`, `tests/unit/renderer/visible-panes.test.ts`, `tests/e2e/workbench.spec.ts`

- [ ] **Step 1: Write failing tests for immediate host-name updates and label priority.**

```ts
service.setObservedHostname(session.id, 'api-prod.example.com')
expect(service.snapshot()[0]).toMatchObject({ observedHostname: 'api-prod.example.com' })
expect(sessionLabel({ hostname: '10.0.0.2', title: '堡垒机目标', observedHostname: 'api-prod.example.com' })).toBe('api-prod.example.com')
```

- [ ] **Step 2: Run the focused tests and verify the old session summary/store cannot carry the new field.**

Run: `npm test -- tests/unit/ssh/session-service.test.ts tests/unit/renderer/sessions.test.ts`

Expected: the new assertions fail before implementation.

- [ ] **Step 3: Add `observedHostname` and exported `sessionLabel` to the renderer session store, then use it in `SessionTabs`.**

```ts
export function sessionLabel(session: SessionView): string {
  return session.observedHostname ?? session.title ?? session.hostname
}
```

Keep `SessionService.setObservedHostname` as the only authoritative state mutation and clone it through `snapshot`/update events.

- [ ] **Step 4: Split hostname observation from the slower fact collection.**

Run `hostname` first after SSH shell readiness; call `sessions.setObservedHostname` as soon as a non-empty line arrives, then run the remaining observation commands and persist facts. Raw sessions remain untouched.

- [ ] **Step 5: Keep `WorkbenchView` mounted while showing settings.**

```vue
<WorkbenchView v-show="!settingsOpen" @show-settings="settingsOpen = true" />
<SettingsView v-show="settingsOpen" @close="settingsOpen = false" />
```

Add an E2E check that an active session remains visible after settings opens and closes.

- [ ] **Step 6: Run the focused unit/E2E checks and commit.**

Run: `npm test -- tests/unit/ssh/session-service.test.ts tests/unit/renderer/sessions.test.ts tests/unit/renderer/visible-panes.test.ts`

Commit: `git add src tests && git commit -m "fix: preserve SSH workbench state and host labels"`

### Task 2: Create encrypted direct-session persistence

**Files:**
- Create: `src/main/ssh/direct-session-repository.ts`
- Modify: `src/main/settings/secret-store.ts`, `src/main/ssh/key-material-store.ts`, `src/main/ssh/session-service.ts`
- Test: `tests/unit/ssh/direct-session-repository.test.ts`, `tests/unit/ssh/key-material-store.test.ts`

- [ ] **Step 1: Write failing repository tests for direct-only metadata, encrypted credentials, update and deletion.**

```ts
await repository.save({ id: 'prod', name: '生产 API', host: 'api.example', port: 22, username: 'ops', auth: { kind: 'password', password: 'secret' } })
expect(await repository.list()).toEqual([expect.objectContaining({ id: 'prod', authKind: 'password' })])
expect(serializedMetadata).not.toContain('secret')
expect(await repository.load('prod')).toMatchObject({ auth: { kind: 'password', password: 'secret' } })
```

- [ ] **Step 2: Run the new test to prove storage is absent.**

Run: `npm test -- tests/unit/ssh/direct-session-repository.test.ts`

Expected: module resolution failure until the repository exists.

- [ ] **Step 3: Implement `DirectSessionRepository` with a metadata JSON file and `ElectronSecretStore` keys scoped to ID.**

Store `{ id, name, host, port, username, authKind, privateKeyPath? }` only in JSON. Store password and private-key passphrase at `direct-session:<id>:password` and `direct-session:<id>:passphrase`. Add `remove(key)` to the secret-store port; removing a profile clears both potential secret keys.

- [ ] **Step 4: Extend key selection to retain a path without exposing key content to the renderer.**

```ts
export type KeyMaterialReference = { id: string; fileName: string; filePath: string }
```

The renderer receives `filePath` only to submit it back for a saved profile; the main process still reads actual bytes, converts PPK if needed, and consumes temporary material exactly once.

- [ ] **Step 5: Run repository/key-material tests and commit.**

Run: `npm test -- tests/unit/ssh/direct-session-repository.test.ts tests/unit/ssh/key-material-store.test.ts`

Commit: `git add src/main/ssh src/main/settings tests/unit/ssh && git commit -m "feat: persist encrypted direct SSH sessions"`

### Task 3: Expose a direct-only XShell-style session book

**Files:**
- Modify: `src/shared/contracts.ts`, `src/main/ipc/register-handlers.ts`, `src/preload/api.ts`, `src/main/main.ts`, `src/renderer/src/views/WorkbenchView.vue`, `src/renderer/src/components/ConnectionDialog.vue`
- Create: `src/renderer/src/components/SavedSessionsDialog.vue`
- Test: `tests/unit/ipc/register-handlers.test.ts`, `tests/unit/shared/contracts.test.ts`, `tests/unit/renderer/saved-sessions.test.ts`, `tests/e2e/workbench.spec.ts`

- [ ] **Step 1: Add failing IPC and renderer-store tests for list/save/open/delete direct profiles.**

```ts
await api.sessions.saveProfile(request)
await api.sessions.openProfile('prod')
await api.sessions.deleteProfile('prod')
expect(invoke).toHaveBeenCalledWith('sessions:open-profile', 'prod')
```

- [ ] **Step 2: Run targeted tests to establish the missing channels/components.**

Run: `npm test -- tests/unit/ipc/register-handlers.test.ts tests/unit/shared/contracts.test.ts tests/unit/renderer/saved-sessions.test.ts`

- [ ] **Step 3: Add validated IPC channels backed only by `DirectSessionRepository`.**

Use distinct channels `sessions:profiles:list`, `sessions:profiles:save`, `sessions:profiles:open`, and `sessions:profiles:delete`. `open` loads credentials in main, reads the selected private-key path when needed, and calls `SessionService.connect`; it never returns password, passphrase, or private-key bytes to the renderer.

- [ ] **Step 4: Implement the connection dialog save action and session-book dialog.**

ConnectionDialog emits a request with `save: boolean` and a required display name when saving. SavedSessionsDialog renders profile name, hostname, user, port and authentication kind; it offers connect, edit and delete. Add a `已保存会话` toolbar button without creating a second terminal page.

- [ ] **Step 5: Add an E2E path for save → close → reopen in the same nine-grid workbench.**

The check must assert that direct saved sessions open a pane and that no second window/page is used.

- [ ] **Step 6: Run targeted tests and commit.**

Run: `npm test -- tests/unit/ipc/register-handlers.test.ts tests/unit/shared/contracts.test.ts tests/unit/renderer/saved-sessions.test.ts`

Commit: `git add src tests && git commit -m "feat: add direct SSH session book"`

### Task 4: Keep Access Client / bastion temporary profiles out of the session book

**Files:**
- Modify: `src/main/access-client/access-session-resolver.ts`, `src/main/access-client/session-opener.ts`, `src/main/ssh/session-service.ts`
- Test: `tests/unit/access-client/access-session-resolver.test.ts`, `tests/unit/ssh/session-service.test.ts`, `tests/e2e/workbench.spec.ts`

- [ ] **Step 1: Change the existing temporary-session test to assert no persistent save occurs.**

```ts
await resolver.resolve({ kind: 'temporary-session', path: 'C:\\temp\\jump.conf', password: 'one-time' })
expect(savedSessions.save).not.toHaveBeenCalled()
```

- [ ] **Step 2: Run the resolver test and observe its current persistence assertion fail.**

Run: `npm test -- tests/unit/access-client/access-session-resolver.test.ts`

- [ ] **Step 3: Return a transient profile for `tmp:` invocations without calling the saved Access Client repository.**

Keep saved-session (`@name` / non-`tmp -load`) behavior intact. Ensure the password is used only for the immediate SSH connection.

- [ ] **Step 4: Pass a display title into Raw session summaries.**

Raw transport continues to connect to its local port, while `ConnectedSession.title` preserves `WinTitle` for the tab label. Assert it never falls back to `127.0.0.1` when a title exists.

- [ ] **Step 5: Run focused tests and commit.**

Run: `npm test -- tests/unit/access-client/access-session-resolver.test.ts tests/unit/ssh/session-service.test.ts`

Commit: `git add src/main/access-client src/main/ssh tests && git commit -m "fix: keep bastion launches transient"`

### Task 5: Make standard Chat Completions testable and diagnosable

**Files:**
- Modify: `src/main/model/chat-completions-client.ts`, `src/main/agent/agent-model-runtime.ts`, `src/main/agent/register-agent-handlers.ts`, `src/main/settings/register-settings-handlers.ts`, `src/preload/api.ts`, `src/renderer/src/components/settings/ModelConnectionForm.vue`
- Test: `tests/unit/model/chat-completions-client.test.ts`, `tests/unit/agent/agent-runtime.test.ts`, `tests/unit/agent/register-agent-handlers.test.ts`, `tests/unit/settings/register-settings-handlers.test.ts`

- [ ] **Step 1: Add failing verifier tests for a plain non-streaming Chat Completions request and safe HTTP/network errors.**

```ts
await client.verify(settings)
expect(fetcher).toHaveBeenCalledWith(settings.endpoint, expect.objectContaining({
  body: JSON.stringify({ model: settings.model, messages: [{ role: 'user', content: 'ping' }], stream: false }),
}))
```

Test HTTP 401 as `模型连接失败（HTTP 401）…`, a fetch exception as a network/TLS diagnostic, and confirm any supplied API key is absent from the message.

- [ ] **Step 2: Run the focused tests and verify they fail because `verify` does not exist.**

Run: `npm test -- tests/unit/model/chat-completions-client.test.ts tests/unit/settings/register-settings-handlers.test.ts`

- [ ] **Step 3: Implement `ChatCompletionsClient.verify` and a typed public connection error.**

Use the same authorization headers, no `response_format`, and `stream: false`. Bound and redact response text. The settings IPC must accept current renderer input, preserve protected saved API keys when the field is blank, and return `{ ok: true, model }` only after validation succeeds.

- [ ] **Step 4: Remove mandatory JSON Schema transport extensions from Agent calls.**

Call `stream(settings, messages, onDelta, undefined, signal)`. Keep the strict local Zod parse; enhance the JSON parser to accept a single fenced JSON response before rejecting it. Map `ModelConnectionError` to its public diagnostic in `register-agent-handlers`.

- [ ] **Step 5: Add a test-connection control to the settings form.**

The control must test current unsaved form data, disable only while testing, show success or server-safe error, and leave persisted settings unchanged.

- [ ] **Step 6: Run focused tests and commit.**

Run: `npm test -- tests/unit/model/chat-completions-client.test.ts tests/unit/agent/agent-runtime.test.ts tests/unit/agent/register-agent-handlers.test.ts tests/unit/settings/register-settings-handlers.test.ts`

Commit: `git add src tests && git commit -m "fix: diagnose standard chat completions connections"`

### Task 6: Ship the single-file Assess Client bridge as `putty.exe`

**Files:**
- Modify: `scripts/windows/terminal-agent-launcher.cpp`, `package.json`, `src/main/main.ts`, `README.md`
- Test: `tests/integration/release-launcher.test.ts`

- [ ] **Step 1: Extend the Windows release integration test for a copied bridge and installed-runtime lookup.**

```ts
const copiedBridge = join(temporaryBridgeDirectory, 'putty.exe')
await copyFile(join(releaseDirectory, 'putty.exe'), copiedBridge)
await setInstallPathForTest(releaseDirectory)
launcher = spawn(copiedBridge, ['-load', `tmp:${profilePath}`, '-pw', password], { windowsHide: true })
```

Keep the test Windows-only. Save and restore the original per-user registry value in `finally`; assert that the generated release contains `putty.exe`, then prove the copied file opens the test SSH session through the separately installed runtime.

- [ ] **Step 2: Run those tests and confirm the old sibling-only resolution fails the new expectation.**

Run: `npm run test:integration -- tests/integration/release-launcher.test.ts`

- [ ] **Step 3: Implement registry registration in the installed Electron runtime.**

Register the directory containing `process.execPath` under `HKCU\\Software\\Terminal-Agent\\InstallPath` only in packaged Windows mode. Registration errors must be non-fatal for a normally launched application.

- [ ] **Step 4: Implement native lookup, validation and a public error in the bridge.**

Use `RegOpenKeyExW`/`RegQueryValueExW` to load the per-user path, append `Terminal-Agent-runtime.exe`, verify it exists, then pass through every argument. Fall back to the bridge directory solely for development/unpacked co-location. Use `MessageBoxW` with install/remediation text if no runtime can be found.

- [ ] **Step 5: Rename package artifacts and documentation.**

`build:launcher` outputs `build/launcher/putty.exe`; `extraFiles` copies it as `putty.exe`; README instructs mapping only that file in Assess Client after the main app is installed.

- [ ] **Step 6: Build and run Windows-oriented verification, then commit.**

Run: `npm run build:launcher && npm run make:win:unpacked && npm run test:integration -- tests/integration/release-launcher.test.ts`

Commit: `git add scripts package.json src/main/main.ts README.md tests && git commit -m "feat: add portable putty access-client bridge"`

### Task 7: Final regression verification and release notes

**Files:**
- Modify: `README.md`, `docs/testing/mvp-acceptance.md`
- Test: all touched suites plus `tests/e2e/workbench.spec.ts`

- [ ] **Step 1: Update acceptance instructions with the five user-visible workflows.**

Document: settings round-trip with nine panes; copied `putty.exe` launch; connection-test success/failure; direct profile save/reopen/delete; temporary bastion launch exclusion.

- [ ] **Step 2: Run lint, type/build and focused tests.**

Run: `npm run build && npm run lint && npm test -- tests/unit/ssh tests/unit/access-client tests/unit/model tests/unit/agent tests/unit/renderer tests/unit/settings tests/unit/ipc`

Expected: all selected checks pass. If Electron binary download is unavailable, record the environmental failure separately and run non-Electron unit suites plus build/type checks.

- [ ] **Step 3: Run E2E and release checks when the local Electron binary is present.**

Run: `npm run test:e2e && npm run test:integration -- tests/integration/release-launcher.test.ts`

Expected: settings persistence, grid behavior, raw/Access Client same-workbench behavior and release launcher all pass.

- [ ] **Step 4: Review the diff against `docs/superpowers/specs/2026-08-10-ssh-workbench-reliability-design.md`, verify no secret fixture appears in metadata or output, and commit.**

Commit: `git add README.md docs && git commit -m "docs: document reliable SSH workbench workflows"`
