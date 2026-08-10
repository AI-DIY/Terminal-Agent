# Bastion Bridge Diagnostics Design

## Goal

Make every Assess Client / bastion launch through the mapped `putty.exe` diagnosable without changing the one-file mapping workflow. A successful temporary bastion launch still opens a terminal in the existing Terminal-Agent workspace and never becomes a saved session.

## User workflow

1. Install Terminal-Agent once.
2. Map only the released `putty.exe` in Assess Client.
3. Open a bastion connection as usual.
4. If it fails, read `putty-bridge.log` beside that mapped `putty.exe`; the in-app warning names the same log file.

No Electron runtime files, resources, or DLLs are copied into the Assess Client mapping folder.

## Architecture

The native bridge creates a unique launch identifier and appends its own start, runtime-location, argument-classification, and process-start result to `putty-bridge.log`. It passes the log path and launch identifier to the started Terminal-Agent runtime through private child-process environment variables.

The runtime appends the matching argument parsing, temporary-profile validation, transport-opening, session-opened, or failure event to the same file. This creates one trace from the external `putty.exe` invocation through the SSH or Raw connection attempt.

The log location is the bridge executable directory. If that directory is not writable, the bridge uses `%LOCALAPPDATA%\\Terminal-Agent\\putty-bridge.log` and records that fallback when possible.

## Accepted launch forms

The initial compatible bastion forms remain the forms implemented by PuTTY-Assistant and verified by the current release integration test:

```text
putty.exe -load "tmp:C:\\path\\to\\session.conf" [-pw "password"]
putty.exe -raw -P <local-port>
```

Saved-session forms (`@name` and `-load name`) stay distinct. A `tmp:` profile is always transient and never writes to the direct-session or saved-session stores. Any other incoming shape is logged as unsupported with its option names, then fails safely instead of being guessed as a different connection.

## Diagnostics and privacy

Each bridge entry includes timestamp, launch ID, bridge path, working directory, registry lookup result, selected runtime, sanitized argument list, temporary-profile path/existence where applicable, process PID or Win32 error code, and fallback log location when used.

Each runtime entry includes timestamp, the same launch ID, invocation kind, profile-read/validation result, selected protocol, connection phase, session identifier on success, and a sanitized failure category on error. The UI presents the matching safe category and diagnostic-log path.

The following values never appear in the log or UI: values after `-pw`, values after password/token/key/passphrase options, API keys, bearer tokens, private-key contents, private-key passphrases, or the full temporary profile content. Diagnostics may include option names, profile path, profile file existence, protocol, port, and error category.

## Error categories

- `runtime-not-found`: registry and co-located runtime lookup failed.
- `bridge-process-start-failed`: `CreateProcessW` failed; the Win32 code is recorded.
- `unsupported-launch-arguments`: incoming command form is not in the supported allowlist.
- `temporary-profile-unreadable`: the `tmp:` file cannot be opened.
- `temporary-profile-invalid`: required temporary profile values are absent or invalid.
- `transport-connect-failed`: SSH or Raw transport failed before a terminal session opened.
- `terminal-open-failed`: transport connected but the SSH terminal could not be opened.

## Testing

Tests must prove that the bridge log is emitted beside a copied `putty.exe`, contains runtime lookup and process-start evidence, and does not contain the test password. Runtime tests must prove that a temporary-profile read failure and a connection failure produce the matching safe category and that temporary bastion launches remain unsaved. The Windows release integration test must still establish a real local SSH shell through a copied bridge and verify one correlated log trace.

## Release

After the implementation and verification pass, publish this as patch release `v1.0.1`. Update the application version and release notes, build the Windows installer and portable artifacts, push `main` to the configured `origin`, and create the corresponding GitHub Release with the verified artifacts and their checksums.
