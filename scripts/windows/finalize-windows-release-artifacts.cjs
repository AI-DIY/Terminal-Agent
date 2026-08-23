/* global __dirname, module, process, require */
/* eslint-disable @typescript-eslint/no-require-imports */

const { createHash } = require('node:crypto')
const { createReadStream } = require('node:fs')
const { copyFile, mkdir, stat, writeFile } = require('node:fs/promises')
const { join, resolve } = require('node:path')

async function requireNonEmptyFile(path, label) {
  let details
  try {
    details = await stat(path)
  }
  catch {
    throw new Error(`Expected ${label} at ${path}.`)
  }

  if (!details.isFile() || details.size === 0) {
    throw new Error(`Expected non-empty ${label} at ${path}.`)
  }

  return details
}

async function sha512File(path) {
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('base64')
}

function latestYml({ version, installerName, sha512, size, releaseDate }) {
  return [
    `version: ${version}`,
    'files:',
    `  - url: ${installerName}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${installerName}`,
    `sha512: ${sha512}`,
    `releaseDate: ${releaseDate.toISOString()}`,
    '',
  ].join('\n')
}

async function finalizeWindowsReleaseArtifacts({
  projectRoot = resolve(__dirname, '..', '..'),
  version = process.env.npm_package_version,
  releaseDate,
} = {}) {
  if (!version) throw new Error('A Windows release version is required.')

  const releaseDirectory = join(projectRoot, 'release')
  const installerName = `Terminal-Agent-Setup-${version}.exe`
  const installerPath = join(releaseDirectory, installerName)
  const packagedBridgePath = join(releaseDirectory, 'win-unpacked', 'putty.exe')
  const bridgePath = join(releaseDirectory, 'putty.exe')
  const latestYmlPath = join(releaseDirectory, 'latest.yml')
  const installer = await requireNonEmptyFile(installerPath, 'Windows installer')
  await requireNonEmptyFile(packagedBridgePath, 'packaged bridge')

  await mkdir(releaseDirectory, { recursive: true })
  await copyFile(packagedBridgePath, bridgePath)
  await requireNonEmptyFile(bridgePath, 'release bridge')

  const publishedAt = releaseDate ?? installer.mtime
  if (!(publishedAt instanceof Date) || Number.isNaN(publishedAt.valueOf())) {
    throw new Error('A valid Windows release date is required.')
  }

  const sha512 = await sha512File(installerPath)
  await writeFile(latestYmlPath, latestYml({
    version,
    installerName,
    sha512,
    size: installer.size,
    releaseDate: publishedAt,
  }), 'utf8')

  return { bridgePath, installerPath, latestYmlPath, sha512 }
}

if (require.main === module) {
  finalizeWindowsReleaseArtifacts()
    .then(({ bridgePath, latestYmlPath }) => process.stdout.write(`${bridgePath}\n${latestYmlPath}\n`))
    .catch(error => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    })
}

module.exports = { finalizeWindowsReleaseArtifacts, latestYml, sha512File }
