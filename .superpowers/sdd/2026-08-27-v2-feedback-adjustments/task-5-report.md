# Task 5 report: versioned release evidence and Windows installer

Date: 2026-08-27
Status: verified.

## Changed files

- `package.json`: application/package version set to `2.0.0`; existing NSIS template resolves to `Terminal-Agent-Setup-2.0.0.exe`.
- `package-lock.json`: only the root `version` and `packages[""].version` changes are part of Task 5. Existing dependency metadata changes remain unstaged.
- `README.md` and `README-en.md`: v2 installer/cleanup filenames and approved behavior references.
- `RELEASE_NOTES.md`: v2 release notes covering text-only new AI input, structured/group plan approval, no autonomous or re-run path, hostname-stable labels/task binding, terminal clipboard context menu, and locale-independent AccessClient title decoding.
- `docs/Terminal-Agent-2.0.0-发布说明.md`: versioned Chinese installation and behavior notes.
- `tests/unit/windows/app-branding.test.ts`: package version, lockfile root version, and exact installer artifact-name assertions.
- `.superpowers/sdd/2026-08-27-v2-feedback-adjustments/task-5-report.md`: this verification report.

The user-owned `docs/superpowers/plans/2026-08-27-v2-feedback-adjustments.md` and `tmp/` remain untracked and are not included. Generated `release/` outputs are not committed.

## Commands and results

1. Initial release inspection:

   `Get-ChildItem -Force .\release | Select-Object Mode,Length,LastWriteTime,Name`

   Result: command exited `0`; `release/` existed and was empty.

2. Focused release and branding tests:

   `npx vitest run tests/unit/windows/app-branding.test.ts tests/unit/windows/finalize-windows-release-artifacts.test.ts`

   Result: `2` test files passed, `12` tests passed, exit `0`.

3. Production build:

   `npm run build`

   Result: `electron-vite build` and `vue-tsc --noEmit` completed successfully, exit `0`.

4. First Windows packaging attempt:

   `npm run make:win`

   Result: failed at `npm run build:launcher`; PowerShell reported:

   `The term 'x86_64-w64-mingw32-g++.exe' is not recognized as the name of a cmdlet, function, script file, or operable program.`

   Root cause investigation found the installed compiler at `C:\msys64\mingw64\bin\x86_64-w64-mingw32-g++.exe`, while that directory was absent from the process `PATH`.

5. Windows packaging rerun with the installed toolchain directory added to this command environment:

   `$env:Path = 'C:\msys64\mingw64\bin;' + $env:Path; x86_64-w64-mingw32-g++.exe --version; npm run make:win`

   Result: compiler reported MSYS2 GCC `16.1.0`; Electron Builder completed the x64 unpacked and NSIS builds, blockmap generation, cleanup ZIP generation, release finalization, and artifact guard; exit `0`.

6. Focused release, branding, and artifact-guard tests after packaging:

   `npx vitest run tests/unit/windows/app-branding.test.ts tests/unit/windows/finalize-windows-release-artifacts.test.ts tests/unit/release-integration-artifacts.test.ts`

   Result: `3` test files passed, `19` tests passed, exit `0`.

7. Packaged runtime artifact guard:

   `node scripts/release-integration-artifacts.cjs`

   Result: `artifact-validator: PASS (exit 0)`.

8. Artifact validation:

   A PowerShell validation command checked all required files for existence and non-zero size, checked `latest.yml` version/URL/SHA-512/size against the installer, checked all cleanup ZIP entries, and compared root/unpacked bridge hashes.

   Result:

   - `Terminal-Agent-Setup-2.0.0.exe`: `117465285` bytes.
   - `Terminal-Agent-Setup-2.0.0.exe.blockmap`: `123241` bytes.
   - `latest.yml`: `355` bytes; version `2.0.0`; installer SHA-512 `XltY/COlmwh9W1yENPrvgNVNOugeevosVBY8vM6mh+u+v8bSm5B91bGiFhUphXjpmkP/eNTae+JmROiXGd9GYA==`; size `117465285`.
   - `putty.exe`: `279040` bytes.
   - `Terminal-Agent-Uninstall-Cleanup-2.0.0.zip`: `5307` bytes; `3` expected entries present.
   - `win-unpacked\Terminal-Agent-runtime.exe`: `225442304` bytes.
   - `win-unpacked\putty.exe`: `279040` bytes.
   - `win-unpacked\resources\app.asar`: `93926763` bytes.
   - Root and unpacked `putty.exe` SHA-256: `5EA31840BA3AB45D51F8E06DDFF5151A2B1CFA9253D5A834F90C0B7ED6946FD3`.

## Artifact paths

- `C:\project\github\Terminal-Agent\release\Terminal-Agent-Setup-2.0.0.exe`
- `C:\project\github\Terminal-Agent\release\Terminal-Agent-Setup-2.0.0.exe.blockmap`
- `C:\project\github\Terminal-Agent\release\latest.yml`
- `C:\project\github\Terminal-Agent\release\putty.exe`
- `C:\project\github\Terminal-Agent\release\Terminal-Agent-Uninstall-Cleanup-2.0.0.zip`
- `C:\project\github\Terminal-Agent\release\win-unpacked\Terminal-Agent-runtime.exe`
- `C:\project\github\Terminal-Agent\release\win-unpacked\putty.exe`
- `C:\project\github\Terminal-Agent\release\win-unpacked\resources\app.asar`

## Concerns

- The compiler is installed but is not on the default command `PATH`; the successful packaging command prepended `C:\msys64\mingw64\bin` for that process only.
- Electron Builder reported a missing `description` field and duplicate dependency references while packaging. Neither caused a failure and neither was changed by Task 5.
- Generated `release/` outputs are intentionally left untracked according to the task brief.

## Commit

Task 5 commit id: `426bd6f` (`release: prepare Terminal-Agent 2.0.0`).
