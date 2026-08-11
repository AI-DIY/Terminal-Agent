# Terminal-Agent v1.0.3

Release date: 2026-08-11

## Windows uninstall-entry cleanup

- Added `Terminal-Agent-Uninstall-Cleanup-1.0.3.zip` for cleaning Terminal-Agent entries left in the Windows installed-apps list.
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
