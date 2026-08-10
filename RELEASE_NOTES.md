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
