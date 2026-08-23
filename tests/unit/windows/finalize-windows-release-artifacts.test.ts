import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

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
  }): Promise<FinalizedWindowsReleaseArtifacts>
}

const require = createRequire(import.meta.url)

function finalizer(): WindowsReleaseArtifactFinalizer {
  return require('../../../scripts/windows/finalize-windows-release-artifacts.cjs') as WindowsReleaseArtifactFinalizer
}

describe('Windows release artifact finalizer', () => {
  it('exports the packaged bridge and installer update metadata at the release root', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'terminal-agent-release-artifacts-'))
    const version = '1.0.8'
    const releaseDate = new Date('2026-08-23T17:30:40.000Z')
    const packagedBridgePath = join(projectRoot, 'release', 'win-unpacked', 'putty.exe')
    const installerPath = join(projectRoot, 'release', `Terminal-Agent-Setup-${version}.exe`)
    const bridgeContents = Buffer.from('packaged bridge')
    const installerContents = Buffer.from('installer payload')

    try {
      await mkdir(dirname(packagedBridgePath), { recursive: true })
      await writeFile(packagedBridgePath, bridgeContents)
      await writeFile(installerPath, installerContents)

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
})
