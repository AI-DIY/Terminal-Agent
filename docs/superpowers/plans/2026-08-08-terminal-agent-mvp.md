# Terminal-Agent MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Vue + Electron desktop SSH agent with three parallel connection entries, structured hostname-keyed host facts, OpenAI Chat Completions model access, and a user-controlled Copilot-to-autonomous workflow.

**Architecture:** Electron's main process is the only owner of SSH, host-fact persistence, model requests, confirmation markers, and rule evaluation. Vue renders the workbench and settings through a narrow preload API. Copilot first presents a natural-language strategy and command candidate; only a user-issued marker can execute that exact candidate directly, while unconfirmed automatic commands are checked against the local regex blacklist.

**Tech Stack:** Node.js 22 LTS, Electron, electron-vite, Vue 3, TypeScript, Vitest, Playwright Electron, `ssh2`, `@xterm/xterm`, `@xterm/addon-fit`, `zod`, Electron `safeStorage`, OpenAI Chat Completions over `fetch`.

---

## Delivery Order

The design spans several independent subsystems. Implement them as five separately runnable increments; do not wait until the end to prove that the core boundaries work.

1. Desktop foundation and OpenAI Chat Completions settings.
2. Direct SSH, terminal tabs, and multi-host workbench.
3. AccessClient launch compatibility.
4. Read-only observation and structured host facts.
5. AI scheduling, Copilot confirmation flow, regex escape fence, and autonomous-mode upgrade.

No product source files currently exist. Task 1 therefore establishes the project, automated test harness, and the process boundary all later tasks rely on.

## Planned File Structure

```text
Terminal-Agent-v2/
  package.json
  electron.vite.config.ts
  tsconfig.json
  vitest.config.ts
  playwright.config.ts
  src/
    main/
      main.ts                         # Electron lifecycle and second-instance routing
      app-runtime.ts                  # Wires independently tested services
      ipc/
        channels.ts                   # Named IPC contracts
        register-handlers.ts          # Main-process handler registration
      settings/
        settings-repository.ts        # Non-secret local settings
        secret-store.ts               # OS-encrypted API-key storage
        model-settings-service.ts     # Validates and saves model settings
      model/
        chat-completions-client.ts    # Streaming OpenAI Chat Completions client
      ssh/
        ssh-client-port.ts            # Testable SSH boundary
        ssh2-client-adapter.ts        # ssh2 shell implementation
        private-key-loader.ts         # PEM/OpenSSH/PKCS/PPK loading boundary
        session-service.ts            # Session lifecycle and terminal data streams
      access-client/
        argv-parser.ts                # PuTTY-compatible startup argument parser
        temp-session-reader.ts        # UTF-8 tmp:key=value configuration reader
        saved-session-repository.ts   # Non-secret compatible saved-session profiles
        access-session-resolver.ts    # Converts compatibility input to SessionRequest
      observation/
        observation-runner.ts         # Read-only command sequence executor
        observation-schema.ts         # Typed observation result schema
      facts/
        host-facts-repository.ts      # Atomic hostname-keyed structured persistence
        host-facts-service.ts         # Compare and merge changed fields
      agent/
        agent-contracts.ts            # Goal, candidate command, and tool request types
        scheduler.ts                  # Goal-driven planning orchestration
        session-mode-service.ts       # Explicit user upgrade from Copilot to autonomous
        confirmation-service.ts       # One-time exact-command user markers
        regex-fence-service.ts        # Copilot-only regex blacklist evaluator
        execution-gateway.ts          # Single route from agent request to SSH send
    preload/
      index.ts                        # Minimal contextBridge API
    renderer/
      src/
        main.ts
        App.vue
        router.ts
        views/
          WorkbenchView.vue
          SettingsView.vue
        components/
          ConnectionDialog.vue
          TerminalPane.vue
          SessionTabs.vue
          AgentPanel.vue
          CommandCandidate.vue
          command-candidate-state.ts
          ModeIndicator.vue
          settings/
            ModelConnectionForm.vue
            RegexFenceRules.vue
        stores/
          sessions.ts
          settings.ts
        styles/app.css
    shared/
      contracts.ts                    # Renderer-preload-main serializable contracts
      validation.ts                   # zod schemas shared on both sides
  tests/
    unit/
    integration/
    e2e/
    fixtures/
```

## Phase 1: Desktop Foundation and Model Connection

### Task 1: Create the Electron/Vue project and test baseline

**Files:**
- Create: `package.json`
- Create: `electron.vite.config.ts`
- Create: `vitest.config.ts`
- Create: `playwright.config.ts`
- Create: `src/main/main.ts`
- Create: `src/preload/index.ts`
- Create: `src/renderer/src/main.ts`
- Create: `src/renderer/src/App.vue`
- Create: `tests/unit/shared/contracts.test.ts`

- [ ] **Step 1: Initialise version control and scaffold the Electron/Vue TypeScript project**

Run:

```powershell
git init
npm init -y
npm install electron electron-vite vue ssh2 @xterm/xterm @xterm/addon-fit zod
npm install -D typescript vite @vitejs/plugin-vue vue-tsc vitest @vitest/coverage-v8 playwright @playwright/test eslint @eslint/js typescript-eslint
```

Add `dev`, `build`, `lint`, `test`, and `test:e2e` scripts to `package.json`; configure `electron.vite.config.ts` with main, preload, and Vue renderer entries, `vitest.config.ts` for `tests/unit`, and `playwright.config.ts` for `tests/e2e`. Expected: `package.json`, `electron.vite.config.ts`, `vitest.config.ts`, `playwright.config.ts`, `src/main`, `src/preload`, and `src/renderer` exist; `npm run dev` opens an Electron window.

- [ ] **Step 2: Add an initially failing shared-contract test**

Create `tests/unit/shared/contracts.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { sessionModeSchema } from '../../src/shared/contracts'

describe('sessionModeSchema', () => {
  it('accepts only the two explicit driving modes', () => {
    expect(sessionModeSchema.parse('copilot')).toBe('copilot')
    expect(sessionModeSchema.parse('autonomous')).toBe('autonomous')
    expect(() => sessionModeSchema.parse('agent')).toThrow()
  })
})
```

- [ ] **Step 3: Run the test to prove the baseline is red**

Run: `npx vitest run tests/unit/shared/contracts.test.ts`

Expected: FAIL because `src/shared/contracts.ts` does not exist.

- [ ] **Step 4: Define shared contracts and the no-Node renderer boundary**

Create `src/shared/contracts.ts`:

```ts
import { z } from 'zod'

export const sessionModeSchema = z.enum(['copilot', 'autonomous'])
export type SessionMode = z.infer<typeof sessionModeSchema>

export const sessionIdSchema = z.string().uuid()
export const hostnameSchema = z.string().trim().min(1).max(255)

export type TerminalDataEvent = {
  sessionId: string
  data: string
}
```

Set `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true` in the BrowserWindow. In `src/preload/index.ts`, expose only named methods such as `settings.get`, `settings.save`, `sessions.connect`, and `agent.confirmCommand`; never expose `ipcRenderer` itself.

- [ ] **Step 5: Make the baseline green**

Run: `npx vitest run tests/unit/shared/contracts.test.ts`

Expected: PASS with one test.

- [ ] **Step 6: Commit the project baseline**

```powershell
git add package.json package-lock.json electron.vite.config.ts vitest.config.ts src tests
git commit -m "chore: bootstrap Electron Vue terminal agent"
```

### Task 2: Implement OpenAI Chat Completions settings with OS-protected API keys

**Files:**
- Create: `src/main/settings/settings-repository.ts`
- Create: `src/main/settings/secret-store.ts`
- Create: `src/main/settings/model-settings-service.ts`
- Create: `src/main/model/chat-completions-client.ts`
- Create: `src/shared/validation.ts`
- Create: `tests/unit/settings/model-settings-service.test.ts`
- Create: `tests/unit/model/chat-completions-client.test.ts`

- [ ] **Step 1: Write failing settings tests**

Create `tests/unit/settings/model-settings-service.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { ModelSettingsService } from '../../../src/main/settings/model-settings-service'

const endpoint = 'https://api.openai.com/v1/chat/completions'

describe('ModelSettingsService', () => {
  it('stores the API key through the secret store, never the settings repository', async () => {
    const settings = { save: vi.fn(), load: vi.fn().mockResolvedValue(null) }
    const secrets = { save: vi.fn(), load: vi.fn().mockResolvedValue(null) }
    const service = new ModelSettingsService(settings, secrets)

    await service.save({ endpoint, model: 'gpt-5', apiKey: 'sk-test', contextLimit: 12000 })

    expect(settings.save).toHaveBeenCalledWith({ endpoint, model: 'gpt-5', contextLimit: 12000 })
    expect(secrets.save).toHaveBeenCalledWith('model.apiKey', 'sk-test')
  })
})
```

- [ ] **Step 2: Run the settings test to prove it is red**

Run: `npx vitest run tests/unit/settings/model-settings-service.test.ts`

Expected: FAIL because `ModelSettingsService` does not exist.

- [ ] **Step 3: Implement validated model settings**

Create `src/shared/validation.ts` with this schema:

```ts
import { z } from 'zod'

export const modelSettingsInputSchema = z.object({
  endpoint: z.string().url().refine(
    value => new URL(value).pathname.endsWith('/chat/completions'),
    'Endpoint must target OpenAI Chat Completions',
  ),
  model: z.string().trim().min(1).max(128),
  apiKey: z.string().trim().min(1).max(4096),
  contextLimit: z.number().int().min(1024).max(1_000_000),
})

export type ModelSettingsInput = z.infer<typeof modelSettingsInputSchema>
```

Implement `ModelSettingsService.save` exactly as tested. Store `{ endpoint, model, contextLimit }` in a JSON file under `app.getPath('userData')`. `contextLimit` is the maximum number of terminal-context characters the scheduler may assemble locally; it is not a model output-token setting. Implement `ElectronSecretStore` with Electron `safeStorage.encryptString` and `safeStorage.decryptString`; fail the save with a user-visible error when `safeStorage.isEncryptionAvailable()` is false. Do not add Ollama endpoints, model discovery, or Ollama-specific request shapes.

- [ ] **Step 4: Write and run a failing streaming-request test**

Create `tests/unit/model/chat-completions-client.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { ChatCompletionsClient } from '../../../src/main/model/chat-completions-client'

describe('ChatCompletionsClient', () => {
  it('uses the OpenAI Chat Completions request shape and forwards text deltas', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(
      'data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
    const onDelta = vi.fn()
    const client = new ChatCompletionsClient(fetcher)

    await client.stream(
      { endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-5', apiKey: 'sk-test', contextLimit: 12000 },
      [{ role: 'user', content: '分析这个错误' }],
      onDelta,
    )

    expect(fetcher).toHaveBeenCalledWith(
      'https://api.openai.com/v1/chat/completions',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(onDelta).toHaveBeenCalledWith('你好')
  })
})
```

Run: `npx vitest run tests/unit/model/chat-completions-client.test.ts`

Expected: FAIL because `ChatCompletionsClient` does not exist.

- [ ] **Step 5: Implement streaming Chat Completions and run both suites**

Implement `stream` to send:

```ts
{
  model: settings.model,
  messages,
  stream: true,
}
```

with `Authorization: Bearer ${settings.apiKey}`. Parse SSE `data:` records, ignore empty records, stop on `[DONE]`, and throw an error containing the HTTP status plus the first 512 response characters for non-2xx responses. Run:

```powershell
npx vitest run tests/unit/settings/model-settings-service.test.ts tests/unit/model/chat-completions-client.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit model settings and model transport**

```powershell
git add src/shared src/main/settings src/main/model tests/unit/settings tests/unit/model
git commit -m "feat: add OpenAI chat completions settings"
```

## Phase 2: SSH and Terminal Workbench

### Task 3: Build SSH connection contracts and direct authentication

**Files:**
- Create: `src/main/ssh/ssh-client-port.ts`
- Create: `src/main/ssh/ssh2-client-adapter.ts`
- Create: `src/main/ssh/private-key-loader.ts`
- Create: `src/main/ssh/session-service.ts`
- Create: `tests/unit/ssh/private-key-loader.test.ts`
- Create: `tests/unit/ssh/session-service.test.ts`
- Create: `tests/fixtures/keys/`

- [ ] **Step 1: Write failing tests for password and private-key request construction**

Create `tests/unit/ssh/session-service.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { SessionService } from '../../../src/main/ssh/session-service'

describe('SessionService', () => {
  it('sends password credentials only to the SSH adapter', async () => {
    const client = { connect: vi.fn().mockResolvedValue({ id: 's1' }) }
    const service = new SessionService(client, { load: vi.fn() })

    await service.connect({ host: 'server-a', port: 22, username: 'ops', auth: { kind: 'password', password: 'secret' } })

    expect(client.connect).toHaveBeenCalledWith(expect.objectContaining({ password: 'secret', username: 'ops' }))
  })
})
```

- [ ] **Step 2: Run the red test**

Run: `npx vitest run tests/unit/ssh/session-service.test.ts`

Expected: FAIL because `SessionService` does not exist.

- [ ] **Step 3: Define the transport boundary and implement `ssh2`**

Create this core interface in `src/main/ssh/ssh-client-port.ts`:

```ts
export type SshConnectOptions = {
  host: string
  port: number
  username?: string
  password?: string
  privateKey?: string | Buffer
  passphrase?: string
}

export type SshShell = {
  write(data: string): void
  resize(columns: number, rows: number): void
  close(): void
  onData(listener: (data: Buffer) => void): void
  onClose(listener: () => void): void
}

export interface SshClientPort {
  connect(options: SshConnectOptions): Promise<{ openShell(columns: number, rows: number): Promise<SshShell>; close(): void }>
}
```

Implement `Ssh2ClientAdapter` using `Client` from `ssh2`, `client.connect(options)`, and `client.shell({ term: 'xterm-256color', cols, rows })`. Map password, private key, passphrase, host, port, and username without logging any secret value. `SessionService` creates every new session with `mode: 'copilot'`; no SSH request, AccessClient parameter, or AI response may select `autonomous` at creation time.

- [ ] **Step 4: Add private-key format fixtures and tests**

Add non-production test keys for OpenSSH, PEM PKCS#1, PEM PKCS#8, encrypted PEM, and encrypted `.ppk`. Write `tests/unit/ssh/private-key-loader.test.ts` with one test per fixture, asserting that `PrivateKeyLoader.load` returns a string or Buffer usable by `ssh2`, and that encrypted inputs require the provided passphrase.

For PPK, introduce `PpkConverter` as a narrow dependency adapter. Add `ppk-to-openssh@3.2.0` only after recording its license in `THIRD-PARTY-NOTICES.md`, pinning the version in `package-lock.json`, and proving the PPK fixture converts successfully. Do not pass PPK material to the renderer or persist it after a connection is closed.

- [ ] **Step 5: Implement key loading and make SSH unit tests green**

`PrivateKeyLoader.load` must inspect the supplied file extension and header, return OpenSSH/PEM content directly where `ssh2` supports it, and call the PPK adapter only for `.ppk`. Zero Buffer references after a failed connect or session close where the runtime permits.

Run:

```powershell
npx vitest run tests/unit/ssh/private-key-loader.test.ts tests/unit/ssh/session-service.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit direct SSH authentication**

```powershell
git add src/main/ssh tests/unit/ssh tests/fixtures/keys THIRD-PARTY-NOTICES.md package.json package-lock.json
git commit -m "feat: add direct SSH password and private key sessions"
```

### Task 4: Render terminal sessions, tabs, and the multi-host workbench

**Files:**
- Create: `src/renderer/src/components/TerminalPane.vue`
- Create: `src/renderer/src/components/SessionTabs.vue`
- Create: `src/renderer/src/views/WorkbenchView.vue`
- Create: `src/renderer/src/stores/sessions.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/main/ipc/register-handlers.ts`
- Create: `tests/unit/renderer/sessions.test.ts`
- Create: `tests/e2e/workbench.spec.ts`

- [ ] **Step 1: Write the failing session-store test**

Create `tests/unit/renderer/sessions.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createSessionsStore } from '../../../src/renderer/src/stores/sessions'

describe('sessions store', () => {
  it('keeps terminal data isolated by session id', () => {
    const store = createSessionsStore()
    store.add({ id: 'a', hostname: 'alpha', mode: 'copilot' })
    store.add({ id: 'b', hostname: 'beta', mode: 'copilot' })
    store.appendData('a', 'alpha output')

    expect(store.byId('a')?.buffer).toBe('alpha output')
    expect(store.byId('b')?.buffer).toBe('')
  })
})
```

- [ ] **Step 2: Run the red renderer test**

Run: `npx vitest run tests/unit/renderer/sessions.test.ts`

Expected: FAIL because the sessions store does not exist.

- [ ] **Step 3: Implement the terminal event contract**

Expose these preload methods, each mapped to a validated IPC channel:

```ts
window.terminalAgent.sessions = {
  connect(request),
  write(sessionId, data),
  resize(sessionId, columns, rows),
  close(sessionId),
  onData(listener),
  onClosed(listener),
}
```

The main handler must route writes and resizes only to a session already created by `SessionService`; unknown IDs reject without accessing a shell.

- [ ] **Step 4: Implement `TerminalPane` and workbench layout**

Instantiate `Terminal` from `xterm` inside `onMounted`, subscribe to `onData` for `sessions.write`, and use `FitAddon` plus `ResizeObserver` to send stable terminal dimensions. Dispose `Terminal`, `FitAddon`, all listeners, and the observer in `onBeforeUnmount`. Render tabs and a responsive grid capped at nine terminal panes; each pane has fixed grid dimensions so stream output does not resize the layout.

- [ ] **Step 5: Make terminal unit and Electron UI tests green**

Create `tests/e2e/workbench.spec.ts` to open the packaged development app, create two mocked sessions through the preload test bridge, and assert two visible session tabs with independent terminal output. Run:

```powershell
npx vitest run tests/unit/renderer/sessions.test.ts
npx playwright test tests/e2e/workbench.spec.ts
```

Expected: both commands PASS.

- [ ] **Step 6: Commit terminal workbench**

```powershell
git add src/preload src/main/ipc src/renderer tests/unit/renderer tests/e2e
git commit -m "feat: add terminal tabs and multi-host workbench"
```

## Phase 3: AccessClient Compatibility

### Task 5: Parse PuTTY-compatible launch arguments and temporary session files

**Files:**
- Create: `src/main/access-client/argv-parser.ts`
- Create: `src/main/access-client/temp-session-reader.ts`
- Create: `src/main/access-client/saved-session-repository.ts`
- Create: `src/main/access-client/access-session-resolver.ts`
- Create: `tests/unit/access-client/argv-parser.test.ts`
- Create: `tests/unit/access-client/access-session-resolver.test.ts`
- Create: `tests/fixtures/access-client/session.conf`
- Modify: `src/main/main.ts`

- [ ] **Step 1: Write parser tests for all supported invocation forms**

Create `tests/unit/access-client/argv-parser.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { parseAccessClientArgv } from '../../../src/main/access-client/argv-parser'

describe('parseAccessClientArgv', () => {
  it.each([
    [['Terminal-Agent.exe', '@prod'], { kind: 'saved-session', name: 'prod' }],
    [['Terminal-Agent.exe', '-load', 'prod'], { kind: 'saved-session', name: 'prod' }],
    [['Terminal-Agent.exe', '-load', 'tmp:C:\\temp\\session.conf', '-pw', 'secret'], { kind: 'temporary-session', path: 'C:\\temp\\session.conf', password: 'secret' }],
    [['Terminal-Agent.exe', '-raw', '-P', '22022'], { kind: 'raw-port', port: 22022 }],
  ])('parses %j', (argv, expected) => {
    expect(parseAccessClientArgv(argv)).toEqual(expected)
  })
})
```

- [ ] **Step 2: Run the parser test to prove it is red**

Run: `npx vitest run tests/unit/access-client/argv-parser.test.ts`

Expected: FAIL because `parseAccessClientArgv` does not exist.

- [ ] **Step 3: Implement strict argument and UTF-8 config parsing**

`parseAccessClientArgv` accepts only the four documented forms. `readTempSession` reads a UTF-8 file and parses one `key=value` per line. Recognise only `HostName`, `PortNumber`, `UserName`, `Protocol`, `WinTitle`, `TermWidth`, `TermHeight`, and `LineCodePage`; ignore `mode`, `websid`, and all unknown fields. Reject unreadable files and invalid ports with explicit local errors.

Implement `SavedSessionRepository.load(name)` for the `@session-name` and `-load session-name` forms. Its profile shape contains only `name`, `host`, `port`, `username`, `protocol`, terminal dimensions, and title; it never stores a password, private key, private-key passphrase, or the AccessClient `-pw` value. Add one parser/resolver assertion that `-load prod` resolves the saved profile named `prod` and a missing name returns a local "session not found" error.

- [ ] **Step 4: Add resolver tests for Raw fallback and secret non-persistence**

Create `tests/unit/access-client/access-session-resolver.test.ts` with these assertions:

```ts
expect(resolve({ kind: 'raw-port', port: 22022 })).toMatchObject({ host: '127.0.0.1', port: 22022, protocol: 'raw' })
expect(resolve({ kind: 'temporary-session', path: fixture, password: 'secret' }).persistentProfile).not.toHaveProperty('password')
```

- [ ] **Step 5: Wire Electron second-instance handling and make the suite green**

In `main.ts`, call `app.requestSingleInstanceLock()`. On the primary instance, register `app.on('second-instance', (_event, argv) => accessClientService.openFromArgv(argv))`. The service creates a new terminal session/tab for every valid later request. Do not log `-pw`, include it in host facts, or emit it through IPC.

Run:

```powershell
npx vitest run tests/unit/access-client
```

Expected: PASS.

- [ ] **Step 6: Commit AccessClient compatibility**

```powershell
git add src/main/access-client src/main/main.ts tests/unit/access-client tests/fixtures/access-client
git commit -m "feat: support AccessClient compatible launches"
```

## Phase 4: Observation and Structured Facts

### Task 6: Run read-only observation and persist hostname-keyed facts

**Files:**
- Create: `src/main/observation/observation-schema.ts`
- Create: `src/main/observation/observation-runner.ts`
- Create: `src/main/facts/host-facts-repository.ts`
- Create: `src/main/facts/host-facts-service.ts`
- Create: `tests/unit/observation/observation-runner.test.ts`
- Create: `tests/unit/facts/host-facts-service.test.ts`

- [ ] **Step 1: Write a failing fact-merge test**

Create `tests/unit/facts/host-facts-service.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { mergeHostFacts } from '../../../src/main/facts/host-facts-service'

describe('mergeHostFacts', () => {
  it('uses hostname rather than route IP and changes only changed fields', () => {
    const result = mergeHostFacts(
      { hostname: 'api-prod', software: { nginx: '1.24' }, processes: [{ name: 'nginx', status: 'running' }], installLocations: {}, services: {}, logLocations: [], configurationHashes: {} },
      { hostname: 'api-prod', software: { nginx: '1.25' }, processes: [{ name: 'nginx', status: 'running' }], installLocations: {}, services: {}, logLocations: [], configurationHashes: {} },
    )

    expect(result.record.hostname).toBe('api-prod')
    expect(result.changed).toEqual(['software.nginx'])
    expect(result.record).not.toHaveProperty('routes')
  })
})
```

- [ ] **Step 2: Run the fact test to prove it is red**

Run: `npx vitest run tests/unit/facts/host-facts-service.test.ts`

Expected: FAIL because `mergeHostFacts` does not exist.

- [ ] **Step 3: Define only structured, non-secret host facts**

Create `HostFacts` with this shape:

```ts
export type HostFacts = {
  hostname: string
  observedAt: string
  software: Record<string, string>
  processes: Array<{ name: string; status: string }>
  installLocations: Record<string, string>
  services: Record<string, string>
  logLocations: string[]
  configurationHashes: Record<string, string>
}
```

Use the normalized hostname as the only repository key. Never persist IP addresses, passwords, private keys, passphrases, temporary AccessClient files, raw terminal history, or an LLM-authored environment narrative. Write the JSON store atomically with a temporary sibling file followed by `rename`.

- [ ] **Step 4: Write a failing observation safety test**

Create `tests/unit/observation/observation-runner.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { ObservationRunner } from '../../../src/main/observation/observation-runner'

describe('ObservationRunner', () => {
  it('sends only its fixed read-only observation commands', async () => {
    const execute = vi.fn().mockResolvedValue('ok')
    await new ObservationRunner(execute).run('linux')

    expect(execute.mock.calls.flat()).toEqual(expect.arrayContaining(['uname -a', 'ps -eo comm=,stat=']))
    expect(execute.mock.calls.flat().join('\n')).not.toMatch(/\b(kill|rm|vi|systemctl\s+restart)\b/)
  })
})
```

- [ ] **Step 5: Implement observation and merge behavior**

Use a fixed platform-specific read-only catalogue. Linux commands include `uname -a`, `ps -eo comm=,stat=`, `systemctl list-units --type=service --no-pager`, and selected package-list commands. Parse outputs into `HostFacts`; do not ask an LLM to regenerate the facts. On every new session, run the observation after shell readiness, load by hostname, merge only changed structured fields, and expose a compact facts snapshot to the scheduler.

Run:

```powershell
npx vitest run tests/unit/observation/observation-runner.test.ts tests/unit/facts/host-facts-service.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit observation and facts**

```powershell
git add src/main/observation src/main/facts tests/unit/observation tests/unit/facts
git commit -m "feat: add read-only observation and host facts"
```

## Phase 5: AI Action, Confirmation, and Regex Escape Fence

### Task 7: Define goal-driven agent contracts and scheduler context

**Files:**
- Create: `src/main/agent/agent-contracts.ts`
- Create: `src/main/agent/scheduler.ts`
- Create: `src/main/agent/session-mode-service.ts`
- Create: `tests/unit/agent/scheduler.test.ts`
- Create: `tests/unit/agent/session-mode-service.test.ts`

- [ ] **Step 1: Write the failing scheduler-context test**

Create `tests/unit/agent/scheduler.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { AgentScheduler } from '../../../src/main/agent/scheduler'

describe('AgentScheduler', () => {
  it('uses the active session facts without leaking credentials or another host facts', async () => {
    const model = { stream: vi.fn() }
    const scheduler = new AgentScheduler(model)

    await scheduler.start({
      goal: '分析 nginx 服务状态',
      session: { id: 'a', hostname: 'api-prod' },
      facts: { hostname: 'api-prod', software: { nginx: '1.25' }, processes: [], installLocations: {}, services: {}, logLocations: [], configurationHashes: {} },
    })

    expect(model.stream).toHaveBeenCalledWith(expect.objectContaining({ hostname: 'api-prod' }))
    expect(JSON.stringify(model.stream.mock.calls)).not.toContain('apiKey')
  })
})
```

- [ ] **Step 2: Run the red scheduler test**

Run: `npx vitest run tests/unit/agent/scheduler.test.ts`

Expected: FAIL because `AgentScheduler` does not exist.

- [ ] **Step 3: Implement goal-driven scheduler input**

Define `AgentGoalContext` containing only the user goal, active session ID, hostname, current terminal excerpt chosen by the user, and structured facts. The scheduler sends a Chinese system instruction that asks for analysis, evidence collection, a proposed strategy, and optionally a candidate command. It must not define a finite list of task types and must not include connection credentials or all historical terminal output.

- [ ] **Step 4: Make the scheduler test green and commit**

Run:

```powershell
npx vitest run tests/unit/agent/scheduler.test.ts
git add src/main/agent/agent-contracts.ts src/main/agent/scheduler.ts tests/unit/agent/scheduler.test.ts
git commit -m "feat: add goal-driven agent scheduler"
```

Expected: test PASS and commit succeeds.

- [ ] **Step 5: Write and run the explicit autonomous-upgrade test**

Create `tests/unit/agent/session-mode-service.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { SessionModeService } from '../../../src/main/agent/session-mode-service'

describe('SessionModeService', () => {
  it('starts in Copilot and upgrades only when the user-facing request is explicit', () => {
    const modes = new SessionModeService()
    modes.create('session-a')

    expect(modes.get('session-a')).toBe('copilot')
    expect(modes.upgradeFromUserAction('session-a')).toBe('autonomous')
    expect(modes.get('session-a')).toBe('autonomous')
  })
})
```

Run: `npx vitest run tests/unit/agent/session-mode-service.test.ts`

Expected: FAIL because `SessionModeService` does not exist.

- [ ] **Step 6: Implement the mode service and commit its test**

Implement an in-memory map with `create`, `get`, `upgradeFromUserAction`, and `close`. Expose only `sessionModes.upgrade(sessionId)` through preload for the visible user control; do not provide the scheduler or model client any method that changes the mode. Run:

```powershell
npx vitest run tests/unit/agent/scheduler.test.ts tests/unit/agent/session-mode-service.test.ts
git add src/main/agent/scheduler.ts src/main/agent/session-mode-service.ts tests/unit/agent/scheduler.test.ts tests/unit/agent/session-mode-service.test.ts
git commit -m "feat: add explicit autonomous session upgrade"
```

Expected: both tests PASS and commit succeeds.

### Task 8: Implement exact-command human confirmation markers

**Files:**
- Create: `src/main/agent/confirmation-service.ts`
- Create: `tests/unit/agent/confirmation-service.test.ts`
- Modify: `src/shared/contracts.ts`
- Modify: `src/main/ipc/register-handlers.ts`

- [ ] **Step 1: Write failing marker tests**

Create `tests/unit/agent/confirmation-service.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { ConfirmationService } from '../../../src/main/agent/confirmation-service'

describe('ConfirmationService', () => {
  it('consumes a marker only for its exact command and session', () => {
    const service = new ConfirmationService(() => 'marker-1')
    const marker = service.issue('session-a', 'systemctl restart nginx')

    expect(service.consume('session-a', 'systemctl restart nginx', marker.id)).toBe(true)
    expect(service.consume('session-a', 'systemctl restart nginx', marker.id)).toBe(false)
  })

  it('rejects use against a changed command or another session', () => {
    const service = new ConfirmationService(() => 'marker-2')
    const marker = service.issue('session-a', 'systemctl restart nginx')

    expect(service.consume('session-a', 'systemctl stop nginx', marker.id)).toBe(false)
    expect(service.consume('session-b', 'systemctl restart nginx', marker.id)).toBe(false)
  })
})
```

- [ ] **Step 2: Run the marker test to prove it is red**

Run: `npx vitest run tests/unit/agent/confirmation-service.test.ts`

Expected: FAIL because `ConfirmationService` does not exist.

- [ ] **Step 3: Implement one-time marker issuance in the main process**

Implement with a SHA-256 hash of the exact UTF-8 command, session ID, random marker ID, expiry of five minutes, and a consumed flag:

```ts
type ConfirmationRecord = {
  sessionId: string
  commandHash: string
  expiresAt: number
  consumed: boolean
}
```

The renderer may request issuance only through `agent.confirmCandidate({ sessionId, candidateId })`; the main process retrieves the candidate command it previously generated and creates the record. Do not accept a renderer-supplied raw command as evidence of confirmation. Markers remain memory-only and are deleted when consumed, expired, or the session closes.

- [ ] **Step 4: Run the confirmation tests and commit**

Run:

```powershell
npx vitest run tests/unit/agent/confirmation-service.test.ts
git add src/main/agent/confirmation-service.ts src/shared/contracts.ts src/main/ipc/register-handlers.ts tests/unit/agent/confirmation-service.test.ts
git commit -m "feat: add exact command confirmation markers"
```

Expected: test PASS and commit succeeds.

### Task 9: Implement the Copilot-only regex escape fence and execution gateway

**Files:**
- Create: `src/main/agent/regex-fence-service.ts`
- Create: `src/main/agent/execution-gateway.ts`
- Create: `src/main/settings/regex-rule-repository.ts`
- Create: `tests/unit/agent/regex-fence-service.test.ts`
- Create: `tests/unit/agent/execution-gateway.test.ts`
- Modify: `src/main/ipc/register-handlers.ts`

- [ ] **Step 1: Write failing blacklist tests**

Create `tests/unit/agent/regex-fence-service.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { RegexFenceService } from '../../../src/main/agent/regex-fence-service'

const rules = [
  { id: 'kill', name: '终止进程', pattern: '(^|[;&|]\\s*)(sudo\\s+)?(kill|killall|pkill)\\b', enabled: true },
  { id: 'editor', name: '编辑器', pattern: '(^|[;&|]\\s*)(sudo\\s+)?(vi|vim|nvim)\\b', enabled: true },
]

describe('RegexFenceService', () => {
  it('returns the first matching enabled rule from the final command text', () => {
    expect(new RegexFenceService(rules).match('sudo kill -9 1234')).toEqual({ id: 'kill', name: '终止进程' })
  })

  it('does not match disabled rules', () => {
    expect(new RegexFenceService([{ ...rules[0], enabled: false }]).match('kill -9 1234')).toBeNull()
  })
})
```

- [ ] **Step 2: Run the fence test to prove it is red**

Run: `npx vitest run tests/unit/agent/regex-fence-service.test.ts`

Expected: FAIL because `RegexFenceService` does not exist.

- [ ] **Step 3: Implement editable regex rules without semantic reclassification**

Persist rules as `{ id, name, pattern, enabled }`. Validate pattern syntax with `new RegExp(pattern, 'iu')` at save time and reject empty names, empty patterns, duplicate IDs, and patterns longer than 2,048 characters. The rule test control invokes the same `match(finalCommandText)` path but cannot execute a command. A rule has no configurable allow/block action: every enabled match means local interception.

- [ ] **Step 4: Write the execution-gateway red tests**

Create `tests/unit/agent/execution-gateway.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { ExecutionGateway } from '../../../src/main/agent/execution-gateway'

describe('ExecutionGateway', () => {
  it('executes a Copilot command carrying a valid human marker before applying the fence', async () => {
    const send = vi.fn().mockResolvedValue({ kind: 'sent' })
    const modes = { get: () => 'copilot' as const }
    const gateway = new ExecutionGateway(modes, { consume: () => true }, { match: () => ({ id: 'kill', name: '终止进程' }) }, send)

    await expect(gateway.execute({ sessionId: 's', command: 'kill -9 1', confirmationId: 'approved' })).resolves.toEqual({ kind: 'sent' })
    expect(send).toHaveBeenCalledWith('s', 'kill -9 1')
  })

  it('intercepts an unconfirmed Copilot command when its regex matches', async () => {
    const send = vi.fn().mockResolvedValue({ kind: 'sent' })
    const modes = { get: () => 'copilot' as const }
    const gateway = new ExecutionGateway(modes, { consume: () => false }, { match: () => ({ id: 'kill', name: '终止进程' }) }, send)

    await expect(gateway.execute({ sessionId: 's', command: 'kill -9 1' })).resolves.toEqual({ kind: 'intercepted', ruleId: 'kill' })
    expect(send).not.toHaveBeenCalled()
  })

  it('does not use the Copilot fence after the user explicitly upgrades to autonomous mode', async () => {
    const send = vi.fn().mockResolvedValue({ kind: 'sent' })
    const modes = { get: () => 'autonomous' as const }
    const gateway = new ExecutionGateway(modes, { consume: () => false }, { match: () => ({ id: 'kill', name: '终止进程' }) }, send)

    await gateway.execute({ sessionId: 's', command: 'kill -9 1' })
    expect(send).toHaveBeenCalledWith('s', 'kill -9 1')
  })
})
```

- [ ] **Step 5: Run the gateway test to prove it is red**

Run: `npx vitest run tests/unit/agent/execution-gateway.test.ts`

Expected: FAIL because `ExecutionGateway` does not exist.

- [ ] **Step 6: Implement the only agent-to-SSH command route**

Implement the decision sequence exactly:

```ts
if (sessionModes.get(request.sessionId) === 'autonomous') return send(request.sessionId, request.command)
if (request.confirmationId && confirmation.consume(request.sessionId, request.command, request.confirmationId)) {
  return send(request.sessionId, request.command)
}
const matched = fence.match(request.command)
if (matched) return { kind: 'intercepted', ruleId: matched.id, ruleName: matched.name }
return send(request.sessionId, request.command)
```

`ExecutionGateway` receives `SessionModeService` and reads the mode itself; `execute` has no caller-provided mode property. No renderer component, model client, scheduler, or SSH adapter may send an AI-originated command except through this gateway. Keep user typing in the native terminal separate from this AI-command path.

- [ ] **Step 7: Run safety tests and commit**

Run:

```powershell
npx vitest run tests/unit/agent/regex-fence-service.test.ts tests/unit/agent/execution-gateway.test.ts
git add src/main/agent src/main/settings/regex-rule-repository.ts src/main/ipc tests/unit/agent
git commit -m "feat: add Copilot regex escape fence"
```

Expected: tests PASS and commit succeeds.

### Task 10: Complete Copilot and Settings UI states

**Files:**
- Create: `src/renderer/src/components/AgentPanel.vue`
- Create: `src/renderer/src/components/CommandCandidate.vue`
- Create: `src/renderer/src/components/command-candidate-state.ts`
- Create: `src/renderer/src/components/ModeIndicator.vue`
- Create: `src/renderer/src/components/settings/ModelConnectionForm.vue`
- Create: `src/renderer/src/components/settings/RegexFenceRules.vue`
- Create: `src/renderer/src/views/SettingsView.vue`
- Create: `tests/unit/renderer/command-candidate.test.ts`
- Create: `tests/e2e/copilot-flow.spec.ts`

- [ ] **Step 1: Write the failing candidate-state test**

Create `tests/unit/renderer/command-candidate.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { candidateState } from '../../../src/renderer/src/components/command-candidate-state'

describe('candidateState', () => {
  it('labels a Copilot candidate as pending until the user confirms it', () => {
    expect(candidateState({ mode: 'copilot', confirmationId: null })).toEqual({ label: '待确认', canExecute: true })
    expect(candidateState({ mode: 'copilot', confirmationId: 'm1' })).toEqual({ label: '已人工确认', canExecute: false })
  })
})
```

- [ ] **Step 2: Run the red UI test**

Run: `npx vitest run tests/unit/renderer/command-candidate.test.ts`

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement visible, mode-specific user experience**

`ModeIndicator` continuously shows `辅助驾驶 - 变更需人工确认` or `全自动驾驶 - AI 可按当前会话目标执行`. In Copilot, `CommandCandidate` renders candidate text, explanation, and one confirm button. The button asks the main process to issue a marker for the saved candidate and then sends only the resulting marker ID. On interception, show the matched rule name and the AI strategy; never create a retry button that bypasses the gateway.

`SettingsView` contains exactly two initial entries: `大模型连接` and `安全围栏规则`. The model form labels its request shape as `OpenAI Chat Completions` and does not show Ollama controls. The rules view manages name, regex, enabled state, and a non-executing match tester; each list row has a fixed display result of `命中即拦截`.

- [ ] **Step 4: Add end-to-end Copilot coverage and run UI tests**

Create `tests/e2e/copilot-flow.spec.ts` that stubs a dangerous candidate, verifies the `待确认` label, clicks confirmation, verifies `已人工确认`, and asserts the main-process send spy receives the exact displayed command. In a second case, issue an unconfirmed `kill -9 1` request and assert the terminal send spy remains uncalled while the matching rule name is visible.

Run:

```powershell
npx vitest run tests/unit/renderer/command-candidate.test.ts
npx playwright test tests/e2e/copilot-flow.spec.ts
```

Expected: both commands PASS.

- [ ] **Step 5: Commit the Copilot and settings UI**

```powershell
git add src/renderer tests/unit/renderer tests/e2e
git commit -m "feat: add Copilot confirmation and settings UI"
```

## Final Integration and Release Verification

### Task 11: Verify all product boundaries in the packaged Electron application

**Files:**
- Create: `tests/integration/ssh-session.integration.test.ts`
- Create: `tests/integration/access-client.integration.test.ts`
- Create: `tests/integration/model-stream.integration.test.ts`
- Create: `docs/testing/mvp-acceptance.md`
- Modify: `README.md`

- [ ] **Step 1: Add a local SSH integration fixture**

Use `ssh2.Server` on an ephemeral local port in `tests/integration/ssh-session.integration.test.ts`. Test a password session opens a PTY shell, terminal input arrives at the fixture, output reaches the session event stream, and close tears down the connection. Use test credentials only.

- [ ] **Step 2: Add AccessClient end-to-end startup coverage**

Create a UTF-8 temp file containing `HostName`, `PortNumber`, `UserName`, `Protocol`, `WinTitle`, `TermWidth`, and `TermHeight`; pass it with `-load tmp:<path> -pw secret`. Assert one session is created with the resolved host, port, user, title, and dimensions, while serialized profile and facts objects contain no password. Add a Raw `-P` case asserting the internal `127.0.0.1` fallback and no fourth renderer connection option.

- [ ] **Step 3: Add model-stream contract coverage without a real API key**

Start a local HTTP fixture that records the JSON request and emits OpenAI-style SSE deltas. Assert `POST`, `stream: true`, `Authorization`, model selection, delta forwarding, and a non-2xx error path. The fixture must not implement or test Ollama endpoints.

- [ ] **Step 4: Build and run all automated suites**

Run:

```powershell
npm run lint
npx vitest run --coverage
npx playwright test
npm run build
```

Expected: lint exits 0, Vitest reports zero failures, Playwright reports zero failures, and the Electron build exits 0.

- [ ] **Step 5: Execute the manual MVP acceptance checklist**

Create `docs/testing/mvp-acceptance.md` with these executable checks:

1. Open one password session and one encrypted-private-key session; verify separate terminal tabs.
2. Launch a valid `tmp:` AccessClient command twice; verify two sessions/tabs and no lost second-instance request.
3. Confirm observation creates host facts keyed by hostname; reconnect through a changed route IP and verify the same record is updated rather than duplicated.
4. In Copilot, verify a generated `kill -9 <pid>` stays local until the user confirms the displayed candidate, then executes that exact command once.
5. Attempt the same `kill` request without confirmation; verify the configured regex rule intercepts it and the SSH fixture receives nothing.
6. Explicitly upgrade a test session to autonomous mode; verify its visible mode label changes and the same command uses the controlled execution path without the Copilot regex check.
7. Save OpenAI Chat Completions settings, restart the application, and verify endpoint/model/context restore while the API Key is retrievable only through OS-protected storage.

- [ ] **Step 6: Commit release verification material**

```powershell
git add tests/integration tests/fixtures docs/testing README.md
git commit -m "test: verify terminal agent MVP boundaries"
```

## Plan Self-Review

### V2 Requirement Coverage

| V2 requirement | Implemented by |
| --- | --- |
| Vue + Electron, main-process authority | Tasks 1 and 4 |
| OpenAI Chat Completions, no Ollama integration | Task 2 and Task 10 |
| Password and private-key connection formats | Task 3 |
| Interactive terminal, tabs, nine-host workbench | Task 4 |
| AccessClient `@`, `-load`, `tmp:`, `-pw`, Raw and second-instance behavior | Task 5 |
| Read-only observation and hostname-keyed structured facts | Task 6 |
| Goal-driven scheduling without a finite task catalogue | Task 7 |
| Copilot natural-language proposal and exact command confirmation | Tasks 8 and 10 |
| Copilot-only editable regex blacklist for command escape | Task 9 |
| Explicit autonomous-mode upgrade and visible state | Tasks 9 and 10 |
| Automated and manual end-to-end acceptance | Task 11 |

### Consistency Checks

* `SessionMode` is always `copilot` or `autonomous`; no automatic downgrade state is introduced.
* The confirmation marker uses the exact command hash and session ID in both the tests and `ExecutionGateway` contract.
* The regex fence has only one fixed result, interception; it is never reused as a semantic classifier or a general policy editor.
* IP addresses are excluded from persisted facts and facts are keyed only by hostname.
* Secrets are not included in renderer contracts, host facts, profiles, logs, or scheduler context.

### Deliberate MVP Exclusions

The plan does not add a credential-vault feature, manual bastion configuration, a user-facing local `127.0.0.1` connection type, audit browsing, automatic downgrade/rollback, or Ollama-specific support.
