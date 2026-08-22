# Terminal-Agent

[中文文档](README.md)

Terminal-Agent is a Windows SSH workbench for daily operations and enterprise bastion-host workflows. It preserves the familiar SSH Shell experience while placing AI in a reviewable task flow: AI understands the task, produces analysis and a command candidate, and an operator reviews it before the exact command reaches the target Shell.

## What It Solves

Traditional terminals connect to hosts well, but they do not put the bastion entry point, multiple Shells, task context, AI guidance, and human change review in one operating surface. Terminal-Agent connects those steps into a controlled flow:

1. An enterprise Assess/Access Client or bastion host invokes the single-file `putty.exe` bridge.
2. The bridge starts the installed Terminal-Agent and hands temporary SSH/Raw bastion connections to the same workbench.
3. An operator asks AI to analyze, troubleshoot, or plan the next step for the associated Shells as a work task.
4. In the default Copilot mode, AI only presents a command candidate; an operator reviews and confirms it before the command is sent.
5. Default safety fences intercept unconfirmed high-risk or interactive commands; the rules can be inspected, tested, and maintained in Settings.

This is not a way for AI to bypass established operations controls. It is a controlled Shell collaboration assistant.

## Key Advantages

- **Compatible with existing bastion entry points**: map only the release `putty.exe` to Assess/Access Client. No Electron runtime directory needs to be copied into the mapping location.
- **Connections and tasks in one workbench**: CMDB bastion launches, named bastion targets, password SSH, and private-key SSH are available in one place; multiple Shells can be viewed side by side.
- **Human-in-the-loop by default**: in Copilot mode, AI provides analysis, evidence steps, and a command candidate. The command is not sent until an operator confirms it.
- **Explicit guardrails before risky actions**: first-run regex rules cover process termination, interactive editors, file removal, service state changes, power actions, and disk partitioning or formatting.
- **Minimal sensitive-data exposure**: AI input/output, bridge diagnostics, and approved-command display are redacted for sensitive content. Model keys are stored through Windows-protected storage and are never returned to the renderer.
- **Built for ongoing operations**: chat workspaces, Shell history, connection layout, and consented local host memory can be restored locally for handoffs and follow-up work.

## Quick Start

### 1. Install Terminal-Agent

Download and run `Terminal-Agent-Setup-1.0.6.exe` from [Releases](https://github.com/AI-DIY/Terminal-Agent/releases). Start Terminal-Agent once after installation.

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
3. Import the API key, select **Test connection**, then activate the profile.
4. For image-based work, configure a VLM profile and the routing mode under **Model selection**.

Model keys are written only by the main process to Windows-protected storage. The UI shows configuration state but never reveals the key.

### 4. Use Task-Oriented AI Copilot for Shell Work

Describe the goal for the current work task and associated Shells. For example:

```text
Check the nginx service status, identify any anomaly, and propose the lowest-risk next action.
```

Use this operating rhythm:

1. Ask AI to explain its analysis and evidence-gathering steps first.
2. Inspect the command candidate and verify the host, session, arguments, and expected impact.
3. In **Copilot** mode, choose **Confirm and execute**. The confirmation marker is bound to the current session and exact command, expires after five minutes, and is single-use.
4. Observe the result in the Shell, then continue the task or ask AI to adapt its recommendation.

Copilot is the default mode. An AI-generated command is never automatically executed in this mode.

### 5. Configure and Use Safety Fences

Open **Settings -> Safety fences** to view, enable, disable, test, and save rules. The first-run defaults include:

- `kill`, `killall`, `pkill`
- `vi`, `vim`, `nvim`
- `rm`
- `systemctl stop`, `restart`, `reload`, `disable`, `mask`
- `shutdown`, `reboot`, `poweroff`, `halt`
- `mkfs`, `fdisk`, `parted`

An unapproved command matching a fence is not sent to the SSH Shell. Review the candidate first, then grant a one-time confirmation for that specific candidate. The confirmation does not extend to another host, session, or command.

### 6. Use Autonomous Mode Only for Explicitly Authorized Low-Risk Sessions

When automation is genuinely required, select **Upgrade autonomous mode** in the **AI workspace** and confirm again in the dialog. The authorization applies only to that session.

Autonomous mode skips per-candidate human review. It is not appropriate for unvalidated production changes and must not replace change tickets, bastion authorization, two-person review, or rollback planning. Keep production work in the default Copilot mode.

## Enterprise Boundaries and Safety Notes

- Terminal-Agent connects through existing bastion or SSH identities. It does not replace IAM, bastion authorization, operations audit, or change management.
- Safety fences are local pre-execution controls, not a complete command authorization system. Maintain rules, permissions, and approval processes according to organizational policy.
- Temporary bastion sessions are not written to **Saved sessions**. Temporary profiles and temporary passwords are not written to the session book.
- Local host memory uses explicit consent and configurable collection scopes. It can be reviewed, edited, or cleared in Settings; do not use it as a secret storage system.
- Before any automated action, verify the target environment, change window, backup or rollback plan, and required approvals.

## Release Assets

The `v1.0.6` Release contains:

| File | Purpose |
| --- | --- |
| `Terminal-Agent-Setup-1.0.6.exe` | Windows x64 installer. |
| `putty.exe` | Single-file bridge for Assess/Access Client or bastion mapping. |
| `Terminal-Agent-Uninstall-Cleanup-1.0.6.zip` | Cleans stale Terminal-Agent entries from Windows installed apps. It does not uninstall the application or remove application files or user data. |
| `latest.yml` and `.blockmap` | Update metadata for deployments that use auto-update. |

To use the cleanup tool, extract the ZIP and run `清理 Terminal-Agent 卸载残留.cmd` as an administrator. It lists matching entries, requires an explicit `Y`, and exports `.reg` backups before deletion.

## Local Development and Packaging

```powershell
npm install
npm test
npm run build
npm run make:win
```

`npm run make:win` creates the installer, unpacked Windows directory, single-file `putty.exe` bridge, and uninstall-entry cleanup ZIP. See [RELEASE_NOTES.md](RELEASE_NOTES.md) for the complete release notes.
