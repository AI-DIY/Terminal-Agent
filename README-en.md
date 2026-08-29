# Terminal-Agent

[中文文档](README.md)

Terminal-Agent is a Windows SSH workbench for daily operations and enterprise bastion-host workflows. It preserves the familiar SSH Shell experience while placing AI in a reviewable task flow: AI understands the task, produces analysis and a command candidate, and an operator reviews it before the exact command reaches the target Shell.

## What It Solves

Traditional terminals connect to hosts well, but they do not put the bastion entry point, multiple Shells, task context, AI guidance, and human change review in one operating surface. Terminal-Agent connects those steps into a controlled flow:

1. An enterprise Assess/Access Client or bastion host invokes the single-file `putty.exe` bridge.
2. The bridge starts the installed Terminal-Agent and hands temporary SSH/Raw bastion connections to the same workbench.
3. An operator asks AI to analyze, troubleshoot, or plan the next step for the associated Shells as a work task.
4. AI produces a text reply or a structured Shell plan; an operator reviews the target, impact, and commands before one group confirmation sends them.
5. Default safety fences intercept unconfirmed high-risk or interactive commands; the rules can be inspected, tested, and maintained in Settings.

This is not a way for AI to bypass established operations controls. It is a controlled Shell collaboration assistant.

## Key Advantages

- **Compatible with existing bastion entry points**: map only the release `putty.exe` to Assess/Access Client. No Electron runtime directory needs to be copied into the mapping location.
- **Native Windows window controls**: Electron's hidden title bar removes the standalone top title strip while the native Windows minimize, maximize/restore, and close controls remain in the application header.
- **Connections and tasks in one workbench**: CMDB bastion launches, named bastion targets, password SSH, and private-key SSH are available in one place; multiple Shells can be viewed side by side.
- **Human-in-the-loop by default**: every AI plan requires one explicit group confirmation, and no command is sent before that confirmation.
- **Explicit guardrails before risky actions**: first-run regex rules cover process termination, interactive editors, file removal, service state changes, power actions, and disk partitioning or formatting.
- **Local credential protection and execution boundaries**: model keys are stored through Windows-protected storage and never returned to the renderer; SSH credentials, temporary bridge passwords, Shell-history protections, regex fences, and group-plan confirmation remain locally enforced.
- **Built for ongoing operations**: task workspaces, Shell history, connection layout, and consented local host memory can be restored locally for handoffs and follow-up work.

## Quick Start

### 1. Install Terminal-Agent

After completing Windows packaging with `npm run make:win` or publishing `v2.0.1`, use the generated `Terminal-Agent-Setup-2.0.1.exe` installer; it is also available from [Releases](https://github.com/AI-DIY/Terminal-Agent/releases) after publication. Start Terminal-Agent once after installation.

Inside the workbench, choose **New SSH connection** and select one of these entry points:

- **Bastion CMDB launch**: choose a target from the configured system and host directory.
- **Bastion host launch**: specify a bastion target directly.
- **Host username + password**: connect to a standard SSH host and optionally save connection metadata.
- **Host private key**: select a private-key file for a standard SSH connection.

### 2. Connect Assess/Access Client or a Bastion PuTTY Invocation

The `putty.exe` in the Release is a standalone bridge, not a complete PuTTY client. Copy or map **only this file** to the executable location configured by Assess/Access Client.

```text
Assess/Access Client / Bastion Host
              |
              v
      release putty.exe bridge
              |
              v
installed Terminal-Agent-runtime.exe
              |
              v
 same Terminal-Agent SSH workbench
```

The bridge forwards AccessClient-compatible arguments, including temporary `-load` profiles, temporary `-pw` passwords, and `-raw` mode, then opens the session in the current workbench. Do not copy `Terminal-Agent-runtime.exe`, `resources`, or other Electron files to the mapping directory.

Each bridge launch appends a `putty-bridge.log` file beside `putty.exe`. It contains the runtime lookup, safe argument shape, and connection result needed for troubleshooting, but never logs passwords, tokens, private-key material, passphrases, or temporary profile paths.

### 3. Configure an AI Model

1. Open **Settings** from the workbench header.
2. Under **LLM profiles**, create an available Ollama, OpenAI-compatible, or llama.cpp profile.
3. Enter the API key directly in the model connection form, select **Test connection**, then save and activate the profile.
4. Existing image messages remain readable; new messages in this version use text input only and do not expose an image-upload control.

Model keys are sent to the main process only while testing or saving, then stored through Windows-protected storage. The UI shows configuration state but never backfills a saved key. File-based key input and LLM-to-VLM key sharing have been removed; an existing VLM key reference is migrated to a protected key owned by that profile.

### 4. Manage Tasks and Diagnostic Windows

- A new task starts as `新建任务 YYYY-MM-DD HH:mm:ss`; its first persisted user message or first persisted Shell association changes it to `任务 YYYY-MM-DD HH:mm:ss`. Use the task-row menu to rename, pin/unpin, or remove it. A custom title is never overwritten by later activity.
- A short task-history list does not show an unnecessary scrollbar when its task menu opens or when a task is renamed or removed; a long history remains normally scrollable.
- When all SSH sessions in a task are closed, the Shell history-replay title and its host/record summary are vertically centered in the toolbar. LLM and VLM connection row content remains genuinely left aligned.
- Access Client temporary profiles decode Chinese session titles according to `LineCodePage`, including `CP936`, GBK, GB2312, and GB18030, avoiding garbled display text.
- `DevTools` opens detached renderer-process Chrome DevTools. `Node Inspector` opens a separate Electron debugging window already attached to the current application's Node.js main process. Both can be focused again and reopened after closing, without external Chrome, `chrome://inspect`, or a copied WebSocket address.
- Version-1 task data is not migrated automatically. When the application reports `任务数据版本不兼容，请清空旧任务数据后重试。`, clear the old task data before continuing.

### 5. Use Task-Oriented AI Plan Approval for Shell Work

Describe the goal for the current work task and associated Shells. For example:

```text
Check the nginx service status, identify any anomaly, and propose the lowest-risk next action.
```

Use this operating rhythm:

1. Ask AI to explain its analysis and evidence-gathering steps first.
2. Inspect the command candidate and verify the host, session, arguments, and expected impact.
3. In the plan card, verify hostname targets, step order, original commands, and any edited final commands, then choose **Confirm and execute N steps**. Every plan requires one group confirmation.
4. Observe the result in the Shell; an execution audit is appended to the task, and executed plans do not expose a re-run action.

AI plans never run automatically. When the same hostname has multiple connections, execution binds to the earliest still-online task-associated connection; visible labels use the hostname and stable ordinals.

### 6. Configure and Use Safety Fences

Open **Settings -> Safety fences** to view, enable, disable, test, and save rules. The first-run defaults include:

- `kill`, `killall`, `pkill`
- `vi`, `vim`, `nvim`
- `rm`
- `systemctl stop`, `restart`, `reload`, `disable`, `mask`
- `shutdown`, `reboot`, `poweroff`, `halt`
- `mkfs`, `fdisk`, `parted`

An unapproved command matching a fence is not sent to the SSH Shell. Review the complete plan first, then grant one group confirmation. The confirmation does not extend to another host, session, or command. This version exposes no autonomous-driving or re-run path.

## Enterprise Boundaries and Safety Notes

- Terminal-Agent connects through existing bastion or SSH identities. It does not replace IAM, bastion authorization, operations audit, or change management.
- Safety fences are local pre-execution controls, not a complete command authorization system. Maintain rules, permissions, and approval processes according to organizational policy.
- Temporary bastion sessions are not written to **Saved sessions**. Temporary profiles and temporary passwords are not written to the session book.
- Local host memory uses explicit consent and configurable collection scopes. It can be reviewed, edited, or cleared in Settings; do not use it as a secret storage system.
- **Model trust boundary**: task messages, authorized host facts, and manually approved command-audit context, as well as model responses, are passed through the model chain unchanged. The application no longer automatically redacts those contents. Configure only a trusted local model, enterprise intranet model, or organization-controlled model service; the application does not additionally block public models.
- This pass-through policy does not remove local protections: model API keys and SSH credentials keep their existing protection, temporary bridge passwords remain non-persistent, and Shell-history protections, host-memory authorization, execution fences, and exact one-time command confirmation remain in effect.
- Before any automated action, verify the target environment, change window, backup or rollback plan, and required approvals.

## Release Assets

A Windows package made with `npm run make:win` or a published `v2.0.1` Release will generate:

| File | Purpose |
| --- | --- |
| `Terminal-Agent-Setup-2.0.1.exe` | Windows x64 installer. |
| `putty.exe` | Single-file bridge for Assess/Access Client or bastion mapping. |
| `Terminal-Agent-Uninstall-Cleanup-2.0.1.zip` | Cleans stale Terminal-Agent entries from Windows installed apps. It does not uninstall the application or remove application files or user data. |
| `latest.yml` and `.blockmap` | Update metadata for deployments that use auto-update. |

After the cleanup tool has been generated, extract the ZIP and run `清理 Terminal-Agent 卸载残留.cmd` as an administrator. It lists matching entries, requires an explicit `Y`, and exports `.reg` backups before deletion.

## Local Development and Packaging

```powershell
npm install
npm test
npm run build
npm run make:win
```

`npm run make:win` creates the installer, unpacked Windows directory, single-file `putty.exe` bridge, and uninstall-entry cleanup ZIP. See [RELEASE_NOTES.md](RELEASE_NOTES.md) for the complete release notes.
