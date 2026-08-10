import { describe, expect, it, vi } from 'vitest'
import { recordPackagedWindowsInstallPath } from '../../../src/main/windows/install-location'

describe('recordPackagedWindowsInstallPath', () => {
  it('registers the packaged Windows executable directory for the portable bridge', async () => {
    const writeInstallPath = vi.fn().mockResolvedValue(undefined)

    await recordPackagedWindowsInstallPath({
      platform: 'win32',
      isPackaged: true,
      execPath: 'C:\\Program Files\\Terminal-Agent\\Terminal-Agent-runtime.exe',
      writeInstallPath,
    })

    expect(writeInstallPath).toHaveBeenCalledWith('C:\\Program Files\\Terminal-Agent')
  })

  it('does not delay startup when registry registration fails', async () => {
    const writeInstallPath = vi.fn().mockRejectedValue(new Error('registry unavailable'))

    await expect(recordPackagedWindowsInstallPath({
      platform: 'win32',
      isPackaged: true,
      execPath: 'C:\\Program Files\\Terminal-Agent\\Terminal-Agent-runtime.exe',
      writeInstallPath,
    })).resolves.toBeUndefined()
  })

  it.each([
    { platform: 'darwin', isPackaged: true },
    { platform: 'win32', isPackaged: false },
  ] as const)('does not write outside packaged Windows builds', async ({ platform, isPackaged }) => {
    const writeInstallPath = vi.fn().mockResolvedValue(undefined)

    await recordPackagedWindowsInstallPath({
      platform,
      isPackaged,
      execPath: 'C:\\Program Files\\Terminal-Agent\\Terminal-Agent-runtime.exe',
      writeInstallPath,
    })

    expect(writeInstallPath).not.toHaveBeenCalled()
  })
})
