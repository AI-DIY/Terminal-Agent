# CETA Feedback Polish Design

## Context

The CETA review asks for eight targeted corrections while explicitly preserving the existing product structure and functionality. The current `1.0.6` application already contains the three-pane workbench, persisted chat and Shell history, host-memory collection, model connection testing, and global AI chat. This change therefore tightens presentation, exposes existing collection behavior more clearly, and strengthens end-to-end verification instead of rebuilding those systems.

## Selected Approach

Use a conservative native-window integration:

- keep the Windows native title bar and its minimize, maximize, and close behavior;
- remove Electron's default `File / Edit / View / Window` application menu;
- make the application content fill the client area so the existing app header becomes the first product-owned row;
- retain the current workbench composition, persistence contracts, SSH behavior, and model architecture.

Two alternatives were rejected. A frameless custom title bar would require reimplementing drag regions, system menus, snapping, accessibility, and window controls, which is disproportionate to a visual polish request. Keeping the native menu and moving Settings into it would preserve the visual separation called out by the review.

## Requirements

### 1. Window chrome and Settings placement

The native title bar remains. The default application menu is removed at application startup, and `autoHideMenuBar` is enabled defensively on the main window. The current app header loses its outer margin, rounded frame, and floating shadow so it aligns directly beneath the title bar. Settings remains the rightmost action in this header, visibly belonging to the same top-level navigation row as the brand and current task.

### 2. Consistent application icon

The generated TA icon no longer contains the blue strip. The PNG and multi-size ICO continue to be generated from the same script and use the same dark background, white `TA`, and subtle neutral border. The in-app brand mark adopts the same square geometry and colors so the installer, executable, taskbar, native window, and workbench header read as one mark.

### 3. Side-region names

All user-visible text and accessibility labels for the left region change from chat-oriented names to `任务历史区`. The right region is labeled `AI工作区`. Chat and AI behavior remain unchanged; only region identity, collapse/expand labels, and relevant resize labels change.

### 4. Task-history scrollbar

The task-history navigation receives a narrow, theme-aware scrollbar with a transparent track, neutral thumb, hover state, stable gutter, and sufficient contrast in both pearl and graphite themes. No global scrollbar rule is introduced.

### 5. Historical task Shell state

The Shell canvas distinguishes three states without changing persisted data:

1. a live task shows live host tabs, connection actions, and live terminals;
2. a historical task with associated Shell records shows a `Shell 历史回放` heading, historical host count, historical host tabs, and the selected read-only record;
3. a task with neither live nor historical Shell data shows the existing connection launcher or a concise empty state.

Historical mode must not show a contradictory live Shell count, live connection language, or a blank live-host strip. The toolbar and empty copy explicitly say that the records are closed and read-only.

### 6. Taller Shell workspace presets

The three persisted row-height presets increase together:

| Preset | Current | New |
| --- | ---: | ---: |
| 紧凑 | 34% | 48% |
| 标准 | 48% | 64% |
| 宽松 | 64% | 80% |

The default remains `标准`, now resolving to `64%`. Existing stored `34`, `48`, and `64` values migrate by semantic position to `48`, `64`, and `80`; they are not rejected or silently reset. Both the Settings page and the Shell layout menu use the same preset catalog.

### 7. Visible, real host-information collection

Create one shared, read-only Linux observation command catalog containing scope, purpose, and exact command. The main-process observation runner derives execution order from this catalog, while the host-memory Settings page renders the same catalog grouped under identity, hardware, processes, and runtime. Disabled scopes remain visible but are marked as not collected.

On an eligible SSH connection:

1. the application shows the existing host-memory disclosure;
2. clicking `我已知道` records consent;
3. the main process executes the enabled catalog commands sequentially through the read-only SSH execution path;
4. bounded outputs are parsed and filtered into the existing structured host-memory record;
5. the repository upserts the record by normalized, observed hostname;
6. Settings can refresh, inspect, edit, and clear the stored record.

The command list is not editable. This prevents the settings surface from becoming an arbitrary remote-command executor. Failures in individual optional commands produce missing fields rather than interrupting the interactive terminal; hostname failure prevents persistence because a stable key cannot be established.

### 8. Model connection and AI workspace verification

Retain the existing provider adapters, protected API-key storage, routing, stream persistence, cancellation, retry, and error sanitization. Verification must prove the complete user path rather than only checking component text:

- a connection test reaches a local fake provider over HTTP and reports the returned model;
- an activated model can receive a message from the AI workspace and stream a response into the correct task;
- temporary provider failure exposes a retry action and a later retry succeeds;
- switching tasks cannot route deltas into the wrong task;
- missing configuration and network errors remain actionable and do not expose credentials;
- the packaged application starts and exposes the same Settings and AI workspace surfaces.

No real external API credential is required for automated verification. Local fake OpenAI-compatible or Ollama endpoints exercise the real network adapters deterministically.

## Component Boundaries

- `src/main/main.ts`: application-menu removal and native window options.
- `scripts/windows/generate-ta-icon.ps1` plus `build-resources/`: single icon generation source.
- `WorkbenchShell.vue`, `WorkbenchSessionSidebar.vue`, and `GlobalChatPanel.vue`: top-level region naming and visual polish.
- `ShellCanvas.vue` and `WorkbenchView.vue`: live, historical, and empty Shell-state presentation.
- `shared/contracts.ts`, workbench preferences service, and layout preference store: semantic row-height migration and validation.
- a shared host-observation catalog: authoritative commands and renderer-safe descriptions.
- observation runner and session observation registration: sequential execution and consent gate.
- host-memory Settings component: read-only command disclosure and stored-record inspection.
- existing model services, provider adapters, chat runtime, and renderer store: verified rather than redesigned unless a failing test identifies a defect.

## Data and Compatibility

No chat, Shell history, model profile, API-key, or host-fact format is removed. Workbench preference loading accepts the three old row-height values and maps them to the corresponding taller presets before returning or persisting the normalized document. Host records remain keyed by normalized hostname in `host-facts.json`.

The package version becomes `1.0.7`, producing `Terminal-Agent-Setup-1.0.7.exe` and a matching uninstall-cleanup archive without overwriting the existing `1.0.6` artifacts.

## Error Handling and Safety

- Menu removal cannot affect keyboard input or SSH sessions.
- Host observation remains opt-in, read-only, bounded, scope-filtered, and isolated from terminal output.
- Unsupported observation platforms do not run the Linux command catalog.
- Renderer code receives descriptions and command strings only; it cannot execute them directly.
- Model and chat errors keep existing credential and filesystem-path redaction.
- Visual changes preserve keyboard-operable splitters, collapse controls, dialogs, focus handling, and accessible names.

## Test and Release Strategy

1. Add failing unit tests for menu removal, icon generation, labels, scrollbar contract, historical-state copy, preset migration, and shared command-catalog use.
2. Implement the smallest production changes that satisfy those tests.
3. Run focused unit tests after each area, then the full unit suite, lint, TypeScript production build, and Playwright end-to-end suite.
4. Exercise host consent, sequential collection, hostname-keyed persistence, Settings inspection, model connection testing, AI streaming, retry, and task switching using local SSH and model servers.
5. Launch the built application at desktop and constrained viewport sizes, capture screenshots, and verify there is no overlap, clipping, blank canvas, or misleading historical state.
6. Build the Windows NSIS installer from the final commit, inspect its version and contents, launch the packaged executable, and report the installer path and checksum.

## Acceptance Criteria

- Every numbered CETA comment has direct source, test, and runtime evidence.
- Existing SSH, chat, history, settings, host-memory, and AI behavior remains available.
- Native window controls remain functional and the redundant native menu is absent.
- All visible app marks use the stripe-free TA design.
- The left and right regions read `任务历史区` and `AI工作区` consistently.
- Historical-only tasks cannot be mistaken for live Shell tasks.
- Shell row presets are materially taller and old preferences migrate predictably.
- The exact host collection commands are visible before consent and are the commands actually executed.
- A local provider proves model testing and AI workspace streaming/retry end to end.
- `Terminal-Agent-Setup-1.0.7.exe` installs or launches successfully on Windows.
