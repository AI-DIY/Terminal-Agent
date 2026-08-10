# Bastion Bridge Recovery and v1.0.1 Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax.

**Goal:** Restore one-file Assess Client launches when the registry is missing or stale, add redacted jump logs, and publish a verified v1.0.1 Windows release.

**Architecture:** The C++ bridge searches a valid registry install first, then co-located and standard install locations, and writes a JSONL trace beside putty.exe with a LocalAppData fallback. It forwards a launch ID and log path as private metadata. The TypeScript runtime appends parse, profile, transport, terminal, success, and safe-failure events, including for an already-running Electron instance.

**Tech Stack:** Win32 C++17, Electron/TypeScript, Vitest, Playwright, ssh2, electron-builder, GitHub CLI.

---

### Task 1: Typed diagnostics foundation

**Files:**
- Create: src/main/access-client/bridge-diagnostics.ts
- Create: src/main/access-client/launch-failure.ts
- Modify: src/main/access-client/argv-parser.ts
- Modify: src/main/access-client/temp-session-reader.ts
- Test: tests/unit/access-client/bridge-diagnostics.test.ts
- Test: tests/unit/access-client/launch-failure.test.ts
- Modify: tests/unit/access-client/argv-parser.test.ts
- Modify: tests/unit/access-client/temp-session-reader.test.ts

- [ ] Step 1: Write failing tests for bridge metadata extraction, password redaction, and fixed messages for unsupported-launch-arguments, temporary-profile-unreadable, and temporary-profile-invalid.
- [ ] Step 2: Run npm test -- tests/unit/access-client/bridge-diagnostics.test.ts tests/unit/access-client/launch-failure.test.ts. Expected: module-not-found failures.
- [ ] Step 3: Implement BridgeLaunchMetadata, extractBridgeLaunchMetadata, redactLaunchArguments, AccessClientLaunchFailureCode, AccessClientLaunchFailure, and formatAccessClientLaunchFailure. Redact values after -pw, -pwfile, --password, --token, --api-key, and --passphrase.
- [ ] Step 4: Make argv-parser and temp-session-reader throw the typed categories while keeping only @name, -load name, -load tmp:path [-pw password], and -raw -P port.
- [ ] Step 5: Run the four focused access-client test files. Expected: PASS. Commit the diagnostic foundation.

### Task 2: Runtime events and connection categories

**Files:**
- Modify: src/main/access-client/bridge-diagnostics.ts
- Modify: src/main/access-client/access-client-service.ts
- Modify: src/main/ssh/session-service.ts
- Modify: tests/unit/access-client/access-client-service.test.ts
- Modify: tests/unit/access-client/bridge-diagnostics.test.ts
- Modify: tests/unit/ssh/session-service.test.ts

- [ ] Step 1: Add failing tests proving one launch ID appears in invocation-parsed, transport-opening, session-opened, and launch-failed events, and the password never appears. Add tests that client.connect is transport-connect-failed and openShell is terminal-open-failed.
- [ ] Step 2: Run npm test -- tests/unit/access-client/access-client-service.test.ts tests/unit/access-client/bridge-diagnostics.test.ts tests/unit/ssh/session-service.test.ts. Expected: failures because no runtime sink or phase categories exist.
- [ ] Step 3: Implement append-only JSONL runtime records. Record only timestamp, launch ID, event, protocol, port, session ID, and fixed category. Swallow logging I/O errors. In AccessClientService extract metadata before stripping Electron arguments and record each launch phase.
- [ ] Step 4: Wrap only connectAccessSsh and connectRaw phase errors in typed categories; preserve direct session errors.
- [ ] Step 5: Run the focused tests. Expected: PASS. Commit runtime tracing.

### Task 3: Native bridge recovery and existing-window routing

**Files:**
- Modify: scripts/windows/terminal-agent-launcher.cpp
- Modify: src/main/access-client/launch-controller.ts
- Modify: src/main/access-client/single-instance.ts
- Modify: src/main/main.ts
- Modify: tests/unit/access-client/launch-controller.test.ts
- Modify: tests/unit/access-client/single-instance.test.ts
- Modify: tests/integration/release-launcher.test.ts

- [ ] Step 1: Add failing tests for categorized UI messages with log paths, controller use on second-instance, and a copied bridge trace containing bridge-started, runtime-location, process-started, and runtime session-opened without the fixture password.
- [ ] Step 2: Run the controller and single-instance tests. Expected: the current generic alert and raw-service routing fail.
- [ ] Step 3: Implement Win32 UTF-8 JSONL logging beside putty.exe, LocalAppData fallback, launch ID generation, control-character escaping, and sensitive-value redaction. Never write registry values or delete files.
- [ ] Step 4: Search candidates in this order: valid registry directory, bridge directory, LocalAppData Programs Terminal-Agent, and Program Files Terminal-Agent. Log every candidate and the numeric Win32 error if process creation fails. Report a missing installation clearly instead of pretending it was repaired.
- [ ] Step 5: Pass --terminal-agent-bridge-log and --terminal-agent-bridge-id before --, preserving every original argument after --. Pass the launch controller to the second-instance handler.
- [ ] Step 6: Make release-launcher.test.ts snapshot and restore its temporary registry value and exercise both a valid registry launch and a missing/stale-registry co-located fallback. Assert no test password in the mapping log.
- [ ] Step 7: Run npm run build:launcher, focused unit tests, npm run make:win:unpacked, and npm run test:integration -- tests/integration/release-launcher.test.ts. Expected: PASS. Commit native recovery and bridge logging.

### Task 4: Version, verification, and GitHub release

**Files:**
- Modify: package.json
- Modify: README.md
- Create or modify: RELEASE_NOTES.md
- Modify: tests/e2e/workbench.spec.ts

- [ ] Step 1: Add a UI regression assertion for the categorized alert and prove no password or profile path is rendered.
- [ ] Step 2: Set package.json to 1.0.1. Document: install once, map only putty.exe, inspect putty-bridge.log beside it after a failure, and secrets are redacted. Add release notes for stale/missing registry recovery and included assets.
- [ ] Step 3: Run npm run build, npm run lint, npm test, npm run test:e2e -- tests/e2e/workbench.spec.ts, npm run make:win, and npm run test:integration -- tests/integration/release-launcher.test.ts. Expected: all commands exit 0 and release contains Terminal-Agent-Setup-1.0.1.exe plus win-unpacked putty.exe.
- [ ] Step 4: Commit release metadata.
- [ ] Step 5: After fresh verification, push main, create/push an annotated v1.0.1 tag, calculate SHA256 for installer and putty.exe, and create the GitHub Release with release/Terminal-Agent-Setup-1.0.1.exe and release/win-unpacked/putty.exe. The release must expose both downloadable assets.

## Plan self-review

The plan covers the requested mapping-directory log, password redaction, stale or missing registry behavior, existing-window launch handling, transient bastion sessions, tests, and the v1.0.1 release assets. It contains no TODO/TBD placeholders and uses the same names for metadata and failure types across tasks.

