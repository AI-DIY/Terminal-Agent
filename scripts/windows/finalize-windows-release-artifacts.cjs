/* global __dirname, module, process, require */
/* eslint-disable @typescript-eslint/no-require-imports */

const { createHash } = require('node:crypto')
const { createReadStream } = require('node:fs')
const { copyFile, mkdir, rm, stat, writeFile } = require('node:fs/promises')
const { isAbsolute, join, relative, resolve, sep } = require('node:path')

const RELEASE_VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?$/

function releaseVersion(version) {
  if (typeof version !== 'string' || !RELEASE_VERSION_PATTERN.test(version)) {
    throw new Error('A valid release version is required.')
  }

  return version
}

function installerNameFor(version) {
  return `Terminal-Agent-Setup-${releaseVersion(version)}.exe`
}

function releaseAssetPath(releaseDirectory, filename) {
  const candidate = resolve(releaseDirectory, filename)
  const pathFromRelease = relative(releaseDirectory, candidate)
  if (pathFromRelease === '..' || pathFromRelease.startsWith(`..${sep}`) || isAbsolute(pathFromRelease)) {
    throw new Error(`Release asset must remain within ${releaseDirectory}.`)
  }

  return candidate
}

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

function latestYml({ version, sha512, size, releaseDate }) {
  const installerName = installerNameFor(version)
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
  const validatedVersion = releaseVersion(version)

  const releaseDirectory = resolve(projectRoot, 'release')
  const installerName = installerNameFor(validatedVersion)
  const installerPath = releaseAssetPath(releaseDirectory, installerName)
  const blockmapPath = releaseAssetPath(releaseDirectory, `${installerName}.blockmap`)
  const cleanupArchivePath = releaseAssetPath(releaseDirectory, `Terminal-Agent-Uninstall-Cleanup-${validatedVersion}.zip`)
  const packagedBridgePath = releaseAssetPath(releaseDirectory, join('win-unpacked', 'putty.exe'))
  const bridgePath = releaseAssetPath(releaseDirectory, 'putty.exe')
  const quickInstallSourcePath = resolve(projectRoot, 'quick-install.cmd')
  const quickInstallPath = releaseAssetPath(releaseDirectory, 'quick-install.cmd')
  const namedQuickInstallSourcePath = resolve(projectRoot, '快速安装脚本.cmd')
  const namedQuickInstallPath = releaseAssetPath(releaseDirectory, '快速安装脚本.cmd')
  const quickGuideMarkdownSourcePath = resolve(projectRoot, '快速安装手册.md')
  const quickGuideMarkdownPath = releaseAssetPath(releaseDirectory, '快速安装手册.md')
  const quickGuideImageNames = [
    'docs/images/quickstart/06-select-global-putty.png',
    'docs/images/quickstart/07-launch-bastion.png',
  ]
  const quickGuideImages = quickGuideImageNames.map(name => ({
    sourcePath: resolve(projectRoot, name),
    releasePath: releaseAssetPath(releaseDirectory, name),
  }))
  const legacyQuickGuidePdfPath = releaseAssetPath(releaseDirectory, '快速安装手册.pdf')
  const latestYmlPath = releaseAssetPath(releaseDirectory, 'latest.yml')
  const installer = await requireNonEmptyFile(installerPath, 'Windows installer')
  await requireNonEmptyFile(blockmapPath, 'installer blockmap')
  await requireNonEmptyFile(cleanupArchivePath, 'uninstall cleanup archive')
  await requireNonEmptyFile(packagedBridgePath, 'packaged bridge')

  await mkdir(releaseDirectory, { recursive: true })
  // The quick-install guide is now maintained as Markdown with adjacent
  // screenshots. Do not leave a stale PDF from an earlier release beside the
  // current installer where it could be mistaken for a supported asset.
  await rm(legacyQuickGuidePdfPath, { force: true })
  await copyFile(packagedBridgePath, bridgePath)
  await requireNonEmptyFile(bridgePath, 'release bridge')

  // Keep the one-click quick installer beside the release guide, bridge and
  // setup package.  A release without this file would reintroduce the manual
  // quick-install flow, so fail the packaging step instead of silently omitting it.
  await requireNonEmptyFile(quickInstallSourcePath, 'quick installer')
  await copyFile(quickInstallSourcePath, quickInstallPath)
  await requireNonEmptyFile(quickInstallPath, 'release quick installer')

  // These named assets are optional for the historical finalizer unit tests,
  // but are copied whenever present so a normal v3.2 release has a complete
  // standalone ZIP beside the installer.  The ZIP packager performs the final
  // required-file check and fails closed if a production guide is missing.
  if (await statIfFile(namedQuickInstallSourcePath)) {
    await copyFile(namedQuickInstallSourcePath, namedQuickInstallPath)
  }
  if (await statIfFile(quickGuideMarkdownSourcePath)) {
    await copyFile(quickGuideMarkdownSourcePath, quickGuideMarkdownPath)
  }
  for (const image of quickGuideImages) {
    if (await statIfFile(image.sourcePath)) {
      await mkdir(resolve(image.releasePath, '..'), { recursive: true })
      await copyFile(image.sourcePath, image.releasePath)
    }
  }

  const publishedAt = releaseDate ?? installer.mtime
  if (!(publishedAt instanceof Date) || Number.isNaN(publishedAt.valueOf())) {
    throw new Error('A valid Windows release date is required.')
  }

  const sha512 = await sha512File(installerPath)
  await writeFile(latestYmlPath, latestYml({
    version: validatedVersion,
    sha512,
    size: installer.size,
    releaseDate: publishedAt,
  }), 'utf8')

  return { bridgePath, installerPath, latestYmlPath, sha512 }
}

async function statIfFile(path) {
  try {
    const details = await stat(path)
    return details.isFile() && details.size > 0
  }
  catch {
    return false
  }
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
