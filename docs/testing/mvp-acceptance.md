# Terminal-Agent MVP Acceptance

Run the packaged application from `release/win-unpacked/Terminal-Agent.exe`.

1. Open separate username/password and private-key SSH sessions and verify separate terminal tabs.
2. Launch `Terminal-Agent.exe @saved-name` and `Terminal-Agent.exe -load saved-name` using a saved compatible profile.
3. Launch `Terminal-Agent.exe -load tmp:<utf8-session-file> -pw <test-password>` and verify the title and PTY size from the session file.
4. Launch `Terminal-Agent.exe -raw -P <local-test-port>` and verify there is no fourth renderer connection form.
5. Reconnect through a different route address and verify structured facts continue under the remote hostname rather than an IP address.
6. In Copilot, confirm a displayed `kill -9 <pid>` candidate and verify the exact candidate is sent once.
7. Submit the same unconfirmed candidate and verify its configured regex rule intercepts it before SSH receives data.
8. Explicitly upgrade a test session to autonomous mode and verify the visible mode state changes before an AI command is sent.
9. Save OpenAI Chat Completions settings, restart the app, and verify endpoint/model/context restore while the API key is never rendered as plaintext.

The application launcher is intentionally separate from the Electron runtime. It inserts the `--` delimiter before forwarding AccessClient arguments so Electron does not reject `tmp:... -pw ...` before the main process starts.
