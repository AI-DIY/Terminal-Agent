import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

type LauncherBuildModule = {
  COMPILER_ARGUMENTS: string[]
  buildLauncher(input: {
    projectRoot: string
    compiler?: string
    runProcess: (command: string, args: string[], options: Record<string, unknown>) => {
      status?: number | null
      error?: NodeJS.ErrnoException
    }
    sourceDigest?: string
    fallbackDigest?: string
  }): { mode: 'compiled' | 'fallback'; path: string; sha256: string }
  sha256(buffer: Buffer): string
}

const require = createRequire(import.meta.url)

function launcherBuild(): LauncherBuildModule {
  return require('../../../scripts/windows/build-launcher.cjs') as LauncherBuildModule
}

function x64PeFixture(): Buffer {
  const executable = Buffer.alloc(512)
  executable.write('MZ', 0, 'ascii')
  executable.writeUInt32LE(0x80, 0x3c)
  executable.write('PE\0\0', 0x80, 'ascii')
  executable.writeUInt16LE(0x8664, 0x84)
  executable.writeUInt16LE(0x20b, 0x98)
  return executable
}

async function createProject() {
  const projectRoot = await mkdtemp(join(tmpdir(), 'terminal-agent-build-launcher-'))
  const sourcePath = join(projectRoot, 'scripts', 'windows', 'terminal-agent-launcher.cpp')
  const outputPath = join(projectRoot, 'build', 'launcher', 'putty.exe')
  await mkdir(dirname(sourcePath), { recursive: true })
  await mkdir(dirname(outputPath), { recursive: true })
  return { projectRoot, sourcePath, outputPath }
}

describe('Windows launcher build helper', () => {
  it('compiles from source with the static MinGW flags when the compiler is available', async () => {
    const project = await createProject()
    const executable = x64PeFixture()
    const calls: Array<{ command: string; args: string[] }> = []

    try {
      await writeFile(project.sourcePath, 'launcher source')
      const result = launcherBuild().buildLauncher({
        projectRoot: project.projectRoot,
        compiler: 'fake-mingw.exe',
        runProcess: (command, args) => {
          calls.push({ command, args })
          if (args[0] === '--version') return { status: 0 }
          const outputIndex = args.indexOf('-o')
          expect(outputIndex).toBeGreaterThan(-1)
          writeFileSync(args[outputIndex + 1], executable)
          return { status: 0 }
        },
      })

      expect(result.mode).toBe('compiled')
      expect(result.sha256).toBe(launcherBuild().sha256(executable))
      expect(calls[1]?.command).toBe('fake-mingw.exe')
      expect(calls[1]?.args).toEqual([
        ...launcherBuild().COMPILER_ARGUMENTS,
        project.sourcePath,
        '-o',
        project.outputPath,
        '-lshell32',
        '-ladvapi32',
      ])
      expect(calls[1]?.args).toContain('-static')
      await expect(readFile(project.outputPath)).resolves.toEqual(executable)
    }
    finally {
      await rm(project.projectRoot, { recursive: true, force: true })
    }
  })

  it('reuses only the exact validated x64 bridge when the compiler is unavailable', async () => {
    const project = await createProject()
    const executable = x64PeFixture()
    const source = Buffer.from('launcher source')
    const build = launcherBuild()

    try {
      await writeFile(project.sourcePath, source)
      await writeFile(project.outputPath, executable)
      const result = build.buildLauncher({
        projectRoot: project.projectRoot,
        compiler: 'missing-mingw.exe',
        runProcess: () => ({ error: Object.assign(new Error('not found'), { code: 'ENOENT' }) }),
        sourceDigest: build.sha256(source),
        fallbackDigest: build.sha256(executable),
      })

      expect(result).toEqual({
        mode: 'fallback',
        path: project.outputPath,
        sha256: build.sha256(executable),
      })
    }
    finally {
      await rm(project.projectRoot, { recursive: true, force: true })
    }
  })

  it('does not fall back when a present compiler fails', async () => {
    const project = await createProject()
    const executable = x64PeFixture()
    const source = Buffer.from('launcher source')
    const build = launcherBuild()
    let compileCalled = false

    try {
      await writeFile(project.sourcePath, source)
      await writeFile(project.outputPath, executable)
      expect(() => build.buildLauncher({
        projectRoot: project.projectRoot,
        compiler: 'broken-mingw.exe',
        runProcess: (_command, args) => {
          if (args[0] === '--version') return { status: 0 }
          compileCalled = true
          return { status: 1 }
        },
        sourceDigest: build.sha256(source),
        fallbackDigest: build.sha256(executable),
      })).toThrow('Launcher compiler exited with status 1')
      expect(compileCalled).toBe(true)
    }
    finally {
      await rm(project.projectRoot, { recursive: true, force: true })
    }
  })

  it('fails closed for a missing, mismatched, or non-x64 fallback', async () => {
    const project = await createProject()
    const source = Buffer.from('launcher source')
    const build = launcherBuild()

    try {
      await writeFile(project.sourcePath, source)
      await writeFile(project.outputPath, Buffer.from('not an executable'))
      expect(() => build.buildLauncher({
        projectRoot: project.projectRoot,
        compiler: 'missing-mingw.exe',
        runProcess: () => ({ error: Object.assign(new Error('not found'), { code: 'ENOENT' }) }),
        sourceDigest: build.sha256(source),
        fallbackDigest: build.sha256(Buffer.from('not an executable')),
      })).toThrow('not a Windows PE executable')

      const x86 = x64PeFixture()
      x86.writeUInt16LE(0x14c, 0x84)
      await writeFile(project.outputPath, x86)
      expect(() => build.buildLauncher({
        projectRoot: project.projectRoot,
        compiler: 'missing-mingw.exe',
        runProcess: () => ({ error: Object.assign(new Error('not found'), { code: 'ENOENT' }) }),
        sourceDigest: build.sha256(source),
        fallbackDigest: build.sha256(x86),
      })).toThrow('must target x64 Windows')
    }
    finally {
      await rm(project.projectRoot, { recursive: true, force: true })
    }
  })
})
