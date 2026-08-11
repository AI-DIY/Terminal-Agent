# Terminal-Agent

Terminal-Agent is a Vue 3 and Electron desktop SSH workbench with direct password/private-key sessions, AccessClient-compatible launches, structured hostname-keyed observations, OpenAI Chat Completions configuration, and a Copilot-first command flow.

## Windows Release

Build the Windows application directory with:

```powershell
npm run make:win:unpacked
```

After installing Terminal-Agent, copy or map only `release/win-unpacked/putty.exe` into the Assess/Access Client mapping location. Do not copy `Terminal-Agent-runtime.exe`, `resources`, or any other Electron files. The portable `putty.exe` bridge locates the installed Terminal-Agent and forwards AccessClient-compatible arguments (including temporary bastion credentials) to the installed runtime.

Every bastion jump appends a redacted diagnostic record to `putty-bridge.log` beside the mapped `putty.exe`. The log identifies the bridge, its runtime lookup, the safe argument shape, process start result, temporary-profile validation, and connection result. Passwords, tokens, private-key material, passphrases, and temporary-profile paths are not written to this log.

The bridge first uses a valid registered install location and then safely checks a co-located runtime and standard Windows install locations. It does not modify the registry or delete files. If both the installation directory and its registry entry have been removed, no bridge can start the deleted runtime: run the Windows installer again, then reopen the connection from Assess/Access Client.

`npm run make:win` generates `Terminal-Agent-Setup-<version>.exe` and `Terminal-Agent-Uninstall-Cleanup-<version>.zip`. A GitHub release includes the Windows installer, the standalone `putty.exe` bridge for Assess/Access Client mapping, and the cleanup ZIP for removing stale Terminal-Agent entries from the Windows installed-apps list.
