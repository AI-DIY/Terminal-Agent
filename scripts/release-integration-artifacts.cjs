/* global __dirname, module, process, require */
/* eslint-disable @typescript-eslint/no-require-imports */

const { existsSync, readFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { listPackage } = require('@electron/asar')

function archivePackageEntry(packageName) {
  return `\\node_modules\\${packageName.replaceAll('/', '\\')}\\package.json`
}

function inspectReleaseIntegrationArtifacts({
  projectRoot = resolve(__dirname, '..'),
  platform = process.platform,
  existsSync: fileExists = existsSync,
  listPackage: listAsarPackage,
  packageDependencies,
} = {}) {
  const releaseDirectory = join(projectRoot, 'release', 'win-unpacked')
  const runtimePath = join(releaseDirectory, 'Terminal-Agent-runtime.exe')
  const bridgePath = join(releaseDirectory, 'putty.exe')
  const asarPath = join(releaseDirectory, 'resources', 'app.asar')
  if (platform !== 'win32') return { ready: true, skipped: true, runtimePath, bridgePath, missingPaths: [] }

  const missingPaths = [runtimePath, bridgePath].filter(path => !fileExists(path))
  if (listAsarPackage && packageDependencies && !fileExists(asarPath)) missingPaths.push(asarPath)

  let missingRuntimeDependencies = []
  if (listAsarPackage && packageDependencies && !missingPaths.includes(asarPath)) {
    const archiveEntries = new Set(listAsarPackage(asarPath))
    const requiredEntries = [
      ...Object.keys(packageDependencies).map(packageName => [packageName + '/package.json', archivePackageEntry(packageName)]),
      ['@langchain/core/singletons.cjs', '\\node_modules\\@langchain\\core\\singletons.cjs'],
      ['@langchain/core/dist/singletons/index.cjs', '\\node_modules\\@langchain\\core\\dist\\singletons\\index.cjs'],
    ]
    missingRuntimeDependencies = requiredEntries
      .filter(([, archivePath]) => !archiveEntries.has(archivePath))
      .map(([dependencyPath]) => dependencyPath)
  }

  return {
    ready: missingPaths.length === 0 && missingRuntimeDependencies.length === 0,
    skipped: false,
    runtimePath,
    bridgePath,
    missingPaths,
    ...(listAsarPackage && packageDependencies ? { missingRuntimeDependencies } : {}),
  }
}

function formatReleaseIntegrationArtifactDiagnostic(inspection) {
  const missingPaths = new Set(inspection.missingPaths)
  const details = [
    'Windows release integration artifacts are unavailable.',
    ...(missingPaths.has(inspection.runtimePath) ? [`Expected unpacked runtime at ${inspection.runtimePath}.`] : []),
    ...(missingPaths.has(inspection.bridgePath) ? [`Expected unpacked bridge at ${inspection.bridgePath}.`] : []),
    ...(inspection.missingRuntimeDependencies ?? []).map(path => `Expected packaged runtime dependency ${path}.`),
    'Run npm run make:win:unpacked before npm run test:integration.',
    'This command does not package automatically.',
  ]
  return details.join('\n')
}

function assertReleaseIntegrationArtifacts(options = {}) {
  const projectRoot = options.projectRoot ?? resolve(__dirname, '..')
  const packageDependencies = options.packageDependencies
    ?? JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')).dependencies
  const inspection = inspectReleaseIntegrationArtifacts({
    ...options,
    projectRoot,
    listPackage: options.listPackage ?? listPackage,
    packageDependencies,
  })
  if (!inspection.ready) throw new Error(formatReleaseIntegrationArtifactDiagnostic(inspection))
  return inspection
}

if (require.main === module) {
  try {
    assertReleaseIntegrationArtifacts()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}

module.exports = {
  assertReleaseIntegrationArtifacts,
  formatReleaseIntegrationArtifactDiagnostic,
  inspectReleaseIntegrationArtifacts,
}
