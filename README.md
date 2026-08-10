# Terminal-Agent

Terminal-Agent is a Vue 3 and Electron desktop SSH workbench with direct password/private-key sessions, AccessClient-compatible launches, structured hostname-keyed observations, OpenAI Chat Completions configuration, and a Copilot-first command flow.

## Windows Release

Build the Windows application directory with:

```powershell
npm run make:win:unpacked
```

The public entry point is `release/win-unpacked/Terminal-Agent.exe`. It forwards AccessClient-compatible arguments to `Terminal-Agent-runtime.exe` without exposing credentials in application logs or persisted settings.

`npm run make:win` additionally generates `Terminal-Agent-Setup-<version>.exe` when the Electron Builder NSIS resources are available from the network.
