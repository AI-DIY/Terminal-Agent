# Terminal-Agent v1.0.8

Release date: 2026-08-23

## CETA follow-up refinements

- Removes the standalone top title strip with Electron's hidden title bar while retaining the native Windows minimize, maximize/restore, and close controls.
- Replaces file-based model-key input with direct API Key editing in the model connection form. A key can be tested before the configuration is saved and activated; protected storage retains it without returning the saved value to the UI.
- Removes LLM key references. Existing VLM references are migrated to protected credentials owned by the corresponding VLM profile.

## Windows release assets after packaging

- A local build or published release will generate `Terminal-Agent-Setup-1.0.8.exe`, the standalone `putty.exe` bridge, and `Terminal-Agent-Uninstall-Cleanup-1.0.8.zip`.

---

# Terminal-Agent v1.0.7

Release date: 2026-08-22

## CETA interface refinements

- Removes Electron's redundant native application menu while retaining the standard Windows title bar and window controls, and lets the workbench fill the complete client area.
- Uses the same stripe-free `TA` mark for the executable, installer, taskbar, window, and in-app branding.
- Names the side regions `任务历史区` and `AI工作区`, improves the task-history scrollbar, and keeps narrow-window controls contained and keyboard accessible.
- Makes historical-only Shell content explicit with `Shell 历史回放`, host and record counts, and a clear read-only notice.
- Raises Shell row-height presets to Compact (48%), Standard (64%), and Relaxed (80%), with semantic migration of existing layouts.

## Host memory and AI verification

- Displays the complete ordered list of fixed read-only host-information commands in Settings, including the current enabled or disabled scope state for every command.
- Executes those commands only after `我已知道` and a required Linux platform check, keeps `hostname` first, and stores filtered structured facts by the observed hostname.
- Verifies the model connection API and `AI工作区` against the same local HTTP provider configuration, including streaming, temporary failure, retry, persistence, cancellation, and supersession coverage.

## Windows release assets

- Includes `Terminal-Agent-Setup-1.0.7.exe`, a newly compiled standalone `putty.exe` bridge, and `Terminal-Agent-Uninstall-Cleanup-1.0.7.zip`.

---

# Terminal-Agent v1.0.6

Release date: 2026-08-22

## V18 workbench visual parity

- Rebuilds the production workbench around the approved V18 desktop frame with a compact top bar, Chat Sessions sidebar, unified Shell host bar, responsive terminal grid, and dedicated AI Chat panel.
- Restyles the real four-mode SSH launcher, connected terminals, historical Shell playback, streaming AI conversation, panel resizing, collapse rails, and Pearl/Graphite themes without introducing prototype sample data.
- Uses Lucide icons and consistent semantic colors, focus treatment, typography, spacing, scrollbars, and compact controls across the renderer.

## Settings visual parity and retained behavior

- Rebuilds all six real settings routes with the V18 navigation, model-routing cards, split model-profile editor, safety-fence table and tester, host-memory controls, and full workbench theme previews.
- Retains real SSH, chat, AI model, history, host-memory, persistence, protected-key, safety-fence, cancellation, retry, and autonomous-upgrade confirmation behavior.
- Adds responsive coverage for 1440x900, 1024x768, and 900x700 layouts, including page-overflow, terminal mounting, and settings-table checks.

## Windows release assets

- Includes `Terminal-Agent-Setup-1.0.6.exe`, a newly compiled standalone `putty.exe` bridge, and `Terminal-Agent-Uninstall-Cleanup-1.0.6.zip`.

---

# Terminal-Agent v1.0.5

Release date: 2026-08-21

## Workbench and Shell history refinement

- Rebrands the application and workbench mark as `TA`, and renames the side regions to Task History and AI Workspace with explicit directional restore controls.
- Unifies Appearance and Shell workspace layout preferences. Row height is now a shared Compact (34%), Standard (48%), or Relaxed (64%) percentage, with automatic migration from v1.0.4 pixel settings.
- Improves Shell title and connection-area hierarchy in Pearl and Graphite themes, adds compact historical Shell connections, multi-host filtering, shared historical layouts, and a host context-menu reconnect action.
- Keeps closed Shell history isolated by normalized hostname and waits for final history persistence before application shutdown.

## Host memory and AI workspace

- Refines Local Host Memory status, scope controls, and dual-theme rendering while retaining per-host review, edit, and clear actions.
- The **I understand** consent action runs only the fixed read-only Linux observation commands, then stores structured facts by hostname.
- Moves the autonomous upgrade action into the AI Workspace and removes saved-session and upgrade actions from the Shell toolbar.
- Retains tested Ollama, OpenAI-compatible, and llama.cpp connection profiles plus durable streaming chat, retry, cancellation, and model connection tests.

## Windows release assets

- Includes `Terminal-Agent-Setup-1.0.5.exe`, a newly compiled standalone `putty.exe` bridge, and `Terminal-Agent-Uninstall-Cleanup-1.0.5.zip`.

---

# Terminal-Agent v1.0.4

Release date: 2026-08-21

## Unified SSH workbench and enterprise bastion entry

- Adds the unified workbench for direct password SSH, direct private-key SSH, bastion CMDB launch, and named bastion-host launch.
- Adds durable work-task chat, associated Shell workspaces, local Shell history playback, configurable workbench layout, and consented local host memory.
- Keeps Assess/Access Client-compatible `putty.exe` as a single-file bridge: temporary bastion SSH/Raw profiles open in the installed Terminal-Agent workbench without being saved as normal session profiles.

## AI task assistance and execution safeguards

- Adds task-oriented global AI chat and AI model profile/routing settings for Ollama, OpenAI-compatible, and llama.cpp endpoints.
- Uses Copilot mode by default: AI proposes a command and a human must confirm the exact candidate before it is sent to the current Shell.
- Includes configurable default safety fences for process termination, interactive editors, file removal, service changes, host power operations, and disk partitioning or formatting.
- Keeps autonomous execution behind an explicit, current-session-only confirmation. It is intended only for verified low-risk maintenance or test work.
- Redacts sensitive material from AI flows, bridge diagnostics, and approved-command context; model keys are stored through OS-protected storage.

## Windows uninstall-entry cleanup

- Includes `Terminal-Agent-Uninstall-Cleanup-1.0.4.zip` for cleaning Terminal-Agent entries left in the Windows installed-apps list.
- After extracting the ZIP, users can double-click `清理 Terminal-Agent 卸载残留.cmd`; it requests administrator permission, lists every matching entry, and requires an explicit `Y` before changing the registry.
- Each matching uninstall entry is exported to a `.reg` backup before deletion. The tool does not uninstall Terminal-Agent, remove application files or user data, or remove `HKCU\Software\Terminal-Agent\InstallPath`.

---

# Terminal-Agent v1.0.2

Release date: 2026-08-11

## Bastion warm-launch fix

- The standalone `putty.exe` now places its private bridge metadata after Electron's argument boundary, so a bastion jump remains correlated when Terminal-Agent is already open.
- Runtime metadata validation rejects shifted Chromium option names instead of creating a stray file named `--terminal-agent-bridge-id`.
- AccessClient temporary profiles that omit `Protocol` now follow the `-load tmp:...` SSH meaning used by the real client; explicit `raw` profiles remain supported and explicit unknown protocols remain invalid.
- A packaged warm-launch regression test opens a real SSH fixture through an existing Terminal-Agent primary instance and verifies that the bridge and runtime share one launch ID without logging credentials or temporary-profile paths.

## Upgrade instructions

1. Install `Terminal-Agent-Setup-1.0.2.exe`.
2. Replace the AccessClient-mapped executable with the included v1.0.2 `putty.exe`.
3. After a jump, inspect `putty-bridge.log` beside that mapped `putty.exe`. The legacy `accessclient-launch.log` is not used by this bridge and may remain empty.

Both the runtime and mapped bridge must be updated; keeping the v1.0.1 mapped `putty.exe` preserves the old warm-launch argument order.

---

# Terminal-Agent v1.0.1

Release date: 2026-08-10

## Bastion bridge diagnostics

- Every start through the released `putty.exe` writes a correlated, redacted JSON-line trace to `putty-bridge.log` beside the mapped bridge. The trace includes runtime lookup, process start, temporary-profile validation, transport opening, session opening, and a safe failure category.
- Passwords, tokens, passphrases, private-key content, and temporary-profile paths are redacted from the trace and from the in-app error message.
- Terminal-Agent now distinguishes unsupported launch arguments, unreadable or invalid temporary profiles, transport failures, and terminal-open failures instead of showing only one generic AccessClient error.
- A second bastion launch while Terminal-Agent is already open is routed through the same protected launch controller and trace path.

## Runtime recovery

- The bridge treats a missing or stale `HKCU\Software\Terminal-Agent\InstallPath` value as invalid and then checks a co-located runtime plus standard Windows installation locations.
- The bridge never rewrites the registry or deletes installation files. If the runtime itself was deleted, reinstall using the included Windows installer.

## Download assets

- `Terminal-Agent-Setup-1.0.1.exe`: Windows installer that restores the Terminal-Agent runtime and its normal registry association.
- `putty.exe`: single-file bridge to map in Assess/Access Client after Terminal-Agent has been installed.
