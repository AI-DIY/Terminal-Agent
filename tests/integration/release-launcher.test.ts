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
import { selectNewRuntimeProcessId } from '../helpers/release-runtime-processes'

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
  let runtimeProcessId: number | undefined
  let primaryFailure: unknown
  let launchAttempted = false
  let preexistingRuntimeProcessIds = new Set<number>()

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

    preexistingRuntimeProcessIds = new Set(await findRuntimeProcessIds())
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

    const [observedShell, discoveredRuntimeProcessId] = await Promise.all([
      fixture.waitForShell(),
      waitForCondition('the runtime process started by this test', () => findNewRuntimeProcessId(preexistingRuntimeProcessIds)),
      once(launcher, 'exit'),
    ]).then(([shell, processId]) => [shell, processId] as const)
    runtimeProcessId = discoveredRuntimeProcessId

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
    let processIdToStop = runtimeProcessId
    await runReleaseLauncherCleanup(primaryFailure, [
      async () => {
        if (launchAttempted) processIdToStop ??= await findNewRuntimeProcessId(preexistingRuntimeProcessIds)
      },
      async () => {
        if (processIdToStop !== undefined) await terminateProcessTree(processIdToStop)
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

test.skipIf(process.platform !== 'win32')('a co-located bridge skips a stale registered install path', async () => {
  await access(packagedBridgePath)

  const stateDirectory = await mkdtemp(join(tmpdir(), 'terminal-agent-release-stale-registry-'))
  const bridgeLogPath = join(releaseDirectory, 'putty-bridge.log')
  let previousInstallPath: InstallPathRegistration | undefined
  let launcher: ChildProcess | undefined
  let runtimeProcessId: number | undefined
  let primaryFailure: unknown
  let launchAttempted = false
  let preexistingRuntimeProcessIds = new Set<number>()

  try {
    previousInstallPath = await readInstallPathRegistration()
    await rm(bridgeLogPath, { force: true })
    await writeInstallPathRegistration(join(stateDirectory, 'missing-installation'))
    preexistingRuntimeProcessIds = new Set(await findRuntimeProcessIds())
    launchAttempted = true
    launcher = spawn(packagedBridgePath, ['-raw', '-P', '1'], {
      env: { ...process.env, APPDATA: stateDirectory, LOCALAPPDATA: stateDirectory },
      stdio: 'ignore',
      windowsHide: true,
    })
    await once(launcher, 'exit')
    runtimeProcessId = await waitForCondition('the co-located runtime process', () => findNewRuntimeProcessId(preexistingRuntimeProcessIds))
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
    let processIdToStop = runtimeProcessId
    await runReleaseLauncherCleanup(primaryFailure, [
      async () => {
        if (launchAttempted) processIdToStop ??= await findNewRuntimeProcessId(preexistingRuntimeProcessIds)
      },
      async () => { if (processIdToStop !== undefined) await terminateProcessTree(processIdToStop) },
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
  let runtimeProcessId: number | undefined
  let primaryFailure: unknown
  let launchAttempted = false
  let preexistingRuntimeProcessIds = new Set<number>()

  try {
    previousInstallPath = await readInstallPathRegistration()
    await cp(releaseDirectory, mappingDirectory, { recursive: true })
    await mkdir(unusablePrimaryLogPath)
    await writeInstallPathRegistration(join(stateDirectory, 'missing-installation'))
    preexistingRuntimeProcessIds = new Set(await findRuntimeProcessIds(copiedRuntimePath))
    launchAttempted = true
    launcher = spawn(copiedBridgePath, ['-raw', '-P', '1'], {
      env: { ...process.env, APPDATA: stateDirectory, LOCALAPPDATA: stateDirectory },
      stdio: 'ignore',
      windowsHide: true,
    })
    await once(launcher, 'exit')
    runtimeProcessId = await waitForCondition('the co-located runtime process with fallback diagnostics', () => findNewRuntimeProcessId(preexistingRuntimeProcessIds, copiedRuntimePath))
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
    let processIdToStop = runtimeProcessId
    await runReleaseLauncherCleanup(primaryFailure, [
      async () => {
        if (launchAttempted) processIdToStop ??= await findNewRuntimeProcessId(preexistingRuntimeProcessIds, copiedRuntimePath)
      },
      async () => { if (processIdToStop !== undefined) await terminateProcessTree(processIdToStop) },
      () => { if (launcher?.exitCode === null) launcher.kill() },
      async () => { if (previousInstallPath !== undefined) await restoreInstallPathRegistration(previousInstallPath) },
      async () => {
        await Promise.all([
          rm(mappingDirectory, { recursive: true, force: true }),
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

async function findNewRuntimeProcessId(preexistingRuntimeProcessIds: ReadonlySet<number>, runtimePath = join(releaseDirectory, 'Terminal-Agent-runtime.exe')): Promise<number | undefined> {
  return selectNewRuntimeProcessId(await findRuntimeProcessIds(runtimePath), preexistingRuntimeProcessIds)
}

async function findRuntimeProcessIds(runtimePath = join(releaseDirectory, 'Terminal-Agent-runtime.exe')): Promise<number[]> {
  const command = [
    "$runtime = Get-CimInstance Win32_Process -Filter \"Name = 'Terminal-Agent-runtime.exe'\"",
    "$matches = $runtime | Where-Object { $_.ExecutablePath -eq $env:TERMINAL_AGENT_RELEASE_RUNTIME -and $_.CommandLine -notmatch ' --type=' }",
    'foreach ($match in $matches) { [Console]::WriteLine($match.ProcessId) }',
  ].join('; ')
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    env: { ...process.env, TERMINAL_AGENT_RELEASE_RUNTIME: runtimePath },
    windowsHide: true,
    timeout: 2_000,
  })
  return stdout
    .split(/\r?\n/)
    .map(value => Number(value.trim()))
    .filter(processId => Number.isInteger(processId) && processId > 0)
}

async function terminateProcessTree(processId: number): Promise<void> {
  await execFileAsync('taskkill.exe', ['/PID', String(processId), '/T', '/F'], { windowsHide: true })
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
