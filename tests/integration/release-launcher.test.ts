import { spawn, type ChildProcess, execFile } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { once } from 'node:events'
import { access, copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from 'vitest'
import { Server, type Connection } from 'ssh2'
import { runReleaseLauncherCleanup } from '../helpers/release-launcher-cleanup'
import {
  ownsRuntimeProcess,
  runtimeProcessIdentityKey,
  terminateOwnedRuntimeProcess,
  type RuntimeProcessIdentity,
} from '../helpers/release-runtime-processes'

const execFileAsync = promisify(execFile)
const releaseDirectory = join(process.cwd(), 'release', 'win-unpacked')
const packagedBridgePath = join(releaseDirectory, 'putty.exe')

test.skipIf(process.platform !== 'win32')('a copied putty bridge forwards a temporary SSH AccessClient profile through the installed runtime', async () => {
  await access(packagedBridgePath)

  const fixture = await startSshFixture()
  const mappingDirectory = await mkdtemp(join(tmpdir(), 'terminal-agent-assess-mapping-'))
  const profileDirectory = await mkdtemp(join(tmpdir(), 'terminal-agent-release-profile-'))
  const stateDirectory = await mkdtemp(join(tmpdir(), 'terminal-agent-release-state-'))
  const profilePath = join(profileDirectory, '发布验证会话.conf')
  const copiedBridgePath = join(mappingDirectory, 'putty.exe')
  const bridgeLogPath = join(mappingDirectory, 'putty-bridge.log')
  const password = 'release-fixture-password'
  let previousInstallPath: InstallPathRegistration | undefined
  let launcher: ChildProcess | undefined
  let runtimeProcess: RuntimeProcessIdentity | undefined
  let primaryFailure: unknown
  let launchAttempted = false
  let preexistingRuntimeProcessIdentities = new Set<string>()

  try {
    previousInstallPath = await readInstallPathRegistration()
    await copyFile(packagedBridgePath, copiedBridgePath)
    await writeInstallPathRegistration(releaseDirectory)
    await writeFile(profilePath, [
      'HostName=127.0.0.1',
      `PortNumber=${fixture.port}`,
      'UserName=release-fixture-user',
      'Protocol=ssh',
      'WinTitle=发布验证终端',
      'TermWidth=132',
      'TermHeight=43',
    ].join('\n'), 'utf8')

    preexistingRuntimeProcessIdentities = new Set((await findRuntimeProcessIdentities()).map(runtimeProcessIdentityKey))
    launchAttempted = true
    launcher = spawn(copiedBridgePath, ['-load', `tmp:${profilePath}`, '-pw', password], {
      env: {
        ...process.env,
        APPDATA: stateDirectory,
        LOCALAPPDATA: stateDirectory,
      },
      stdio: 'ignore',
      windowsHide: true,
    })

    const [observedShell] = await Promise.all([
      fixture.waitForShell(),
      once(launcher, 'exit'),
    ])
    runtimeProcess = await findNewRuntimeProcessIdentity(preexistingRuntimeProcessIdentities)

    expect(observedShell).toEqual({
      username: 'release-fixture-user',
      pty: { columns: 132, rows: 43 },
    })
    await waitForCondition('the correlated bridge diagnostic trace', async () => {
      const trace = await readFile(bridgeLogPath, 'utf8').catch(() => '')
      return trace.includes('"source":"bridge"')
        && trace.includes('"event":"process-started"')
        && trace.includes('"source":"runtime"')
        && trace.includes('"event":"session-opened"')
    })
    const trace = await readFile(bridgeLogPath, 'utf8')
    expect(trace).toContain('"runtime":"')
    expect(trace).not.toContain(password)
    expect(trace).not.toContain(profilePath)
  } catch (error) {
    primaryFailure = error
    throw error
  } finally {
    let processToStop = runtimeProcess
    await runReleaseLauncherCleanup(primaryFailure, [
      async () => {
        if (launchAttempted) processToStop ??= await findNewRuntimeProcessIdentity(preexistingRuntimeProcessIdentities)
      },
      async () => {
        if (processToStop !== undefined) await terminateProcessTree(processToStop)
      },
      () => { if (launcher?.exitCode === null) launcher.kill() },
      () => fixture.close(),
      async () => { if (previousInstallPath !== undefined) await restoreInstallPathRegistration(previousInstallPath) },
      async () => {
        expect(await findFilesContaining(stateDirectory, [password, profilePath])).toEqual([])
      },
      async () => {
        await Promise.all([
          rm(mappingDirectory, { recursive: true, force: true }),
          rm(profileDirectory, { recursive: true, force: true }),
          rm(stateDirectory, { recursive: true, force: true }),
        ])
      },
    ])
  }
})

test.skipIf(process.platform !== 'win32')('a warm putty bridge launch preserves metadata when Terminal-Agent is already running', async () => {
  await access(packagedBridgePath)

  const fixture = await startSshFixture()
  const mappingDirectory = await mkdtemp(join(tmpdir(), 'terminal-agent-warm-launch-mapping-'))
  const profileDirectory = await mkdtemp(join(tmpdir(), 'terminal-agent-warm-launch-profile-'))
  const stateDirectory = await mkdtemp(join(tmpdir(), 'terminal-agent-warm-launch-state-'))
  const profilePath = join(profileDirectory, '暖启动验证会话.conf')
  const copiedBridgePath = join(mappingDirectory, 'putty.exe')
  const copiedRuntimePath = join(mappingDirectory, 'Terminal-Agent-runtime.exe')
  const bridgeLogPath = join(mappingDirectory, 'putty-bridge.log')
  const testEnvironment = { ...process.env, APPDATA: stateDirectory, LOCALAPPDATA: stateDirectory }
  let previousInstallPath: InstallPathRegistration | undefined
  let launcher: ChildProcess | undefined
  let primaryRuntime: ChildProcess | undefined
  let primaryRuntimeProcess: RuntimeProcessIdentity | undefined
  let primaryFailure: unknown
  let preexistingRuntimeProcessIdentities = new Set<string>()
  let preexistingBridgeRuntimeProcessIdentities = new Set<string>()

  try {
    previousInstallPath = await readInstallPathRegistration()
    await cp(releaseDirectory, mappingDirectory, { recursive: true })
    await writeInstallPathRegistration(mappingDirectory)
    await writeFile(profilePath, [
      'HostName=127.0.0.1',
      `PortNumber=${fixture.port}`,
      'UserName=release-fixture-user',
      'Protocol=ssh',
      'WinTitle=暖启动验证终端',
      'TermWidth=132',
      'TermHeight=43',
    ].join('\n'), 'utf8')

    const runningPrimaryProcessIds = await findAnyRuntimeProcessIds()
    if (runningPrimaryProcessIds.length === 0) {
      preexistingRuntimeProcessIdentities = new Set((await findRuntimeProcessIdentities(copiedRuntimePath)).map(runtimeProcessIdentityKey))
      primaryRuntime = spawn(copiedRuntimePath, [], {
        cwd: mappingDirectory,
        env: testEnvironment,
        stdio: 'ignore',
        windowsHide: true,
      })
      primaryRuntimeProcess = await waitForCondition(
        'the primary runtime process started for the warm-launch test',
        () => findNewRuntimeProcessIdentity(preexistingRuntimeProcessIdentities, copiedRuntimePath),
      )
      await waitForCondition(
        'the primary runtime renderer started for the warm-launch test',
        () => {
          if (primaryRuntime?.exitCode !== null) {
            throw new Error(`Primary warm-launch runtime exited before its renderer started (exit ${primaryRuntime?.exitCode ?? 'unknown'})`)
          }
          return hasRendererProcess(primaryRuntimeProcess?.processId ?? 0, copiedRuntimePath)
        },
      )
    }

    preexistingBridgeRuntimeProcessIdentities = new Set((await findAllRuntimeProcessIdentities(copiedRuntimePath)).map(runtimeProcessIdentityKey))
    launcher = spawn(copiedBridgePath, ['-load', `tmp:${profilePath}`, '-pw', 'release-fixture-password'], {
      cwd: mappingDirectory,
      env: testEnvironment,
      stdio: 'ignore',
      windowsHide: true,
    })
    await Promise.all([fixture.waitForShell(), once(launcher, 'exit')])

    const trace = await waitForCondition('the warm-launch runtime trace', async () => {
      const value = await readFile(bridgeLogPath, 'utf8').catch(() => '')
      return value.includes('"event":"process-started"')
        && value.includes('"event":"invocation-parsed"')
        && value.includes('"event":"session-opened"')
        ? value : false
    })
    const records = trace.trim().split(/\r?\n/).map(line => JSON.parse(line) as { launchId?: string; source?: string; event?: string })
    const bridgeStart = records.find(record => record.source === 'bridge' && record.event === 'process-started')
    const runtimeSession = records.find(record => record.source === 'runtime' && record.event === 'session-opened')
    expect(bridgeStart).toBeDefined()
    expect(runtimeSession).toBeDefined()
    expect(bridgeStart?.launchId).toEqual(expect.any(String))
    expect(bridgeStart?.launchId?.length).toBeGreaterThan(0)
    expect(runtimeSession?.launchId).toBe(bridgeStart?.launchId)
    if (primaryRuntime) {
      expect(await findFilesNamed(mappingDirectory, '--terminal-agent-bridge-id')).toEqual([])
    }
    expect(trace).not.toContain('release-fixture-password')
    expect(trace).not.toContain(profilePath)
  } catch (error) {
    primaryFailure = error
    throw error
  } finally {
    let processToStop = primaryRuntimeProcess
    await runReleaseLauncherCleanup(primaryFailure, [
      async () => {
        if (primaryRuntime) processToStop ??= await findNewRuntimeProcessIdentity(preexistingRuntimeProcessIdentities, copiedRuntimePath)
      },
      async () => { if (processToStop !== undefined) await terminateProcessTree(processToStop) },
      () => { if (launcher?.exitCode === null) launcher.kill() },
      () => { if (primaryRuntime?.exitCode === null) primaryRuntime.kill() },
      () => terminateNewRuntimeProcesses(copiedRuntimePath, preexistingBridgeRuntimeProcessIdentities),
      async () => {
        await waitForCondition('the warm-launch secondary runtime process to exit', async () => {
          const processes = await findAllRuntimeProcessIdentities(copiedRuntimePath)
          return processes.every(process => preexistingBridgeRuntimeProcessIdentities.has(runtimeProcessIdentityKey(process)))
        })
      },
      () => fixture.close(),
      async () => { if (previousInstallPath !== undefined) await restoreInstallPathRegistration(previousInstallPath) },
      () => removeDirectoryWhenUnlocked(mappingDirectory),
      async () => { await rm(profileDirectory, { recursive: true, force: true }) },
      async () => { await rm(stateDirectory, { recursive: true, force: true }) },
    ])
  }
})

test.skipIf(process.platform !== 'win32')('a co-located bridge skips a stale registered install path', async () => {
  await access(packagedBridgePath)

  const stateDirectory = await mkdtemp(join(tmpdir(), 'terminal-agent-release-stale-registry-'))
  const bridgeLogPath = join(releaseDirectory, 'putty-bridge.log')
  let previousInstallPath: InstallPathRegistration | undefined
  let launcher: ChildProcess | undefined
  let runtimeProcess: RuntimeProcessIdentity | undefined
  let primaryFailure: unknown
  let launchAttempted = false
  let preexistingRuntimeProcessIdentities = new Set<string>()

  try {
    previousInstallPath = await readInstallPathRegistration()
    await rm(bridgeLogPath, { force: true })
    await writeInstallPathRegistration(join(stateDirectory, 'missing-installation'))
    preexistingRuntimeProcessIdentities = new Set((await findRuntimeProcessIdentities()).map(runtimeProcessIdentityKey))
    launchAttempted = true
    launcher = spawn(packagedBridgePath, ['-raw', '-P', '1'], {
      env: { ...process.env, APPDATA: stateDirectory, LOCALAPPDATA: stateDirectory },
      stdio: 'ignore',
      windowsHide: true,
    })
    await once(launcher, 'exit')
    runtimeProcess = await findNewRuntimeProcessIdentity(preexistingRuntimeProcessIdentities)
    await waitForCondition('the stale-registry bridge trace', async () => {
      const trace = await readFile(bridgeLogPath, 'utf8').catch(() => '')
      return trace.includes('"candidateSource":"registry"')
        && trace.includes('"exists":"false"')
        && trace.includes('"candidateSource":"bridge-directory"')
        && trace.includes('"exists":"true"')
        && trace.includes('"event":"process-started"')
    })
  } catch (error) {
    primaryFailure = error
    throw error
  } finally {
    let processToStop = runtimeProcess
    await runReleaseLauncherCleanup(primaryFailure, [
      async () => {
        if (launchAttempted) processToStop ??= await findNewRuntimeProcessIdentity(preexistingRuntimeProcessIdentities)
      },
      async () => { if (processToStop !== undefined) await terminateProcessTree(processToStop) },
      () => { if (launcher?.exitCode === null) launcher.kill() },
      async () => { if (previousInstallPath !== undefined) await restoreInstallPathRegistration(previousInstallPath) },
      async () => { await rm(stateDirectory, { recursive: true, force: true }) },
      async () => { await rm(bridgeLogPath, { force: true }) },
    ])
  }
})

test.skipIf(process.platform !== 'win32')('a co-located bridge falls back to a local log when its mapped log location cannot be opened', async () => {
  await access(packagedBridgePath)

  const mappingDirectory = await mkdtemp(join(tmpdir(), 'terminal-agent-unwritable-log-mapping-'))
  const stateDirectory = await mkdtemp(join(tmpdir(), 'terminal-agent-unwritable-log-state-'))
  const copiedBridgePath = join(mappingDirectory, 'putty.exe')
  const copiedRuntimePath = join(mappingDirectory, 'Terminal-Agent-runtime.exe')
  const unusablePrimaryLogPath = join(mappingDirectory, 'putty-bridge.log')
  const fallbackLogPath = join(stateDirectory, 'Terminal-Agent', 'putty-bridge.log')
  let previousInstallPath: InstallPathRegistration | undefined
  let launcher: ChildProcess | undefined
  let runtimeProcess: RuntimeProcessIdentity | undefined
  let primaryFailure: unknown
  let launchAttempted = false
  let preexistingRuntimeProcessIdentities = new Set<string>()
  let preexistingAllRuntimeProcessIdentities = new Set<string>()

  try {
    previousInstallPath = await readInstallPathRegistration()
    await cp(releaseDirectory, mappingDirectory, { recursive: true })
    await mkdir(unusablePrimaryLogPath)
    await writeInstallPathRegistration(join(stateDirectory, 'missing-installation'))
    preexistingRuntimeProcessIdentities = new Set((await findRuntimeProcessIdentities(copiedRuntimePath)).map(runtimeProcessIdentityKey))
    preexistingAllRuntimeProcessIdentities = new Set((await findAllRuntimeProcessIdentities(copiedRuntimePath)).map(runtimeProcessIdentityKey))
    launchAttempted = true
    launcher = spawn(copiedBridgePath, ['-raw', '-P', '1'], {
      env: { ...process.env, APPDATA: stateDirectory, LOCALAPPDATA: stateDirectory },
      stdio: 'ignore',
      windowsHide: true,
    })
    await once(launcher, 'exit')
    runtimeProcess = await findNewRuntimeProcessIdentity(preexistingRuntimeProcessIdentities, copiedRuntimePath)
    await waitForCondition('the local fallback bridge diagnostic trace', async () => {
      const trace = await readFile(fallbackLogPath, 'utf8').catch(() => '')
      return trace.includes('"source":"bridge"')
        && trace.includes('"event":"process-started"')
        && trace.includes('"source":"runtime"')
        && trace.includes('"event":"invocation-parsed"')
    })
  } catch (error) {
    primaryFailure = error
    throw error
  } finally {
    let processToStop = runtimeProcess
    await runReleaseLauncherCleanup(primaryFailure, [
      async () => {
        if (launchAttempted) processToStop ??= await findNewRuntimeProcessIdentity(preexistingRuntimeProcessIdentities, copiedRuntimePath)
      },
      async () => { if (processToStop !== undefined) await terminateProcessTree(processToStop) },
      () => { if (launcher?.exitCode === null) launcher.kill() },
      () => terminateNewRuntimeProcesses(copiedRuntimePath, preexistingAllRuntimeProcessIdentities),
      async () => {
        await waitForCondition('the fallback-log secondary runtime processes to exit', async () => {
          const processes = await findAllRuntimeProcessIdentities(copiedRuntimePath)
          return processes.every(process => preexistingAllRuntimeProcessIdentities.has(runtimeProcessIdentityKey(process)))
        })
      },
      async () => { if (previousInstallPath !== undefined) await restoreInstallPathRegistration(previousInstallPath) },
      async () => {
        await Promise.all([
          removeDirectoryWhenUnlocked(mappingDirectory),
          rm(stateDirectory, { recursive: true, force: true }),
        ])
      },
    ])
  }
})

type InstallPathRegistration =
  | { exists: false }
  | { exists: true; kind: 'String'; value: string }

async function readInstallPathRegistration(): Promise<InstallPathRegistration> {
  const script = [
    "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\Terminal-Agent', $false)",
    'if ($null -eq $key) { [Console]::Write(\'{"exists":false}\'); exit 0 }',
    "$value = $key.GetValue('InstallPath', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)",
    "if ($null -eq $value) { $key.Dispose(); [Console]::Write('{\"exists\":false}'); exit 0 }",
    "$kind = $key.GetValueKind('InstallPath')",
    '$key.Dispose()',
    "if ($kind -ne [Microsoft.Win32.RegistryValueKind]::String) { throw 'InstallPath must be a REG_SZ value for this release test.' }",
    '[Console]::Write((@{ exists = $true; kind = \'String\'; value = [string]$value } | ConvertTo-Json -Compress))',
  ].join('; ')
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
  })
  return JSON.parse(stdout) as InstallPathRegistration
}

async function writeInstallPathRegistration(installPath: string): Promise<void> {
  const script = [
    "$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\\Terminal-Agent')",
    "$key.SetValue('InstallPath', $env:TERMINAL_AGENT_RELEASE_INSTALL_PATH, [Microsoft.Win32.RegistryValueKind]::String)",
    '$key.Dispose()',
  ].join('; ')
  await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, TERMINAL_AGENT_RELEASE_INSTALL_PATH: installPath },
    windowsHide: true,
  })
}

async function restoreInstallPathRegistration(previous: InstallPathRegistration): Promise<void> {
  const script = previous.exists
    ? [
        "$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\\Terminal-Agent')",
        "$key.SetValue('InstallPath', $env:TERMINAL_AGENT_RELEASE_INSTALL_PATH, [Microsoft.Win32.RegistryValueKind]::String)",
        '$key.Dispose()',
      ].join('; ')
    : [
        "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\Terminal-Agent', $true)",
        "if ($null -ne $key) { $key.DeleteValue('InstallPath', $false); $key.Dispose() }",
      ].join('; ')
  await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: previous.exists ? { ...process.env, TERMINAL_AGENT_RELEASE_INSTALL_PATH: previous.value } : process.env,
    windowsHide: true,
  })
}

async function startSshFixture(): Promise<{
  port: number
  waitForShell(): Promise<{ username: string; pty: { columns: number; rows: number } }>
  close(): Promise<void>
}> {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2_048 })
  const clients = new Set<Connection>()
  let resolveShell: ((value: { username: string; pty: { columns: number; rows: number } }) => void) | undefined
  let rejectShell: ((reason: Error) => void) | undefined
  const shellOpened = new Promise<{ username: string; pty: { columns: number; rows: number } }>((resolve, reject) => {
    resolveShell = resolve
    rejectShell = reject
  })
  let authenticatedUsername: string | undefined
  let pty: { columns: number; rows: number } | undefined
  let shellWasOpened = false
  const maybeResolveShell = () => {
    if (authenticatedUsername !== undefined && pty !== undefined && shellWasOpened) {
      resolveShell?.({ username: authenticatedUsername, pty })
      resolveShell = undefined
    }
  }
  const server = new Server({ hostKeys: [privateKey.export({ type: 'pkcs1', format: 'pem' })] }, client => {
    clients.add(client)
    client.once('close', () => clients.delete(client))
    client.on('authentication', context => {
      if (context.method === 'password' && context.username === 'release-fixture-user' && context.password === 'release-fixture-password') {
        authenticatedUsername = context.username
        context.accept()
        return
      }
      context.reject()
    }).on('ready', () => {
      client.on('session', accept => {
        const session = accept()
        session.on('pty', (acceptPty, _rejectPty, info) => {
          pty = { columns: info.cols, rows: info.rows }
          acceptPty()
          maybeResolveShell()
        }).on('shell', acceptShell => {
          const stream = acceptShell()
          shellWasOpened = true
          stream.write('release-fixture-ready\r\n')
          maybeResolveShell()
        })
      })
    }).once('error', error => rejectShell?.(error))
  })

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    port: (server.address() as AddressInfo).port,
    waitForShell: () => waitForPromise('password authentication and shell opening', shellOpened),
    close: async () => {
      for (const client of clients) client.end()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    },
  }
}

async function findNewRuntimeProcessIdentity(
  preexistingRuntimeProcesses: ReadonlySet<string>,
  runtimePath = join(releaseDirectory, 'Terminal-Agent-runtime.exe'),
): Promise<RuntimeProcessIdentity | undefined> {
  return (await findRuntimeProcessIdentities(runtimePath))
    .find(process => !preexistingRuntimeProcesses.has(runtimeProcessIdentityKey(process)))
}

async function findRuntimeProcessIdentities(
  runtimePath = join(releaseDirectory, 'Terminal-Agent-runtime.exe'),
): Promise<RuntimeProcessIdentity[]> {
  return queryRuntimeProcessIdentities(runtimePath, false)
}

async function findAllRuntimeProcessIdentities(runtimePath: string): Promise<RuntimeProcessIdentity[]> {
  return queryRuntimeProcessIdentities(runtimePath, true)
}

async function queryRuntimeProcessIdentities(runtimePath: string, includeChildren: boolean): Promise<RuntimeProcessIdentity[]> {
  const command = [
    "$runtime = Get-CimInstance Win32_Process -Filter \"Name = 'Terminal-Agent-runtime.exe'\"",
    includeChildren
      ? '$matches = $runtime | Where-Object { $_.ExecutablePath -eq $env:TERMINAL_AGENT_RELEASE_RUNTIME }'
      : "$matches = $runtime | Where-Object { $_.ExecutablePath -eq $env:TERMINAL_AGENT_RELEASE_RUNTIME -and $_.CommandLine -notmatch ' --type=' }",
    processIdentityOutputScript('$matches'),
  ].join('; ')
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    env: { ...process.env, TERMINAL_AGENT_RELEASE_RUNTIME: runtimePath },
    windowsHide: true,
    timeout: 2_000,
  })
  return parseRuntimeProcessIdentities(stdout)
}

async function findAnyRuntimeProcessIds(): Promise<number[]> {
  const command = [
    "$runtime = Get-CimInstance Win32_Process -Filter \"Name = 'Terminal-Agent-runtime.exe'\"",
    "$matches = $runtime | Where-Object { $_.CommandLine -notmatch ' --type=' }",
    'foreach ($match in $matches) { [Console]::WriteLine($match.ProcessId) }',
  ].join('; ')
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    windowsHide: true,
    timeout: 2_000,
  })
  return stdout
    .split(/\r?\n/)
    .map(value => Number(value.trim()))
    .filter(processId => Number.isInteger(processId) && processId > 0)
}

async function readRuntimeProcessIdentity(processId: number): Promise<RuntimeProcessIdentity | undefined> {
  const command = [
    '$matches = Get-CimInstance Win32_Process -Filter (\'ProcessId = \' + [int]$env:TERMINAL_AGENT_PROCESS_ID)',
    processIdentityOutputScript('$matches'),
  ].join('; ')
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    env: { ...process.env, TERMINAL_AGENT_PROCESS_ID: String(processId) },
    windowsHide: true,
    timeout: 2_000,
  })
  return parseRuntimeProcessIdentities(stdout)[0]
}

function processIdentityOutputScript(matchesExpression: string): string {
  return [
    `foreach ($match in ${matchesExpression}) {`,
    'if ($null -eq $match.ExecutablePath -or $null -eq $match.CreationDate) { continue }',
    '$identity = @{ processId = [int]$match.ProcessId; executablePath = [string]$match.ExecutablePath; creationDate = ([DateTime]$match.CreationDate).ToUniversalTime().ToString(\'o\') }',
    '[Console]::WriteLine(($identity | ConvertTo-Json -Compress))',
    '}',
  ].join('; ')
}

function parseRuntimeProcessIdentities(output: string): RuntimeProcessIdentity[] {
  return output
    .split(/\r?\n/)
    .map(value => value.trim())
    .filter(value => value.length > 0)
    .map(value => JSON.parse(value) as RuntimeProcessIdentity)
    .filter(identity => Number.isInteger(identity.processId)
      && identity.processId > 0
      && identity.executablePath.length > 0
      && identity.creationDate.length > 0)
}

async function terminateNewRuntimeProcesses(runtimePath: string, preexistingProcesses: ReadonlySet<string>): Promise<void> {
  const processes = await findAllRuntimeProcessIdentities(runtimePath)
  for (const process of processes) {
    if (!preexistingProcesses.has(runtimeProcessIdentityKey(process))) await terminateProcessTree(process)
  }
}

async function hasRendererProcess(parentProcessId: number, runtimePath: string): Promise<boolean> {
  const command = [
    "$runtime = Get-CimInstance Win32_Process -Filter \"Name = 'Terminal-Agent-runtime.exe'\"",
    "$match = $runtime | Where-Object { $_.ParentProcessId -eq [uint32]$env:TERMINAL_AGENT_PRIMARY_PID -and $_.ExecutablePath -eq $env:TERMINAL_AGENT_RELEASE_RUNTIME -and $_.CommandLine -match ' --type=renderer' } | Select-Object -First 1",
    "if ($null -ne $match) { [Console]::Write('ready') }",
  ].join('; ')
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    env: {
      ...process.env,
      TERMINAL_AGENT_PRIMARY_PID: String(parentProcessId),
      TERMINAL_AGENT_RELEASE_RUNTIME: runtimePath,
    },
    windowsHide: true,
    timeout: 2_000,
  })
  return stdout.trim() === 'ready'
}

async function terminateProcessTree(expected: RuntimeProcessIdentity): Promise<void> {
  await terminateOwnedRuntimeProcess(expected, readRuntimeProcessIdentity, async processId => {
    try {
      await execFileAsync('taskkill.exe', ['/PID', String(processId), '/T', '/F'], { windowsHide: true })
    } catch (error) {
      if (!ownsRuntimeProcess(await readRuntimeProcessIdentity(processId), expected)) return
      throw error
    }
  })
}

async function waitForCondition<T>(description: string, condition: () => Promise<T | false>): Promise<T> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const result = await condition()
    if (result !== false && result !== undefined) return result
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out waiting for ${description}`)
}

async function waitForPromise<T>(description: string, promise: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), 20_000)
      }),
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

async function removeDirectoryWhenUnlocked(directory: string): Promise<void> {
  await waitForCondition(`the directory to become removable: ${directory}`, async () => {
    try {
      await rm(directory, { recursive: true, force: true })
      return true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EBUSY' || code === 'EPERM') return false
      throw error
    }
  })
}

async function findFilesContaining(directory: string, values: readonly string[]): Promise<string[]> {
  const matches: string[] = []
  const needles = values.map(value => Buffer.from(value, 'utf8'))
  const visit = async (currentDirectory: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(currentDirectory, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      const path = join(currentDirectory, entry.name)
      if (entry.isDirectory()) {
        await visit(path)
      } else if (entry.isFile()) {
        const content = await readFile(path)
        if (needles.some(needle => content.includes(needle))) matches.push(path)
      }
    }
  }

  await visit(directory)
  return matches
}

async function findFilesNamed(directory: string, fileName: string): Promise<string[]> {
  const matches: string[] = []
  const visit = async (currentDirectory: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(currentDirectory, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      const path = join(currentDirectory, entry.name)
      if (entry.isDirectory()) {
        await visit(path)
      } else if (entry.isFile() && entry.name === fileName) {
        matches.push(path)
      }
    }
  }

  await visit(directory)
  return matches
}
