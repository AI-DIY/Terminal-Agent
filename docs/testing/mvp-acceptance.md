# Terminal-Agent MVP Acceptance

Build the release directory with `npm run make:win:unpacked`. Start the installed Terminal-Agent normally once, or install it with the generated NSIS installer, before testing a copied bridge. The normal installed executable is `Terminal-Agent-runtime.exe`; the only file that belongs in an Assess/Access Client mapping directory is `putty.exe`.

## Reliable SSH workbench

1. Open one username/password SSH session and one username/private-key SSH session. Confirm both appear as tabs and panes in the same workbench.
2. Open up to nine direct sessions and select them in turn. Confirm all selected terminals share the one workbench page and fill the existing nine-grid view; no additional application window or connection page is created.
3. With an active SSH session, a partially filled direct-connection form, and selected grid panes, choose **Settings**, then **Back to workbench**. Confirm the original terminal remains connected, the form input and the selected grid panes remain present, and a command can be sent without reconnecting.
4. Directly connect to an address such as `10.0.0.2`. Once the connection becomes ready, confirm its top tab changes to the remote `hostname` value. For an Access Client Raw/bastion profile, confirm the tab instead displays the profile's target title, never the local forwarding address such as `127.0.0.1`.

## Saved direct sessions and temporary bastion jumps

1. Create a password-authenticated direct SSH session, enable **Save to session book**, give it a name, and connect. Open **Saved sessions**, close the terminal, then reopen it from that list. Confirm it returns to the same workbench/grid and does not request the saved password again.
2. Repeat with a private-key session. Confirm the session book lists its name, host, user, port, and authentication type, while the saved JSON contains only metadata and a private-key path—not private-key bytes or a passphrase.
3. Delete either saved session and confirm it disappears from the list and can no longer be reopened.
4. Start an Access Client/bastion connection with `putty.exe -load tmp:<utf8-session-file> -pw <temporary-password>` (or its `-raw` equivalent). Confirm its terminal opens in the very same workbench/grid, but it never appears in **Saved sessions**. Confirm that neither the temporary profile nor temporary password is written to the session book.

## Assess/Access Client single-file bridge

1. Copy only `release/win-unpacked/putty.exe` to a clean temporary mapping directory. Do not copy `Terminal-Agent-runtime.exe`, `resources`, or any Electron files.
2. Map Assess/Access Client to that copied `putty.exe` and open a temporary SSH or Raw/bastion profile. Confirm the installed Terminal-Agent runtime starts, forwards `-load`, `-pw`, and `-raw` arguments, and opens the connection in the existing workbench/grid.
3. If the app is not installed and the bridge is not beside an unpacked runtime, confirm `putty.exe` shows the actionable message that Terminal-Agent must be installed or started once. It must not silently exit.
4. Run `npm run test:integration -- tests/integration/release-launcher.test.ts` after creating the release directory. The test copies only `putty.exe`, temporarily registers the installed release directory, exercises password authentication and a shell, then restores the original registry value.

## Standard Chat Completions diagnostics

1. In **Settings → Model connection**, enter an OpenAI-compatible Chat Completions endpoint, model, and API key, then choose **Test connection** before saving. Confirm a successful standard, non-streaming request reports `连接成功：<model>`.
2. Enter an invalid key and test again. Confirm the error includes the HTTP status (for example, `HTTP 401`) and a safe response summary, without showing the API key.
3. Use an unreachable endpoint or a TLS/certificate failure. Confirm the error identifies a network/TLS problem and recommends checking the endpoint, proxy, and certificate; it must not collapse all failures into a generic unavailable message.
4. Save valid settings, restart the application, and confirm endpoint/model/context restore while the API key remains masked. Run an AI analysis against a compatible service that does not support `response_format: json_schema`; it should still make the standard request and locally validate the returned JSON.

## Existing safety checks

1. In Copilot, confirm a displayed `kill -9 <pid>` candidate and verify the exact candidate is sent once.
2. Submit the same unconfirmed candidate and verify its configured regex rule intercepts it before SSH receives data.
3. Explicitly upgrade a test session to autonomous mode and verify the visible mode state changes before an AI command is sent.
