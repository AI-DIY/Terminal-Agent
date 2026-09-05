/* global Buffer, __dirname, module, process, require */
/* eslint-disable @typescript-eslint/no-require-imports */

const { createHash } = require('node:crypto')
const { existsSync, mkdirSync, readFileSync, statSync } = require('node:fs')
const { resolve, join } = require('node:path')
const { spawnSync } = require('node:child_process')

const PROJECT_ROOT = resolve(__dirname, '..', '..')
const SOURCE_RELATIVE_PATH = join('scripts', 'windows', 'terminal-agent-launcher.cpp')
const OUTPUT_RELATIVE_PATH = join('build', 'launcher', 'putty.exe')
const COMPILER = 'x86_64-w64-mingw32-g++.exe'

// This digest identifies the source that produced the validated release bridge
// lineage. A fallback must never be used for a different launcher source.
const VALIDATED_SOURCE_SHA256 = 'FFE784B8172FD4FB3E34B5CC47D6857C6BB30CBEC61EE41AD135AA48FB495D37'
// Captured from the validated x64 bridge already present in build/launcher.
const VALIDATED_FALLBACK_SHA256 = 'E9664089128B37F739101D9624AA8D055BA18F2915AD34AD829546FCF5120F83'

const COMPILER_ARGUMENTS = [
  '-std=c++17',
  '-O2',
  '-s',
  '-static',
  '-municode',
]

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex').toUpperCase()
}

function sourceSha256(buffer) {
  // Git may check this source out with LF or CRLF depending on core.autocrlf.
  return sha256(Buffer.from(buffer.toString('utf8').replaceAll('\r\n', '\n'), 'utf8'))
}

function readNonEmptyFile(path, label) {
  if (!existsSync(path)) throw new Error(`Expected ${label} at ${path}.`)
  const details = statSync(path)
  if (!details.isFile() || details.size === 0) throw new Error(`Expected non-empty ${label} at ${path}.`)
  return readFileSync(path)
}

function assertX64Pe(buffer, label) {
  if (buffer.length < 0x40 || buffer.toString('ascii', 0, 2) !== 'MZ') {
    throw new Error(`${label} is not a Windows PE executable.`)
  }

  const peOffset = buffer.readUInt32LE(0x3c)
  if (peOffset < 0x40 || peOffset + 26 > buffer.length || buffer.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') {
    throw new Error(`${label} has an invalid PE header.`)
  }

  const machine = buffer.readUInt16LE(peOffset + 4)
  if (machine !== 0x8664) {
    throw new Error(`${label} must target x64 Windows (machine 0x8664).`)
  }

  const optionalHeaderMagic = buffer.readUInt16LE(peOffset + 24)
  if (optionalHeaderMagic !== 0x20b) {
    throw new Error(`${label} must use the x64 PE optional header (magic 0x20b).`)
  }
}

function compilerProbe(compiler, runProcess) {
  let result
  try {
    result = runProcess(compiler, ['--version'], { stdio: 'ignore', windowsHide: true })
  }
  catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return false
    throw error
  }

  if (result?.error?.code === 'ENOENT') return false
  if (result?.error) throw result.error
  return true
}

function compileLauncher({ compiler, sourcePath, outputPath, runProcess }) {
  const result = runProcess(compiler, [
    ...COMPILER_ARGUMENTS,
    sourcePath,
    '-o',
    outputPath,
    '-lshell32',
    '-ladvapi32',
  ], { stdio: 'inherit', windowsHide: true })

  if (result?.error) throw result.error
  if (result?.status !== 0) {
    throw new Error(`Launcher compiler exited with status ${result?.status ?? 'unknown'}.`)
  }

  const output = readNonEmptyFile(outputPath, 'compiled launcher')
  assertX64Pe(output, 'Compiled launcher')
  return { mode: 'compiled', path: outputPath, sha256: sha256(output) }
}

function reuseValidatedLauncher({ sourcePath, outputPath, sourceDigest = VALIDATED_SOURCE_SHA256, fallbackDigest = VALIDATED_FALLBACK_SHA256 }) {
  const source = readNonEmptyFile(sourcePath, 'launcher source')
  if (sourceSha256(source) !== sourceDigest) {
    throw new Error(
      `Cannot reuse the validated launcher because ${SOURCE_RELATIVE_PATH} has changed. `
      + 'Install the MinGW-w64 compiler and build it from source.',
    )
  }

  const output = readNonEmptyFile(outputPath, 'validated launcher fallback')
  assertX64Pe(output, 'Validated launcher fallback')
  const digest = sha256(output)
  if (digest !== fallbackDigest) {
    throw new Error(
      `Cannot reuse ${OUTPUT_RELATIVE_PATH}: its SHA-256 digest is ${digest}, `
      + `expected ${fallbackDigest}. Install the MinGW-w64 compiler and build it from source.`,
    )
  }

  return { mode: 'fallback', path: outputPath, sha256: digest }
}

function buildLauncher({
  projectRoot = PROJECT_ROOT,
  compiler = process.env.TERMINAL_AGENT_MINGW_CXX || COMPILER,
  runProcess = spawnSync,
  sourceDigest,
  fallbackDigest,
} = {}) {
  const sourcePath = resolve(projectRoot, SOURCE_RELATIVE_PATH)
  const outputPath = resolve(projectRoot, OUTPUT_RELATIVE_PATH)
  mkdirSync(resolve(outputPath, '..'), { recursive: true })

  if (compilerProbe(compiler, runProcess)) {
    return compileLauncher({ compiler, sourcePath, outputPath, runProcess })
  }

  return reuseValidatedLauncher({ sourcePath, outputPath, sourceDigest, fallbackDigest })
}

function compilerFromArguments(argumentsList) {
  const compilerIndex = argumentsList.indexOf('--compiler')
  return compilerIndex >= 0 && argumentsList[compilerIndex + 1]
    ? argumentsList[compilerIndex + 1]
    : undefined
}

function main() {
  try {
    const result = buildLauncher({ compiler: compilerFromArguments(process.argv.slice(2)) })
    const mode = result.mode === 'compiled' ? 'compiled from source' : 'reused the validated existing binary'
    process.stdout.write(`Windows launcher ${mode}: ${result.path} (${result.sha256})\n`)
  }
  catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}

if (require.main === module) main()

module.exports = {
  COMPILER,
  COMPILER_ARGUMENTS,
  OUTPUT_RELATIVE_PATH,
  PROJECT_ROOT,
  SOURCE_RELATIVE_PATH,
  VALIDATED_FALLBACK_SHA256,
  VALIDATED_SOURCE_SHA256,
  assertX64Pe,
  buildLauncher,
  compilerProbe,
  compileLauncher,
  compilerFromArguments,
  reuseValidatedLauncher,
  sha256,
  sourceSha256,
}
