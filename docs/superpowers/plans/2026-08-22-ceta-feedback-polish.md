# CETA Feedback Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply all eight CETA review corrections without removing existing functionality, prove host collection and AI networking end to end, and produce a Windows 1.0.7 installer.

**Architecture:** Keep the native Windows frame, remove Electron's redundant application menu, and refine the existing three-pane Vue workbench. Use versioned preference migration for taller Shell rows and one shared host-observation command catalog for both main-process execution and renderer disclosure. Preserve the existing model/chat stack and strengthen its local HTTP end-to-end evidence.

**Tech Stack:** Electron 43, Vue 3, TypeScript 6, Zod 4, Vitest 4, Playwright Electron, ssh2, electron-builder/NSIS, PowerShell/System.Drawing.

---

### Task 1: Establish a Clean Baseline

**Files:**
- Inspect: `package.json`
- Inspect: `package-lock.json`
- Inspect: `tests/**/*.test.ts`

- [x] **Step 1: Confirm branch and clean tracked state**

Run:

```powershell
git branch --show-current
git status --short
```

Expected: branch is `codex/ceta-feedback-polish` and there are no tracked modifications.

- [x] **Step 2: Install the locked dependency graph**

Run:

```powershell
npm ci
```

Expected: exit 0 with no `package-lock.json` change.

- [x] **Step 3: Run the unit baseline**

Run:

```powershell
npm test
```

Expected: all existing Vitest tests pass before production changes.

- [x] **Step 4: Run the production build baseline**

Run:

```powershell
npm run build
```

Expected: Electron/Vite bundles and `vue-tsc --noEmit` complete successfully.

### Task 2: Integrate Native Window Chrome and Stripe-Free Branding

**Files:**
- Modify: `tests/unit/electron-startup.test.ts`
- Modify: `tests/unit/windows/app-branding.test.ts`
- Modify: `src/main/main.ts`
- Modify: `src/renderer/src/components/workbench/WorkbenchShell.vue`
- Modify: `scripts/windows/generate-ta-icon.ps1`
- Regenerate: `build-resources/ta-icon.png`
- Regenerate: `build-resources/ta-icon.ico`

- [x] **Step 1: Write failing window and icon contract tests**

Add these assertions:

```ts
it('removes the redundant native application menu while retaining the native frame', () => {
  const source = readFileSync(new URL('../../src/main/main.ts', import.meta.url), 'utf8')
  expect(source).toContain("import { app, BrowserWindow, Menu } from 'electron'")
  expect(source).toContain('Menu.setApplicationMenu(null)')
  expect(source).toContain('autoHideMenuBar: true')
  expect(source).not.toContain('frame: false')
})
```

```ts
expect(iconGenerator).not.toContain('accentWidth')
expect(iconGenerator).not.toContain('accentBrush')
expect(iconGenerator).toContain("[System.Drawing.RectangleF]::new(0, 0, $size, $size)")
expect(shell).toContain('class="brand-mark"')
expect(shell).toContain('width: 28px; height: 28px')
expect(shell).not.toContain('margin: 8px')
```

- [x] **Step 2: Run the focused tests and observe failure**

Run:

```powershell
npx vitest run tests/unit/electron-startup.test.ts tests/unit/windows/app-branding.test.ts
```

Expected: FAIL because the application menu is still installed, the icon generator still draws an accent strip, and the workbench is still a floating inset frame.

- [x] **Step 3: Implement the minimal window and icon changes**

Use the following main-process behavior:

```ts
import { app, BrowserWindow, Menu } from 'electron'

export function createMainWindow(): BrowserWindow {
  Menu.setApplicationMenu(null)
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    webPreferences: { /* retain current sandbox options */ },
  })
  // retain existing registration and navigation order
}
```

Generate the mark without an accent rectangle and center text in the complete square:

```powershell
$graphics.Clear([System.Drawing.Color]::FromArgb(29, 36, 44))
$borderPen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(83, 94, 106), [Math]::Max(1, $size / 128))
$textArea = [System.Drawing.RectangleF]::new(0, 0, $size, $size)
$graphics.DrawString('TA', $font, $textBrush, $textArea, $format)
```

Make `.workbench-shell` fill the renderer viewport with `width: 100vw`, `height: 100vh`, `margin: 0`, `border: 0`, `border-radius: 0`, and `box-shadow: none`. Keep the native frame enabled.

- [x] **Step 4: Regenerate both icon formats and rerun tests**

Run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/windows/generate-ta-icon.ps1
npx vitest run tests/unit/electron-startup.test.ts tests/unit/windows/app-branding.test.ts
```

Expected: PASS; the PNG and ICO are regenerated from the stripe-free source.

- [x] **Step 5: Commit window integration**

```powershell
git add tests/unit/electron-startup.test.ts tests/unit/windows/app-branding.test.ts src/main/main.ts src/renderer/src/components/workbench/WorkbenchShell.vue scripts/windows/generate-ta-icon.ps1 build-resources/ta-icon.png build-resources/ta-icon.ico
git commit -m "fix: unify CETA window chrome and branding"
```

### Task 3: Rename and Polish the Side Regions

**Files:**
- Modify: `tests/unit/windows/app-branding.test.ts`
- Modify: `tests/unit/renderer/v18-visual-contract.test.ts`
- Modify: `tests/e2e/workbench.spec.ts`
- Modify: `src/renderer/src/components/workbench/WorkbenchShell.vue`
- Modify: `src/renderer/src/components/workbench/WorkbenchSessionSidebar.vue`
- Modify: `src/renderer/src/components/chat/GlobalChatPanel.vue`

- [ ] **Step 1: Write failing naming and scrollbar tests**

Replace the former label expectations with:

```ts
expect(history).toContain('任务历史区')
expect(shell).toContain('展开任务历史区')
expect(shell).toContain('展开 AI工作区')
expect(shell).toContain('调整任务历史区宽度')
expect(shell).toContain('调整 AI工作区宽度')
expect(chat).toContain('aria-label="AI工作区"')
expect(history).toContain('scrollbar-width: thin')
expect(history).toContain('::-webkit-scrollbar-thumb')
```

Update Playwright locators to use the new collapse, expand, and separator accessible names.

- [ ] **Step 2: Run focused tests and observe failure**

Run:

```powershell
npx vitest run tests/unit/windows/app-branding.test.ts tests/unit/renderer/v18-visual-contract.test.ts
```

Expected: FAIL on the old `聊天会话` and `AI 聊天` region names and missing custom scrollbar rules.

- [ ] **Step 3: Implement the region vocabulary and scrollbar**

Use these visible and accessible labels:

```vue
<aside class="session-sidebar" aria-label="任务历史区">
  <div class="panel-title"><strong>任务历史区</strong><span>聊天与 Shell 记录</span></div>
</aside>
```

```vue
<section class="global-chat-panel" aria-label="AI工作区">
  <h3>{{ readOnly ? 'AI工作区 · 历史' : 'AI工作区' }}</h3>
</section>
```

Rename collapse, expand, and splitter labels consistently. Add a sidebar-local scrollbar:

```css
nav {
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--muted) 58%, transparent) transparent;
  scrollbar-gutter: stable;
}
nav::-webkit-scrollbar { width: 8px; }
nav::-webkit-scrollbar-track { background: transparent; }
nav::-webkit-scrollbar-thumb {
  border: 2px solid transparent;
  border-radius: 4px;
  background: color-mix(in srgb, var(--muted) 58%, transparent);
  background-clip: padding-box;
}
nav::-webkit-scrollbar-thumb:hover { background-color: var(--muted); }
```

- [ ] **Step 4: Run focused unit and UI locator tests**

Run:

```powershell
npx vitest run tests/unit/windows/app-branding.test.ts tests/unit/renderer/v18-visual-contract.test.ts
npx playwright test tests/e2e/workbench.spec.ts --grep "persists resized and collapsed sidebars"
```

Expected: PASS with the new names and keyboard-operable splitters.

- [ ] **Step 5: Commit side-region polish**

```powershell
git add tests/unit/windows/app-branding.test.ts tests/unit/renderer/v18-visual-contract.test.ts tests/e2e/workbench.spec.ts src/renderer/src/components/workbench/WorkbenchShell.vue src/renderer/src/components/workbench/WorkbenchSessionSidebar.vue src/renderer/src/components/chat/GlobalChatPanel.vue
git commit -m "fix: clarify CETA workbench regions"
```

### Task 4: Clarify Historical-Only Shell Presentation

**Files:**
- Modify: `tests/unit/renderer/shell-canvas.test.ts`
- Modify: `tests/e2e/workbench.spec.ts`
- Modify: `src/renderer/src/components/workbench/ShellCanvas.vue`
- Modify: `src/renderer/src/views/WorkbenchView.vue`

- [ ] **Step 1: Write failing historical-state tests**

Add static and runtime expectations:

```ts
expect(canvas).toContain('Shell 历史回放')
expect(canvas).toContain('{{ historyHosts.length }} 台主机')
expect(canvas).toContain('以下 Shell 已关闭，仅提供只读回放')
expect(canvas).toContain('v-if="isLive" class="shell-title"')
```

In the existing historical-chat Playwright flow:

```ts
await expect(page.getByText('Shell 历史回放', { exact: true })).toBeVisible()
await expect(page.getByText(/台主机 · .*条记录/)).toBeVisible()
await expect(page.getByText(/以下 Shell 已关闭，仅提供只读回放/)).toBeVisible()
await expect(page.getByText(/个关联 · .*个正在显示/)).toHaveCount(0)
```

- [ ] **Step 2: Run the focused tests and observe failure**

Run:

```powershell
npx vitest run tests/unit/renderer/shell-canvas.test.ts
```

Expected: FAIL because historical mode still says `Shell 历史` and renders the generic live-association summary.

- [ ] **Step 3: Implement explicit live/history toolbars and copy**

Use a historical heading independent of `shellCount`:

```vue
<div v-else class="history-toolbar-title">
  <strong>Shell 历史回放</strong>
  <span>{{ historyHosts.length }} 台主机 · {{ shellCount }} 条记录</span>
</div>
<div class="hostbar-tools">
  <div v-if="isLive" class="shell-title">
    <strong>Shell</strong>
    <span>{{ shellCount }} 个关联 · {{ displayedSessionIds.length }} 个正在显示</span>
  </div>
  <span v-else class="history-readonly-note">以下 Shell 已关闭，仅提供只读回放</span>
  <!-- retain live connect, restore-live, and layout actions -->
</div>
```

Keep the history host tabs, context menu, selected-host filtering, read-only preview slot, and reconnect action unchanged.

- [ ] **Step 4: Run focused unit and historical Playwright tests**

Run:

```powershell
npx vitest run tests/unit/renderer/shell-canvas.test.ts
npx playwright test tests/e2e/workbench.spec.ts --grep "historical"
```

Expected: PASS; historical tasks show no contradictory live Shell summary.

- [ ] **Step 5: Commit historical-state polish**

```powershell
git add tests/unit/renderer/shell-canvas.test.ts tests/e2e/workbench.spec.ts src/renderer/src/components/workbench/ShellCanvas.vue src/renderer/src/views/WorkbenchView.vue
git commit -m "fix: clarify historical Shell playback"
```

### Task 5: Migrate to Taller Shell Row Presets

**Files:**
- Modify: `tests/unit/renderer/layout-preferences.test.ts`
- Modify: `tests/unit/settings/workbench-preferences-service.test.ts`
- Modify: `src/shared/contracts.ts`
- Modify: `src/main/settings/workbench-preferences-service.ts`
- Modify: `src/renderer/src/stores/layout-preferences.ts`

- [ ] **Step 1: Write failing preset and version-2 migration tests**

Update the renderer contract:

```ts
expect(SHELL_ROW_HEIGHT_PRESETS).toEqual([
  { label: '紧凑', value: 48 },
  { label: '标准', value: 64 },
  { label: '宽松', value: 80 },
])
expect(createDefaultWorkbenchPreferences().rowHeightPercent).toBe(64)
```

Add a version-2 migration table:

```ts
it.each([[34, 48], [48, 64], [64, 80]] as const)(
  'migrates the version-2 %i%% row height to %i%%',
  async (oldHeight, expectedHeight) => {
    const { service, filePath } = await createService()
    await writeFile(filePath, JSON.stringify({
      version: 2,
      appearance: { theme: 'pearl' },
      layout: { ...layoutWithoutRowHeight, rowHeightPercent: oldHeight },
      routing: {},
      memory: {},
    }))
    await expect(service.load()).resolves.toMatchObject({ rowHeightPercent: expectedHeight })
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toMatchObject({
      version: 3,
      layout: { rowHeightPercent: expectedHeight },
    })
  },
)
```

- [ ] **Step 2: Run focused tests and observe failure**

Run:

```powershell
npx vitest run tests/unit/renderer/layout-preferences.test.ts tests/unit/settings/workbench-preferences-service.test.ts
```

Expected: FAIL because the schemas and defaults still use `34 / 48 / 64` and document version 2.

- [ ] **Step 3: Implement version-3 preferences and migration**

Use the new public schema:

```ts
export const shellRowHeightPercentSchema = z.union([z.literal(48), z.literal(64), z.literal(80)])
export const workbenchPreferencesDocumentSchema = z.object({
  version: z.literal(3),
  appearance: z.object({ theme: workbenchThemeSchema }).strict(),
  layout: workbenchLayoutSchema,
  routing: z.object({}).strict(),
  memory: z.object({}).strict(),
}).strict()
```

Add explicit legacy version-2 parsing and semantic mapping:

```ts
const version2RowHeightSchema = z.union([z.literal(34), z.literal(48), z.literal(64)])
const version2DocumentSchema = z.object({
  version: z.literal(2),
  appearance: z.object({ theme: workbenchThemeSchema }).strict(),
  layout: workbenchLayoutSchema.omit({ rowHeightPercent: true }).extend({ rowHeightPercent: version2RowHeightSchema }).strict(),
  routing: z.object({}).strict(),
  memory: z.object({}).strict(),
}).strict()

function tallerRowHeight(value: 34 | 48 | 64): 48 | 64 | 80 {
  return value === 34 ? 48 : value === 48 ? 64 : 80
}
```

Migrate both version 1 and version 2 directly to version 3. Set the default and `SHELL_ROW_HEIGHT_PRESETS` to `48 / 64 / 80`.

- [ ] **Step 4: Run migration and renderer tests**

Run:

```powershell
npx vitest run tests/unit/renderer/layout-preferences.test.ts tests/unit/settings/workbench-preferences-service.test.ts tests/unit/shared/contracts.test.ts
```

Expected: PASS for new documents, old pixel documents, and old percentage documents.

- [ ] **Step 5: Commit layout migration**

```powershell
git add tests/unit/renderer/layout-preferences.test.ts tests/unit/settings/workbench-preferences-service.test.ts src/shared/contracts.ts src/main/settings/workbench-preferences-service.ts src/renderer/src/stores/layout-preferences.ts
git commit -m "feat: increase Shell workspace heights"
```

### Task 6: Share and Display the Real Host Collection Command Catalog

**Files:**
- Create: `src/shared/host-memory-commands.ts`
- Create: `tests/unit/shared/host-memory-commands.test.ts`
- Modify: `tests/unit/observation/observation-runner.test.ts`
- Modify: `tests/unit/observation/register-session-observation.test.ts`
- Modify: `tests/unit/renderer/host-memory-settings.test.ts`
- Modify: `tests/e2e/settings.spec.ts`
- Modify: `src/main/observation/observation-runner.ts`
- Modify: `src/main/observation/register-session-observation.ts`
- Modify: `src/renderer/src/components/settings/HostMemorySettings.vue`

- [ ] **Step 1: Write failing shared-catalog and renderer tests**

Define expected public behavior:

```ts
import { HOST_MEMORY_COMMANDS, hostMemoryCommandsForScopes } from '../../../src/shared/host-memory-commands'

it('keeps hostname first and filters optional commands by enabled scope', () => {
  expect(HOST_MEMORY_COMMANDS[0]).toMatchObject({ id: 'hostname', command: 'hostname', required: true })
  expect(hostMemoryCommandsForScopes({ identity: false, hardware: false, processes: false, runtime: true }).map(item => item.id))
    .toEqual(['hostname', 'current-user', 'working-directory', 'services'])
})
```

```ts
expect(memory).toContain("import { HOST_MEMORY_COMMANDS")
expect(memory).toContain('采集命令清单')
expect(memory).toContain('<code>{{ item.command }}</code>')
expect(memory).toContain("settings.scopes[item.scope]")
```

- [ ] **Step 2: Run focused tests and observe failure**

Run:

```powershell
npx vitest run tests/unit/shared/host-memory-commands.test.ts tests/unit/observation/observation-runner.test.ts tests/unit/renderer/host-memory-settings.test.ts
```

Expected: FAIL because the shared catalog does not exist and Settings does not disclose commands.

- [ ] **Step 3: Implement the authoritative catalog**

Create the catalog with exact commands already used by the observation runner:

```ts
import type { HostMemoryScope, HostMemoryScopes } from './contracts'

export type HostMemoryCommand = Readonly<{
  id: string
  scope: HostMemoryScope | null
  label: string
  command: string
  required?: true
}>

export const linuxCpuModelCommand = 'awk -F: \'/^model name[[:space:]]*:/ { sub(/^[[:space:]]+/, "", $2); print $2; exit }\' /proc/cpuinfo'
export const linuxMemoryCommand = 'awk \'/^MemTotal:/ { print $2; exit }\' /proc/meminfo'
export const linuxDiskCommand = 'lsblk -b -dn -o NAME,SIZE,TYPE | head -n 64'
export const linuxNetworkCommand = 'ip -o addr show | head -n 128'
export const linuxProcessCommand = 'for p in /proc/[0-9]*; do [ -r "$p/comm" ] || continue; pid=${p##*/}; name=$(head -n 1 "$p/comm"); cwd=$(readlink "$p/cwd" 2>/dev/null || true); printf \'%s\\t%s\\t%s\\n\' "$pid" "$name" "$cwd"; done | head -n 200'
export const linuxServiceCommand = 'systemctl list-units --type=service --state=running,failed --no-pager --no-legend | head -n 128'

export const HOST_MEMORY_COMMANDS = [
  { id: 'hostname', scope: null, label: '主机名（唯一存储键）', command: 'hostname', required: true },
  { id: 'os-name', scope: 'identity', label: '操作系统', command: 'uname -s' },
  { id: 'os-version', scope: 'identity', label: '系统版本', command: 'uname -r' },
  { id: 'cpu-model', scope: 'hardware', label: 'CPU 型号', command: linuxCpuModelCommand },
  { id: 'cpu-architecture', scope: 'hardware', label: 'CPU 架构', command: 'uname -m' },
  { id: 'cpu-cores', scope: 'hardware', label: '逻辑核心数', command: 'getconf _NPROCESSORS_ONLN' },
  { id: 'memory', scope: 'hardware', label: '内存总量', command: linuxMemoryCommand },
  { id: 'disks', scope: 'hardware', label: '磁盘', command: linuxDiskCommand },
  { id: 'network', scope: 'hardware', label: '网络接口', command: linuxNetworkCommand },
  { id: 'processes', scope: 'processes', label: '运行进程', command: linuxProcessCommand },
  { id: 'current-user', scope: 'runtime', label: '当前用户', command: 'id -un' },
  { id: 'working-directory', scope: 'runtime', label: '工作目录', command: 'pwd -P' },
  { id: 'services', scope: 'runtime', label: '服务状态', command: linuxServiceCommand },
] as const satisfies readonly HostMemoryCommand[]

export function hostMemoryCommandsForScopes(scopes: HostMemoryScopes): readonly HostMemoryCommand[] {
  return HOST_MEMORY_COMMANDS.filter(item => item.scope === null || scopes[item.scope])
}
```

Keep the long command constants in this same file above the catalog. Re-export them from `observation-runner.ts` for current consumers. Derive `commandsFor()` and `commandAllowed()` from the shared catalog so display and execution cannot drift.

- [ ] **Step 4: Render the read-only catalog and verify consent execution**

Add this settings structure:

```vue
<section class="command-catalog" aria-labelledby="command-catalog-title">
  <div class="section-head">
    <div><h3 id="command-catalog-title">采集命令清单</h3><p>连接 Shell 后，点击“我已知道”才会按以下顺序执行。</p></div>
    <span>只读预制</span>
  </div>
  <ol>
    <li v-for="item in HOST_MEMORY_COMMANDS" :key="item.id" :class="{ disabled: item.scope && !settings.scopes[item.scope] }">
      <span><strong>{{ item.label }}</strong><small>{{ item.required ? '始终执行' : item.scope && settings.scopes[item.scope] ? '将执行' : '当前不执行' }}</small></span>
      <code>{{ item.command }}</code>
    </li>
  </ol>
</section>
```

Extend the existing observation test to compare every `executeReadOnly` command, in order, with `hostMemoryCommandsForScopes(scopes).map(item => item.command)`. Extend Settings E2E to assert `hostname`, `uname -s`, and the disabled-scope state are visible.

- [ ] **Step 5: Run host collection tests and commit**

Run:

```powershell
npx vitest run tests/unit/shared/host-memory-commands.test.ts tests/unit/observation/observation-runner.test.ts tests/unit/observation/register-session-observation.test.ts tests/unit/renderer/host-memory-settings.test.ts tests/unit/facts/host-facts-service.test.ts tests/unit/facts/host-facts-repository.test.ts
npm run build
```

Expected: PASS; main and renderer compile against the same immutable catalog.

```powershell
git add src/shared/host-memory-commands.ts tests/unit/shared/host-memory-commands.test.ts tests/unit/observation/observation-runner.test.ts tests/unit/observation/register-session-observation.test.ts tests/unit/renderer/host-memory-settings.test.ts tests/e2e/settings.spec.ts src/main/observation/observation-runner.ts src/main/observation/register-session-observation.ts src/renderer/src/components/settings/HostMemorySettings.vue
git commit -m "feat: disclose real host collection commands"
```

### Task 7: Prove Model Connection and AI Workspace End to End

**Files:**
- Modify: `tests/e2e/workbench.spec.ts`
- Inspect: `src/main/model/model-provider-router.ts`
- Inspect: `src/main/model/chat-completions-client.ts`
- Inspect: `src/main/chat/chat-runtime.ts`
- Inspect: `src/renderer/src/stores/global-chat.ts`

- [ ] **Step 1: Extend the fake-provider test through connection testing**

Before saving the fake Ollama profile, call the public connection-test API with the same input:

```ts
const input = {
  name: 'E2E Fake Ollama',
  kind: 'llm' as const,
  provider: 'ollama' as const,
  model: 'fake-e2e',
  endpoint: endpointValue,
  contextLimit: 1024,
}
const tested = await window.terminalAgent.settings.models.test(input)
const profile = await window.terminalAgent.settings.models.save(input)
if (!profile.active) await window.terminalAgent.settings.models.activate(profile.id)
return tested
```

Assert that the connection result identifies `fake-e2e`, then keep the existing streaming, temporary 503 failure, retry, persistence, cancellation, and supersession assertions.

- [ ] **Step 2: Run the focused unit model suites**

Run:

```powershell
npx vitest run tests/unit/model/model-provider-router.test.ts tests/unit/model/chat-completions-client.test.ts tests/unit/settings/model-profile-service.test.ts tests/unit/chat/chat-runtime.test.ts tests/unit/renderer/global-chat.test.ts
```

Expected: PASS for provider routing, API-key isolation, stream parsing, cancellation, retry, and renderer run ownership.

- [ ] **Step 3: Run the real Electron fake-provider flow**

Run:

```powershell
npm run build
npx playwright test tests/e2e/workbench.spec.ts --grep "streams fake global AI chat"
```

Expected: PASS; the connection test and AI workspace both reach the local HTTP server, first streaming succeeds, the second request fails safely, and retry succeeds.

- [ ] **Step 4: Fix only failures exposed by the new evidence**

If the connection-test request differs from runtime, make both paths use `ModelProviderRouter.test()` and `ModelProviderRouter.stream()` with the same normalized provider endpoint. Preserve this public behavior:

```ts
const tested = await profiles.prepareForConnectionTest(input)
const result = await providerRouter.test(tested)
return { ok: true as const, model: result.model }
```

Rerun Steps 2 and 3 after any fix. If no failure occurs, do not modify production model code.

- [ ] **Step 5: Commit the verification contract**

```powershell
git add tests/e2e/workbench.spec.ts src/main/model/model-provider-router.ts src/main/model/chat-completions-client.ts src/main/chat/chat-runtime.ts src/renderer/src/stores/global-chat.ts
git commit -m "test: verify model and AI workspace networking"
```

Only add production files that actually changed.

### Task 8: Version, Full Verification, Visual QA, and Installer

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `README.md`
- Modify: `README-en.md`
- Modify: `RELEASE_NOTES.md`
- Modify: `tests/unit/windows/app-branding.test.ts`
- Generate: `release/Terminal-Agent-Setup-1.0.7.exe`
- Generate: `release/Terminal-Agent-Uninstall-Cleanup-1.0.7.zip`

- [ ] **Step 1: Update release metadata with a failing branding assertion first**

Change the branding test to:

```ts
expect(packageJson.version).toBe('1.0.7')
```

Run:

```powershell
npx vitest run tests/unit/windows/app-branding.test.ts
```

Expected: FAIL because package metadata is still 1.0.6.

- [ ] **Step 2: Apply the patch version and release notes**

Run:

```powershell
npm version 1.0.7 --no-git-tag-version
```

Update README artifact names to `1.0.7`. Add a 1.0.7 release-note section listing window chrome, consistent icon, region labels, history UI, taller layouts, visible host commands, and model/AI verification. Do not create a git tag.

- [ ] **Step 3: Run the complete automated verification matrix**

Run each command independently:

```powershell
npm test
npm run lint
npm run build
npm run test:e2e
npm run test:integration
```

Expected: every command exits 0. Record exact test counts from Vitest and Playwright output.

- [ ] **Step 4: Perform desktop and constrained visual checks**

Launch the Electron build with a temporary user-data directory. Capture `1440x900` and `1024x768` screenshots for:

```text
live empty workspace
historical-only workspace
host-memory settings command catalog
AI workspace with a streamed response
```

Verify by screenshot inspection and DOM bounds that the native menu is absent, the app content begins immediately under the title bar, labels do not clip, no controls overlap, history is unambiguously read-only, and there is no page-level horizontal overflow.

- [ ] **Step 5: Build and inspect the Windows installer**

Run:

```powershell
npm run make:win
Get-FileHash release/Terminal-Agent-Setup-1.0.7.exe -Algorithm SHA256
Get-Item release/Terminal-Agent-Setup-1.0.7.exe | Select-Object FullName,Length,LastWriteTime
```

Expected: `Terminal-Agent-Setup-1.0.7.exe` and the cleanup ZIP exist and are non-empty; the SHA-256 hash is captured.

- [ ] **Step 6: Smoke-test packaged launch and commit release changes**

Launch `release/win-unpacked/Terminal-Agent-runtime.exe` with a temporary user-data directory, confirm a responsive main window and visible `设置`, `任务历史区`, and `AI工作区`, then close it cleanly.

```powershell
git add package.json package-lock.json README.md README-en.md RELEASE_NOTES.md tests/unit/windows/app-branding.test.ts
git commit -m "release: prepare CETA polish 1.0.7"
git status --short --branch
```

Expected: branch `codex/ceta-feedback-polish` is clean except ignored/generated release output, and the installer was built from the committed source state.
