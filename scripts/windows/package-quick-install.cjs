/* global Buffer, __dirname, module, process, require */
/* eslint-disable @typescript-eslint/no-require-imports */

// A tiny dependency-free ZIP writer keeps the release command usable on clean
// Windows machines.  The installer is stored (method 0) rather than recompressed:
// NSIS files are already compressed, and storing them avoids a second large
// memory/CPU spike while still producing a standards-compliant ZIP archive.
const { existsSync } = require('node:fs')
const { readFile, stat, writeFile, mkdir } = require('node:fs/promises')
const { resolve, join, relative, sep, isAbsolute } = require('node:path')

const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?$/

function releaseVersion(value) {
  if (typeof value !== 'string' || !VERSION_PATTERN.test(value)) throw new Error('A valid release version is required.')
  return value
}

function installerNameFor(version) {
  return `Terminal-Agent-Setup-${releaseVersion(version)}.exe`
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0)
  return value >>> 0
})

function crc32(buffer) {
  let value = 0xffffffff
  for (const byte of buffer) value = (value >>> 8) ^ CRC_TABLE[(value ^ byte) & 0xff]
  return (value ^ 0xffffffff) >>> 0
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear())
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

function u16(value) {
  const buffer = Buffer.allocUnsafe(2)
  buffer.writeUInt16LE(value & 0xffff, 0)
  return buffer
}

function u32(value) {
  const buffer = Buffer.allocUnsafe(4)
  buffer.writeUInt32LE(value >>> 0, 0)
  return buffer
}

async function requireFile(path, label) {
  let details
  try { details = await stat(path) } catch { throw new Error(`Expected ${label} at ${path}.`) }
  if (!details.isFile() || details.size === 0) throw new Error(`Expected non-empty ${label} at ${path}.`)
  return details
}

function archiveEntry(path, name, content, timestamp) {
  const filename = Buffer.from(name, 'utf8')
  if (filename.length > 0xffff) throw new Error(`ZIP entry name is too long: ${name}`)
  if (content.length > 0xffffffff) throw new Error(`ZIP entry is too large: ${name}`)
  const checksum = crc32(content)
  const { time, date } = dosDateTime(timestamp)
  const localOffset = archiveEntry.offset
  const local = Buffer.concat([
    u32(0x04034b50), u16(20), u16(0x800), u16(0), u16(time), u16(date),
    u32(checksum), u32(content.length), u32(content.length), u16(filename.length), u16(0), filename,
  ])
  archiveEntry.offset += local.length + content.length
  const central = Buffer.concat([
    u32(0x02014b50), u16(20), u16(20), u16(0x800), u16(0), u16(time), u16(date),
    u32(checksum), u32(content.length), u32(content.length), u16(filename.length), u16(0), u16(0),
    u16(0), u16(0), u32(0), u32(localOffset), filename,
  ])
  return { local: Buffer.concat([local, content]), central }
}

archiveEntry.offset = 0

async function writeZip(outputPath, entries) {
  archiveEntry.offset = 0
  const localParts = []
  const centralParts = []
  for (const entry of entries) {
    const details = await requireFile(entry.path, entry.label ?? entry.name)
    const content = await readFile(entry.path)
    if (content.length !== details.size || content.length === 0) throw new Error(`Unable to read a complete ${entry.label ?? entry.name}.`)
    const part = archiveEntry(entry.name, entry.name, content, details.mtime)
    localParts.push(part.local)
    centralParts.push(part.central)
  }
  const localData = Buffer.concat(localParts)
  const centralData = Buffer.concat(centralParts)
  if (entries.length > 0xffff || centralData.length > 0xffffffff || localData.length > 0xffffffff) throw new Error('ZIP64 is required for this release package.')
  const end = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(centralData.length), u32(localData.length), u16(0),
  ])
  await mkdir(resolve(outputPath, '..'), { recursive: true })
  await writeFile(outputPath, Buffer.concat([localData, centralData, end]))
  return { path: outputPath, entries: entries.map(entry => entry.name), bytes: localData.length + centralData.length + end.length }
}

function safeReleasePath(releaseDirectory, filename) {
  const candidate = resolve(releaseDirectory, filename)
  const fromRelease = relative(releaseDirectory, candidate)
  if (fromRelease === '..' || fromRelease.startsWith(`..${sep}`) || isAbsolute(fromRelease)) throw new Error('Release asset must remain within the release directory.')
  return candidate
}

async function packageQuickInstall({
  projectRoot = resolve(__dirname, '..', '..'),
  version,
  releaseDirectory = join(projectRoot, 'release'),
  outputPath = join(releaseDirectory, `Terminal-Agent-Quick-Install-${releaseVersion(version)}.zip`),
} = {}) {
  const validatedVersion = releaseVersion(version)
  const releaseRoot = resolve(releaseDirectory)
  const installerName = installerNameFor(validatedVersion)
  const source = filename => safeReleasePath(releaseRoot, filename)
  const firstExisting = candidates => candidates.map(candidate => resolve(candidate)).find(candidate => existsSync(candidate)) ?? resolve(candidates[0])
  const installerPath = source(installerName)
  const bridgePath = source('putty.exe')
  const manualMdPath = firstExisting([source('快速安装手册.md'), join(projectRoot, '快速安装手册.md')])
  const manualPdfPath = firstExisting([source('快速安装手册.pdf'), join(projectRoot, '快速安装手册.pdf')])
  const scriptPath = firstExisting([source('快速安装脚本.cmd'), join(projectRoot, '快速安装脚本.cmd')])
  const implementationPath = firstExisting([source('quick-install.cmd'), join(projectRoot, 'quick-install.cmd')])
  const entries = [
    { name: 'putty.exe', path: bridgePath, label: 'putty.exe bridge' },
    { name: installerName, path: installerPath, label: 'Windows installer' },
    { name: '快速安装手册.md', path: manualMdPath, label: 'quick-install Markdown guide' },
    { name: '快速安装手册.pdf', path: manualPdfPath, label: 'quick-install PDF guide' },
    { name: '快速安装脚本.cmd', path: scriptPath, label: 'quick-install script' },
    { name: 'quick-install.cmd', path: implementationPath, label: 'quick-install implementation' },
  ]
  for (const entry of entries) await requireFile(entry.path, entry.label)
  const output = resolve(outputPath)
  return writeZip(output, entries)
}

if (require.main === module) {
  const projectRoot = resolve(__dirname, '..', '..')
  const packageJson = require(join(projectRoot, 'package.json'))
  packageQuickInstall({ projectRoot, version: process.env.npm_package_version ?? packageJson.version })
    .then(result => process.stdout.write(`${result.path}\n${result.entries.join('\n')}\n`))
    .catch(error => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    })
}

module.exports = { packageQuickInstall, writeZip, releaseVersion, installerNameFor, crc32 }
