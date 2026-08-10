# Terminal-Agent

Terminal-Agent is a Vue 3 and Electron desktop SSH workbench with direct password/private-key sessions, AccessClient-compatible launches, structured hostname-keyed observations, OpenAI Chat Completions configuration, and a Copilot-first command flow.

## Windows Release

Build the Windows application directory with:

```powershell
npm run make:win:unpacked
```

After installing Terminal-Agent, copy or map only `release/win-unpacked/putty.exe` into the Assess/Access Client mapping location. Do not copy `Terminal-Agent-runtime.exe`, `resources`, or any other Electron files. The portable `putty.exe` bridge locates the installed Terminal-Agent and forwards AccessClient-compatible arguments (including temporary bastion credentials) to the installed runtime without exposing them in application logs or persisted settings.

The installer and each packaged Windows startup record the installed location for the bridge. If the bridge reports that Terminal-Agent cannot be found, install Terminal-Agent or start it once, then reopen the connection from Assess/Access Client.

`npm run make:win` additionally generates `Terminal-Agent-Setup-<version>.exe` when the Electron Builder NSIS resources are available from the network.
