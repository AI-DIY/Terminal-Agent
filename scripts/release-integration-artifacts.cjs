/* global __dirname, module, process, require */
/* eslint-disable @typescript-eslint/no-require-imports */

const { existsSync } = require('node:fs')
const { join, resolve } = require('node:path')

function inspectReleaseIntegrationArtifacts({ projectRoot = resolve(__dirname, '..'), existsSync: fileExists = existsSync } = {}) {
  const releaseDirectory = join(projectRoot, 'release', 'win-unpacked')
  const runtimePath = join(releaseDirectory, 'Terminal-Agent-runtime.exe')
  const bridgePath = join(releaseDirectory, 'putty.exe')
  const missingPaths = [runtimePath, bridgePath].filter(path => !fileExists(path))

  return { ready: missingPaths.length === 0, runtimePath, bridgePath, missingPaths }
}

function formatReleaseIntegrationArtifactDiagnostic(inspection) {
  return [
    'Windows release integration artifacts are unavailable.',
    `Expected unpacked runtime at ${inspection.runtimePath}.`,
    `Expected unpacked bridge at ${inspection.bridgePath}.`,
    'Run npm run make:win:unpacked before npm run test:integration.',
    'This command does not package automatically.',
  ].join('\n')
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
