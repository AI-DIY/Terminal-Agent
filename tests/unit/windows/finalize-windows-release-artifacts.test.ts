import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

type PdfGenerator = (input: {
  projectRoot: string
  markdownPath: string
  outputPath: string
}) => Promise<{ path: string; bytes: number }>

type FinalizedWindowsReleaseArtifacts = {
  bridgePath: string
  installerPath: string
  latestYmlPath: string
  sha512: string
}

type WindowsReleaseArtifactFinalizer = {
  finalizeWindowsReleaseArtifacts(input: {
    projectRoot: string
    version: string
    releaseDate?: Date
    pdfGenerator?: PdfGenerator
  }): Promise<FinalizedWindowsReleaseArtifacts>
  latestYml(input: {
    version: string
    sha512: string
    size: number
    releaseDate: Date
  }): string
}

const require = createRequire(import.meta.url)

function finalizer(): WindowsReleaseArtifactFinalizer {
  return require('../../../scripts/windows/finalize-windows-release-artifacts.cjs') as WindowsReleaseArtifactFinalizer
}

function stubPdfGenerator() {
  const pdf = Buffer.from('%PDF-1.7\nquick-install guide\n%%EOF\n')
  return vi.fn(async ({ outputPath }: { outputPath: string }) => {
    await writeFile(outputPath, pdf)
    return { path: outputPath, bytes: pdf.length }
  }) as unknown as PdfGenerator
}

describe('Windows release artifact finalizer', () => {
  it('exports the packaged bridge and installer update metadata at the release root', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'terminal-agent-release-artifacts-'))
    const version = '1.0.8'
    const releaseDate = new Date('2026-08-23T17:30:40.000Z')
    const packagedBridgePath = join(projectRoot, 'release', 'win-unpacked', 'putty.exe')
    const installerPath = join(projectRoot, 'release', `Terminal-Agent-Setup-${version}.exe`)
    const blockmapPath = join(projectRoot, 'release', `Terminal-Agent-Setup-${version}.exe.blockmap`)
    const cleanupArchivePath = join(projectRoot, 'release', `Terminal-Agent-Uninstall-Cleanup-${version}.zip`)
    const quickInstallSourcePath = join(projectRoot, 'quick-install.cmd')
    const bridgeContents = Buffer.from('packaged bridge')
    const installerContents = Buffer.from('installer payload')

    try {
      await mkdir(dirname(packagedBridgePath), { recursive: true })
      await writeFile(packagedBridgePath, bridgeContents)
      await writeFile(installerPath, installerContents)
      await writeFile(blockmapPath, 'blockmap payload')
      await writeFile(cleanupArchivePath, 'cleanup archive payload')
      await writeFile(quickInstallSourcePath, '@echo off\r\n')

      const result = await finalizer().finalizeWindowsReleaseArtifacts({ projectRoot, version, releaseDate })
      const expectedSha512 = createHash('sha512').update(installerContents).digest('base64')

      expect(await readFile(result.bridgePath)).toEqual(bridgeContents)
      expect(result).toEqual({
        bridgePath: join(projectRoot, 'release', 'putty.exe'),
        installerPath,
        latestYmlPath: join(projectRoot, 'release', 'latest.yml'),
        sha512: expectedSha512,
      })
      await expect(readFile(result.latestYmlPath, 'utf8')).resolves.toBe([
        `version: ${version}`,
        'files:',
        `  - url: Terminal-Agent-Setup-${version}.exe`,
        `    sha512: ${expectedSha512}`,
        `    size: ${installerContents.length}`,
        `path: Terminal-Agent-Setup-${version}.exe`,
        `sha512: ${expectedSha512}`,
        `releaseDate: ${releaseDate.toISOString()}`,
        '',
      ].join('\n'))
    }
    finally {
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  it('copies the quick installer beside the release assets when the source checkout provides it', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'terminal-agent-release-artifacts-'))
    const version = '1.0.8'
    const releaseDate = new Date('2026-08-23T17:30:40.000Z')
    const packagedBridgePath = join(projectRoot, 'release', 'win-unpacked', 'putty.exe')
    const installerPath = join(projectRoot, 'release', `Terminal-Agent-Setup-${version}.exe`)
    const blockmapPath = join(projectRoot, 'release', `Terminal-Agent-Setup-${version}.exe.blockmap`)
    const cleanupArchivePath = join(projectRoot, 'release', `Terminal-Agent-Uninstall-Cleanup-${version}.zip`)
    const quickInstallSourcePath = join(projectRoot, 'quick-install.cmd')
    const quickInstallPath = join(projectRoot, 'release', 'quick-install.cmd')
    const quickInstallContents = Buffer.from('@echo off\r\necho quick install\r\n')

    try {
      await mkdir(dirname(packagedBridgePath), { recursive: true })
      await writeFile(packagedBridgePath, 'packaged bridge')
      await writeFile(installerPath, 'installer payload')
      await writeFile(blockmapPath, 'blockmap payload')
      await writeFile(cleanupArchivePath, 'cleanup archive payload')
      await writeFile(quickInstallSourcePath, quickInstallContents)

      await finalizer().finalizeWindowsReleaseArtifacts({ projectRoot, version, releaseDate })

      expect(await readFile(quickInstallPath)).toEqual(quickInstallContents)
    }
    finally {
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  it('copies the Markdown guide and its screenshots and regenerates the PDF from Markdown', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'terminal-agent-release-artifacts-'))
    const version = '1.0.8'
    const packagedBridgePath = join(projectRoot, 'release', 'win-unpacked', 'putty.exe')
    const installerPath = join(projectRoot, 'release', `Terminal-Agent-Setup-${version}.exe`)
    const blockmapPath = join(projectRoot, 'release', `Terminal-Agent-Setup-${version}.exe.blockmap`)
    const cleanupArchivePath = join(projectRoot, 'release', `Terminal-Agent-Uninstall-Cleanup-${version}.zip`)
    const quickInstallSourcePath = join(projectRoot, 'quick-install.cmd')
    const guidePath = join(projectRoot, '快速安装手册.md')
    const firstImagePath = join(projectRoot, 'docs', 'images', 'quickstart', '06-select-global-putty.png')
    const secondImagePath = join(projectRoot, 'docs', 'images', 'quickstart', '07-launch-bastion.png')

    try {
      await mkdir(dirname(packagedBridgePath), { recursive: true })
      await mkdir(dirname(firstImagePath), { recursive: true })
      await writeFile(packagedBridgePath, 'packaged bridge')
      await writeFile(installerPath, 'installer payload')
      await writeFile(blockmapPath, 'blockmap payload')
      await writeFile(cleanupArchivePath, 'cleanup archive payload')
      await writeFile(quickInstallSourcePath, '@echo off\r\n')
      await writeFile(guidePath, 'guide')
      await writeFile(firstImagePath, 'session image')
      await writeFile(secondImagePath, 'bastion image')
      await writeFile(join(projectRoot, 'release', '快速安装手册.pdf'), 'legacy pdf')
      const pdfGenerator = stubPdfGenerator()

      await finalizer().finalizeWindowsReleaseArtifacts({ projectRoot, version, pdfGenerator })

      await expect(readFile(join(projectRoot, 'release', '快速安装手册.md'), 'utf8')).resolves.toBe('guide')
      await expect(readFile(join(projectRoot, 'release', 'docs', 'images', 'quickstart', '06-select-global-putty.png'), 'utf8')).resolves.toBe('session image')
      await expect(readFile(join(projectRoot, 'release', 'docs', 'images', 'quickstart', '07-launch-bastion.png'), 'utf8')).resolves.toBe('bastion image')
      await expect(readFile(join(projectRoot, 'release', '快速安装手册.pdf'), 'utf8')).resolves.toContain('%PDF-1.7')
      expect(pdfGenerator).toHaveBeenCalledWith({
        projectRoot,
        markdownPath: guidePath,
        outputPath: join(projectRoot, 'release', '快速安装手册.pdf'),
      })
    }
    finally {
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  it('requires the quick installer before publishing a Windows release', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'terminal-agent-release-artifacts-'))
    const version = '1.0.8'
    const packagedBridgePath = join(projectRoot, 'release', 'win-unpacked', 'putty.exe')
    const installerPath = join(projectRoot, 'release', `Terminal-Agent-Setup-${version}.exe`)
    const blockmapPath = join(projectRoot, 'release', `Terminal-Agent-Setup-${version}.exe.blockmap`)
    const cleanupArchivePath = join(projectRoot, 'release', `Terminal-Agent-Uninstall-Cleanup-${version}.zip`)

    try {
      await mkdir(dirname(packagedBridgePath), { recursive: true })
      await writeFile(packagedBridgePath, 'packaged bridge')
      await writeFile(installerPath, 'installer payload')
      await writeFile(blockmapPath, 'blockmap payload')
      await writeFile(cleanupArchivePath, 'cleanup archive payload')

      await expect(finalizer().finalizeWindowsReleaseArtifacts({ projectRoot, version }))
        .rejects.toThrow('quick installer')
    }
    finally {
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  it('rejects a release version that could escape a release path or inject YAML', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'terminal-agent-release-artifacts-'))
    const releaseDate = new Date('2026-08-23T17:30:40.000Z')

    try {
      await expect(finalizer().finalizeWindowsReleaseArtifacts({
        projectRoot,
        version: '1.0.8/../../outside',
        releaseDate,
      })).rejects.toThrow('valid release version')
      expect(() => finalizer().latestYml({
        version: '1.0.8\ninjected: true',
        sha512: 'sha512',
        size: 1,
        releaseDate,
      })).toThrow('valid release version')
    }
    finally {
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  it('requires a non-empty installer blockmap before publishing release metadata', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'terminal-agent-release-artifacts-'))
    const version = '1.0.8'
    const packagedBridgePath = join(projectRoot, 'release', 'win-unpacked', 'putty.exe')
    const installerPath = join(projectRoot, 'release', `Terminal-Agent-Setup-${version}.exe`)
    const cleanupArchivePath = join(projectRoot, 'release', `Terminal-Agent-Uninstall-Cleanup-${version}.zip`)

    try {
      await mkdir(dirname(packagedBridgePath), { recursive: true })
      await writeFile(packagedBridgePath, 'packaged bridge')
      await writeFile(installerPath, 'installer payload')
      await writeFile(cleanupArchivePath, 'cleanup archive payload')

      await expect(finalizer().finalizeWindowsReleaseArtifacts({ projectRoot, version }))
        .rejects.toThrow('installer blockmap')
    }
    finally {
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  it('requires a non-empty installer before publishing release metadata', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'terminal-agent-release-artifacts-'))
    const version = '1.0.8'
    const packagedBridgePath = join(projectRoot, 'release', 'win-unpacked', 'putty.exe')
    const blockmapPath = join(projectRoot, 'release', `Terminal-Agent-Setup-${version}.exe.blockmap`)
    const cleanupArchivePath = join(projectRoot, 'release', `Terminal-Agent-Uninstall-Cleanup-${version}.zip`)

    try {
      await mkdir(dirname(packagedBridgePath), { recursive: true })
      await writeFile(packagedBridgePath, 'packaged bridge')
      await writeFile(blockmapPath, 'blockmap payload')
      await writeFile(cleanupArchivePath, 'cleanup archive payload')

      await expect(finalizer().finalizeWindowsReleaseArtifacts({ projectRoot, version }))
        .rejects.toThrow('Windows installer')
    }
    finally {
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  it('rejects a zero-byte installer blockmap before publishing release metadata', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'terminal-agent-release-artifacts-'))
    const version = '1.0.8'
    const packagedBridgePath = join(projectRoot, 'release', 'win-unpacked', 'putty.exe')
    const installerPath = join(projectRoot, 'release', `Terminal-Agent-Setup-${version}.exe`)
    const blockmapPath = join(projectRoot, 'release', `Terminal-Agent-Setup-${version}.exe.blockmap`)
    const cleanupArchivePath = join(projectRoot, 'release', `Terminal-Agent-Uninstall-Cleanup-${version}.zip`)

    try {
      await mkdir(dirname(packagedBridgePath), { recursive: true })
      await writeFile(packagedBridgePath, 'packaged bridge')
      await writeFile(installerPath, 'installer payload')
      await writeFile(blockmapPath, '')
      await writeFile(cleanupArchivePath, 'cleanup archive payload')

      await expect(finalizer().finalizeWindowsReleaseArtifacts({ projectRoot, version }))
        .rejects.toThrow('non-empty installer blockmap')
    }
    finally {
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  it('requires a non-empty uninstall cleanup archive before publishing release metadata', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'terminal-agent-release-artifacts-'))
    const version = '1.0.8'
    const packagedBridgePath = join(projectRoot, 'release', 'win-unpacked', 'putty.exe')
    const installerPath = join(projectRoot, 'release', `Terminal-Agent-Setup-${version}.exe`)
    const blockmapPath = join(projectRoot, 'release', `Terminal-Agent-Setup-${version}.exe.blockmap`)
    const cleanupArchivePath = join(projectRoot, 'release', `Terminal-Agent-Uninstall-Cleanup-${version}.zip`)

    try {
      await mkdir(dirname(packagedBridgePath), { recursive: true })
      await writeFile(packagedBridgePath, 'packaged bridge')
      await writeFile(installerPath, 'installer payload')
      await writeFile(blockmapPath, 'blockmap payload')
      await writeFile(cleanupArchivePath, '')

      await expect(finalizer().finalizeWindowsReleaseArtifacts({ projectRoot, version }))
        .rejects.toThrow('non-empty uninstall cleanup archive')
    }
    finally {
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  it('requires a non-empty packaged bridge before publishing release metadata', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'terminal-agent-release-artifacts-'))
    const version = '1.0.8'
    const packagedBridgePath = join(projectRoot, 'release', 'win-unpacked', 'putty.exe')
    const installerPath = join(projectRoot, 'release', `Terminal-Agent-Setup-${version}.exe`)
    const blockmapPath = join(projectRoot, 'release', `Terminal-Agent-Setup-${version}.exe.blockmap`)
    const cleanupArchivePath = join(projectRoot, 'release', `Terminal-Agent-Uninstall-Cleanup-${version}.zip`)

    try {
      await mkdir(dirname(packagedBridgePath), { recursive: true })
      await writeFile(packagedBridgePath, '')
      await writeFile(installerPath, 'installer payload')
      await writeFile(blockmapPath, 'blockmap payload')
      await writeFile(cleanupArchivePath, 'cleanup archive payload')

      await expect(finalizer().finalizeWindowsReleaseArtifacts({ projectRoot, version }))
        .rejects.toThrow('non-empty packaged bridge')
    }
    finally {
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  it('rejects a cleanup archive path that is a directory', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'terminal-agent-release-artifacts-'))
    const version = '1.0.8'
    const packagedBridgePath = join(projectRoot, 'release', 'win-unpacked', 'putty.exe')
    const installerPath = join(projectRoot, 'release', `Terminal-Agent-Setup-${version}.exe`)
    const blockmapPath = join(projectRoot, 'release', `Terminal-Agent-Setup-${version}.exe.blockmap`)
    const cleanupArchivePath = join(projectRoot, 'release', `Terminal-Agent-Uninstall-Cleanup-${version}.zip`)

    try {
      await mkdir(dirname(packagedBridgePath), { recursive: true })
      await writeFile(packagedBridgePath, 'packaged bridge')
      await writeFile(installerPath, 'installer payload')
      await writeFile(blockmapPath, 'blockmap payload')
      await mkdir(cleanupArchivePath)

      await expect(finalizer().finalizeWindowsReleaseArtifacts({ projectRoot, version }))
        .rejects.toThrow('non-empty uninstall cleanup archive')
    }
    finally {
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  it('overwrites root release metadata with the current packaged bridge and installer', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'terminal-agent-release-artifacts-'))
    const version = '1.0.8'
    const releaseDate = new Date('2026-08-23T17:30:40.000Z')
    const packagedBridgePath = join(projectRoot, 'release', 'win-unpacked', 'putty.exe')
    const installerPath = join(projectRoot, 'release', `Terminal-Agent-Setup-${version}.exe`)
    const blockmapPath = join(projectRoot, 'release', `Terminal-Agent-Setup-${version}.exe.blockmap`)
    const cleanupArchivePath = join(projectRoot, 'release', `Terminal-Agent-Uninstall-Cleanup-${version}.zip`)
    const quickInstallSourcePath = join(projectRoot, 'quick-install.cmd')

    try {
      await mkdir(dirname(packagedBridgePath), { recursive: true })
      await writeFile(packagedBridgePath, 'first bridge')
      await writeFile(installerPath, 'first installer')
      await writeFile(blockmapPath, 'blockmap payload')
      await writeFile(cleanupArchivePath, 'cleanup archive payload')
      await writeFile(quickInstallSourcePath, '@echo off\r\necho quick install\r\n')
      await finalizer().finalizeWindowsReleaseArtifacts({ projectRoot, version, releaseDate })

      const currentBridge = Buffer.from('current bridge')
      const currentInstaller = Buffer.from('current installer')
      await writeFile(packagedBridgePath, currentBridge)
      await writeFile(installerPath, currentInstaller)
      const result = await finalizer().finalizeWindowsReleaseArtifacts({ projectRoot, version, releaseDate })
      const currentSha512 = createHash('sha512').update(currentInstaller).digest('base64')

      expect(await readFile(result.bridgePath)).toEqual(currentBridge)
      await expect(readFile(result.latestYmlPath, 'utf8')).resolves.toContain(`sha512: ${currentSha512}`)
    }
    finally {
      await rm(projectRoot, { recursive: true, force: true })
    }
  })
})
