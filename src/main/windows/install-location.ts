import { execFile } from 'node:child_process'
import { dirname } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type InstallPathWriter = (installPath: string) => Promise<void>

export type PackagedWindowsInstallLocation = {
  platform: NodeJS.Platform
  isPackaged: boolean
  execPath: string
  writeInstallPath: InstallPathWriter
}

export async function writeWindowsInstallPath(installPath: string): Promise<void> {
  await execFileAsync('reg.exe', [
    'add',
    'HKCU\\Software\\Terminal-Agent',
    '/v',
    'InstallPath',
    '/t',
    'REG_SZ',
    '/d',
    installPath,
    '/f',
  ], { windowsHide: true })
}

export async function recordPackagedWindowsInstallPath(location: PackagedWindowsInstallLocation): Promise<void> {
  if (location.platform !== 'win32' || !location.isPackaged) return
  try {
    await location.writeInstallPath(dirname(location.execPath))
  } catch {
    // The bridge has a colocated-development fallback and startup must never wait on a registry write.
  }
}
