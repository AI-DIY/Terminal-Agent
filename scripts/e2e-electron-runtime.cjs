/* global __dirname, module, process, require */
/* eslint-disable @typescript-eslint/no-require-imports */

const { existsSync, readFileSync } = require('node:fs')
const { join, resolve } = require('node:path')

function executableNameForPlatform(platform) {
  if (platform === 'darwin') return join('Electron.app', 'Contents', 'MacOS', 'Electron')
  return platform === 'win32' ? 'electron.exe' : 'electron'
}

function inspectElectronRuntime({
  electronPackageDirectory,
  expectedVersion,
  platform,
  overrideDistributionPath,
  existsSync: fileExists = existsSync,
  readFileSync: readFile = readFileSync,
}) {
  const distributionPath = overrideDistributionPath || join(electronPackageDirectory, 'dist')
  const executablePath = join(distributionPath, executableNameForPlatform(platform))
  const versionPath = join(distributionPath, 'version')
  const executableExists = fileExists(executablePath)
  const versionExists = fileExists(versionPath)
  let actualVersion = null
  if (versionExists) actualVersion = readFile(versionPath, 'utf8').trim().replace(/^v/, '')

  return {
    ready: executableExists && actualVersion === expectedVersion,
    distributionPath,
    executablePath,
    expectedVersion,
    actualVersion,
  }
}

function inspectProjectElectronRuntime({ projectRoot = resolve(__dirname, '..'), environment = process.env, platform = process.platform } = {}) {
  const electronPackagePath = require.resolve('electron/package.json', { paths: [projectRoot] })
  const electronPackageDirectory = resolve(electronPackagePath, '..')
  const expectedVersion = JSON.parse(readFileSync(electronPackagePath, 'utf8')).version
  return inspectElectronRuntime({
    electronPackageDirectory,
    expectedVersion,
    platform,
    overrideDistributionPath: environment.ELECTRON_OVERRIDE_DIST_PATH,
  })
}

function formatElectronRuntimeDiagnostic(inspection) {
  const actualVersion = inspection.actualVersion === null ? 'missing' : inspection.actualVersion
  return [
    'Electron E2E runtime is unavailable or incompatible.',
    `Expected Electron ${inspection.expectedVersion} at ${inspection.executablePath}; runtime version is ${actualVersion}.`,
    'Run npm ci with lifecycle scripts enabled (do not use --ignore-scripts), then verify node_modules/electron/dist is populated.',
    'Alternatively, point ELECTRON_OVERRIDE_DIST_PATH at a matching Electron distribution directory containing electron.exe and version.',
  ].join('\n')
}

function assertProjectElectronRuntime(options) {
  const inspection = inspectProjectElectronRuntime(options)
  if (!inspection.ready) throw new Error(formatElectronRuntimeDiagnostic(inspection))
  return inspection.executablePath
}

if (require.main === module) assertProjectElectronRuntime()

module.exports = {
  assertProjectElectronRuntime,
  formatElectronRuntimeDiagnostic,
  inspectElectronRuntime,
  inspectProjectElectronRuntime,
}
