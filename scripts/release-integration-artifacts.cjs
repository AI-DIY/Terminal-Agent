/* global __dirname, module, process, require */
/* eslint-disable @typescript-eslint/no-require-imports */

const { existsSync } = require('node:fs')
const { join, resolve } = require('node:path')

function inspectReleaseIntegrationArtifacts({ projectRoot = resolve(__dirname, '..'), platform = process.platform, existsSync: fileExists = existsSync } = {}) {
  const releaseDirectory = join(projectRoot, 'release', 'win-unpacked')
  const runtimePath = join(releaseDirectory, 'Terminal-Agent-runtime.exe')
  const bridgePath = join(releaseDirectory, 'putty.exe')
  if (platform !== 'win32') return { ready: true, skipped: true, runtimePath, bridgePath, missingPaths: [] }

  const missingPaths = [runtimePath, bridgePath].filter(path => !fileExists(path))

  return { ready: missingPaths.length === 0, skipped: false, runtimePath, bridgePath, missingPaths }
}

function formatReleaseIntegrationArtifactDiagnostic(inspection) {
  const missingPaths = new Set(inspection.missingPaths)
  const details = [
    'Windows release integration artifacts are unavailable.',
    ...(missingPaths.has(inspection.runtimePath) ? [`Expected unpacked runtime at ${inspection.runtimePath}.`] : []),
    ...(missingPaths.has(inspection.bridgePath) ? [`Expected unpacked bridge at ${inspection.bridgePath}.`] : []),
    'Run npm run make:win:unpacked before npm run test:integration.',
    'This command does not package automatically.',
  ]
  return details.join('\n')
}

function assertReleaseIntegrationArtifacts(options) {
  const inspection = inspectReleaseIntegrationArtifacts(options)
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
