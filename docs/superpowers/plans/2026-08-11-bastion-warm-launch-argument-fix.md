# Bastion Warm-Launch Argument Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task with verification checkpoints.

**Goal:** Preserve AccessClient bridge metadata when a packaged Terminal-Agent is already running, accept the real AccessClient temporary SSH profile shape, prevent malformed metadata from becoming a log path, and ship verified 1.0.2 Windows artifacts.

**Architecture:** Keep the native bridge as the only process launcher. Move its private metadata and the original AccessClient arguments behind the Windows/Electron `--` boundary so Chromium does not reinterpret their values during a second-instance launch. Keep the TypeScript metadata extractor and temporary-profile reader as small defensive boundaries, and prove the warm-launch path with a real SSH fixture and a copied release directory without terminating any pre-existing user runtime.

**Tech Stack:** C++17 Win32 launcher, Electron 43, TypeScript/Vitest, Node `ssh2` integration fixture, electron-vite/electron-builder, NSIS.

---

### Task 1: Add the metadata parser regression tests

**Files:**
- Modify: `tests/unit/access-client/bridge-diagnostics.test.ts`
- Modify: `src/main/access-client/bridge-diagnostics.ts`

- [x] **Step 1: Write a failing test for metadata after the Electron boundary**

Add a case to `describe('bridge diagnostics')` using the exact warm-launch shape:

```ts
it('extracts bridge metadata after the Electron argument boundary', () => {
  expect(extractBridgeLaunchMetadata([
    'Terminal-Agent-runtime.exe',
    '--',
    '--terminal-agent-bridge-log', 'D:\\Assess\\putty-bridge.log',
    '--terminal-agent-bridge-id', '39612-69704187',
    '-load', 'tmp:C:\\Temp\\session.conf', '-pw', 'secret',
  ])).toEqual({ logPath: 'D:\\Assess\\putty-bridge.log', launchId: '39612-69704187' })
})
```

- [x] **Step 2: Write a failing test for option-shaped values**

Add a case proving the malformed screenshot shape has no metadata:

```ts
it('rejects option-shaped metadata values produced by a shifted second-instance argv', () => {
  expect(extractBridgeLaunchMetadata([
    'Terminal-Agent-runtime.exe',
    '--terminal-agent-bridge-log', '--terminal-agent-bridge-id',
    '--terminal-agent-bridge-id', '--allow-file-access-from-files',
    '--', '-load', 'tmp:C:\\Temp\\session.conf',
  ])).toBeUndefined()
})
```

- [x] **Step 3: Run the focused tests and verify they fail for the missing behavior**

Run:

```text
npm test -- tests/unit/access-client/bridge-diagnostics.test.ts
```

Expected before implementation: the boundary case passes with the current scanner, while the option-shaped case fails because `extractBridgeLaunchMetadata` currently accepts those option names as values. The command must report exactly one failed test and no TypeScript error.

- [x] **Step 4: Commit the test-only red state**

```text
git add tests/unit/access-client/bridge-diagnostics.test.ts
git commit -m "test: cover malformed bastion bridge metadata"
```

### Task 2: Add a real warm-launch release regression test

**Files:**
- Modify: `tests/integration/release-launcher.test.ts`

- [x] **Step 1: Add a test that isolates a primary runtime and invokes the bridge a second time**

Insert a Windows-only test after the existing first-launch test. It must copy `release/win-unpacked` into a temporary mapping directory, set the registry install path to that copied directory, detect whether any Terminal-Agent primary instance already exists, and start the copied runtime only when none exists. It then invokes the copied `putty.exe` with the temporary SSH profile. Use the existing cleanup helpers and add `findAnyRuntimeProcessIds`, `hasRendererProcess`, and `findFilesNamed` so the test never terminates a pre-existing user runtime. The core setup and assertions must be:

```ts
await cp(releaseDirectory, mappingDirectory, { recursive: true })
await writeInstallPathRegistration(mappingDirectory)
const copiedRuntimePath = join(mappingDirectory, 'Terminal-Agent-runtime.exe')
const copiedBridgePath = join(mappingDirectory, 'putty.exe')
const bridgeLogPath = join(mappingDirectory, 'putty-bridge.log')
const runningPrimaryProcessIds = await findAnyRuntimeProcessIds()
if (runningPrimaryProcessIds.length === 0) {
  preexistingRuntimeProcessIds = new Set(await findRuntimeProcessIds(copiedRuntimePath))
  primaryRuntime = spawn(copiedRuntimePath, [], { env: testEnvironment, stdio: 'ignore', windowsHide: true })
  primaryRuntimeProcessId = await waitForCondition(
    'the primary runtime process started for the warm-launch test',
    () => findNewRuntimeProcessId(preexistingRuntimeProcessIds, copiedRuntimePath),
  )
  await waitForCondition('the primary renderer', () => hasRendererProcess(primaryRuntimeProcessId, copiedRuntimePath))
}
await writeFile(profilePath, [
  'HostName=127.0.0.1',
  `PortNumber=${fixture.port}`,
  'UserName=release-fixture-user',
  'Protocol=ssh',
  'WinTitle=暖启动验证终端',
  'TermWidth=132',
  'TermHeight=43',
].join('\n'), 'utf8')
launcher = spawn(copiedBridgePath, ['-load', `tmp:${profilePath}`, '-pw', 'release-fixture-password'], {
  env: testEnvironment, stdio: 'ignore', windowsHide: true,
})
await Promise.all([fixture.waitForShell(), once(launcher, 'exit')])
const trace = await waitForCondition('the warm-launch runtime trace', async () => {
  const value = await readFile(bridgeLogPath, 'utf8').catch(() => '')
  return value.includes('"event":"process-started"')
    && value.includes('"event":"invocation-parsed"')
    && value.includes('"event":"session-opened"')
    ? value : false
})
expect(trace.match(/"source":"runtime"/g)).not.toBeNull()
expect(await findFilesNamed(mappingDirectory, '--terminal-agent-bridge-id')).toEqual([])
```

The test must stop the copied primary process tree before removing temporary files and restore the previous registry value in `finally`, including cleanup after a failed assertion.

- [x] **Step 2: Run only the new integration test against the current release artifact**

Run:

```text
npm run test:integration -- tests/integration/release-launcher.test.ts -t "warm-launch"
```

Expected before the launcher fix: the test reaches the runtime but fails waiting for the SSH shell or the correlated runtime trace, and the isolated malformed path exists. This is the required red proof that the test catches the screenshot symptom.

### Task 3: Fix the native bridge argument boundary

**Files:**
- Modify: `scripts/windows/terminal-agent-launcher.cpp:291-297`

- [x] **Step 1: Change only the command-line construction**

Build the command line with the boundary before all private and original arguments:

```cpp
std::wstring commandLine = QuoteWindowsArgument(runtime) + L" --"
  + L" --terminal-agent-bridge-log " + QuoteWindowsArgument(logPath)
  + L" --terminal-agent-bridge-id " + QuoteWindowsArgument(launchId);
for (int index = 1; index < argumentCount; ++index) {
  commandLine += L" " + QuoteWindowsArgument(arguments[index]);
}
```

Do not change runtime lookup, logging, or redaction in this task. The resulting order is `runtime -- metadata original-arguments`, which is the smallest change that protects warm launches.

- [x] **Step 2: Rebuild only the launcher and rerun the new integration test**

Run:

```text
npm run build:launcher
Copy-Item -Force build/launcher/putty.exe release/win-unpacked/putty.exe
npm run test:integration -- tests/integration/release-launcher.test.ts -t "warm-launch"
```

Expected: the launcher build exits 0, the rebuilt bridge replaces only the ignored unpacked test artifact, and the warm-launch integration test reaches the SSH fixture and correlated runtime trace.

- [x] **Step 3: Commit the native fix after the red test is available**

```text
git add scripts/windows/terminal-agent-launcher.cpp
git commit -m "fix: preserve bastion metadata across warm launches"
```

### Task 4: Accept the actual AccessClient temporary SSH profile

**Files:**
- Modify: `tests/unit/access-client/temp-session-reader.test.ts`
- Modify: `src/main/access-client/temp-session-reader.ts`

- [x] **Step 1: Add the redacted real-world profile regression test**

Use the observed fields `NoRemoteWinTitle`, `LineCodePage`, `HostName`, `mode=direct`, `PortNumber`, `TermHeight`, `TermWidth`, `UserName`, `websid`, and `WinTitle`, omitting `Protocol`. Assert that `readTempSession` resolves to an SSH profile with the expected sanitized fixture host, username, port, dimensions, title, and line code page.

- [x] **Step 2: Run the focused test and verify the current strict parser fails**

Run:

```text
npm test -- tests/unit/access-client/temp-session-reader.test.ts
```

Expected before implementation: exactly one test fails with `temporary-profile-invalid` because `Protocol` is absent.

- [x] **Step 3: Default only a missing or blank Protocol to SSH**

Use:

```ts
const protocolValue = values.get('Protocol')?.trim().toLowerCase()
const protocol = protocolValue || 'ssh'
if (protocol !== 'ssh' && protocol !== 'raw') throw invalidTemporaryProfile()
```

Do not accept any other explicit protocol value and do not persist ignored AccessClient metadata.

- [x] **Step 4: Run the temporary-profile and resolver suites**

Run:

```text
npm test -- tests/unit/access-client/temp-session-reader.test.ts tests/unit/access-client/access-session-resolver.test.ts
```

Expected: both files pass and the observed profile shape resolves as SSH.

- [x] **Step 5: Commit the compatibility fix**

```text
git add src/main/access-client/temp-session-reader.ts tests/unit/access-client/temp-session-reader.test.ts
git commit -m "fix: accept AccessClient temporary SSH profiles"
```

### Task 5: Harden runtime metadata extraction and turn the unit test green

**Files:**
- Modify: `src/main/access-client/bridge-diagnostics.ts`
- Modify: `tests/unit/access-client/bridge-diagnostics.test.ts`

- [x] **Step 1: Implement a single value validator**

Change `argumentValue` to return `undefined` when the option is absent, the following value is empty, or the following value starts with `-`:

```ts
function argumentValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  const value = index >= 0 ? argv[index + 1]?.trim() : undefined
  return value && !value.startsWith('-') ? value : undefined
}
```

Keep `extractBridgeLaunchMetadata` and all diagnostic redaction behavior unchanged.

- [x] **Step 2: Run the focused unit tests and then the related AccessClient suite**

Run:

```text
npm test -- tests/unit/access-client/bridge-diagnostics.test.ts
npm test -- tests/unit/access-client/bridge-diagnostics.test.ts tests/unit/access-client/single-instance.test.ts tests/unit/access-client/access-client-service.test.ts tests/unit/access-client/launch-controller.test.ts
```

Expected: both commands exit 0; the focused file has 5 tests and the related suite has 11 tests, with no credential text in output.

- [x] **Step 3: Commit the runtime hardening**

```text
git add src/main/access-client/bridge-diagnostics.ts tests/unit/access-client/bridge-diagnostics.test.ts
git commit -m "fix: reject shifted bastion metadata values"
```

### Task 6: Version and release the verified fix

**Files:**
- Modify: `package.json:3`
- Modify: `package-lock.json` (root package version only, using npm metadata update)
- Modify: `RELEASE_NOTES.md`

- [x] **Step 1: Bump the patch version and document the warm-launch fix**

Set the package version to `1.0.2`, update the lockfile root package version through `npm version 1.0.2 --no-git-tag-version`, and prepend release notes that say the bridge metadata now crosses Electron's argument boundary safely and that users must remap the included `putty.exe` after installing the new runtime.

- [x] **Step 2: Run the full source verification before packaging**

Run:

```text
npm test
npm run lint
npm run build
```

Expected: each command exits 0; Vitest reports zero failed tests; ESLint reports zero errors; electron-vite and vue-tsc both complete successfully.

- [x] **Step 3: Build the Windows unpacked release and installer**

Run:

```text
npm run make:win
```

Expected: `release/win-unpacked/putty.exe`, `release/win-unpacked/Terminal-Agent-runtime.exe`, and `release/Terminal-Agent-Setup-1.0.2.exe` exist, and the launcher binary timestamp is newer than the source fix.

- [x] **Step 4: Run the complete Windows release-launcher integration suite against the new artifacts**

Run:

```text
npm run test:integration -- tests/integration/release-launcher.test.ts
```

Expected: all warm-launch, stale-registry, and fallback-log tests pass; the suite leaves no temporary process, registry override, or credential-containing file.

- [x] **Step 5: Inspect the final diff and commit release metadata**

Run:

```text
git diff --check
git status --short
git diff --stat
```

Confirm only the planned tracked source, test, documentation, and package metadata changed; `release/` is intentionally ignored and is verified separately by artifact inspection. Then commit:

```text
git add package.json package-lock.json RELEASE_NOTES.md
git commit -m "release: ship bastion warm-launch fix 1.0.2"
```
