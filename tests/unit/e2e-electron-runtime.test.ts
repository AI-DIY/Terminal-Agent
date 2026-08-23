import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

type RuntimeInspection = {
  ready: boolean
  executablePath: string
  distributionPath: string
  expectedVersion: string
  actualVersion: string | null
}

type RuntimeGuard = {
  inspectElectronRuntime(input: {
    electronPackageDirectory: string
    expectedVersion: string
    platform: NodeJS.Platform
    overrideDistributionPath?: string
    existsSync?: (path: string) => boolean
    readFileSync?: (path: string, encoding: string) => string
  }): RuntimeInspection
  formatElectronRuntimeDiagnostic(inspection: RuntimeInspection): string
}

const require = createRequire(import.meta.url)
const runtimeGuard = require('../../scripts/e2e-electron-runtime.cjs') as RuntimeGuard

describe('E2E Electron runtime guard', () => {
  it('accepts a matching explicit Electron distribution override', () => {
    const distributionPath = join('shared-runtime', 'electron-dist')
    const executablePath = join(distributionPath, 'electron.exe')
    const versionPath = join(distributionPath, 'version')
    const inspection = runtimeGuard.inspectElectronRuntime({
      electronPackageDirectory: join('project', 'node_modules', 'electron'),
      expectedVersion: '43.3.0',
      platform: 'win32',
      overrideDistributionPath: distributionPath,
      existsSync: path => path === executablePath || path === versionPath,
      readFileSync: () => 'v43.3.0\n',
    })

    expect(inspection).toMatchObject({
      ready: true,
      distributionPath,
      executablePath,
      expectedVersion: '43.3.0',
      actualVersion: '43.3.0',
    })
  })

  it('reports an actionable diagnostic instead of relying on Electron implicit download', () => {
    const inspection = runtimeGuard.inspectElectronRuntime({
      electronPackageDirectory: join('project', 'node_modules', 'electron'),
      expectedVersion: '43.3.0',
      platform: 'win32',
      existsSync: () => false,
    })

    expect(inspection.ready).toBe(false)
    expect(runtimeGuard.formatElectronRuntimeDiagnostic(inspection)).toContain('npm ci')
    expect(runtimeGuard.formatElectronRuntimeDiagnostic(inspection)).toContain('ELECTRON_OVERRIDE_DIST_PATH')
    expect(runtimeGuard.formatElectronRuntimeDiagnostic(inspection)).toContain('electron.exe')
  })
})
